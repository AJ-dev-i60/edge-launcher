'use strict';

// Pocket-ID (OIDC) authorization-code flow with PKCE, using only Node
// built-ins. Confidential client: the code exchange happens server-side and
// the client secret never reaches the browser.

const crypto = require('crypto');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class OidcAuth {
  constructor(config) {
    this.issuer = config.issuer.replace(/\/+$/, '');
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.redirectUri = `${this.baseUrl}/auth/callback`;
    this.sessionTtlMs = config.sessionTtlMs || 12 * 60 * 60 * 1000;
    // Restricts access to members of these Pocket-ID groups. Empty = any
    // user the identity provider authenticates.
    this.allowedGroups = config.allowedGroups || [];
    // Signing key for session cookies. Deriving it from the client secret
    // keeps sessions valid across restarts without another env var to manage.
    this.sessionKey = crypto.createHash('sha256').update(`session:${this.clientSecret}`).digest();
    this.discovery = null;
    this.pending = new Map();
  }

  async endpoints() {
    if (this.discovery) return this.discovery;
    const res = await fetch(`${this.issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    this.discovery = await res.json();
    return this.discovery;
  }

  // --- session cookie: signed, stateless -----------------------------------

  sign(payload) {
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const mac = b64url(crypto.createHmac('sha256', this.sessionKey).update(body).digest());
    return `${body}.${mac}`;
  }

  verify(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return null;
    const [body, mac] = cookieValue.split('.');
    const expected = b64url(crypto.createHmac('sha256', this.sessionKey).update(body).digest());
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const session = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      if (!session.exp || session.exp < Date.now()) return null;
      return session;
    } catch {
      return null;
    }
  }

  sessionFrom(req) {
    const match = /(?:^|;\s*)el_session=([^;]+)/.exec(req.headers.cookie || '');
    return match ? this.verify(decodeURIComponent(match[1])) : null;
  }

  // --- flow ----------------------------------------------------------------

  async authorizeUrl(returnTo = '/') {
    const { authorization_endpoint } = await this.endpoints();
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    this.sweepPending();
    this.pending.set(state, { verifier, returnTo, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email groups',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${authorization_endpoint}?${params}`;
  }

  sweepPending() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }

  async callback(url) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (url.searchParams.get('error')) {
      throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
    }
    if (!code || !state) throw new Error('Missing code or state');

    const entry = this.pending.get(state);
    // Single use: an unknown or replayed state is rejected outright.
    if (!entry) throw new Error('Unknown or expired state — start again');
    this.pending.delete(state);

    const { token_endpoint } = await this.endpoints();
    const res = await fetch(token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      // Pocket-ID expects client_secret_post: it ignores an HTTP Basic header
      // and answers "Client id or secret not provided". Its discovery document
      // advertises no token_endpoint_auth_methods_supported, so this is not
      // discoverable — it has to be known.
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        code_verifier: entry.verifier,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const tokens = await res.json();
    const claims = this.readIdToken(tokens.id_token);

    const groups = Array.isArray(claims.groups) ? claims.groups : [];
    if (this.allowedGroups.length && !groups.some((g) => this.allowedGroups.includes(g))) {
      throw new Error(`Your account is not in a permitted group (${this.allowedGroups.join(', ')})`);
    }

    return {
      cookie: this.sign({
        sub: claims.sub,
        name: claims.name || claims.preferred_username || claims.email || 'user',
        email: claims.email || '',
        exp: Date.now() + this.sessionTtlMs,
      }),
      returnTo: entry.returnTo || '/',
    };
  }

  // The ID token arrives over TLS directly from the token endpoint in
  // response to our own request, so per OIDC Core 3.1.3.7 the signature need
  // not be re-verified here. Issuer, audience and expiry are still checked.
  readIdToken(idToken) {
    if (!idToken) throw new Error('No id_token returned');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Malformed id_token');
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

    if (claims.iss !== this.issuer) throw new Error(`Unexpected issuer ${claims.iss}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) throw new Error('id_token audience mismatch');
    if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error('id_token already expired');
    return claims;
  }

  cookieHeader(value, secure) {
    return `el_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      this.sessionTtlMs / 1000
    )}${secure ? '; Secure' : ''}`;
  }

  clearCookieHeader(secure) {
    return `el_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

module.exports = { OidcAuth };
