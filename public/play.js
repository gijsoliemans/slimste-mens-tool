'use strict';
/* Spelerclient.
   Deze bundel kent alleen: een spelerscode, hintteksten, tegelstatus en de klok.
   Er zit geen puzzelkennis in dit bestand en er is geen endpoint bereikbaar
   met alleen de spelerscode dat meer prijsgeeft dan wat hier getoond wordt. */

const $ = (id) => document.getElementById(id);
const joinView = $('join');
const gameView = $('game');
const tilesEl = $('tiles');
const answersEl = $('answers');
const clockEl = $('clock');
const progressEl = $('progress');
const statusEl = $('status-label');
const connEl = $('conn');
const overlayEl = $('overlay');

let code = null;
let source = null;
let pollTimer = null;
let lastMessageAt = 0;
let clockState = { remainingMs: 0, running: false, at: 0 };
let renderedTiles = new Map();
let renderedAnswers = new Map();
let lastRev = -1;

// --- Code uit de URL halen (/p/CODE of ?c=CODE) ---------------------------
function codeFromUrl() {
  const m = location.pathname.match(/^\/p\/([A-Za-z0-9]{4,8})$/);
  if (m) return m[1].toUpperCase();
  const q = new URLSearchParams(location.search).get('c') || new URLSearchParams(location.search).get('code');
  return q ? q.toUpperCase() : null;
}

// --- Toast ---------------------------------------------------------------
function toast(text, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// --- Klok ----------------------------------------------------------------
function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : String(s);
}

function displayedRemaining() {
  if (!clockState.running) return clockState.remainingMs;
  return Math.max(0, clockState.remainingMs - (Date.now() - clockState.at));
}

function paintClock() {
  const ms = displayedRemaining();
  clockEl.textContent = formatClock(ms);
  clockEl.classList.toggle('danger', ms <= 10000);
  clockEl.classList.toggle('warn', ms > 10000 && ms <= 20000);
  clockEl.classList.toggle('pulse', clockState.running && ms <= 5000);
}
setInterval(paintClock, 100);

// --- Render --------------------------------------------------------------
const STATUS_TEXT = {
  idle: 'Wachten op de quizmaster',
  running: 'Speel!',
  paused: 'Gepauzeerd',
  ended: 'Afgelopen'
};

function render(state) {
  joinView.classList.add('hidden');
  gameView.classList.remove('hidden');

  clockState = { remainingMs: state.remainingMs, running: state.running, at: Date.now() };
  paintClock();

  progressEl.textContent = `${state.foundCount} / ${state.answerCount}`;
  statusEl.textContent = STATUS_TEXT[state.status] || '';

  // Tegels: bestaande elementen hergebruiken zodat er niets verspringt.
  const wanted = new Set(state.tiles.map((t) => t.id));
  renderedTiles.forEach((el, id) => { if (!wanted.has(id)) { el.remove(); renderedTiles.delete(id); } });

  state.tiles.forEach((t, index) => {
    let el = renderedTiles.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.textContent = t.text;
      tilesEl.appendChild(el);
      renderedTiles.set(t.id, el);
    }
    if (el.textContent !== t.text) el.textContent = t.text;
    el.classList.toggle('pending', !state.started);
    el.style.order = String(index);
    const wasOpen = !el.classList.contains('found') && !el.classList.contains('revealed');
    el.classList.toggle('found', t.state === 'found');
    el.classList.toggle('revealed', t.state === 'revealed');
    // Groepskleur pas zichtbaar zodra het antwoord onthuld is. Voor open tegels
    // is t.group altijd null, dus er valt hier niets af te lezen.
    ['g0', 'g1', 'g2'].forEach((c, gi) => el.classList.toggle(c, t.group === gi));
    if (wasOpen && t.state !== 'open') {
      el.classList.remove('flip');
      void el.offsetWidth;
      el.classList.add('flip');
    }
  });

  // Onthulde antwoorden. Net als bij de tegels hergebruiken we bestaande
  // elementen: de klok tikt elke seconde, en een nieuw element zou de
  // chip-in-animatie elke keer opnieuw afspelen.
  const wantedAnswers = new Set(state.answers.map((a) => a.group));
  renderedAnswers.forEach((el, g) => { if (!wantedAnswers.has(g)) { el.remove(); renderedAnswers.delete(g); } });

  state.answers.forEach((a) => {
    let chip = renderedAnswers.get(a.group);
    if (!chip) {
      chip = document.createElement('div');
      chip.appendChild(document.createElement('span'));
      const expl = document.createElement('span');
      expl.className = 'expl';
      chip.appendChild(expl);
      answersEl.appendChild(chip);
      renderedAnswers.set(a.group, chip);
    }
    const cls = 'answer-chip g' + a.group + (a.found ? '' : ' not-found');
    if (chip.className !== cls) chip.className = cls;
    chip.style.order = String(a.group);

    const label = chip.firstChild;
    const labelText = (a.found ? '✓ ' : '') + a.text;
    if (label.textContent !== labelText) label.textContent = labelText;

    const expl = chip.lastChild;
    if (expl.textContent !== (a.explanation || '')) expl.textContent = a.explanation || '';
    expl.hidden = !a.explanation;
  });

  // Wachtscherm: de hints zijn er nog niet, en dat is de bedoeling.
  if (!state.started) {
    showOverlay('Even geduld', 'De quizmaster start de ronde zo.');
  } else if (state.status === 'ended') {
    const allFound = state.foundCount === state.answerCount;
    showOverlay(
      allFound ? 'Alles gevonden!' : (state.endedReason === 'time' ? 'Tijd voorbij' : 'Ronde afgelopen'),
      `${state.foundCount} van de ${state.answerCount} antwoorden` +
        (allFound && state.remainingMs > 0 ? ` — ${formatClock(state.remainingMs)} over` : '')
    );
    // Onthulde antwoorden blijven leesbaar: overlay na 2,5s weg.
    setTimeout(hideOverlay, 2500);
  } else {
    hideOverlay();
  }

  lastRev = state.rev;
}

