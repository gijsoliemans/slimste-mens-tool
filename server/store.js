'use strict';
// Persistente opslag van puzzels + host-instellingen in een JSON-bestand.
// Bewust geen database: de tool moet lokaal en zonder internet kunnen draaien.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.SM_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'puzzles.json');
const TMP_FILE = DB_FILE + '.tmp';

const DEFAULT_SESSION_SETTINGS = {
  totalSeconds: 60,
  bonusSeconds: 0,
  penaltySeconds: 0,
  shuffle: true
};

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function emptyDb() {
  return {
    version: 1,
    puzzles: [],
    tags: [],
    defaults: { ...DEFAULT_SESSION_SETTINGS }
  };
}

let db = emptyDb();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = Object.assign(emptyDb(), parsed);
    db.defaults = Object.assign({ ...DEFAULT_SESSION_SETTINGS }, parsed.defaults || {});
    db.puzzles = (parsed.puzzles || []).map(normalisePuzzle);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] kon opslag niet lezen, start met lege set:', err.message);
    }
    db = emptyDb();
    save();
  }
  return db;
}

let saveQueued = false;
function save() {
  // Atomair schrijven: eerst tmp, dan rename. Voorkomt een half bestand bij een crash.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, DB_FILE);
  saveQueued = false;
}

function saveSoon() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => { try { save(); } catch (e) { console.error('[store] save faalde:', e.message); } }, 50);
}

function normaliseText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function normalisePuzzle(input) {
  const answers = Array.isArray(input.answers) ? input.answers.slice(0, 3) : [];
  return {
    id: input.id || uuid(),
    title: normaliseText(input.title) || 'Naamloze puzzel',
    notes: typeof input.notes === 'string' ? input.notes : '',
    tags: Array.isArray(input.tags) ? input.tags.map(normaliseText).filter(Boolean).slice(0, 12) : [],
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
    playCount: Number.isFinite(input.playCount) ? input.playCount : 0,
    lastPlayedAt: input.lastPlayedAt || null,
    answers: answers.map((a) => ({
      id: a.id || uuid(),
      text: normaliseText(a.text),
      acceptableAlternatives: Array.isArray(a.acceptableAlternatives)
        ? a.acceptableAlternatives.map(normaliseText).filter(Boolean)
        : [],
      explanation: typeof a.explanation === 'string' ? a.explanation : '',
      hints: (Array.isArray(a.hints) ? a.hints.slice(0, 4) : []).map((h) => ({
        id: h.id || uuid(),
        text: normaliseText(h.text)
      }))
    }))
  };
}

// --- Validatie ------------------------------------------------------------
// Harde fouten blokkeren "opslaan als definitieve puzzel" en het starten van een spel.
// Waarschuwingen blokkeren niets.
function validate(puzzle) {
  const errors = [];
  const warnings = [];

  if (!normaliseText(puzzle.title)) errors.push('De puzzel heeft geen titel.');
  if (!Array.isArray(puzzle.answers) || puzzle.answers.length !== 3) {
    errors.push(`Een puzzel heeft precies 3 antwoorden (nu ${(puzzle.answers || []).length}).`);
  }

  const hintTexts = [];
  const answerTexts = [];
  (puzzle.answers || []).forEach((a, i) => {
    const label = `Antwoord ${i + 1}`;
    if (!normaliseText(a.text)) errors.push(`${label} heeft geen tekst.`);
    else answerTexts.push(normaliseText(a.text).toLowerCase());
    const hints = a.hints || [];
    if (hints.length !== 4) errors.push(`${label} heeft precies 4 hints nodig (nu ${hints.length}).`);
    hints.forEach((h, j) => {
      const t = normaliseText(h.text);
      if (!t) errors.push(`${label}, hint ${j + 1} is leeg.`);
      else hintTexts.push(t.toLowerCase());
    });
  });

  const seen = new Set();
  const dupes = new Set();
  hintTexts.forEach((t) => { if (seen.has(t)) dupes.add(t); else seen.add(t); });
  dupes.forEach((t) => warnings.push(`De hint "${t}" komt meerdere keren voor in deze puzzel.`));
  hintTexts.forEach((t) => {
    if (answerTexts.includes(t)) warnings.push(`De hint "${t}" is letterlijk gelijk aan een antwoord.`);
  });

  return { errors, warnings, complete: errors.length === 0 };
}

function summarise(p) {
  const v = validate(p);
  const hintCount = (p.answers || []).reduce((n, a) => n + (a.hints || []).length, 0);
  // searchBlob gaat alleen naar de host-only lijst, zodat zoeken op hint of
  // antwoord werkt zonder dat de speler ooit een lijst-endpoint kan bereiken.
  const searchBlob = (p.answers || [])
    .map((a) => [a.text, (a.acceptableAlternatives || []).join(' '), (a.hints || []).map((h) => h.text).join(' ')].join(' '))
    .join(' ');
  return {
    id: p.id,
    title: p.title,
    tags: p.tags,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    playCount: p.playCount,
    lastPlayedAt: p.lastPlayedAt,
    answerCount: (p.answers || []).length,
    hintCount,
    searchBlob,
    complete: v.complete,
    warnings: v.warnings,
    errors: v.errors
  };
}

