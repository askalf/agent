/**
 * AskAlf Agent Bridge — WebSocket client with task queue and universal executors.
 *
 * Supports multiple execution backends:
 * - Claude CLI (primary)
 * - Codex CLI
 * - Shell commands (for simple tasks)
 * - Custom executors via plugins
 */

import WebSocket from 'ws';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { freemem, totalmem, loadavg } from 'os';
import { validateInput, requestApproval, sanitizeOutput, logAudit, loadPolicy } from './security.js';

export interface BridgeOptions {
  apiKey: string;
  url: string;
  deviceName: string;
  hostname: string;
  os: string;
  capabilities: Record<string, boolean>;
  systemInfo?: {
    arch: string;
    cpuCores: number;
    totalMemoryMB: number;
    nodeVersion: string;
  };
  maxConcurrent?: number;
  executionTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
}

interface ServerMessage {
  type: string;
  payload: Record<string, unknown>;
}

interface TaskPayload {
  executionId: string;
  agentId: string;
  agentName: string;
  input: string;
  executor?: 'claude' | 'codex' | 'shell';
  maxTurns?: number;
  maxBudget?: number;
  timeoutMs?: number;
  workingDirectory?: string;
}

interface ActiveExecution {
  id: string;
  process: ChildProcess;
  startedAt: number;
}

export class AgentBridge {
  private ws: WebSocket | null = null;
  private options: Required<Omit<BridgeOptions, 'systemInfo'>> & { systemInfo?: BridgeOptions['systemInfo'] };
  private deviceId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeExecutions = new Map<string, ActiveExecution>();
  private taskQueue: TaskPayload[] = [];
  private shouldReconnect = true;
  private reconnectAttempt = 0;

