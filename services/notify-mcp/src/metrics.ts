/**
 * Prometheus exposition without a client library.
 *
 * Four counters and one histogram do not justify a dependency, and a smaller
 * dependency tree is a smaller image and a shorter CVE list. Format is the
 * Prometheus text exposition format v0.0.4.
 *
 * Metric names are chosen to answer the questions in docs/05-OBSERVABILITY.md.
 */

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 15000];

class Metrics {
  private notifyTotal = 0;
  private notifyFailedTotal = 0;
  private channelOk: Record<string, number> = { telegram: 0, ntfy: 0 };
  private channelFail: Record<string, number> = { telegram: 0, ntfy: 0 };
  private latencyBuckets = new Array<number>(LATENCY_BUCKETS_MS.length).fill(0);
  private latencyCount = 0;
  private latencySum = 0;
  private toolErrorsTotal = 0;
  private readonly startedAt = Date.now();

  observeNotify(o: { telegramOk: boolean; ntfyOk: boolean; durationMs: number }): void {
    this.notifyTotal += 1;
    if (!o.telegramOk && !o.ntfyOk) this.notifyFailedTotal += 1;
    if (o.telegramOk) this.channelOk['telegram'] = (this.channelOk['telegram'] ?? 0) + 1;
    else this.channelFail['telegram'] = (this.channelFail['telegram'] ?? 0) + 1;
    if (o.ntfyOk) this.channelOk['ntfy'] = (this.channelOk['ntfy'] ?? 0) + 1;
    else this.channelFail['ntfy'] = (this.channelFail['ntfy'] ?? 0) + 1;

    this.latencyCount += 1;
    this.latencySum += o.durationMs;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      const bound = LATENCY_BUCKETS_MS[i];
      if (bound !== undefined && o.durationMs <= bound) this.latencyBuckets[i]! += 1;
    }
  }

  observeToolError(): void {
    this.toolErrorsTotal += 1;
  }

  render(): string {
    const out: string[] = [];
    out.push('# HELP backbone_notify_total Notifications attempted.');
    out.push('# TYPE backbone_notify_total counter');
    out.push(`backbone_notify_total ${this.notifyTotal}`);

    out.push('# HELP backbone_notify_failed_total Notifications where every channel failed.');
    out.push('# TYPE backbone_notify_failed_total counter');
    out.push(`backbone_notify_failed_total ${this.notifyFailedTotal}`);

    out.push('# HELP backbone_notify_channel_total Per-channel delivery outcomes.');
    out.push('# TYPE backbone_notify_channel_total counter');
    for (const ch of ['telegram', 'ntfy']) {
      out.push(`backbone_notify_channel_total{channel="${ch}",outcome="ok"} ${this.channelOk[ch] ?? 0}`);
      out.push(`backbone_notify_channel_total{channel="${ch}",outcome="fail"} ${this.channelFail[ch] ?? 0}`);
    }

    out.push('# HELP backbone_tool_errors_total MCP tool invocations that raised.');
    out.push('# TYPE backbone_tool_errors_total counter');
    out.push(`backbone_tool_errors_total ${this.toolErrorsTotal}`);

    out.push('# HELP backbone_notify_duration_ms Notification fan-out latency.');
    out.push('# TYPE backbone_notify_duration_ms histogram');
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      cumulative = this.latencyBuckets[i] ?? 0;
      out.push(`backbone_notify_duration_ms_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${cumulative}`);
    }
    out.push(`backbone_notify_duration_ms_bucket{le="+Inf"} ${this.latencyCount}`);
    out.push(`backbone_notify_duration_ms_sum ${this.latencySum}`);
    out.push(`backbone_notify_duration_ms_count ${this.latencyCount}`);

    out.push('# HELP backbone_uptime_seconds Process uptime.');
    out.push('# TYPE backbone_uptime_seconds gauge');
    out.push(`backbone_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);

    return out.join('\n') + '\n';
  }
}

export const metrics = new Metrics();