// --- CRUD -----------------------------------------------------------------
function listPuzzles() {
  return db.puzzles.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function listSummaries() {
  return listPuzzles().map(summarise);
}

function getPuzzle(id) {
  return db.puzzles.find((p) => p.id === id) || null;
}

function upsertPuzzle(input, { draft = false } = {}) {
  const puzzle = normalisePuzzle(input);
  const v = validate(puzzle);
  if (!draft && v.errors.length) {
    const err = new Error('Puzzel is niet compleet');
    err.status = 422;
    err.details = v;
    throw err;
  }
  const existing = db.puzzles.findIndex((p) => p.id === puzzle.id);
  if (existing >= 0) {
    puzzle.createdAt = db.puzzles[existing].createdAt;
    puzzle.playCount = db.puzzles[existing].playCount;
    puzzle.lastPlayedAt = db.puzzles[existing].lastPlayedAt;
    puzzle.updatedAt = nowIso();
    db.puzzles[existing] = puzzle;
  } else {
    puzzle.updatedAt = nowIso();
    db.puzzles.push(puzzle);
  }
  saveSoon();
  return { puzzle, validation: v };
}

function deletePuzzle(id) {
  const i = db.puzzles.findIndex((p) => p.id === id);
  if (i < 0) return false;
  db.puzzles.splice(i, 1);
  saveSoon();
  return true;
}

function duplicatePuzzle(id) {
  const src = getPuzzle(id);
  if (!src) return null;
  const copy = normalisePuzzle(JSON.parse(JSON.stringify(src)));
  copy.id = uuid();
  copy.title = src.title + ' (kopie)';
  copy.createdAt = nowIso();
  copy.updatedAt = nowIso();
  copy.playCount = 0;
  copy.lastPlayedAt = null;
  copy.answers.forEach((a) => {
    a.id = uuid();
    a.hints.forEach((h) => { h.id = uuid(); });
  });
  db.puzzles.push(copy);
  saveSoon();
  return copy;
}

function markPlayed(id) {
  const p = getPuzzle(id);
  if (!p) return;
  p.playCount = (p.playCount || 0) + 1;
  p.lastPlayedAt = nowIso();
  saveSoon();
}

function allTags() {
  const set = new Set();
  db.puzzles.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function getDefaults() {
  return { ...db.defaults };
}

function setDefaults(next) {
  db.defaults = {
    totalSeconds: clampInt(next.totalSeconds, 5, 3600, db.defaults.totalSeconds),
    bonusSeconds: clampInt(next.bonusSeconds, 0, 600, db.defaults.bonusSeconds),
    penaltySeconds: clampInt(next.penaltySeconds, 0, 600, db.defaults.penaltySeconds),
    shuffle: next.shuffle !== false
  };
  saveSoon();
  return getDefaults();
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function exportPuzzles(ids) {
  const set = ids && ids.length ? new Set(ids) : null;
  const list = db.puzzles.filter((p) => !set || set.has(p.id));
  return {
    format: 'slimste-mens-tool/puzzles',
    version: 1,
    exportedAt: nowIso(),
    puzzles: JSON.parse(JSON.stringify(list))
  };
}

function importPuzzles(payload, { mode = 'copy' } = {}) {
  const incoming = Array.isArray(payload) ? payload : (payload && payload.puzzles) || [];
  if (!Array.isArray(incoming) || !incoming.length) {
    const err = new Error('Geen puzzels gevonden in dit bestand.');
    err.status = 400;
    throw err;
  }
  const result = { added: 0, replaced: 0, titles: [] };
  incoming.forEach((raw) => {
    const p = normalisePuzzle(raw);
    const existing = db.puzzles.findIndex((x) => x.id === p.id);
    if (existing >= 0 && mode === 'replace') {
      p.updatedAt = nowIso();
      db.puzzles[existing] = p;
      result.replaced++;
    } else {
      if (existing >= 0) {
        p.id = uuid();
        p.answers.forEach((a) => { a.id = uuid(); a.hints.forEach((h) => { h.id = uuid(); }); });
      }
      p.updatedAt = nowIso();
      db.puzzles.push(p);
      result.added++;
    }
    result.titles.push(p.title);
  });
  saveSoon();
  return result;
}

module.exports = {
  DATA_DIR,
  uuid,
  nowIso,
  load,
  save,
  validate,
  summarise,
  listPuzzles,
  listSummaries,
  getPuzzle,
  upsertPuzzle,
  deletePuzzle,
  duplicatePuzzle,
  markPlayed,
  allTags,
  getDefaults,
  setDefaults,
  exportPuzzles,
  importPuzzles,
  clampInt,
  DEFAULT_SESSION_SETTINGS
};
