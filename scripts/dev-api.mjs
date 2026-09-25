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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load local development credentials from a git-ignored file, so keys never
 * have to be exported by hand or typed into a shell (where they would land in
 * history). Existing environment variables always win, so CI and the hosted
 * runtime are unaffected. Values are never logged.
 */
function loadLocalEnv(file = path.join(ROOT, '.env.development.local')) {
  if (!fs.existsSync(file)) return [];

  const loaded = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const i = trimmed.indexOf('=');
    if (i <= 0) continue;

    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env) && value) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

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

// Standalone mode. pathToFileURL is used rather than hand-building a file://
// string: on Windows the manual form drops a slash (file://C:/... instead of
// file:///C:/...), so the comparison never matches and the server exits
// immediately without listening.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const loaded = loadLocalEnv();
  const port = Number(process.env.PORT) || 3001;

  createApiServer().listen(port, () => {
    const configured = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
    console.log(`[dev-api] listening on http://localhost:${port}`);
    console.log(`[dev-api]   POST /api/extract`);
    console.log(`[dev-api]   GET  /api/extractions`);
    // Only variable NAMES are printed, never values.
    console.log(`[dev-api] .env.development.local: ${loaded.length ? loaded.join(', ') : 'not found / nothing new'}`);
    console.log(`[dev-api] shared library: ${configured ? 'configured' : 'NOT configured (no caching)'}`);
    console.log(`[dev-api] gemini key:     ${process.env.GEMINI_KEY ? 'set' : 'NOT set'}`);
    console.log(`[dev-api] supadata key:   ${process.env.SUPADATA_KEY ? 'set' : 'NOT set'}`);
    console.log('');
    console.log('Point the frontend at it with:');
    console.log(`  VITE_API_BASE=http://localhost:${port}/api npm run dev   (in ./frontend)`);
  });
}
