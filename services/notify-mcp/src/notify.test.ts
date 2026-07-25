/**
 * Tests for the delivery layer. No network: a fake fetch is injected.
 *
 * These exist because the port from curl-subprocess to fetch changed the error
 * surface. execFile rejects on non-zero exit (curl -f turns HTTP 4xx/5xx into a
 * non-zero exit); fetch resolves on 4xx/5xx and only rejects on transport
 * failure. Getting that wrong would silently report failed deliveries as ok.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configFromEnv,
  sendNtfy,
  sendTelegram,
  shortcutClickUrl,
  type NotifyConfig,
} from './notify.js';

const cfg: NotifyConfig = {
  telegramToken: 'tok',
  telegramChat: '123',
  ntfyTopic: 'topic',
  ntfyBaseUrl: 'https://ntfy.example',
  shortcutName: 'Backbone Notify Bridge',
  timeoutMs: 1000,
};

function fakeFetch(status: number, body = '') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
  return { fn, calls };
}

test('configFromEnv prefers BACKBONE_-prefixed vars, falls back to Hermes vars', () => {
  const a = configFromEnv({ TELEGRAM_BOT_TOKEN: 'hermes', TELEGRAM_HOME_CHANNEL: 'chan' });
  assert.equal(a.telegramToken, 'hermes');
  assert.equal(a.telegramChat, 'chan');

  const b = configFromEnv({
    TELEGRAM_BOT_TOKEN: 'hermes',
    BACKBONE_TELEGRAM_BOT_TOKEN: 'backbone',
  });
  assert.equal(b.telegramToken, 'backbone');
});

test('configFromEnv defaults ntfy base url to ntfy.sh', () => {
  assert.equal(configFromEnv({}).ntfyBaseUrl, 'https://ntfy.sh');
});

test('telegram: unconfigured is a clean failure, not a throw', async () => {
  const res = await sendTelegram({ ...cfg, telegramToken: '' }, 'T', 'B');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not configured/);
});

test('telegram: 200 is ok and the body is form-encoded', async () => {
  const { fn, calls } = fakeFetch(200);
  const res = await sendTelegram(cfg, 'Title', 'Body', 'extra', fn as never);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/api\.telegram\.org\/bottok\/sendMessage$/);
  const body = String(calls[0]!.init.body);
  assert.match(body, /chat_id=123/);
  // title, body and extra are newline-joined
  assert.match(decodeURIComponent(body), /Title\nBody\nextra/);
});

test('telegram: HTTP 429 is a failure, not a success', async () => {
  // The regression this guards: fetch resolves on 4xx, so `if (res.ok)` is
  // required. curl -f used to make this a rejection for free.
  const { fn } = fakeFetch(429);
  const res = await sendTelegram(cfg, 'T', 'B', undefined, fn as never);
  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
});

test('telegram: transport error is caught', async () => {
  const boom = async () => {
    throw new Error('ECONNREFUSED');
  };
  const res = await sendTelegram(cfg, 'T', 'B', undefined, boom as never);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ECONNREFUSED');
});

test('telegram: timeout is reported as "timeout"', async () => {
  const boom = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const res = await sendTelegram(cfg, 'T', 'B', undefined, boom as never);
  assert.equal(res.error, 'timeout');
});

test('ntfy: headers carry title, priority and tags; body is the text', async () => {
  const { fn, calls } = fakeFetch(200, '{"id":"abc123"}');
  const res = await sendNtfy(cfg, 'hello', { title: 'T', priority: '4', tags: 'robot' }, fn as never);
  assert.equal(res.ok, true);
  assert.equal(res.id, 'abc123');
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h['Title'], 'T');
  assert.equal(h['Priority'], '4');
  assert.equal(h['Tags'], 'robot');
  assert.equal(calls[0]!.init.body, 'hello');
  assert.equal(calls[0]!.url, 'https://ntfy.example/topic');
});

test('ntfy: non-JSON 200 is still a success', async () => {
  const { fn } = fakeFetch(200, 'plain text');
  const res = await sendNtfy(cfg, 'x', { title: 'T', priority: '3', tags: 'robot' }, fn as never);
  assert.equal(res.ok, true);
  assert.equal(res.id, undefined);
});

test('ntfy: trailing slash on base url does not double up', async () => {
  const { fn, calls } = fakeFetch(200);
  await sendNtfy(
    { ...cfg, ntfyBaseUrl: 'https://ntfy.example/' },
    'x',
    { title: 'T', priority: '3', tags: 'robot' },
    fn as never,
  );
  assert.equal(calls[0]!.url, 'https://ntfy.example/topic');
});

test('ntfy: missing topic is a clean failure', async () => {
  const res = await sendNtfy({ ...cfg, ntfyTopic: '' }, 'x', {
    title: 'T',
    priority: '3',
    tags: 'robot',
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /BACKBONE_NTFY_TOPIC/);
});

test('ntfy: Click header only present when a reminder is requested', async () => {
  const { fn, calls } = fakeFetch(200);
  await sendNtfy(cfg, 'x', { title: 'T', priority: '3', tags: 'robot' }, fn as never);
  assert.equal((calls[0]!.init.headers as Record<string, string>)['Click'], undefined);
});

test('shortcutClickUrl round-trips the reminder payload', () => {
  const url = shortcutClickUrl('Backbone Notify Bridge', 'Buy milk', '2026-07-26T12:00:00Z');
  assert.match(url, /^shortcuts:\/\/run-shortcut\?name=Backbone%20Notify%20Bridge/);
  const text = new URL(url.replace('shortcuts://', 'https://')).searchParams.get('text');
  assert.deepEqual(JSON.parse(text ?? '{}'), {
    action: 'reminder',
    title: 'Buy milk',
    due: '2026-07-26T12:00:00Z',
  });
});
