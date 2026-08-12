'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OidcAuth } = require('./auth');

const CONFIG = {
  coolifyUrl: (process.env.COOLIFY_URL || 'https://coolify.edgestudios.co.za').replace(/\/+$/, ''),
  token: process.env.COOLIFY_TOKEN || '',
  port: Number(process.env.PORT || 3000),
  refreshMs: Number(process.env.REFRESH_MS || 60000),
  passcode: process.env.PASSCODE || '',
  title: process.env.TITLE || 'EdgeStudios',
  // Comma-separated resource names to leave off the page.
  hidden: (process.env.HIDE || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  oidc: {
    issuer: process.env.OIDC_ISSUER || 'https://id.edgestudios.co.za',
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    baseUrl: process.env.BASE_URL || '',
    allowedGroups: (process.env.OIDC_ALLOWED_GROUPS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
};

// Pocket-ID if it is configured, else the passcode, else open. Declaring the
// mode once here keeps every later decision a single comparison.
const oidc =
  CONFIG.oidc.clientId && CONFIG.oidc.clientSecret && CONFIG.oidc.baseUrl
    ? new OidcAuth(CONFIG.oidc)
    : null;
const AUTH_MODE = oidc ? 'oidc' : process.env.PASSCODE ? 'passcode' : 'open';

// ---------------------------------------------------------------------------
// Coolify polling
//
// The shape of Coolify's API responses varies by resource type and drifts
// between releases, so rather than reaching for fixed paths we walk each
// object and collect every `fqdn` we find. Applications carry theirs at the
// top level; services hang them off nested service_applications entries.
// ---------------------------------------------------------------------------

let cache = { apps: [], fetchedAt: null, stale: true, error: null };

function collectFqdns(node, found, depth = 0) {
  if (!node || depth > 6) return found;
  if (Array.isArray(node)) {
    for (const item of node) collectFqdns(item, found, depth + 1);
    return found;
  }
  if (typeof node !== 'object') return found;

  if (typeof node.fqdn === 'string' && node.fqdn.trim()) {
    for (const part of node.fqdn.split(',')) {
      const url = part.trim();
      if (/^https?:\/\//i.test(url)) found.add(url.replace(/\/+$/, ''));
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'fqdn') continue;
    if (value && typeof value === 'object') collectFqdns(value, found, depth + 1);
  }
  return found;
}

// Coolify reports things like "running:healthy", "exited:unhealthy",
// "degraded". Only the part before the colon tells us whether it is up.
function normaliseStatus(raw) {
  const status = String(raw || '').toLowerCase();
  if (!status) return 'unknown';
  if (status.startsWith('running')) {
    return status.includes('unhealthy') ? 'degraded' : 'running';
  }
  if (status.startsWith('degraded') || status.startsWith('restarting')) return 'degraded';
  if (status.startsWith('exited') || status.startsWith('stopped')) return 'stopped';
  return 'unknown';
}

async function coolifyGet(endpoint) {
  const res = await fetch(`${CONFIG.coolifyUrl}/api/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${CONFIG.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET ${endpoint} -> HTTP ${res.status}`);
  const body = await res.json();
  // Some endpoints return a bare array, others wrap it in { data: [...] }.
  return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
}

// Projects give us human-readable grouping. It is a nice-to-have: if the call
// fails we still render, just without project names.
async function buildProjectIndex() {
  const index = new Map();
  try {
    const projects = await coolifyGet('projects');
    for (const project of projects) {
      for (const env of project.environments || []) {
        if (env?.id != null) index.set(String(env.id), project.name);
      }
    }
  } catch {
    // Non-fatal — grouping falls back to "Apps".
  }
  return index;
}

function toEntries(resources, kind, projectIndex) {
  const entries = [];
  for (const resource of resources) {
    const name = resource.name || resource.uuid || 'unnamed';
    if (CONFIG.hidden.includes(name.toLowerCase())) continue;

    const urls = [...collectFqdns(resource, new Set())];
    // A resource with no FQDN has nothing to launch — databases, workers and
    // half-configured apps all land here.
    if (urls.length === 0) continue;

    urls.sort((a, b) => (a.startsWith('https') === b.startsWith('https') ? 0 : a.startsWith('https') ? -1 : 1));

    entries.push({
      id: resource.uuid || `${kind}-${name}`,
      name,
      kind,
      description: resource.description || '',
      status: normaliseStatus(resource.status),
      url: urls[0],
      extraUrls: urls.slice(1),
      project: projectIndex.get(String(resource.environment_id)) || 'Apps',
    });
  }
  return entries;
}

async function refresh() {
  if (!CONFIG.token) {
    cache = { apps: [], fetchedAt: new Date().toISOString(), stale: true, error: 'COOLIFY_TOKEN is not set' };
    return;
  }
  try {
    const projectIndex = await buildProjectIndex();
    // One endpoint failing is survivable — report it only if both do, and
    // report why rather than reducing every cause to "nothing came back".
    const [applications, services] = await Promise.all([
      coolifyGet('applications').catch((err) => err),
      coolifyGet('services').catch((err) => err),
    ]);

    if (applications instanceof Error && services instanceof Error) {
      throw new Error(`applications: ${applications.message}; services: ${services.message}`);
    }

    const apps = [
      ...toEntries(applications instanceof Error ? [] : applications, 'application', projectIndex),
      ...toEntries(services instanceof Error ? [] : services, 'service', projectIndex),
    ].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));

    cache = { apps, fetchedAt: new Date().toISOString(), stale: false, error: null };
    console.log(`[launcher] refreshed: ${apps.length} launchable resources`);
  } catch (err) {
    // Keep serving the last good list; just mark it stale so the page can say so.
    cache = { ...cache, stale: true, error: String(err.message || err), fetchedAt: cache.fetchedAt };
    console.error(`[launcher] refresh failed: ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Optional passcode gate
//
// This page is an index of every internal service, and the wildcard on
// edgestudios.co.za makes any hostname publicly resolvable. Setting PASSCODE
// keeps it from being world-readable. Leaving it unset serves the page openly.
// ---------------------------------------------------------------------------

const passHash = CONFIG.passcode
  ? crypto.createHash('sha256').update(CONFIG.passcode).digest('hex')
  : null;

function isAuthed(req) {
  if (AUTH_MODE === 'oidc') return Boolean(oidc.sessionFrom(req));
  if (!passHash) return true;
  const cookie = req.headers.cookie || '';
  const match = /(?:^|;\s*)el_auth=([a-f0-9]{64})/.exec(cookie);
  if (!match) return false;
  const given = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(passHash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee;
font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
form{display:flex;flex-direction:column;gap:12px;width:min(320px,90vw)}
h1{font-size:18px;margin:0 0 4px;font-weight:650}
input{padding:12px 14px;border-radius:10px;border:1px solid #2a2f3a;background:#171a21;color:inherit;font-size:15px}
button{padding:12px 14px;border-radius:10px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;font-size:15px}
p{margin:0;color:#f87171;font-size:14px;min-height:20px}
</style></head><body><form method="POST" action="/login">
<h1>Launcher</h1><input type="password" name="passcode" placeholder="Passcode" autofocus autocomplete="current-password">
<button type="submit">Enter</button><p>__ERROR__</p></form></body></html>`;

function authError(message) {
  const safe = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee;
font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;text-align:center;padding:20px}
a{color:#7aa5f7}p{color:#f87171;max-width:46ch}</style>
<div><h1 style="font-size:18px">Sign-in failed</h1><p>${safe}</p><a href="/auth/login">Try again</a></div>`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, apps: cache.apps.length, stale: cache.stale }));
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      const submitted = decodeURIComponent((/passcode=([^&]*)/.exec(body)?.[1] || '').replace(/\+/g, ' '));
      if (passHash && crypto.createHash('sha256').update(submitted).digest('hex') === passHash) {
        return send(res, 302, 'text/plain', 'ok', {
          'Set-Cookie': `el_auth=${passHash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${
            url.protocol === 'https:' ? '; Secure' : ''
          }`,
          Location: '/',
        });
      }
      send(res, 401, 'text/html; charset=utf-8', LOGIN_PAGE.replace('__ERROR__', 'Incorrect passcode'));
    });
    return;
  }

  if (AUTH_MODE === 'oidc') {
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https');

    if (url.pathname === '/auth/login') {
      try {
        const target = await oidc.authorizeUrl(url.searchParams.get('return') || '/');
        return send(res, 302, 'text/plain', 'redirecting', { Location: target });
      } catch (err) {
        return send(res, 502, 'text/html; charset=utf-8', authError(`Cannot reach Pocket-ID: ${err.message}`));
      }
    }

    if (url.pathname === '/auth/callback') {
      try {
        const { cookie, returnTo } = await oidc.callback(url);
        return send(res, 302, 'text/plain', 'ok', {
          'Set-Cookie': oidc.cookieHeader(cookie, secure),
          Location: returnTo,
        });
      } catch (err) {
        return send(res, 401, 'text/html; charset=utf-8', authError(err.message));
      }
    }

    if (url.pathname === '/auth/logout') {
      return send(res, 302, 'text/plain', 'bye', {
        'Set-Cookie': oidc.clearCookieHeader(secure),
        Location: '/',
      });
    }

    // Anything else, unauthenticated: bounce straight into Pocket-ID rather
    // than showing an interstitial nobody would read.
    if (!isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, 'application/json', '{"error":"unauthenticated"}');
      return send(res, 302, 'text/plain', 'login', {
        Location: `/auth/login?return=${encodeURIComponent(url.pathname)}`,
      });
    }
  } else if (!isAuthed(req)) {
    return send(res, 401, 'text/html; charset=utf-8', LOGIN_PAGE.replace('__ERROR__', ''));
  }

  if (url.pathname === '/api/apps') {
    if (url.searchParams.get('refresh') === '1') await refresh();
    const session = AUTH_MODE === 'oidc' ? oidc.sessionFrom(req) : null;
    return send(
      res,
      200,
      'application/json',
      JSON.stringify({ ...cache, title: CONFIG.title, authMode: AUTH_MODE, user: session?.name || null })
    );
  }

  if (url.pathname === '/') {
    return send(res, 200, 'text/html; charset=utf-8', INDEX_HTML);
  }

  send(res, 404, 'text/plain', 'Not found');
});

server.listen(CONFIG.port, () => {
  console.log(`[launcher] listening on :${CONFIG.port} -> ${CONFIG.coolifyUrl}`);
  if (!CONFIG.token) console.warn('[launcher] WARNING: COOLIFY_TOKEN is not set; the page will be empty');
  console.log(`[launcher] auth mode: ${AUTH_MODE}${AUTH_MODE === 'oidc' ? ` (${CONFIG.oidc.issuer})` : ''}`);
  if (AUTH_MODE === 'open') {
    console.warn('[launcher] WARNING: no auth configured; anyone who can reach this host sees every app');
  }
  refresh();
  setInterval(refresh, CONFIG.refreshMs).unref();
});
