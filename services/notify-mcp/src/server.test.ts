/**
 * Tests for the pod-facing behaviour: readiness semantics, the tool contract,
 * and the metrics exposition format.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness, createMcpServer } from './server.js';
import { buildTools, NOTIFY_INPUT_SCHEMA } from './tools.js';
import { metrics } from './metrics.js';
import { configFromEnv } from './notify.js';

test('readyz is 503 when no delivery channel is configured', () => {
  const r = readiness(configFromEnv({}));
  assert.equal(r.ready, false);
  assert.match(r.reason, /no delivery channel/);
});

test('readyz is ok with telegram only', () => {
  const r = readiness(configFromEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_HOME_CHANNEL: 'c' }));
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'telegram only');
});

test('readyz is ok with ntfy only', () => {
  const r = readiness(configFromEnv({ BACKBONE_NTFY_TOPIC: 'topic' }));
  assert.equal(r.ready, true);
  assert.equal(r.reason, 'ntfy only');
});

test('a half-configured telegram (token but no chat) does not count as a channel', () => {
  const r = readiness(configFromEnv({ TELEGRAM_BOT_TOKEN: 't' }));
  assert.equal(r.ready, false);
});

test('tool contract is unchanged from the stdio original', () => {
  const tools = buildTools(configFromEnv({}));
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, 'notify');
  // The agent-visible schema must not drift: prompts and learned tool-calling
  // behaviour were built against these exact fields.
  const props = (NOTIFY_INPUT_SCHEMA as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(props).sort(), [
    'action',
    'actionTitle',
    'due',
    'priority',
    'tags',
    'text',
    'title',
  ]);
  assert.deepEqual((NOTIFY_INPUT_SCHEMA as { required: string[] }).required, ['text']);
});

test('mcp server constructs and registers the tool handlers', async () => {
  const server = createMcpServer(buildTools(configFromEnv({})));
  assert.ok(server);
});

test('notify with no channels configured returns ok:false rather than throwing', async () => {
  const tools = buildTools(configFromEnv({}));
  const result = (await tools[0]!.handler({ text: 'hello' })) as {
    ok: boolean;
    delivered: { telegram: boolean; ntfy: boolean };
  };
  assert.equal(result.ok, false);
  assert.equal(result.delivered.telegram, false);
  assert.equal(result.delivered.ntfy, false);
});

test('notify rejects a missing text argument', async () => {
  const tools = buildTools(configFromEnv({}));
  await assert.rejects(() => tools[0]!.handler({}), /text must be a non-empty string/);
});

test('metrics render in Prometheus text exposition format', () => {
  metrics.observeNotify({ telegramOk: true, ntfyOk: false, durationMs: 120 });
  const out = metrics.render();
  assert.match(out, /^# HELP backbone_notify_total /m);
  assert.match(out, /^# TYPE backbone_notify_total counter$/m);
  assert.match(out, /^backbone_notify_total \d+$/m);
  assert.match(out, /backbone_notify_channel_total\{channel="telegram",outcome="ok"\} \d+/);
  assert.match(out, /backbone_notify_duration_ms_bucket\{le="\+Inf"\} \d+/);
  assert.match(out, /^backbone_notify_duration_ms_count \d+$/m);
  // Every non-comment line must be `name value` or `name{labels} value`.
  for (const line of out.trim().split('\n')) {
    if (line.startsWith('#')) continue;
    assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[\d.]+$/, `bad exposition line: ${line}`);
  }
});