  constructor(options: BridgeOptions) {
    this.options = {
      maxConcurrent: 2,
      executionTimeoutMs: 600_000,
      reconnectBaseMs: 2000,
      reconnectMaxMs: 60000,
      heartbeatIntervalMs: 30000,
      ...options,
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.options.url.replace(/^https?:\/\//, 'wss://').replace(/\/$/, '') + '/ws/agent-bridge';

      console.log(`  Connecting to ${wsUrl}...`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.options.apiKey}`,
          'X-Agent-Version': '2.0.0',
          'X-Device-Name': this.options.deviceName,
        },
        handshakeTimeout: 15_000,
      });

      this.ws.on('open', () => {
        this.reconnectAttempt = 0;
        console.log('  Connected. Registering device...');

        if (this.deviceId) {
          this.send('device:reconnect', { deviceId: this.deviceId });
        } else {
          this.send('device:register', {
            deviceName: this.options.deviceName,
            hostname: this.options.hostname,
            os: this.options.os,
            capabilities: this.options.capabilities,
            systemInfo: this.options.systemInfo,
            maxConcurrent: this.options.maxConcurrent,
            version: '2.0.0',
          });
        }

        this.startHeartbeat();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg: ServerMessage = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error('  Failed to parse server message:', err);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`  Disconnected (${code}: ${reason.toString() || 'no reason'})`);
        this.stopHeartbeat();
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error(`  WebSocket error: ${err.message}`);
        if (!this.deviceId) reject(err);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Kill all active executions
    for (const [id, exec] of this.activeExecutions) {
      console.log(`  Cancelling execution ${id}`);
      exec.process.kill('SIGTERM');
    }
    this.activeExecutions.clear();
    this.taskQueue = [];
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'device:registered':
        this.deviceId = msg.payload['deviceId'] as string;
        console.log(`  Registered as device ${this.deviceId}`);
        console.log(`  Ready — waiting for tasks...\n`);
        break;

      case 'task:dispatch':
        this.enqueueTask(msg.payload as unknown as TaskPayload);
        break;

      case 'task:cancel':
        this.cancelTask(msg.payload['executionId'] as string);
        break;

      case 'device:ping':
        this.send('device:pong', { ts: Date.now() });
        break;

      case 'device:error':
        console.error(`  Server error: [${msg.payload['code']}] ${msg.payload['message']}`);
        if (msg.payload['code'] === 'AUTH_FAILED') {
          this.shouldReconnect = false;
          console.error('  Authentication failed. Check your API key.');
        }
        break;

      default:
        break;
    }
  }

  // ── Task Queue ──

  private enqueueTask(task: TaskPayload): void {
    if (this.activeExecutions.size < this.options.maxConcurrent) {
      this.executeTask(task);
    } else {
      this.taskQueue.push(task);
      console.log(`  Task ${task.executionId} queued (${this.taskQueue.length} in queue, ${this.activeExecutions.size} running)`);
      this.send('execution:queued', { executionId: task.executionId, position: this.taskQueue.length });
    }
  }

  private drainQueue(): void {
    while (this.taskQueue.length > 0 && this.activeExecutions.size < this.options.maxConcurrent) {
      const next = this.taskQueue.shift()!;
      this.executeTask(next);
    }
  }

  // ── Task Execution ──

  private async executeTask(task: TaskPayload): Promise<void> {
    const executor = task.executor || this.detectBestExecutor(task);
    const ts = new Date().toISOString();
    const startTime = Date.now();

    console.log(`  [${ts}] Task: ${task.agentName} (${task.executionId.slice(0, 12)}...)`);
    console.log(`    Executor: ${executor} | Input: ${task.input.substring(0, 80)}${task.input.length > 80 ? '...' : ''}`);

    // Security: validate input against policy
    const validation = validateInput(task.input, task.agentName);
    if (!validation.allowed) {
      console.error(`    BLOCKED: ${validation.reason}`);
      this.send('execution:failed', { executionId: task.executionId, error: `Security policy: ${validation.reason}`, executor });
      logAudit({ timestamp: ts, executionId: task.executionId, agentName: task.agentName, executor, input: task.input, result: 'blocked', error: validation.reason });
      this.drainQueue();
      return;
    }

    // Security: approval gate
    const approved = await requestApproval(task.executionId, task.agentName, task.input);
    if (!approved) {
      this.send('execution:failed', { executionId: task.executionId, error: 'Execution denied by operator', executor });
      logAudit({ timestamp: ts, executionId: task.executionId, agentName: task.agentName, executor, input: task.input, result: 'denied' });
      this.drainQueue();
      return;
    }

    // Enforce max timeout from policy
    const maxTimeout = loadPolicy().maxTimeoutMs;
    if (task.timeoutMs && task.timeoutMs > maxTimeout) {
      task.timeoutMs = maxTimeout;
    }

    this.send('execution:accepted', { executionId: task.executionId, executor });

    try {
      let result: ExecutionResult;

      switch (executor) {
        case 'claude':
          result = await this.runClaude(task);
          break;
        case 'codex':
          result = await this.runCodex(task);
          break;
        case 'shell':
          result = await this.runShell(task);
          break;
        default:
          throw new Error(`Unknown executor: ${executor}`);
      }

      // Security: sanitize output before sending back
      const cleanOutput = sanitizeOutput(result.output);
      const durationMs = Date.now() - startTime;

      this.send('execution:complete', {
        executionId: task.executionId,
        output: cleanOutput,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cost: result.cost,
        executor,
        durationMs,
      });

      logAudit({ timestamp: ts, executionId: task.executionId, agentName: task.agentName, executor, input: task.input, result: 'success', durationMs, cost: result.cost });
      console.log(`    Done: $${result.cost.toFixed(4)} | ${result.tokensIn + result.tokensOut} tokens | ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      this.send('execution:failed', { executionId: task.executionId, error: errorMsg, executor });
      logAudit({ timestamp: ts, executionId: task.executionId, agentName: task.agentName, executor, input: task.input, result: 'failed', durationMs, error: errorMsg });
      console.error(`    Failed: ${errorMsg}`);
    } finally {
      this.activeExecutions.delete(task.executionId);
      this.drainQueue();
    }
  }

  private detectBestExecutor(task: TaskPayload): 'claude' | 'codex' | 'shell' {
    // AI executors preferred — they understand intent and use tools safely
    if (this.options.capabilities['claude']) return 'claude';
    if (this.options.capabilities['codex']) return 'codex';
    // Shell mode — runs commands directly. Security policy enforces guardrails.
    return 'shell';
  }

  private cancelTask(executionId: string): void {
    const exec = this.activeExecutions.get(executionId);
    if (exec) {
      console.log(`  Cancelling task ${executionId}`);
      exec.process.kill('SIGTERM');
      this.activeExecutions.delete(executionId);
      this.drainQueue();
      return;
    }
    // Check queue
    const qIdx = this.taskQueue.findIndex(t => t.executionId === executionId);
    if (qIdx >= 0) {
      this.taskQueue.splice(qIdx, 1);
      console.log(`  Removed queued task ${executionId}`);
    }
  }

  // ── Executors ──

  private findExecutable(name: string): string | null {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      return execSync(cmd, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0] || null;
    } catch {
      return null;
    }
  }

