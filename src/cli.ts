#!/usr/bin/env node
/**
 * AskAlf Agent CLI
 * Connect any device to your AskAlf team via WebSocket bridge.
 */

import { AgentBridge } from './bridge.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, hostname, platform, type, release, cpus, totalmem, freemem } from 'os';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };
const VERSION = pkg.version;

const CONFIG_DIR = join(homedir(), '.askalf');
const CONFIG_FILE = join(CONFIG_DIR, 'agent.json');
const PID_FILE = join(CONFIG_DIR, 'agent.pid');
const LOG_FILE = join(CONFIG_DIR, 'agent.log');

interface AgentConfig {
  apiKey: string;
  url: string;
  deviceName?: string;
  maxConcurrent?: number;
  executionTimeoutMs?: number;
}

function loadConfig(): AgentConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config: AgentConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function detectCapabilities(): Record<string, boolean> {
  return {
    shell: true,
    filesystem: true,
    git: hasCommand('git'),
    docker: hasCommand('docker'),
    node: hasCommand('node'),
    python: hasCommand('python3') || hasCommand('python'),
    claude: hasCommand('claude'),
    codex: hasCommand('codex'),
    curl: hasCommand('curl'),
    ssh: hasCommand('ssh'),
    rsync: hasCommand('rsync'),
    ffmpeg: hasCommand('ffmpeg'),
    jq: hasCommand('jq'),
  };
}

function getSystemInfo() {
  const cpuInfo = cpus();
  return {
    hostname: hostname(),
    os: `${type()} ${release()} (${platform()})`,
    arch: process.arch,
    cpuCores: cpuInfo.length,
    cpuModel: cpuInfo[0]?.model ?? 'unknown',
    totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(freemem() / 1024 / 1024),
    nodeVersion: process.version,
    capabilities: detectCapabilities(),
  };
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`${platform() === 'win32' ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function connect(apiKey: string, url: string, opts: { name?: string; concurrent?: number; timeout?: number }): Promise<void> {
  const system = getSystemInfo();
  const config: AgentConfig = {
    apiKey,
    url,
    deviceName: opts.name || system.hostname,
    maxConcurrent: opts.concurrent || 2,
    executionTimeoutMs: (opts.timeout || 10) * 60 * 1000,
  };
  saveConfig(config);

  const caps = Object.entries(system.capabilities).filter(([, v]) => v).map(([k]) => k);

  console.log(`\n  AskAlf Agent v${VERSION}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Device:   ${config.deviceName}`);
  console.log(`  OS:       ${system.os}`);
  console.log(`  CPU:      ${system.cpuCores} cores (${system.cpuModel.substring(0, 40)})`);
  console.log(`  Memory:   ${system.freeMemoryMB}MB free / ${system.totalMemoryMB}MB total`);
  console.log(`  Node:     ${system.nodeVersion}`);
  console.log(`  Server:   ${url}`);
  console.log(`  Workers:  ${config.maxConcurrent} concurrent`);
  console.log(`  Timeout:  ${(config.executionTimeoutMs! / 60000).toFixed(0)} minutes`);
  console.log(`  Tools:    ${caps.join(', ')}`);
  console.log(`  ─────────────────────────────────\n`);

  const bridge = new AgentBridge({
    apiKey,
    url,
    deviceName: config.deviceName!,
    hostname: system.hostname,
    os: system.os,
    capabilities: system.capabilities,
    systemInfo: {
      arch: system.arch,
      cpuCores: system.cpuCores,
      totalMemoryMB: system.totalMemoryMB,
      nodeVersion: system.nodeVersion,
    },
    maxConcurrent: config.maxConcurrent!,
    executionTimeoutMs: config.executionTimeoutMs!,
  });

  const shutdown = () => {
    console.log('\n  Shutting down...');
    bridge.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bridge.connect();
}

function daemon(): void {
  const config = loadConfig();
  if (!config) {
    console.error('No configuration found. Run `askalf-agent connect <api-key>` first.');
    process.exit(1);
  }

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  const args = ['connect', config.apiKey, '--url', config.url];
  if (config.deviceName) args.push('--name', config.deviceName);
  if (config.maxConcurrent) args.push('--concurrent', String(config.maxConcurrent));

  const child = spawn(process.execPath, [process.argv[1]!, ...args], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();

  writeFileSync(PID_FILE, String(child.pid));
  console.log(`Agent daemon started (PID: ${child.pid})`);
  console.log(`  Config: ${CONFIG_FILE}`);
  console.log(`  PID:    ${PID_FILE}`);
  process.exit(0);
}

function status(): void {
  const config = loadConfig();
  if (!config) {
    console.log('Not configured. Run `askalf-agent connect <api-key>` first.');
    return;
  }

  console.log(`\n  AskAlf Agent v${VERSION}`);
  console.log(`  Server:  ${config.url}`);
  console.log(`  Device:  ${config.deviceName}`);

  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(pid, 0);
      console.log(`  Status:  Running (PID ${pid})`);
    } catch {
      console.log('  Status:  Not running (stale PID)');
    }
  } else {
    console.log('  Status:  Not running');
  }

  const system = getSystemInfo();
  const caps = Object.entries(system.capabilities).filter(([, v]) => v).map(([k]) => k);
  console.log(`  Tools:   ${caps.join(', ')}`);
  console.log(`  Memory:  ${system.freeMemoryMB}MB free / ${system.totalMemoryMB}MB total\n`);
}

function disconnect(): void {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Agent stopped (PID: ${pid})`);
    } catch {
      console.log('Agent was not running.');
    }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  } else {
    console.log('No running agent found.');
  }
}

// ── CLI argument parsing ──

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

const command = (args.includes('--help') || args.includes('-h')) ? undefined : args[0];

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

switch (command) {
  case 'connect': {
    const apiKey = args[1];
    if (!apiKey || apiKey.startsWith('--')) {
      console.error('Usage: askalf-agent connect <api-key> [options]');
      console.error('  --url <url>           Server URL (default: wss://askalf.org)');
      console.error('  --name <name>         Device name (default: hostname)');
      console.error('  --concurrent <n>      Max concurrent tasks (default: 2)');
      console.error('  --timeout <minutes>   Execution timeout (default: 10)');
      process.exit(1);
    }
    connect(apiKey, getFlag('--url') || 'wss://askalf.org', {
      name: getFlag('--name'),
      concurrent: getFlag('--concurrent') ? parseInt(getFlag('--concurrent')!) : undefined,
      timeout: getFlag('--timeout') ? parseInt(getFlag('--timeout')!) : undefined,
    });
    break;
  }
  case 'daemon':
    daemon();
    break;
  case 'status':
    status();
    break;
  case 'disconnect':
  case 'stop':
    disconnect();
    break;
  default:
    console.log(`
  AskAlf Agent v${VERSION}

  Connect any device to your AskAlf team.

  Commands:
    connect <api-key>    Connect this device
    daemon               Run as background service
    status               Check connection and device info
    disconnect           Stop the agent

  Options:
    --url <url>          Server URL (default: wss://askalf.org)
    --name <name>        Device name (default: hostname)
    --concurrent <n>     Max concurrent tasks (default: 2)
    --timeout <min>      Execution timeout in minutes (default: 10)
    --version            Show version
    --help               Show this help

  Examples:
    askalf-agent connect sk-ant-xxx
    askalf-agent connect sk-ant-xxx --url wss://my-server.com --name prod-01
    askalf-agent daemon
`);
}
