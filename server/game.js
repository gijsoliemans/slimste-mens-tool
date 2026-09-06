'use strict';
// Spelsessies. De server is de enige bron van waarheid voor klok en status.
//
// GEHEIMHOUDING (eis 7):
//   - session.tiles bevat wél de koppeling tile -> answerId, maar die koppeling
//     verlaat de server nooit richting de speler.
//   - playerView() bouwt de spelerpayload van nul op; er is geen "verwijder de
//     geheime velden"-stap die je kunt vergeten.
//   - tile-ids zijn per sessie willekeurig en zeggen niets over de groep.
//   - de sessiecode van de speler geeft geen toegang tot host-endpoints.

const crypto = require('crypto');
const store = require('./store');

const TICK_MS = 250;          // hoe vaak de server de klok controleert
const BROADCAST_MS = 1000;    // hoe vaak een lopende klok naar clients gaat
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // opruimen na 12 uur inactiviteit

const sessions = new Map();      // hostSessionId -> session
const byCode = new Map();        // spelerscode -> hostSessionId
const listeners = new Set();     // { sessionId, role, send }

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // zonder I, O, 0, 1
  let code;
  do {
    code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  } while (byCode.has(code));
  return code;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Klok -----------------------------------------------------------------
function elapsedMs(s) {
  return s.elapsedMs + (s.status === 'running' ? Date.now() - s.runningSince : 0);
}

function remainingMs(s) {
  return Math.max(0, s.totalMs + s.adjustMs - elapsedMs(s));
}

function settleClock(s) {
  if (s.status === 'running') {
    s.elapsedMs = elapsedMs(s);
    s.runningSince = null;
  }
}

// --- Sessies aanmaken -----------------------------------------------------
function createSession(puzzle, settings) {
  const v = store.validate(puzzle);
  if (!v.complete) {
    const err = new Error('Deze puzzel is nog een concept en kan niet gestart worden.');
    err.status = 422;
    err.details = v;
    throw err;
  }

  // Diepe kopie: bewerken van de puzzel raakt een lopende sessie niet (randgeval 9.5).
  const snapshot = JSON.parse(JSON.stringify(puzzle));

  const cfg = {
    totalSeconds: store.clampInt(settings.totalSeconds, 5, 3600, 60),
    bonusSeconds: store.clampInt(settings.bonusSeconds, 0, 600, 0),
    penaltySeconds: store.clampInt(settings.penaltySeconds, 0, 600, 0),
    shuffle: settings.shuffle !== false
  };

  const tiles = [];
  snapshot.answers.forEach((a) => {
    a.hints.forEach((h) => {
      tiles.push({
        id: crypto.randomBytes(8).toString('hex'),
        text: h.text,
        hintId: h.id,
        answerId: a.id // blijft server-side
      });
    });
  });

  const session = {
    id: crypto.randomBytes(24).toString('hex'), // geheime host-sessie-id
    code: randomCode(),                          // publieke spelerscode
    puzzleId: puzzle.id,
    puzzle: snapshot,
    settings: cfg,
    tiles: cfg.shuffle ? shuffled(tiles) : tiles, // volgorde één keer vastgezet
    status: 'idle',                               // idle | running | paused | ended
    totalMs: cfg.totalSeconds * 1000,
    adjustMs: 0,
    elapsedMs: 0,
    runningSince: null,
    found: [],            // answerIds die goedgekeurd zijn
    revealed: [],         // answerIds die zichtbaar zijn (found + handmatig onthuld)
    wrongCount: 0,
    revealAll: false,
    endedReason: null,    // 'time' | 'complete' | 'host'
    history: [],          // undo-stack
    log: [],
    createdAt: Date.now(),
    lastTouched: Date.now(),
    lastBroadcast: 0,
    playersSeen: 0
  };

  sessions.set(session.id, session);
  byCode.set(session.code, session.id);
  store.markPlayed(puzzle.id);
  return session;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function getByCode(code) {
  const id = byCode.get(String(code || '').toUpperCase().trim());
  return id ? sessions.get(id) || null : null;
}

function endSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  broadcast(s, 'closed');
  byCode.delete(s.code);
  sessions.delete(id);
  return true;
}

