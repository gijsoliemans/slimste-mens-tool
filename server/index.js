'use strict';
// HTTP-server zonder externe dependencies: statische bestanden, JSON-API en SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const store = require('./store');
const auth = require('./auth');
const game = require('./game');

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.SM_BIND || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png'
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, Object.assign({
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Alle scripts en stijlen komen van dezelfde origin; er zijn geen inline
    // scripts. Geinjecteerde code wordt dus sowieso niet uitgevoerd.
    // 'unsafe-inline' staat alleen bij style-src, voor de style-attributen.
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  }, headers));
  res.end(buf);
}

function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
}

function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[server]', err);
  json(res, status, {
    error: (err && err.message) || 'Serverfout',
    code: err && err.code,
    details: err && err.details
  });
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Verzoek te groot'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('Ongeldige JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function requireHost(req) {
  if (!auth.isHost(req)) {
    throw Object.assign(new Error('Alleen voor de quizmaster. Log opnieuw in.'), { status: 401 });
  }
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}

// --- Statische bestanden --------------------------------------------------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/play' || rel.startsWith('/p/')) rel = '/play.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  // Let op de padscheiding: zonder die zou een zustermap als "public-privé"
  // de controle passeren. Onbereikbaar zoals de route nu loopt, maar dit is
  // code die anderen forken.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'Verboden');
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Niet gevonden', { 'Content-Type': 'text/plain; charset=utf-8' });
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type });
  });
}

// --- SSE ------------------------------------------------------------------
function openStream(req, res, session, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  };
  const unsubscribe = game.subscribe(session.id, role, send);

  // Directe eerste status, zodat een herlaad meteen synchroon zit.
  send('state', JSON.stringify(role === 'host' ? game.hostView(session) : game.playerView(session)));
  // Laat de host weten dat het aantal kijkers veranderd is.
  game.broadcast(session);

  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);

  const close = () => {
    clearInterval(keepAlive);
    unsubscribe();
    try { game.broadcast(session); } catch (e) {}
  };
  req.on('close', close);
  req.on('error', close);
}

