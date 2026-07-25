#!/usr/bin/env python3
"""
backbone-exporter — Prometheus metrics for a system that exposes none.

hermes-agent has **no `/metrics` endpoint**. Verified: `grep -rniE 'prometheus|/metrics'
--include='*.py'` over the upstream tree returns nothing (VALIDATION.md L32). That is the
largest observability gap in this project, and every gateway-level signal on the Grafana
dashboard is otherwise inferred from outside the application — pod restarts, container memory,
CronJob completion — rather than reported by it.

This service closes it by reading the state the agent already writes:

  memory_store.db   recall_log (2,725 rows), facts, entities, edges
  kanban.db         task_runs
  cron/jobs.json    the in-process scheduler's job table, with completion counts

**Recall latency is measured, not read.** `recall_log` records `ts` but no duration, so there is
no stored latency to export. Instead a synthetic prober runs a real FTS query against the live
`memory_store.db` on an interval and times it. That is a legitimate measurement and calling it a
prober — rather than implying the number came from the application — is what makes the metric
honest.

Stdlib only. No prometheus_client, no external deps: the same posture as notify-mcp, and one
less thing in the image.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATE_DIR = Path(os.environ.get("BACKBONE_STATE_DIR", "/state"))
PORT = int(os.environ.get("PORT", "9101"))
PROBE_INTERVAL = float(os.environ.get("PROBE_INTERVAL_SECONDS", "30"))
PROBE_QUERY = os.environ.get("PROBE_QUERY", "backbone")

# Seconds. Chosen around the ~37 ms median the operator's own published
# characterisation of this memory substrate reported, so the interesting part of
# the distribution is not all in one bucket.
LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5]


def _ro(db: Path) -> sqlite3.Connection:
    """Read-only handle. The gateway is a live writer on these files."""
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)


class Probe:
    """Times a real recall against the live memory store."""

    def __init__(self) -> None:
        self.buckets = [0] * len(LATENCY_BUCKETS)
        self.count = 0
        self.total = 0.0
        self.failures = 0
        self.last_error = ""
        self._lock = threading.Lock()

    def observe(self, seconds: float) -> None:
        with self._lock:
            self.count += 1
            self.total += seconds
            for i, b in enumerate(LATENCY_BUCKETS):
                if seconds <= b:
                    self.buckets[i] += 1

    def run_once(self) -> None:
        db = STATE_DIR / "memory_store.db"
        if not db.exists():
            with self._lock:
                self.failures += 1
                self.last_error = "memory_store.db missing"
            return
        try:
            started = time.perf_counter()
            conn = _ro(db)
            try:
                # Mirror what a real recall does: full-text match against the
                # facts index, ranked, top-k. Falls back to a LIKE scan if the
                # FTS table is absent, so the metric still means something.
                try:
                    conn.execute(
                        "SELECT fact_id FROM facts_fts WHERE facts_fts MATCH ? LIMIT 5",
                        (PROBE_QUERY,),
                    ).fetchall()
                except sqlite3.Error:
                    conn.execute(
                        "SELECT fact_id FROM facts WHERE content LIKE ? LIMIT 5",
                        (f"%{PROBE_QUERY}%",),
                    ).fetchall()
            finally:
                conn.close()
            self.observe(time.perf_counter() - started)
        except Exception as exc:  # noqa: BLE001 - never let the prober kill the exporter
            with self._lock:
                self.failures += 1
                self.last_error = str(exc)[:120]

    def loop(self) -> None:
        while True:
            self.run_once()
            time.sleep(PROBE_INTERVAL)


PROBE = Probe()


def _scalar(db: Path, sql: str) -> int | None:
    if not db.exists():
        return None
    try:
        conn = _ro(db)
        try:
            row = conn.execute(sql).fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return None


def _esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def collect() -> str:
    out: list[str] = []

    def metric(name: str, mtype: str, help_text: str) -> None:
        out.append(f"# HELP {name} {help_text}")
        out.append(f"# TYPE {name} {mtype}")

    mem = STATE_DIR / "memory_store.db"
    kan = STATE_DIR / "kanban.db"

    # --- memory substrate ----------------------------------------------------
    metric("backbone_memory_rows", "gauge", "Row counts in the hybrid memory store.")
    for label, sql in (
        ("facts", "SELECT count(*) FROM facts"),
        ("entities", "SELECT count(*) FROM entities"),
        ("edges", "SELECT count(*) FROM edges"),
        ("recall_events", "SELECT count(*) FROM recall_log"),
    ):
        v = _scalar(mem, sql)
        if v is not None:
            out.append(f'backbone_memory_rows{{table="{label}"}} {v}')

    # --- recall latency (MEASURED by the prober, not read from the app) ------
    metric(
        "backbone_recall_latency_seconds",
        "histogram",
        "Latency of a synthetic recall query against the live memory store. "
        "Measured by this exporter -- recall_log stores no duration.",
    )
    cumulative = 0
    with PROBE._lock:  # noqa: SLF001 - single reader, simplest correct thing here
        buckets, count, total = list(PROBE.buckets), PROBE.count, PROBE.total
        failures, last_error = PROBE.failures, PROBE.last_error
    for i, b in enumerate(LATENCY_BUCKETS):
        cumulative = buckets[i]
        out.append(f'backbone_recall_latency_seconds_bucket{{le="{b}"}} {cumulative}')
    out.append(f'backbone_recall_latency_seconds_bucket{{le="+Inf"}} {count}')
    out.append(f"backbone_recall_latency_seconds_sum {total:.6f}")
    out.append(f"backbone_recall_latency_seconds_count {count}")

    metric("backbone_recall_probe_failures_total", "counter", "Recall probes that errored.")
    out.append(f"backbone_recall_probe_failures_total {failures}")

    # --- scheduled workflows -------------------------------------------------
    # The gateway's cron scheduler runs IN-PROCESS and keeps its job table in
    # cron/jobs.json. Kubernetes CronJob metrics cannot see these at all -- they
    # are not CronJobs, they are entries in a file the gateway owns.
    jobs_file = STATE_DIR / "cron" / "jobs.json"
    metric("backbone_workflow_runs_total", "counter", "Completed runs per scheduled workflow.")
    metric_emitted = set()
    enabled_lines: list[str] = []
    last_run_lines: list[str] = []
    if jobs_file.exists():
        try:
            payload = json.loads(jobs_file.read_text())
            jobs = payload.get("jobs", payload) if isinstance(payload, dict) else payload
            for job in jobs if isinstance(jobs, list) else []:
                if not isinstance(job, dict):
                    continue
                name = _esc(str(job.get("name", "unknown")))
                completed = (job.get("repeat") or {}).get("completed")
                if isinstance(completed, int) and name not in metric_emitted:
                    out.append(f'backbone_workflow_runs_total{{job="{name}"}} {completed}')
                    metric_emitted.add(name)
                enabled_lines.append(
                    f'backbone_workflow_enabled{{job="{name}"}} {1 if job.get("enabled") else 0}'
                )
                last = job.get("last_run_at")
                if isinstance(last, str) and last:
                    try:
                        ts = time.mktime(time.strptime(last[:19], "%Y-%m-%dT%H:%M:%S"))
                        last_run_lines.append(
                            f'backbone_workflow_last_run_timestamp_seconds{{job="{name}"}} {ts:.0f}'
                        )
                    except ValueError:
                        pass
        except Exception:  # noqa: BLE001
            pass

    metric("backbone_workflow_enabled", "gauge", "1 if the scheduled workflow is enabled.")
    out.extend(enabled_lines)
    metric(
        "backbone_workflow_last_run_timestamp_seconds",
        "gauge",
        "Unix timestamp of the last run of each scheduled workflow.",
    )
    out.extend(last_run_lines)

    # --- task runs -----------------------------------------------------------
    metric("backbone_task_runs_total", "counter", "Task runs by terminal status.")
    if kan.exists():
        try:
            conn = _ro(kan)
            try:
                for status, n in conn.execute(
                    "SELECT status, count(*) FROM task_runs GROUP BY status"
                ):
                    out.append(f'backbone_task_runs_total{{status="{_esc(str(status))}"}} {n}')
            finally:
                conn.close()
        except Exception:  # noqa: BLE001
            pass

    # --- volume growth -------------------------------------------------------
    # local-path PVCs cannot be expanded online, so this needs weeks of runway.
    metric("backbone_store_bytes", "gauge", "On-disk size of each state store.")
    for db in sorted(STATE_DIR.glob("*.db")):
        out.append(f'backbone_store_bytes{{db="{_esc(db.name)}"}} {db.stat().st_size}')

    metric("backbone_exporter_up", "gauge", "1 when the exporter served this scrape.")
    out.append("backbone_exporter_up 1")
    if last_error:
        out.append(f'# last_probe_error: {_esc(last_error)}')

    return "\n".join(out) + "\n"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: str, ctype: str = "application/json") -> None:
        payload = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/healthz":
            self._send(200, json.dumps({"status": "ok"}))
        elif path == "/readyz":
            # Ready means the state directory is actually readable. An exporter
            # that cannot see the databases should leave the Service rather than
            # serve zeros that look like a healthy idle system.
            mem = STATE_DIR / "memory_store.db"
            ok = mem.exists()
            self._send(
                200 if ok else 503,
                json.dumps({"ready": ok, "state_dir": str(STATE_DIR),
                            "reason": "ok" if ok else "memory_store.db not readable"}),
            )
        elif path == "/metrics":
            self._send(200, collect(), "text/plain; version=0.0.4; charset=utf-8")
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def log_message(self, *args) -> None:  # silence per-request logging
        pass


def main() -> None:
    print(json.dumps({"svc": "backbone-exporter", "msg": "starting",
                      "state_dir": str(STATE_DIR), "port": PORT,
                      "probe_interval_s": PROBE_INTERVAL}), flush=True)
    threading.Thread(target=PROBE.loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
