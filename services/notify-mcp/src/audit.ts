/**
 * Append-only, hash-chained JSONL audit stream.
 *
 * Ported from Backbone `packages/governance/src/audit-log.ts`, which emitted the
 * same shape until the governance gate was removed on 2026-05-24 (see
 * docs/00-CURRENT-STATE.md §2). The schema is deliberately compatible with the
 * frozen archive at ~/.hermes/archive-backbone-2026-05-24/governance-audit.jsonl
 * so old and new lines can be read by one parser.
 *
 * Two things are new here.
 *
 * 1. **The hash chain.** The original appended independent lines with no linkage.
 *    docs/RETENTION.md previously claimed otherwise; that was wrong and is
 *    corrected there. Each line now carries `seq` and `prevHash`, so removing or
 *    editing a line in the middle of the file is detectable.
 *
 * 2. **It runs at the tool boundary, not in the gateway.** notify-mcp is where a
 *    world-affecting action actually happens. As a forked stdio child it had no
 *    identity, no volume and no lifecycle of its own, so it could not have owned
 *    an audit stream. Giving it a network transport and a PVC is what makes this
 *    possible -- the containerization enables the audit, not the reverse.
 *
 * Failure is never fatal. An audit write that throws must not break the tool
 * call; it degrades to stderr, and the gap is visible in the chain.
 */
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Genesis link. A chain whose first line has this prevHash is complete. */
export const GENESIS = '0'.repeat(64);

export interface AuditLineInput {
  /** Coarse category -- `execute` | `refuse` | `error`. */
  category: string;
  /** Emitting component. */
  source?: string;
  /** `personal` | `work`, when known. */
  domain?: string | null;
  /** Structured fields: tool, ok, channels, durationMs, ... */
  payload?: Record<string, unknown>;
}

export interface AuditLine extends Record<string, unknown> {
  ts: string;
  seq: number;
  prevHash: string;
  category: string;
  source: string;
  domain: string | null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

/**
 * One writer per process.
 *
 * notify-mcp runs 2 replicas and the volume is ReadWriteOnce, so a single shared
 * file would interleave two chains and corrupt both. Each pod therefore owns
 * `audit-<instance>.jsonl` and its own independent chain. Verification is
 * per-file, which is the correct granularity: a chain is only meaningful for a
 * single append-ordered writer.
 */
export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;
  private readonly path: string;
  private ready = false;
  /** Latched on first init failure so a bad path is not retried per-call. */
  private disabled = false;

  constructor(path?: string, instance?: string) {
    const dir = process.env['BACKBONE_AUDIT_DIR'] ?? '/var/lib/backbone/audit';
    const id = instance ?? process.env['HOSTNAME'] ?? randomUUID().slice(0, 8);
    this.path = path ?? process.env['BACKBONE_AUDIT_PATH'] ?? join(dir, `audit-${id}.jsonl`);
  }

  get filePath(): string {
    return this.path;
  }

  /**
   * Resume an existing chain rather than restarting it.
   *
   * A pod restart must not reset seq to 0 -- that would make the file look
   * tampered with at exactly the moment it is most likely to be inspected.
   */
  private init(): void {
    if (this.ready || this.disabled) return;
    const dir = dirname(this.path);

    // Probe writability BEFORE mkdir.
    //
    // `mkdirSync(dir, { recursive: true })` does NOT reliably fail fast on a
    // pseudo-filesystem: pointed at /proc/<nonexistent>/ it spins, burning
    // syscalls indefinitely rather than throwing EACCES. A hardening test found
    // this by trying to audit to an unwritable path -- the test hung, and the
    // same hang existed in the production path any time BACKBONE_AUDIT_DIR
    // pointed somewhere the container could not write. docs/OPERATIONS.md,
    // 2026-07-25.
    //
    // So: walk to the nearest existing ancestor, assert W_OK on it, and only
    // then create. A failure latches `disabled` -- auditing degrades to stderr
    // instead of retrying on every single tool call.
    try {
      let ancestor = dir;
      while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
        ancestor = dirname(ancestor);
      }
      accessSync(ancestor, constants.W_OK);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    } catch (err) {
      this.disabled = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          svc: 'notify-mcp',
          msg: 'audit disabled: path not writable',
          path: this.path,
          error: msg,
        }) + '\n',
      );
      return;
    }

    if (existsSync(this.path)) {
      const lines = readFileSync(this.path, 'utf-8').trimEnd().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        try {
          const parsed = JSON.parse(last) as { seq?: number };
          this.seq = typeof parsed.seq === 'number' ? parsed.seq : lines.length;
          this.prevHash = sha256(last);
        } catch {
          // Trailing line is unparseable -- a torn write from an ungraceful
          // kill. Chain from it anyway: verification will flag the break, which
          // is the honest outcome. Silently starting a fresh chain would hide it.
          this.seq = lines.length;
          this.prevHash = sha256(last);
        }
      }
    }
    this.ready = true;
  }

  /** Append one line. Best-effort: logs to stderr on failure, never throws. */
  append(input: AuditLineInput): AuditLine | null {
    try {
      this.init();
      if (this.disabled) return null;
      const line: AuditLine = {
        ts: new Date().toISOString(),
        seq: ++this.seq,
        prevHash: this.prevHash,
        category: input.category,
        source: input.source ?? 'notify-mcp',
        domain: input.domain ?? null,
        ...(input.payload ?? {}),
      };
      const serialized = JSON.stringify(line);
      appendFileSync(this.path, `${serialized}\n`, 'utf-8');
      this.prevHash = sha256(serialized);
      return line;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          svc: 'notify-mcp',
          msg: 'audit append failed',
          error: msg,
        }) + '\n',
      );
      return null;
    }
  }
}

export interface VerifyResult {
  valid: boolean;
  lines: number;
  /** 1-based line number of the first break, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Walk a chain and report the first break.
 *
 * Detects: an edited line (its hash no longer matches the next line's prevHash),
 * a deleted line (seq gap), and a truncated head (first prevHash is not GENESIS).
 * Does NOT detect wholesale re-signing of the entire file by someone with write
 * access -- that needs an external anchor, which this does not have and does not
 * claim to.
 */
export function verifyChain(content: string): VerifyResult {
  const lines = content.trimEnd().split('\n').filter(Boolean);
  if (lines.length === 0) return { valid: true, lines: 0 };

  let expectedPrev = GENESIS;
  let expectedSeq = 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let parsed: { seq?: number; prevHash?: string };
    try {
      parsed = JSON.parse(raw) as { seq?: number; prevHash?: string };
    } catch {
      return { valid: false, lines: lines.length, brokenAt: i + 1, reason: 'unparseable line' };
    }
    if (parsed.prevHash !== expectedPrev) {
      return {
        valid: false,
        lines: lines.length,
        brokenAt: i + 1,
        reason: `prevHash mismatch: expected ${expectedPrev.slice(0, 12)}…, got ${String(parsed.prevHash).slice(0, 12)}…`,
      };
    }
    if (parsed.seq !== expectedSeq) {
      return {
        valid: false,
        lines: lines.length,
        brokenAt: i + 1,
        reason: `seq gap: expected ${expectedSeq}, got ${parsed.seq}`,
      };
    }
    expectedPrev = sha256(raw);
    expectedSeq += 1;
  }
  return { valid: true, lines: lines.length };
}
