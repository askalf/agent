/**
 * AskAlf Agent Security Layer
 *
 * - Execution approval gate (interactive + auto-approve modes)
 * - Audit logging (every execution logged to ~/.askalf/audit.log)
 * - Output sanitization (strip secrets, tokens, keys from output)
 * - Filesystem boundaries (configurable allowed paths)
 * - Execution policy (block dangerous patterns)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const CONFIG_DIR = join(homedir(), '.askalf');
const AUDIT_LOG = join(CONFIG_DIR, 'audit.log');
const POLICY_FILE = join(CONFIG_DIR, 'policy.json');

// ── Security Policy ──

export interface SecurityPolicy {
  /** Require interactive approval before each execution */
  requireApproval: boolean;
  /** Auto-approve tasks from these agent names */
  trustedAgents: string[];
  /** Block execution if input contains these patterns */
  blockedPatterns: string[];
  /** Only allow execution in these directories (empty = unrestricted) */
  allowedPaths: string[];
  /** Maximum execution timeout override (ms) */
  maxTimeoutMs: number;
  /** Strip secrets from output before sending back */
  sanitizeOutput: boolean;
  /** Log all executions to audit file */
  auditLog: boolean;
}

const DEFAULT_POLICY: SecurityPolicy = {
  requireApproval: false,
  trustedAgents: [],
  blockedPatterns: [
    // Filesystem destruction
    'rm -rf /',
    'rm -rf ~',
    'rm -rf \\*',
    'mkfs\\.',
    'dd if=/dev/zero',
    'dd if=/dev/random',
    '> /dev/sda',
    'chmod -R 777 /',
    'chown -R.*/',
    // Process/system attacks
    ':(){:|:&};:',      // fork bomb
    'shutdown',
    'reboot',
    'init 0',
    'halt',
    // Database destruction
    'DROP TABLE',
    'DROP DATABASE',
    'TRUNCATE TABLE',
    'DELETE FROM.*WHERE 1',
    'DELETE FROM.*WHERE true',
    // Remote code execution via pipe
    'curl.*\\|.*sh',
    'wget.*\\|.*sh',
    'curl.*\\|.*bash',
    'wget.*\\|.*bash',
    // Credential theft
    'cat.*/etc/shadow',
    'cat.*/etc/passwd',
    'cat.*\\.ssh/id_',
    'cat.*\\.env',
    // Network attacks
    'nmap -sS',
    'hping3',
    // Windows specific
    'format c:',
    'del /f /s /q c:\\\\',
    'Remove-Item.*-Recurse.*-Force.*C:\\\\',
  ],
  allowedPaths: [],
  maxTimeoutMs: 600_000,
  sanitizeOutput: true,
  auditLog: true,
};

let policy: SecurityPolicy | undefined;

export function loadPolicy(): SecurityPolicy {
  if (policy) return policy;

  if (existsSync(POLICY_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
      const loaded: SecurityPolicy = { ...DEFAULT_POLICY, ...raw };
      policy = loaded;
      return loaded;
    } catch {
      // Corrupt policy file — use defaults
    }
  }

  const defaults: SecurityPolicy = { ...DEFAULT_POLICY };
  policy = defaults;
  return defaults;
}

// ── Input Validation ──

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateInput(input: string, agentName: string): ValidationResult {
  const p = loadPolicy();

  // Check blocked patterns
  for (const pattern of p.blockedPatterns) {
    try {
      if (new RegExp(pattern, 'i').test(input)) {
        return { allowed: false, reason: `Blocked pattern detected: ${pattern}` };
      }
    } catch {
      // Invalid regex in policy — skip
      if (input.toLowerCase().includes(pattern.toLowerCase())) {
        return { allowed: false, reason: `Blocked pattern detected: ${pattern}` };
      }
    }
  }

  // Check path boundaries
  if (p.allowedPaths.length > 0) {
    // Extract any file paths from the input
    const pathMatches = input.match(/(?:\/[\w\-.\/]+|[A-Z]:\\[\w\-.\\]+)/g) ?? [];
    for (const path of pathMatches) {
      const normalized = path.replace(/\\/g, '/');
      if (!p.allowedPaths.some(allowed => normalized.startsWith(allowed.replace(/\\/g, '/')))) {
        return { allowed: false, reason: `Path outside allowed boundaries: ${path}` };
      }
    }
  }

  return { allowed: true };
}