function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    code: s.code,
    puzzleId: s.puzzleId,
    title: s.puzzle.title,
    status: s.status,
    remainingMs: remainingMs(s),
    found: s.found.length,
    createdAt: s.createdAt
  }));
}

// --- Views ----------------------------------------------------------------
// Alles wat de speler krijgt. Geen antwoordteksten, geen alternatieven, geen
// toelichting, geen groepering — behalve voor antwoorden die onthuld zijn.
function playerView(s) {
  const revealedSet = new Set(s.revealed);
  const foundSet = new Set(s.found);
  const showAll = s.revealAll;

  const tiles = s.tiles.map((t) => {
    const isRevealed = showAll || revealedSet.has(t.answerId);
    return {
      id: t.id,
      text: t.text,
      state: !isRevealed ? 'open' : (foundSet.has(t.answerId) ? 'found' : 'revealed'),
      // group is uitsluitend gevuld als het antwoord al onthuld is
      group: isRevealed ? groupIndex(s, t.answerId) : null
    };
  });

  const answers = s.puzzle.answers
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => showAll || revealedSet.has(a.id))
    .map(({ a, i }) => ({
      group: i,
      text: a.text,
      explanation: showAll ? (a.explanation || '') : '',
      found: foundSet.has(a.id)
    }));

  return {
    code: s.code,
    status: s.status,
    running: s.status === 'running',
    remainingMs: remainingMs(s),
    totalMs: s.totalMs + s.adjustMs,
    serverNow: Date.now(),
    tiles,
    answers,
    foundCount: s.found.length,
    answerCount: s.puzzle.answers.length,
    revealAll: s.revealAll,
    endedReason: s.status === 'ended' ? s.endedReason : null,
    rev: s.rev || 0
  };
}

function groupIndex(s, answerId) {
  return s.puzzle.answers.findIndex((a) => a.id === answerId);
}

// Alles wat de host krijgt: de volledige puzzel plus de spelstatus.
function hostView(s) {
  const foundSet = new Set(s.found);
  const revealedSet = new Set(s.revealed);
  const tileByAnswer = new Map();
  s.tiles.forEach((t, order) => {
    if (!tileByAnswer.has(t.answerId)) tileByAnswer.set(t.answerId, []);
    tileByAnswer.get(t.answerId).push({ id: t.id, text: t.text, order });
  });

  return {
    id: s.id,
    code: s.code,
    puzzleId: s.puzzleId,
    title: s.puzzle.title,
    notes: s.puzzle.notes || '',
    settings: s.settings,
    status: s.status,
    running: s.status === 'running',
    remainingMs: remainingMs(s),
    totalMs: s.totalMs + s.adjustMs,
    baseTotalMs: s.totalMs,
    adjustMs: s.adjustMs,
    serverNow: Date.now(),
    wrongCount: s.wrongCount,
    revealAll: s.revealAll,
    endedReason: s.status === 'ended' ? s.endedReason : null,
    canUndo: s.history.length > 0,
    playerOrder: s.tiles.map((t) => ({ id: t.id, text: t.text })),
    answers: s.puzzle.answers.map((a, i) => ({
      id: a.id,
      group: i,
      text: a.text,
      acceptableAlternatives: a.acceptableAlternatives || [],
      explanation: a.explanation || '',
      found: foundSet.has(a.id),
      revealed: s.revealAll || revealedSet.has(a.id),
      hints: (tileByAnswer.get(a.id) || [])
    })),
    foundCount: s.found.length,
    log: s.log.slice(-40),
    rev: s.rev || 0
  };
}

// --- Acties ---------------------------------------------------------------
function snapshotForUndo(s, label) {
  s.history.push({
    label,
    found: s.found.slice(),
    revealed: s.revealed.slice(),
    adjustMs: s.adjustMs,
    wrongCount: s.wrongCount,
    revealAll: s.revealAll,
    status: s.status,
    endedReason: s.endedReason,
    logLength: s.log.length
  });
  if (s.history.length > 100) s.history.shift();
}

function addLog(s, text) {
  s.log.push({ at: Date.now(), text, remainingMs: remainingMs(s) });
}

function maybeFinish(s) {
  if (s.status === 'ended') return;
  if (s.found.length >= s.puzzle.answers.length) {
    settleClock(s);
    s.status = 'ended';
    s.endedReason = 'complete';
    addLog(s, 'Alle antwoorden gevonden.');
  }
}