let overlayTimer = null;
function showOverlay(title, sub) {
  $('overlay-title').textContent = title;
  $('overlay-sub').textContent = sub || '';
  overlayEl.classList.remove('hidden');
}
function hideOverlay() {
  overlayEl.classList.add('hidden');
}

// --- Verbinding ----------------------------------------------------------
function setConn(cls, title) {
  connEl.className = 'conn ' + (cls || '');
  connEl.title = title || '';
}

function connect(newCode) {
  code = newCode;
  try { localStorage.setItem('sm_player_code', code); } catch (e) {}
  const clean = '/p/' + code;
  if (location.pathname + location.search !== clean) history.replaceState(null, '', clean);

  if (source) { source.close(); source = null; }
  source = new EventSource('/api/play/stream?code=' + encodeURIComponent(code));

  source.addEventListener('state', (e) => { lastMessageAt = Date.now(); setConn('', 'Verbonden'); render(JSON.parse(e.data)); });
  source.addEventListener('tick', (e) => { lastMessageAt = Date.now(); setConn('', 'Verbonden'); render(JSON.parse(e.data)); });
  source.addEventListener('closed', () => {
    setConn('off', 'Sessie gesloten');
    showOverlay('Sessie gesloten', 'De quizmaster heeft deze sessie beëindigd.');
  });
  source.addEventListener('switched', (e) => {
    // Volgende puzzel op dezelfde code: opnieuw verbinden.
    const data = JSON.parse(e.data);
    renderedTiles.forEach((el) => el.remove());
    renderedTiles.clear();
    renderedAnswers.forEach((el) => el.remove());
    renderedAnswers.clear();
    hideOverlay();
    toast('Volgende puzzel!', 'ok');
    setTimeout(() => connect(data.code || code), 300);
  });
  source.onerror = () => { setConn('slow', 'Opnieuw verbinden…'); };

  startPollingWatchdog();
}

// Terugvaloptie: als er 6 seconden geen bericht binnenkwam, halen we de status op.
function startPollingWatchdog() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!code) return;
    if (Date.now() - lastMessageAt < 6000) return;
    try {
      const res = await fetch('/api/play/state?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (res.status === 404) {
        setConn('off', 'Onbekende code');
        showOverlay('Sessie niet gevonden', 'Vraag de quizmaster om een nieuwe code.');
        return;
      }
      const data = await res.json();
      lastMessageAt = Date.now();
      setConn('slow', 'Verbinding hersteld via polling');
      render(data);
    } catch (e) {
      setConn('off', 'Geen verbinding');
    }
  }, 2000);
}

// Na terugkeer uit de achtergrond meteen bijwerken.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && code) {
    lastMessageAt = 0;
    fetch('/api/play/state?code=' + encodeURIComponent(code), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { lastMessageAt = Date.now(); render(d); } })
      .catch(() => {});
  }
});

// --- Meedoen -------------------------------------------------------------
$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('join-code').value.trim().toUpperCase();
  $('join-error').textContent = '';
  if (!value) return;
  try {
    const res = await fetch('/api/play/state?code=' + encodeURIComponent(value), { cache: 'no-store' });
    if (!res.ok) { $('join-error').textContent = 'Deze code hoort niet bij een actieve sessie.'; return; }
    connect(value);
  } catch (err) {
    $('join-error').textContent = 'Geen verbinding met de server.';
  }
});

(function boot() {
  let initial = codeFromUrl();
  if (!initial) { try { initial = localStorage.getItem('sm_player_code'); } catch (e) {} }
  if (initial) {
    fetch('/api/play/state?code=' + encodeURIComponent(initial), { cache: 'no-store' })
      .then((r) => { if (r.ok) connect(initial); else $('join-code').focus(); })
      .catch(() => $('join-code').focus());
  } else {
    $('join-code').focus();
  }
})();