// --- API ------------------------------------------------------------------
async function handleApi(req, res, pathname, query) {
  const method = req.method;

  // ---- Host login ----
  if (pathname === '/api/host/login' && method === 'POST') {
    const body = await readBody(req);
    if (!auth.checkPassword(body.password || '')) {
      await new Promise((r) => setTimeout(r, 400)); // rem brute force af
      return json(res, 401, { error: 'Wachtwoord klopt niet.' });
    }
    const token = auth.issueToken();
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(token, isSecure(req)) });
  }

  if (pathname === '/api/host/logout' && method === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
  }

  if (pathname === '/api/host/me' && method === 'GET') {
    return json(res, 200, { host: auth.isHost(req) });
  }

  if (pathname === '/api/host/password' && method === 'POST') {
    requireHost(req);
    const body = await readBody(req);
    const next = String(body.password || '');
    if (next.length < 6) return json(res, 400, { error: 'Kies een wachtwoord van minstens 6 tekens.' });
    auth.setPassword(next);
    const token = auth.issueToken();
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(token, isSecure(req)) });
  }

  // ---- Spelerkant (publiek, maar bevat nooit puzzelinhoud) ----
  if (pathname === '/api/play/state' && method === 'GET') {
    const s = game.getByCode(query.code);
    if (!s) return json(res, 404, { error: 'Deze code hoort niet bij een actieve sessie.' });
    return json(res, 200, game.playerView(s));
  }

  if (pathname === '/api/play/stream' && method === 'GET') {
    const s = game.getByCode(query.code);
    if (!s) return json(res, 404, { error: 'Onbekende code.' });
    return openStream(req, res, s, 'player');
  }

  // ---- Alles hieronder vereist host-authenticatie ----
  requireHost(req);

  if (pathname === '/api/puzzles' && method === 'GET') {
    return json(res, 200, { puzzles: store.listSummaries(), tags: store.allTags(), defaults: store.getDefaults() });
  }

  if (pathname === '/api/puzzles' && method === 'POST') {
    const body = await readBody(req);
    const { puzzle, validation } = store.upsertPuzzle(body.puzzle || body, { draft: !!body.draft });
    return json(res, 200, { puzzle, validation, summary: store.summarise(puzzle) });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    return json(res, 200, { defaults: store.setDefaults(body) });
  }

  if (pathname === '/api/export' && method === 'GET') {
    const ids = query.ids ? String(query.ids).split(',').filter(Boolean) : null;
    const payload = store.exportPuzzles(ids);
    return json(res, 200, payload, {
      'Content-Disposition': `attachment; filename="puzzels-${new Date().toISOString().slice(0, 10)}.json"`
    });
  }

  if (pathname === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const result = store.importPuzzles(body.data || body, { mode: body.mode || 'copy' });
    return json(res, 200, result);
  }

  let m;
  if ((m = pathname.match(/^\/api\/puzzles\/([\w-]+)$/))) {
    if (method === 'GET') {
      const p = store.getPuzzle(m[1]);
      if (!p) return json(res, 404, { error: 'Puzzel niet gevonden.' });
      return json(res, 200, { puzzle: p, validation: store.validate(p) });
    }
    if (method === 'DELETE') {
      return json(res, 200, { ok: store.deletePuzzle(m[1]) });
    }
  }

  if ((m = pathname.match(/^\/api\/puzzles\/([\w-]+)\/duplicate$/)) && method === 'POST') {
    const copy = store.duplicatePuzzle(m[1]);
    if (!copy) return json(res, 404, { error: 'Puzzel niet gevonden.' });
    return json(res, 200, { puzzle: copy, summary: store.summarise(copy) });
  }

  // ---- Sessies ----
  if (pathname === '/api/sessions' && method === 'GET') {
    return json(res, 200, { sessions: game.listSessions() });
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    const body = await readBody(req);
    const p = store.getPuzzle(body.puzzleId);
    if (!p) return json(res, 404, { error: 'Puzzel niet gevonden.' });
    const settings = Object.assign({}, store.getDefaults(), body.settings || {});
    const s = game.createSession(p, settings);
    if (body.saveDefaults) store.setDefaults(settings);
    return json(res, 200, { session: game.hostView(s) });
  }

  if ((m = pathname.match(/^\/api\/sessions\/([a-f0-9]+)$/))) {
    const s = game.getSession(m[1]);
    if (!s) return json(res, 404, { error: 'Sessie bestaat niet (meer).' });
    if (method === 'GET') return json(res, 200, game.hostView(s));
    if (method === 'DELETE') { game.endSession(s.id); return json(res, 200, { ok: true }); }
  }

  if ((m = pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/action$/)) && method === 'POST') {
    const s = game.getSession(m[1]);
    if (!s) return json(res, 404, { error: 'Sessie bestaat niet (meer).' });
    const body = await readBody(req);
    game.applyAction(s, body);
    return json(res, 200, game.hostView(s));
  }

  if ((m = pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/stream$/)) && method === 'GET') {
    const s = game.getSession(m[1]);
    if (!s) return json(res, 404, { error: 'Sessie bestaat niet (meer).' });
    return openStream(req, res, s, 'host');
  }

  // Sessie op basis van puzzel: gebruikt om na een ronde door te schakelen
  // naar de volgende puzzel binnen dezelfde spelerscode.
  if ((m = pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/next$/)) && method === 'POST') {
    const s = game.getSession(m[1]);
    if (!s) return json(res, 404, { error: 'Sessie bestaat niet (meer).' });
    const body = await readBody(req);
    const p = store.getPuzzle(body.puzzleId);
    if (!p) return json(res, 404, { error: 'Puzzel niet gevonden.' });
    const settings = Object.assign({}, s.settings, body.settings || {});
    const next = game.createSession(p, settings);
    // Neem de spelerscode over zodat de speler geen nieuwe link nodig heeft.
    game.adoptCode(next, s);
    return json(res, 200, { session: game.hostView(next) });
  }

  return json(res, 404, { error: 'Onbekend endpoint' });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    Promise.resolve()
      .then(() => handleApi(req, res, pathname, parsed.query))
      .catch((err) => { if (!res.headersSent) fail(res, err); else try { res.end(); } catch (e) {} });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Methode niet toegestaan');
  serveStatic(req, res, pathname);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

function localAddresses() {
  const os = require('os');
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}

store.load();
const authInfo = auth.init();

server.listen(PORT, HOST, () => {
  const lines = [];
  lines.push('');
  lines.push('  Slimste Mens puzzeltool draait');
  lines.push('  ------------------------------');
  lines.push(`  Quizmaster : http://localhost:${PORT}/`);
  localAddresses().forEach((a) => lines.push(`  Op je netwerk: http://${a}:${PORT}/`));
  lines.push('');
  if (authInfo.generatedPassword) {
    lines.push(`  Hostwachtwoord (eenmalig gegenereerd): ${authInfo.generatedPassword}`);
    lines.push('  Bewaar dit. Je kunt het wijzigen bij Instellingen in de app.');
  } else if (authInfo.fromEnv) {
    lines.push('  Hostwachtwoord komt uit SM_HOST_PASSWORD.');
  } else {
    lines.push('  Hostwachtwoord: zoals eerder ingesteld.');
  }
  lines.push('');
  console.log(lines.join('\n'));
});

module.exports = server;
