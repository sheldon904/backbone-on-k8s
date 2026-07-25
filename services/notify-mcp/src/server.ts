#!/usr/bin/env node
/**
 * Backbone notify MCP — Streamable HTTP transport.
 *
 * The original (Backbone/adapters/mcp-governance) speaks stdio and is forked by
 * the Hermes gateway. A stdio MCP server cannot be a sidecar: the parent forks it
 * and speaks over inherited file descriptors, and a sidecar container has its own
 * process namespace. So under Kubernetes there are exactly two options —
 *
 *   (a) bake the Node binary into the gateway image and keep forking it, or
 *   (b) give it a network transport and make it a real Service.
 *
 * This is (b). Rationale and the cost of (a) are in docs/01-CONTAINERIZATION.md.
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp   MCP Streamable HTTP (stateless)
 *   GET  /healthz          liveness  — process is up
 *   GET  /readyz           readiness — config is complete enough to deliver
 *   GET  /metrics          Prometheus text exposition
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { buildTools, type BackboneTool } from './tools.js';
import { configFromEnv } from './notify.js';
import { metrics } from './metrics.js';

const PORT = Number(process.env['PORT'] || 8080);
const HOST = process.env['HOST'] || '0.0.0.0';
const SHUTDOWN_GRACE_MS = Number(process.env['SHUTDOWN_GRACE_MS'] || 10000);

/** Structured logs: one JSON object per line, for Loki/journald ingestion. */
function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, svc: 'notify-mcp', msg, ...extra }) + '\n',
  );
}

export function createMcpServer(tools: BackboneTool[]): Server {
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: 'backbone', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolByName.get(req.params.name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
    try {
      const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      metrics.observeToolError();
      log('error', 'tool failed', { tool: req.params.name, error: message });
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: message, tool: req.params.name }) }],
      };
    }
  });

  return server;
}

/**
 * Readiness is not "the process started". It is "a request would succeed".
 * With neither channel configured, every notify call fails, so the pod should
 * not receive traffic — that is a config error worth surfacing as NotReady
 * rather than as a hundred 200-OK responses containing {ok:false}.
 */
export function readiness(cfg = configFromEnv()): { ready: boolean; reason: string } {
  const telegram = Boolean(cfg.telegramToken && cfg.telegramChat);
  const ntfy = Boolean(cfg.ntfyTopic);
  if (!telegram && !ntfy) {
    return { ready: false, reason: 'no delivery channel configured (telegram and ntfy both unset)' };
  }
  return { ready: true, reason: telegram && ntfy ? 'both channels' : telegram ? 'telegram only' : 'ntfy only' };
}

function send(res: ServerResponse, status: number, body: string, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * One MCP Server + transport per request.
 *
 * Cost: object allocation per call. Benefit: zero cross-request state, so the
 * Deployment scales horizontally with no session affinity on the Ingress, and a
 * crash in one request cannot corrupt another.
 */
async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  tools: BackboneTool[],
): Promise<void> {
  const server = createMcpServer(tools);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    log('error', 'transport error', { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'internal' }));
  }
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const tools = buildTools(cfg);
  log('info', 'starting', {
    port: PORT,
    tools: tools.map((t) => t.name),
    // Never log secret values. Presence only.
    channels: { telegram: Boolean(cfg.telegramToken && cfg.telegramChat), ntfy: Boolean(cfg.ntfyTopic) },
  });


  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/healthz') return send(res, 200, JSON.stringify({ status: 'ok' }));

    if (url === '/readyz') {
      const r = readiness(cfg);
      return send(res, r.ready ? 200 : 503, JSON.stringify(r));
    }

    if (url === '/metrics') {
      return send(res, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
    }

    if (url === '/mcp') {
      // A fresh Server + transport per request. Stateless mode keeps no session,
      // so a shared transport instance ends up bound to an already-closed
      // response stream on the second request -- see docs/OPERATIONS.md,
      // 2026-07-25 "tools/list returns HTTP 500".
      void handleMcp(req, res, tools);
      return;
    }

    send(res, 404, JSON.stringify({ error: 'not found' }));
  });

  http.listen(PORT, HOST, () => log('info', 'listening', { host: HOST, port: PORT }));

  // SIGTERM is what kubelet sends first. Stop accepting, let in-flight finish,
  // then exit. Without this the pod dies mid-notification on every rollout.
  const shutdown = (signal: string) => {
    log('info', 'shutting down', { signal, graceMs: SHUTDOWN_GRACE_MS });
    const timer = setTimeout(() => {
      log('warn', 'grace period expired, forcing exit');
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    http.close(() => {
      log('info', 'closed cleanly');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only run when executed directly, so the module can be imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch((e) => {
    log('error', 'fatal', { error: e instanceof Error ? e.stack : String(e) });
    process.exit(1);
  });
}
