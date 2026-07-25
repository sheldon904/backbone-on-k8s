/**
 * The single Backbone tool: `notify`.
 *
 * Input schema is kept byte-compatible with the stdio original so the agent's
 * prompt and any learned tool-calling behaviour carry over unchanged. Only the
 * transport and the delivery mechanism differ.
 */
import {
  configFromEnv,
  sendNtfy,
  sendTelegram,
  shortcutClickUrl,
  type NotifyConfig,
} from './notify.js';
import { metrics } from './metrics.js';

export interface BackboneTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`${field} must be a non-empty string`);
  return v;
}
function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  return v || undefined;
}

export const NOTIFY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'Lock-screen body. Keep under ~80 chars for clean display.',
    },
    title: { type: 'string', description: 'Bold line above the body. Default: "Backbone".' },
    priority: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: 'ntfy priority 1-5. 3=default, 4=actionable, 5=wake-through-DND (rare).',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        'ntfy tags (first emoji prefixes body). Examples: ["alarm_clock"], ["rotating_light"]. Default: ["robot"].',
    },
    action: {
      type: 'string',
      enum: ['reminder', 'none'],
      description:
        "If 'reminder', tap creates an Apple Reminder via the iOS Shortcut. Default: 'none' (pure ping).",
    },
    actionTitle: {
      type: 'string',
      description: 'Title for the created Reminder. Default: same as text.',
    },
    due: {
      type: 'string',
      description:
        "ISO-8601 timestamp for the Reminder alarm (include offset). Default: now+4h.",
    },
  },
  required: ['text'],
};

export function buildTools(cfg: NotifyConfig = configFromEnv()): BackboneTool[] {
  return [
    {
      name: 'notify',
      description:
        "Push a notification to the operator's phone. Delivered to Telegram (reliable background push) and ntfy. Set action='reminder' to make tapping the ntfy notification create a native Apple Reminder. Use for any actionable item or time-critical alert. Stay silent on chit-chat.",
      inputSchema: NOTIFY_INPUT_SCHEMA,
      handler: async (args) => {
        const started = Date.now();
        const text = asString(args['text'], 'text');
        const title = asOptionalString(args['title'], 'title') ?? 'Backbone';
        const priority = typeof args['priority'] === 'number' ? String(args['priority']) : '3';
        const tagsArr = Array.isArray(args['tags'])
          ? (args['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : ['robot'];
        const tags = tagsArr.join(',');

        const wantsReminder = (asOptionalString(args['action'], 'action') ?? 'none') === 'reminder';
        const due = wantsReminder
          ? (asOptionalString(args['due'], 'due') ??
             new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString())
          : undefined;

        const clickUrl =
          wantsReminder && due
            ? shortcutClickUrl(
                cfg.shortcutName,
                asOptionalString(args['actionTitle'], 'actionTitle') ?? text,
                due,
              )
            : undefined;

        // Both channels are attempted; neither blocks the other. The original
        // awaited them in series, which meant a Telegram timeout delayed ntfy by
        // the full 15s. In a pod with a readiness probe that is the difference
        // between "slow" and "restarted".
        const [telegram, ntfy] = await Promise.all([
          sendTelegram(cfg, title, text, wantsReminder && due ? `Reminder due ${due}` : undefined),
          sendNtfy(cfg, text, { title, priority, tags, ...(clickUrl ? { clickUrl } : {}) }),
        ]);

        metrics.observeNotify({
          telegramOk: telegram.ok,
          ntfyOk: ntfy.ok,
          durationMs: Date.now() - started,
        });

        return {
          ok: telegram.ok || ntfy.ok,
          delivered: { telegram: telegram.ok, ntfy: ntfy.ok },
          telegram,
          ntfy,
          actionKind: wantsReminder ? 'reminder' : 'none',
          textLength: text.length,
          hasClickUrl: Boolean(clickUrl),
        };
      },
    },
  ];
}
