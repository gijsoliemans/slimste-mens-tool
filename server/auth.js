'use strict';
// Host-authenticatie. De hostweergave en alle endpoints die een volledige puzzel
// kunnen teruggeven zitten hierachter. De spelerweergave is bewust publiek,
// maar krijgt nooit puzzelinhoud (zie game.js -> playerView).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const CONFIG_FILE = path.join(store.DATA_DIR, 'config.json');
const COOKIE_NAME = 'sm_host';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 dagen

let config = null;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomWords(n) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function init() {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    config = null;
  }
  if (!config || !config.secret) {
    config = {
      secret: crypto.randomBytes(32).toString('hex'),
      passwordHash: null,
      passwordSalt: null,
      createdAt: store.nowIso()
    };
  }
  // Wachtwoord uit omgeving heeft altijd voorrang; anders eenmalig genereren.
  let generated = null;
  if (process.env.SM_HOST_PASSWORD) {
    setPassword(process.env.SM_HOST_PASSWORD, false);
  } else if (!config.passwordHash) {
    generated = randomWords(4) + '-' + randomWords(4);
    setPassword(generated, false);
  }
  persist();
  return { generatedPassword: generated, fromEnv: !!process.env.SM_HOST_PASSWORD };
}

function persist() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function setPassword(password, save = true) {
  const salt = crypto.randomBytes(16).toString('hex');
  config.passwordSalt = salt;
  config.passwordHash = hash(password, salt);
  config.passwordChangedAt = store.nowIso();
  if (save) persist();
}

function checkPassword(password) {
  if (!config || !config.passwordHash) return false;
  const candidate = Buffer.from(hash(password, config.passwordSalt), 'hex');
  const expected = Buffer.from(config.passwordHash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function issueToken() {
  const payload = b64url(JSON.stringify({ iat: Date.now(), n: crypto.randomBytes(8).toString('hex') }));
  const sig = b64url(crypto.createHmac('sha256', config.secret).update(payload).digest());
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', config.secret).update(payload).digest());
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!data.iat || Date.now() - data.iat > TOKEN_TTL_MS) return false;
    // Tokens die van voor de laatste wachtwoordwijziging komen, vervallen.
    if (config.passwordChangedAt && data.iat < Date.parse(config.passwordChangedAt)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isHost(req) {
  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME] && verifyToken(cookies[COOKIE_NAME])) return true;
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ') && verifyToken(header.slice(7))) return true;
  return false;
}

function cookieHeader(token, secure) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  init,
  setPassword,
  checkPassword,
  issueToken,
  verifyToken,
  isHost,
  cookieHeader,
  clearCookieHeader,
  COOKIE_NAME
};
