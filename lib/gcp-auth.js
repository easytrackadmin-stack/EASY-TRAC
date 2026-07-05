// ══════════════════════════════════════════════════════════════════════════════
// lib/gcp-auth.js
// Service-account OAuth2 token minting for GCP APIs (Cloud Run, etc.)
//
// The app runs on Railway — no GCP metadata server available. All GCP API auth
// must be derived from an SA key JSON (same pattern as gtm-service.js:96-147
// but generalized: any SA key, any OAuth scope, per-caller cache).
//
// Exports:
//   getAccessToken({ saKeyJson, scope })  → { accessToken, expiresAt }
//   isSaKeyValid(saKeyJson)               → boolean (non-throwing)
//   _resetCacheForTests()                 — test helper only
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const crypto = require('crypto');

const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const FETCH_TIMEOUT_MS = 8000;

// Cache: `${client_email}|${scope}` → { accessToken, expiresAt }
const _cache = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function _parseSaKey(saKeyJson) {
  let sa;
  if (typeof saKeyJson === 'string') {
    try { sa = JSON.parse(saKeyJson); }
    catch (_) { throw new Error('invalid service account JSON'); }
  } else if (saKeyJson && typeof saKeyJson === 'object') {
    sa = saKeyJson;
  } else {
    throw new Error('invalid service account JSON');
  }

  if (!sa.client_email) throw new Error('service account JSON missing client_email');
  if (!sa.private_key)  throw new Error('service account JSON missing private_key');

  // Railway env vars store literal \n; normalize to real newlines so Node crypto
  // can parse the PEM — same fix as gtm-service.js getSA line 107.
  const normalizedKey = sa.private_key.replace(/\\n/g, '\n');

  return { client_email: sa.client_email, private_key: normalizedKey };
}

function _buildJWT(client_email, private_key, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss:   client_email,
    scope,
    aud:   TOKEN_URL,
    iat:   now,
    exp:   now + 3600,
  }));
  const unsigned = header + '.' + payload;
  const signer   = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = base64url(signer.sign(private_key));
  return unsigned + '.' + sig;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getAccessToken({ saKeyJson, scope = DEFAULT_SCOPE }) {
  const { client_email, private_key } = _parseSaKey(saKeyJson);

  const cacheKey = `${client_email}|${scope}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = _cache.get(cacheKey);
  if (cached && now < cached.expiresAt - 60) return cached;

  const jwt  = _buildJWT(client_email, private_key, scope);
  const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
             + '&assertion=' + encodeURIComponent(jwt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await globalThis.fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let errMsg = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed.error || parsed.error_description) {
        errMsg = [parsed.error, parsed.error_description].filter(Boolean).join(': ');
      }
    } catch (_) { /* keep raw text */ }
    const err = new Error(`GCP token request failed (HTTP ${res.status}): ${errMsg}`);
    err.status = res.status;
    throw err;
  }

  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error('GCP token response is not valid JSON'); }

  if (!data.access_token) throw new Error('GCP token response missing access_token');

  const expiresAt = now + (data.expires_in || 3600);
  const entry = { accessToken: data.access_token, expiresAt };
  _cache.set(cacheKey, entry);
  return entry;
}

function isSaKeyValid(saKeyJson) {
  try {
    _parseSaKey(saKeyJson);
    return true;
  } catch (_) {
    return false;
  }
}

function _resetCacheForTests() {
  _cache.clear();
}

module.exports = { getAccessToken, isSaKeyValid, _resetCacheForTests };