  private sanitizeInput(input: string): string {
    // Remove control characters and null bytes
    return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  private runClaude(task: TaskPayload): Promise<ExecutionResult> {
    const claudePath = this.findExecutable('claude');
    if (!claudePath) throw new Error('Claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code');

    const args = ['--print', '--output-format', 'json'];
    if (task.maxTurns) args.push('--max-turns', String(task.maxTurns));
    if (task.maxBudget) args.push('--max-budget-usd', String(task.maxBudget));
    args.push(this.sanitizeInput(task.input));

    return this.spawnExecutor(claudePath, args, task, 'claude');
  }

  private runCodex(task: TaskPayload): Promise<ExecutionResult> {
    const codexPath = this.findExecutable('codex');
    if (!codexPath) throw new Error('Codex CLI not installed.');

    const args = ['--full-auto', '--quiet', this.sanitizeInput(task.input)];
    return this.spawnExecutor(codexPath, args, task, 'codex');
  }

  private runShell(task: TaskPayload): Promise<ExecutionResult> {
    // Shell executor — runs commands via the native shell.
    // Security is enforced by the policy layer (blockedPatterns, approval gate, audit log).
    // This is the fallback when no AI CLI (Claude/Codex) is available.
    const sanitized = this.sanitizeInput(task.input);
    const p = loadPolicy();

    // If the input looks like a multi-line script, write to temp and execute
    const isMultiLine = sanitized.includes('\n');
    let shell: string;
    let shellArgs: string[];

    if (process.platform === 'win32') {
      // Windows: prefer PowerShell, fall back to cmd
      const hasPowerShell = this.findExecutable('pwsh') || this.findExecutable('powershell');
      if (hasPowerShell) {
        shell = hasPowerShell;
        shellArgs = ['-NoProfile', '-NonInteractive', '-Command', sanitized];
      } else {
        shell = 'cmd';
        shellArgs = ['/c', sanitized];
      }
    } else {
      // Unix: prefer bash, fall back to sh
      const hasBash = this.findExecutable('bash');
      shell = hasBash || '/bin/sh';
      shellArgs = ['-c', sanitized];
    }

    // Extra safety for shell mode: require approval if policy doesn't already require it
    // and the command contains potentially destructive patterns
    const CAUTION_PATTERNS = /\brm\b|\bmkdir\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bkill\b|\bsudo\b|\bapt\b|\byum\b|\bbrew\b|\bnpm\b|\bpip\b|\bgit\s+push\b|\bgit\s+reset\b|\bdocker\s+rm\b/i;
    if (CAUTION_PATTERNS.test(sanitized) && !p.requireApproval) {
      console.log(`    [shell] Caution: command contains potentially destructive operations`);
    }

    return this.spawnExecutor(shell, shellArgs, task, 'shell');
  }

  private spawnExecutor(
    path: string,
    args: string[],
    task: TaskPayload,
    executor: string,
  ): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const timeout = task.timeoutMs || this.options.executionTimeoutMs;
      const cwd = task.workingDirectory || process.cwd();

      const proc = spawn(path, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
        cwd,
        env: { ...process.env },
      });

      this.activeExecutions.set(task.executionId, {
        id: task.executionId,
        process: proc,
        startedAt: Date.now(),
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        this.send('execution:progress', {
          executionId: task.executionId,
          bytes: stdout.length,
          chunk: text.substring(0, 500),
        });
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.error) return reject(new Error(String(parsed.error)));
          } catch { /* not JSON */ }
          return reject(new Error(stderr.substring(0, 500) || `${executor} exited with code ${code}`));
        }

        if (executor === 'claude') {
          resolve(this.parseClaudeOutput(stdout));
        } else if (executor === 'codex') {
          resolve({ output: stdout, tokensIn: 0, tokensOut: 0, cost: 0 });
        } else {
          resolve({ output: stdout, tokensIn: 0, tokensOut: 0, cost: 0 });
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn ${executor}: ${err.message}`));
      });
    });
  }

  private parseClaudeOutput(stdout: string): ExecutionResult {
    const lines = stdout.trim().split('\n');
    let output = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result') {
          output = parsed.result || '';
          tokensIn = parsed.input_tokens || 0;
          tokensOut = parsed.output_tokens || 0;
          cost = parsed.total_cost_usd || parsed.cost || 0;
        } else if (parsed.type === 'assistant' && parsed.message) {
          const textBlocks = (parsed.message.content || [])
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text);
          if (!output) output = '';
          output += textBlocks.join('');
        }
      } catch { /* skip non-JSON lines */ }
    }

    return { output: output || stdout, tokensIn, tokensOut, cost };
  }

  // ── Heartbeat with real system metrics ──

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const load = loadavg();
      this.send('device:heartbeat', {
        activeExecutions: this.activeExecutions.size,
        queuedTasks: this.taskQueue.length,
        freeMemoryMB: Math.round(freemem() / 1024 / 1024),
        totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
        loadAvg1m: Math.round(load[0]! * 100) / 100,
        loadAvg5m: Math.round(load[1]! * 100) / 100,
        uptime: Math.round(process.uptime()),
      });
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Reconnect with exponential backoff ──

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.options.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.options.reconnectMaxMs,
    );
    this.reconnectAttempt++;
    console.log(`  Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.error(`  Reconnect failed: ${err instanceof Error ? err.message : err}`);
        this.scheduleReconnect();
      }
    }, delay);
  }
}

interface ExecutionResult {
  output: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}