function expireIfNeeded(s) {
  if (s.status === 'running' && remainingMs(s) <= 0) {
    s.elapsedMs = s.totalMs + s.adjustMs;
    s.runningSince = null;
    s.status = 'ended';
    s.endedReason = 'time';
    addLog(s, 'Tijd afgelopen.');
    return true;
  }
  return false;
}

/**
 * Regel voor randgeval 9.3 (tijd loopt af terwijl de host op goed drukt):
 * de klok van de server beslist. Een scoreactie telt alleen als de server hem
 * ontvangt terwijl er nog tijd over is. Is de tijd op het moment van
 * binnenkomst al 0, dan wordt de actie geweigerd met reden 'time-up'.
 * De host kan het antwoord daarna nog wel onthullen.
 */
function requireLiveClock(s) {
  expireIfNeeded(s);
  if (s.status === 'ended') {
    const err = new Error('De tijd was al voorbij, deze actie telt niet meer.');
    err.status = 409;
    err.code = 'time-up';
    throw err;
  }
  if (s.status === 'idle') {
    const err = new Error('De klok is nog niet gestart.');
    err.status = 409;
    err.code = 'not-started';
    throw err;
  }
}

function applyAction(s, action) {
  const type = action && action.type;
  s.lastTouched = Date.now();

  switch (type) {
    case 'start': {
      expireIfNeeded(s);
      if (s.status === 'ended') break;
      if (s.status !== 'running') {
        s.runningSince = Date.now();
        s.status = 'running';
        addLog(s, 'Klok gestart.');
      }
      break;
    }
    case 'pause': {
      if (s.status === 'running') {
        settleClock(s);
        s.status = 'paused';
        addLog(s, 'Klok gepauzeerd.');
      }
      break;
    }
    case 'reset': {
      snapshotForUndo(s, 'reset');
      s.status = 'idle';
      s.elapsedMs = 0;
      s.runningSince = null;
      s.adjustMs = 0;
      s.found = [];
      s.revealed = [];
      s.wrongCount = 0;
      s.revealAll = false;
      s.endedReason = null;
      addLog(s, 'Ronde gereset.');
      break;
    }
    case 'correct': {
      const answer = s.puzzle.answers.find((a) => a.id === action.answerId);
      if (!answer) throw badRequest('Onbekend antwoord.');
      if (s.found.includes(answer.id)) break;
      requireLiveClock(s);
      snapshotForUndo(s, 'correct');
      s.found.push(answer.id);
      if (!s.revealed.includes(answer.id)) s.revealed.push(answer.id);
      if (s.settings.bonusSeconds) s.adjustMs += s.settings.bonusSeconds * 1000;
      addLog(s, `Goed: ${answer.text}${s.settings.bonusSeconds ? ` (+${s.settings.bonusSeconds}s)` : ''}`);
      maybeFinish(s);
      break;
    }
    case 'wrong': {
      requireLiveClock(s);
      snapshotForUndo(s, 'wrong');
      s.wrongCount++;
      if (s.settings.penaltySeconds) s.adjustMs -= s.settings.penaltySeconds * 1000;
      addLog(s, `Fout${s.settings.penaltySeconds ? ` (-${s.settings.penaltySeconds}s)` : ''}`);
      expireIfNeeded(s);
      break;
    }
    case 'reveal': {
      const answer = s.puzzle.answers.find((a) => a.id === action.answerId);
      if (!answer) throw badRequest('Onbekend antwoord.');
      if (s.revealed.includes(answer.id)) break;
      snapshotForUndo(s, 'reveal');
      s.revealed.push(answer.id);
      addLog(s, `Onthuld: ${answer.text}`);
      break;
    }
    case 'revealAll': {
      snapshotForUndo(s, 'revealAll');
      s.revealAll = true;
      s.puzzle.answers.forEach((a) => { if (!s.revealed.includes(a.id)) s.revealed.push(a.id); });
      if (s.status !== 'ended') {
        settleClock(s);
        s.status = 'ended';
        s.endedReason = s.endedReason || 'host';
      }
      addLog(s, 'Alles onthuld.');
      break;
    }
    case 'stop': {
      if (s.status !== 'ended') {
        settleClock(s);
        s.status = 'ended';
        s.endedReason = 'host';
        addLog(s, 'Ronde gestopt door quizmaster.');
      }
      break;
    }
    case 'addTime': {
      const secs = store.clampInt(action.seconds, -3600, 3600, 0);
      if (!secs) break;
      snapshotForUndo(s, 'addTime');
      s.adjustMs += secs * 1000;
      addLog(s, `Tijd aangepast: ${secs > 0 ? '+' : ''}${secs}s`);
      if (s.status === 'ended' && s.endedReason === 'time' && remainingMs(s) > 0) {
        // Tijd bijgeplust na afloop: ronde staat weer open, maar gepauzeerd.
        s.status = 'paused';
        s.endedReason = null;
      }
      expireIfNeeded(s);
      break;
    }
    case 'undo': {
      const prev = s.history.pop();
      if (!prev) break;
      s.found = prev.found;
      s.revealed = prev.revealed;
      s.adjustMs = prev.adjustMs;
      s.wrongCount = prev.wrongCount;
      s.revealAll = prev.revealAll;
      s.endedReason = prev.endedReason;
      // De klok wordt niet teruggedraaid: verstreken tijd blijft verstreken.
      // Kwam de ronde door deze actie tot een einde, dan komt hij terug als
      // 'paused' zodat de quizmaster zelf bepaalt wanneer de klok weer loopt.
      if (s.status === 'ended' && prev.status !== 'ended') {
        settleClock(s);
        s.status = 'paused';
      } else {
        s.status = prev.status === 'running' && s.status === 'running' ? 'running' : s.status;
      }
      s.log = s.log.slice(0, prev.logLength);
      addLog(s, `Ongedaan gemaakt: ${prev.label}`);
      break;
    }
    default:
      throw badRequest('Onbekende actie: ' + type);
  }

  expireIfNeeded(s);
  s.rev = (s.rev || 0) + 1;
  broadcast(s);
  return s;
}

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

