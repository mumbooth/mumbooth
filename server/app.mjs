// Fastify app. Logging: one line per request with the route PATTERN, status and duration. Never ip, headers, body, ids.
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController } from 'fastify';
import { ApiError } from './util.mjs';
import { issue, holdClaim } from './issue.mjs';
import { chat } from './chat.mjs';
import { status, proof } from './stats.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

export async function buildApp(ctx, { logStream } = {}) {
  const { config } = ctx;
  const loggerOpts = logStream ? { level: config.logLevel, stream: logStream } : { level: config.logLevel };
  const app = Fastify({
    logger: loggerOpts, logController: new LogController({ disableRequestLogging: true }), trustProxy: config.trustProxy, bodyLimit: 512_000,
    genReqId: () => '-', routerOptions: { ignoreTrailingSlash: true },
  });
  ctx.logEvent = (event, fields = {}) => app.log.info({ event, ...fields }, event);
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (req, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.addHook('onResponse', async (req, reply) => {
    app.log.info({ method: req.method, route: req.routeOptions?.url ?? '(unmatched)', status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'req');
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(err.toBody());
    if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'bad_request', message: 'Request body is too large.' });
    if (err.statusCode >= 400 && err.statusCode < 500) return reply.code(400).send({ error: 'bad_request', message: 'Malformed request.' });
    app.log.error({ errName: err?.name, errCode: err?.code }, 'unhandled'); // never the message: it may echo request data
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our side.' });
  });
  app.setNotFoundHandler((req, reply) => {
    if (config.serveWeb && req.method === 'GET' && !req.url.startsWith('/api/')) return serveWeb(req, reply);
    reply.code(404).send({ error: 'not_found', message: 'Not found.' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/status', async (req, reply) => { reply.header('Cache-Control', 'public, max-age=15'); return status(ctx); });
  app.get('/api/keys', async () => ({ current: ctx.keys.current, keys: ctx.keys.publicList() }));
  app.get('/api/proof', async () => proof(ctx));
  app.post('/api/issue', async (req) => issue(ctx, req.body));
  app.post('/api/hold/claim', async (req) => holdClaim(ctx, req.body));
  app.post('/api/chat', (req, reply) => chat(ctx, req, reply));

  // ---- local dev only (SERVE_WEB=1): serve ../web with clean URLs, like nginx does in production
  async function serveWeb(req, reply) {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch { return reply.code(404).send({ error: 'not_found', message: 'Not found.' }); }
    if (p.endsWith('/')) p += 'index.html';
    else if (!path.extname(p)) p += '/index.html';
    const file = path.join(config.webDir, path.normalize(p));
    if (!file.startsWith(config.webDir + path.sep)) return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    try {
      const buf = await fs.promises.readFile(file);
      return reply.header('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream').send(buf);
    } catch { return reply.code(404).send({ error: 'not_found', message: 'Not found.' }); }
  }
  return app;
}
