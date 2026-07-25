/**
 * Notification delivery — Telegram primary, ntfy secondary.
 *
 * Ported from Backbone/adapters/mcp-governance/src/tools.ts with one deliberate
 * behavioural change: **no subprocesses.**
 *
 * The original shells out to `curl` via execFile for both channels. That is fine
 * under systemd on a host that has curl, and it is a hard blocker in a container:
 * it forces a base image with a shell and curl in it, which rules out distroless
 * and widens the attack surface for a process whose entire job is two outbound
 * POSTs. Node 20+ has fetch built in, so the dependency is unnecessary.
 *
 * See docs/01-CONTAINERIZATION.md §"What changed and why".
 */

export interface DeliveryResult {
  ok: boolean;
  error?: string;
  status?: number;
  id?: string;
}

export interface NotifyConfig {
  telegramToken: string;
  telegramChat: string;
  ntfyTopic: string;
  ntfyBaseUrl: string;
  shortcutName: string;
  timeoutMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  return {
    telegramToken: env['BACKBONE_TELEGRAM_BOT_TOKEN'] || env['TELEGRAM_BOT_TOKEN'] || '',
    telegramChat: env['BACKBONE_TELEGRAM_CHAT_ID'] || env['TELEGRAM_HOME_CHANNEL'] || '',
    ntfyTopic: env['BACKBONE_NTFY_TOPIC'] || '',
    ntfyBaseUrl: env['BACKBONE_NTFY_BASE_URL'] || 'https://ntfy.sh',
    shortcutName: env['BACKBONE_NTFY_SHORTCUT_NAME'] || 'Backbone Notify Bridge',
    timeoutMs: Number(env['BACKBONE_NOTIFY_TIMEOUT_MS'] || 15000),
  };
}

/** fetch with a hard deadline. AbortSignal.timeout is Node 17.3+. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout surfaces as TimeoutError
    if (err.name === 'TimeoutError') return 'timeout';
    return err.message;
  }
  return String(err);
}

export async function sendTelegram(
  cfg: NotifyConfig,
  title: string,
  body: string,
  extra?: string,
  doFetch = fetchWithTimeout,
): Promise<DeliveryResult> {
  if (!cfg.telegramToken || !cfg.telegramChat) {
    return { ok: false, error: 'telegram not configured (token/chat missing)' };
  }
  const message = extra ? `${title}\n${body}\n${extra}` : `${title}\n${body}`;
  const params = new URLSearchParams({
    chat_id: cfg.telegramChat,
    text: message,
    disable_web_page_preview: 'true',
  });
  try {
    const res = await doFetch(
      `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      cfg.timeoutMs,
    );
    if (!res.ok) {
      return { ok: false, status: res.status, error: `telegram HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

export interface NtfyOptions {
  title: string;
  priority: string;
  tags: string;
  clickUrl?: string;
}

export async function sendNtfy(
  cfg: NotifyConfig,
  text: string,
  opts: NtfyOptions,
  doFetch = fetchWithTimeout,
): Promise<DeliveryResult> {
  if (!cfg.ntfyTopic) {
    return { ok: false, error: 'BACKBONE_NTFY_TOPIC not set' };
  }
  const headers: Record<string, string> = {
    Title: opts.title,
    Priority: opts.priority,
    Tags: opts.tags,
  };
  if (opts.clickUrl) headers['Click'] = opts.clickUrl;

  const url = `${cfg.ntfyBaseUrl.replace(/\/$/, '')}/${cfg.ntfyTopic}`;
  try {
    const res = await doFetch(url, { method: 'POST', headers, body: text }, cfg.timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `ntfy HTTP ${res.status}` };
    }
    let id: string | undefined;
    try {
      const parsed = JSON.parse(await res.text()) as { id?: unknown };
      if (typeof parsed.id === 'string') id = parsed.id;
    } catch {
      // ntfy did not return JSON — still a success if the status was 2xx
    }
    return { ok: true, status: res.status, id };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/** Deep-link that makes tapping the ntfy notification create a native Apple Reminder. */
export function shortcutClickUrl(shortcutName: string, title: string, due: string): string {
  const payload = JSON.stringify({ action: 'reminder', title, due });
  return (
    `shortcuts://run-shortcut?name=${encodeURIComponent(shortcutName)}` +
    `&input=text&text=${encodeURIComponent(payload)}`
  );
}