// ── Approval Gate ──

export async function requestApproval(
  executionId: string,
  agentName: string,
  input: string,
): Promise<boolean> {
  const p = loadPolicy();

  if (!p.requireApproval) return true;
  if (p.trustedAgents.includes(agentName)) return true;

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log(`\n  ┌─ APPROVAL REQUIRED ────────────────────────`);
    console.log(`  │ Execution: ${executionId.slice(0, 16)}...`);
    console.log(`  │ Agent:     ${agentName}`);
    console.log(`  │ Task:      ${input.substring(0, 120)}${input.length > 120 ? '...' : ''}`);
    console.log(`  └──────────────────────────────────────────────`);

    rl.question('  Approve? [y/N] ', (answer) => {
      rl.close();
      const approved = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
      if (!approved) {
        console.log('  Execution denied.');
      }
      resolve(approved);
    });

    // Auto-deny after 60 seconds
    setTimeout(() => {
      rl.close();
      console.log('  Approval timed out — denied.');
      resolve(false);
    }, 60_000);
  });
}

// ── Output Sanitization ──

const SECRET_PATTERNS = [
  // API keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9]{32,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9_-]{20,}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /xoxp-[a-zA-Z0-9-]+/g,

  // Tokens
  /Bearer\s+[a-zA-Z0-9_\-.]+/g,
  /token["\s:=]+[a-zA-Z0-9_\-.]{20,}/gi,

  // Passwords in common formats
  /password["\s:=]+[^\s"',;]{8,}/gi,
  /passwd["\s:=]+[^\s"',;]{8,}/gi,
  /secret["\s:=]+[^\s"',;]{8,}/gi,

  // Private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,

  // Connection strings with passwords
  /(?:postgres|mysql|redis|mongodb):\/\/[^:]+:[^@]+@/g,

  // AWS
  /ASIA[A-Z0-9]{16}/g,
  /[a-zA-Z0-9/+=]{40}(?=\s|$|")/g,

  // JWT tokens
  /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
];

export function sanitizeOutput(output: string): string {
  const p = loadPolicy();
  if (!p.sanitizeOutput) return output;

  let sanitized = output;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Keep first 4 and last 4 chars, mask the rest
      if (match.length <= 12) return '[REDACTED]';
      return match.slice(0, 4) + '[REDACTED]' + match.slice(-4);
    });
  }

  // Also check for common env var leaks
  const envVarPattern = /(?:^|\n)([A-Z_]{2,}(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS))=(.+)/gm;
  sanitized = sanitized.replace(envVarPattern, (_, name: string) => `${name}=[REDACTED]`);

  return sanitized;
}

// ── Audit Logging ──

export interface AuditEntry {
  timestamp: string;
  executionId: string;
  agentName: string;
  executor: string;
  input: string;
  result: 'success' | 'failed' | 'denied' | 'blocked';
  durationMs?: number;
  cost?: number;
  error?: string;
}

export function logAudit(entry: AuditEntry): void {
  const p = loadPolicy();
  if (!p.auditLog) return;

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  const line = JSON.stringify({
    ...entry,
    input: entry.input.substring(0, 500), // Truncate for log
  }) + '\n';

  try {
    appendFileSync(AUDIT_LOG, line, { mode: 0o600 });
  } catch {
    // Audit logging failure is not fatal
  }
}

/**
 * Read recent audit entries.
 */
export function readAuditLog(limit = 50): AuditEntry[] {
  if (!existsSync(AUDIT_LOG)) return [];
  try {
    const lines = readFileSync(AUDIT_LOG, 'utf8').trim().split('\n');
    return lines
      .slice(-limit)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as AuditEntry[];
  } catch {
    return [];
  }
}