// --- SSE hub --------------------------------------------------------------
function subscribe(sessionId, role, send) {
  const entry = { sessionId, role, send };
  listeners.add(entry);
  return () => listeners.delete(entry);
}

function countListeners(sessionId, role) {
  let n = 0;
  listeners.forEach((l) => { if (l.sessionId === sessionId && l.role === role) n++; });
  return n;
}

function broadcast(s, event) {
  const players = countListeners(s.id, 'player');
  const payloadPlayer = JSON.stringify(Object.assign(playerView(s), { players }));
  const payloadHost = JSON.stringify(Object.assign(hostView(s), { players }));
  listeners.forEach((l) => {
    if (l.sessionId !== s.id) return;
    try {
      l.send(event || 'state', l.role === 'host' ? payloadHost : payloadPlayer);
    } catch (e) { /* stille verbinding, wordt door de server opgeruimd */ }
  });
  s.lastBroadcast = Date.now();
}

// --- Tick -----------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s) => {
    if (expireIfNeeded(s)) {
      s.rev = (s.rev || 0) + 1;
      broadcast(s);
      return;
    }
    if (s.status === 'running' && now - s.lastBroadcast >= BROADCAST_MS) {
      broadcast(s, 'tick');
    }
    if (now - s.lastTouched > SESSION_TTL_MS && countListeners(s.id, 'host') === 0) {
      endSession(s.id);
    }
  });
}, TICK_MS).unref();


// De volgende puzzel binnen dezelfde avond: de nieuwe sessie neemt de
// spelerscode van de oude over, zodat de speler zijn link mag houden.
// De oude sessie wordt afgesloten en zijn kijkers krijgen een 'switched'-event,
// waarna hun client opnieuw verbindt op dezelfde code.
function adoptCode(next, previous) {
  byCode.delete(next.code);
  const code = previous.code;
  listeners.forEach((l) => {
    if (l.sessionId !== previous.id || l.role !== 'player') return;
    try { l.send('switched', JSON.stringify({ code })); } catch (e) {}
  });
  byCode.delete(previous.code);
  sessions.delete(previous.id);
  next.code = code;
  byCode.set(code, next.id);
  return next;
}

module.exports = {
  createSession,
  adoptCode,
  getSession,
  getByCode,
  endSession,
  listSessions,
  applyAction,
  playerView,
  hostView,
  subscribe,
  countListeners,
  remainingMs,
  broadcast
};
