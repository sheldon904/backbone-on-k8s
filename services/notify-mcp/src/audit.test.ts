/**
 * Chain tests. The point of a hash chain is that tampering is detectable, so
 * most of these tamper with a file and assert the break is found at the right
 * line -- a chain that only passes on untouched input proves nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, verifyChain, GENESIS } from './audit.js';

function tmpPath(name = 'audit.jsonl'): string {
  return join(mkdtempSync(join(tmpdir(), 'bb-audit-')), name);
}

test('first line chains from GENESIS with seq 1', () => {
  const p = tmpPath();
  const log = new AuditLog(p);
  const line = log.append({ category: 'execute', payload: { tool: 'notify', ok: true } });
  assert.equal(line?.seq, 1);
  assert.equal(line?.prevHash, GENESIS);
  assert.equal(line?.source, 'notify-mcp');
  assert.equal(verifyChain(readFileSync(p, 'utf-8')).valid, true);
});

test('payload fields are merged onto the envelope', () => {
  const p = tmpPath();
  const line = new AuditLog(p).append({
    category: 'execute',
    domain: 'personal',
    payload: { tool: 'notify', ok: true, channels: { telegram: true, ntfy: false }, durationMs: 142 },
  });
  assert.equal(line?.['tool'], 'notify');
  assert.equal(line?.['durationMs'], 142);
  assert.equal(line?.domain, 'personal');
  assert.deepEqual(line?.['channels'], { telegram: true, ntfy: false });
});

test('a clean chain of 50 lines verifies', () => {
  const p = tmpPath();
  const log = new AuditLog(p);
  for (let i = 0; i < 50; i++) log.append({ category: 'execute', payload: { n: i } });
  const r = verifyChain(readFileSync(p, 'utf-8'));
  assert.equal(r.valid, true);
  assert.equal(r.lines, 50);
});

test('EDITING a line in the middle is detected at the NEXT line', () => {
  const p = tmpPath();
  const log = new AuditLog(p);
  for (let i = 0; i < 5; i++) log.append({ category: 'execute', payload: { n: i } });

  const lines = readFileSync(p, 'utf-8').trimEnd().split('\n');
  const doctored = JSON.parse(lines[2]!) as Record<string, unknown>;
  doctored['ok'] = 'tampered';
  lines[2] = JSON.stringify(doctored);
  writeFileSync(p, lines.join('\n') + '\n');

  const r = verifyChain(readFileSync(p, 'utf-8'));
  assert.equal(r.valid, false);
  // Line 3 was edited, so line 4's prevHash no longer matches.
  assert.equal(r.brokenAt, 4);
  assert.match(r.reason ?? '', /prevHash mismatch/);
});

test('DELETING a line is detected', () => {
  const p = tmpPath();
  const log = new AuditLog(p);
  for (let i = 0; i < 5; i++) log.append({ category: 'execute', payload: { n: i } });

  const lines = readFileSync(p, 'utf-8').trimEnd().split('\n');
  lines.splice(2, 1);
  writeFileSync(p, lines.join('\n') + '\n');

  const r = verifyChain(readFileSync(p, 'utf-8'));
  assert.equal(r.valid, false);
  assert.equal(r.brokenAt, 3);
});

test('TRUNCATING the head is detected — first prevHash is not GENESIS', () => {
  const p = tmpPath();
  const log = new AuditLog(p);
  for (let i = 0; i < 5; i++) log.append({ category: 'execute', payload: { n: i } });

  const lines = readFileSync(p, 'utf-8').trimEnd().split('\n');
  writeFileSync(p, lines.slice(2).join('\n') + '\n');

  const r = verifyChain(readFileSync(p, 'utf-8'));
  assert.equal(r.valid, false);
  assert.equal(r.brokenAt, 1);
});

test('truncating the TAIL stays valid — that is the honest limit of a chain', () => {
  // A chain proves nothing was altered or removed from the middle. It cannot
  // prove nothing was removed from the end; that needs an external anchor.
  // Asserted so the limitation is documented in executable form.
  const p = tmpPath();
  const log = new AuditLog(p);
  for (let i = 0; i < 5; i++) log.append({ category: 'execute', payload: { n: i } });

  const lines = readFileSync(p, 'utf-8').trimEnd().split('\n');
  writeFileSync(p, lines.slice(0, 3).join('\n') + '\n');

  assert.equal(verifyChain(readFileSync(p, 'utf-8')).valid, true);
});

test('a restart RESUMES the chain instead of restarting it', () => {
  const p = tmpPath();
  const first = new AuditLog(p);
  first.append({ category: 'execute', payload: { n: 1 } });
  first.append({ category: 'execute', payload: { n: 2 } });

  // Simulate a pod restart: brand new instance, same file.
  const second = new AuditLog(p);
  const line = second.append({ category: 'execute', payload: { n: 3 } });

  assert.equal(line?.seq, 3, 'seq must continue, not reset');
  assert.equal(verifyChain(readFileSync(p, 'utf-8')).valid, true);
});

test('two replicas write independent files and both verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-audit-'));
  const a = new AuditLog(join(dir, 'audit-pod-a.jsonl'));
  const b = new AuditLog(join(dir, 'audit-pod-b.jsonl'));
  for (let i = 0; i < 3; i++) {
    a.append({ category: 'execute', payload: { pod: 'a', n: i } });
    b.append({ category: 'execute', payload: { pod: 'b', n: i } });
  }
  assert.equal(verifyChain(readFileSync(a.filePath, 'utf-8')).valid, true);
  assert.equal(verifyChain(readFileSync(b.filePath, 'utf-8')).valid, true);
});

test('an empty file is a valid (empty) chain', () => {
  assert.deepEqual(verifyChain(''), { valid: true, lines: 0 });
});

test('an unwritable path degrades to null, never throws, and never spins', () => {
  // Regression guard. The first version of this test pointed at
  // /proc/<nonexistent>/ and HUNG -- mkdirSync(recursive) spins on procfs
  // rather than throwing. That hang was in the production init path too.
  // See docs/OPERATIONS.md 2026-07-25.
  const dir = mkdtempSync(join(tmpdir(), 'bb-audit-ro-'));
  chmodSync(dir, 0o500); // r-x: cannot create files
  try {
    const started = Date.now();
    const log = new AuditLog(join(dir, 'nested', 'audit.jsonl'));
    assert.equal(log.append({ category: 'execute' }), null);
    // A second call must not retry -- the latch makes it free.
    assert.equal(log.append({ category: 'execute' }), null);
    assert.ok(Date.now() - started < 2000, 'init must fail fast, not spin');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('procfs specifically does not hang', () => {
  const started = Date.now();
  const log = new AuditLog('/proc/definitely-not-writable/audit.jsonl');
  assert.equal(log.append({ category: 'execute' }), null);
  assert.ok(Date.now() - started < 2000, 'must not spin on procfs');
});

test('schema stays compatible with the pre-teardown archive', () => {
  // The frozen governance-audit.jsonl carries ts/category/source/domain plus
  // free-form payload. New readers must be able to parse old lines.
  const p = tmpPath();
  const line = new AuditLog(p).append({
    category: 'execute',
    source: 'executor',
    domain: 'personal',
    payload: { proposalId: 'PROP-X', operatorId: 'gate@hermes', ok: true, state: 'executed' },
  });
  for (const k of ['ts', 'category', 'source', 'domain']) {
    assert.ok(k in (line as Record<string, unknown>), `missing ${k}`);
  }
  assert.equal(line?.['state'], 'executed');
});
