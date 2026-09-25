#!/usr/bin/env node
/**
 * A local stand-in for the Vercel serverless runtime.
 *
 * Vercel's Node runtime hands each handler a request that already has `query`
 * and a parsed `body`, and a response carrying `.status()` / `.json()` helpers.
 * This reproduces exactly that contract over a plain Node HTTP server, so the
 * same `api/*.js` files run unmodified.
 *
 * Two uses:
 *   1. `node scripts/dev-api.mjs` - run the API locally against the local
 *      Supabase stack, and point the frontend at it with
 *      VITE_API_BASE=http://localhost:3001/api
 *   2. `createApiServer()` - imported by the HTTP integration suite so the
 *      handlers are tested through real sockets rather than mock objects.
 */

import http from 'node:http';

const ROUTES = {
  '/api/extract': () => import('../api/extract.js'),
  '/api/extractions': () => import('../api/extractions.js')
};

const MAX_BODY_BYTES = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Give `res` the Vercel helper shape. */
function decorate(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = payload => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
    return res;
  };
  return res;
}

export function createApiServer() {
  return http.createServer(async (req, res) => {
    decorate(res);

    const url = new URL(req.url, 'http://localhost');
    const loadRoute = ROUTES[url.pathname];

    if (!loadRoute) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Vercel exposes the query string as a plain object.
    req.query = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        const raw = await readBody(req);
        req.body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        if (e.statusCode === 413) return res.status(413).json({ error: 'Request is too large.' });
        req.body = {};
      }
    }

    try {
      const mod = await loadRoute();
      await mod.default(req, res);
    } catch (e) {
      console.error(`[dev-api] ${url.pathname} failed:`, e);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });
}

// Standalone mode.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const port = Number(process.env.PORT) || 3001;

  createApiServer().listen(port, () => {
    const configured = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
    console.log(`[dev-api] listening on http://localhost:${port}`);
    console.log(`[dev-api]   POST /api/extract`);
    console.log(`[dev-api]   GET  /api/extractions`);
    console.log(`[dev-api] shared library: ${configured ? 'configured' : 'NOT configured (no caching)'}`);
    console.log(`[dev-api] gemini key:     ${process.env.GEMINI_KEY ? 'set' : 'NOT set'}`);
    console.log('');
    console.log('Point the frontend at it with:');
    console.log(`  VITE_API_BASE=http://localhost:${port}/api npm run dev   (in ./frontend)`);
  });
}
