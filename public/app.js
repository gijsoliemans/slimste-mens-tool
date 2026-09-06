'use strict';
/* Hostclient. Alles wat hier gebeurt is host-geauthenticeerd. */

const $ = (id) => document.getElementById(id);
const GROUP_COLORS = ['#ffcc33', '#60a5fa', '#f472b6'];

let state = {
  puzzles: [],
  tags: [],
  defaults: { totalSeconds: 60, bonusSeconds: 0, penaltySeconds: 0, shuffle: true },
  editing: null,
  dirty: false,
  session: null,
  sessionClock: { remainingMs: 0, running: false, at: 0 },
  eventSource: null,
  pendingStartPuzzleId: null,
  showValidationDetails: false,
  logSignature: null,
  panelSignature: null
};

// --- API -----------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store'
  }, options));
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (res.status === 401) { showView('login'); throw Object.assign(new Error('Log opnieuw in.'), { handled: true }); }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Fout ${res.status}`);
    err.details = data && data.details;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

function toast(text, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : String(s);
}

// --- Views ---------------------------------------------------------------
const VIEWS = ['login', 'list', 'editor', 'live'];
function showView(name) {
  VIEWS.forEach((v) => $('view-' + v).classList.toggle('hidden', v !== name));
  if (name !== 'live') closeStream();
  window.scrollTo(0, 0);
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close-modal]')) e.target.closest('.modal').classList.add('hidden');
  if (e.target.classList.contains('modal')) e.target.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach((m) => m.classList.add('hidden'));
});

// --- Inloggen ------------------------------------------------------------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/host/login', { method: 'POST', body: JSON.stringify({ password: $('login-password').value }) });
    $('login-password').value = '';
    await loadList();
    showView('list');
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('/api/host/logout', { method: 'POST' }).catch(() => {});
  showView('login');
});

// --- Overzicht -----------------------------------------------------------
async function loadList() {
  const data = await api('/api/puzzles');
  state.puzzles = data.puzzles;
  state.tags = data.tags;
  state.defaults = data.defaults;
  renderTagFilter();
  renderList();
  loadActiveSessions();
}

function renderTagFilter() {
  const sel = $('tag-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">Alle tags</option>';
  state.tags.forEach((t) => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  });
  sel.value = current;
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const tag = $('tag-filter').value;
  const status = $('status-filter').value;
  const list = $('puzzle-list');
  list.innerHTML = '';

  const filtered = state.puzzles.filter((p) => {
    if (tag && !(p.tags || []).includes(tag)) return false;
    if (status === 'complete' && !p.complete) return false;
    if (status === 'draft' && p.complete) return false;
    if (!q) return true;
    return (p.title + ' ' + (p.tags || []).join(' ') + ' ' + (p.notes || '') + ' ' + (p.searchBlob || '')).toLowerCase().includes(q);
  });

  $('list-empty').classList.toggle('hidden', filtered.length > 0);
  if (!filtered.length && (q || tag || status)) $('list-empty').textContent = 'Geen puzzels gevonden met dit filter.';
  else $('list-empty').textContent = 'Nog geen puzzels. Maak er een met “Nieuwe puzzel”.';

  filtered.forEach((p) => list.appendChild(puzzleCard(p)));
}

function puzzleCard(p) {
  const card = document.createElement('article');
  card.className = 'puzzle-card' + (p.complete ? '' : ' draft');

  const head = document.createElement('div');
  head.className = 'row';
  const h = document.createElement('h3');
  h.textContent = p.title;
  head.appendChild(h);
  head.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }));
  const badge = document.createElement('span');
  badge.className = 'tag ' + (p.complete ? 'badge-ready' : 'badge-draft');
  badge.textContent = p.complete ? 'Speelklaar' : 'Concept';
  head.appendChild(badge);
  card.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(
    Object.assign(document.createElement('span'), { textContent: `${p.hintCount}/12 hints` }),
    Object.assign(document.createElement('span'), { textContent: `${p.playCount}× gespeeld` }),
    Object.assign(document.createElement('span'), { textContent: `gewijzigd ${fmtDate(p.updatedAt)}` })
  );
  (p.tags || []).forEach((t) => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.textContent = t;
    meta.appendChild(el);
  });
  card.appendChild(meta);

  if (p.warnings && p.warnings.length) {
    const w = document.createElement('div');
    w.className = 'v-item v-warn';
    w.textContent = p.warnings[0] + (p.warnings.length > 1 ? ` (+${p.warnings.length - 1})` : '');
    card.appendChild(w);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const start = document.createElement('button');
  start.className = 'btn-primary btn-sm';
  start.textContent = '▶ Start sessie';
  start.disabled = !p.complete;
  start.title = p.complete ? '' : 'Deze puzzel is nog niet compleet.';
  start.onclick = () => openStartModal(p);
  const edit = document.createElement('button');
  edit.className = 'btn-ghost btn-sm';
  edit.textContent = 'Bewerken';
  edit.onclick = () => openEditor(p.id);
  const dup = document.createElement('button');
  dup.className = 'btn-ghost btn-sm';
  dup.textContent = 'Dupliceren';
  dup.onclick = async () => {
    await api(`/api/puzzles/${p.id}/duplicate`, { method: 'POST' });
    toast('Gedupliceerd.', 'ok');
    loadList();
  };
  const del = document.createElement('button');
  del.className = 'btn-ghost btn-sm';
  del.textContent = 'Verwijderen';
  del.onclick = async () => {
    if (!confirm(`"${p.title}" definitief verwijderen?`)) return;
    await api(`/api/puzzles/${p.id}`, { method: 'DELETE' });
    toast('Verwijderd.', 'ok');
    loadList();
  };
  actions.append(start, edit, dup, del);
  card.appendChild(actions);
  return card;
}

['search', 'tag-filter', 'status-filter'].forEach((id) => $(id).addEventListener('input', renderList));

async function loadActiveSessions() {
  const box = $('active-sessions');
  try {
    const { sessions } = await api('/api/sessions');
    box.innerHTML = '';
    sessions.forEach((s) => {
      const pill = document.createElement('div');
      pill.className = 'session-pill';
      const dot = document.createElement('span');
      dot.className = 'dot ' + (s.status === 'running' ? '' : s.status);
      pill.appendChild(dot);
      pill.appendChild(Object.assign(document.createElement('span'), {
        textContent: `${s.title} — code ${s.code} — ${s.found}/3`
      }));
      const open = document.createElement('button');
      open.className = 'btn-ghost btn-sm';
      open.textContent = 'Naar sessie';
      open.onclick = () => openSession(s.id);
      pill.appendChild(open);
      box.appendChild(pill);
    });
  } catch (e) { box.innerHTML = ''; }
}

// --- Editor --------------------------------------------------------------
function blankPuzzle() {
  return {
    id: uid(),
    title: '',
    notes: '',
    tags: [],
    answers: [0, 1, 2].map(() => ({
      id: uid(),
      text: '',
      acceptableAlternatives: [],
      explanation: '',
      hints: [0, 1, 2, 3].map(() => ({ id: uid(), text: '' }))
    }))
  };
}

$('btn-new').addEventListener('click', () => {
  state.editing = blankPuzzle();
  state.dirty = false;
  fillEditor();
  showView('editor');
  $('p-title').focus();
});

async function openEditor(id) {
  const { puzzle } = await api('/api/puzzles/' + id);
  // Vul aan tot 3 antwoorden / 4 hints zodat een concept prettig te bewerken is.
  while (puzzle.answers.length < 3) puzzle.answers.push({ id: uid(), text: '', acceptableAlternatives: [], explanation: '', hints: [] });
  puzzle.answers.forEach((a) => {
    a.acceptableAlternatives = a.acceptableAlternatives || [];
    while (a.hints.length < 4) a.hints.push({ id: uid(), text: '' });
  });
  state.editing = puzzle;
  state.dirty = false;
  fillEditor();
  showView('editor');
}

function fillEditor() {
  const p = state.editing;
  $('editor-title-label').textContent = p.title || 'Nieuwe puzzel';
  $('p-title').value = p.title || '';
  $('p-tags').value = (p.tags || []).join(', ');
  $('p-notes').value = p.notes || '';
  renderAnswerBlocks();
  validateEditor();
  markClean();
}

function markDirty() {
  state.dirty = true;
  $('editor-status').textContent = 'Niet opgeslagen';
  $('editor-status').classList.add('dirty');
}
function markClean() {
  state.dirty = false;
  $('editor-status').textContent = 'Opgeslagen';
  $('editor-status').classList.remove('dirty');
}

['p-title', 'p-tags', 'p-notes'].forEach((id) => $(id).addEventListener('input', () => {
  const p = state.editing;
  p.title = $('p-title').value;
  p.tags = $('p-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
  p.notes = $('p-notes').value;
  $('editor-title-label').textContent = p.title || 'Nieuwe puzzel';
  markDirty();
  validateEditor();
}));

function renderAnswerBlocks() {
  const wrap = $('answer-blocks');
  wrap.innerHTML = '';
  state.editing.answers.forEach((answer, ai) => wrap.appendChild(answerBlock(answer, ai)));
}

function answerBlock(answer, ai) {
  const block = document.createElement('section');
  block.className = 'answer-block';
  block.style.setProperty('--group-color', GROUP_COLORS[ai % 3]);
  block.dataset.answerIndex = String(ai);

  const title = document.createElement('h3');
  title.textContent = `Antwoord ${ai + 1}`;
  block.appendChild(title);

  const answerField = document.createElement('div');
  answerField.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = 'Het antwoord';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = answer.text || '';
  input.placeholder = 'Napoleon';
  input.oninput = () => { answer.text = input.value; markDirty(); validateEditor(); };
  answerField.append(lbl, input);
  block.appendChild(answerField);

  // Alternatieven
  const altField = document.createElement('div');
  altField.className = 'field';
  const altLbl = document.createElement('label');
  altLbl.textContent = 'Ook goed rekenen';
  const altList = document.createElement('div');
  altList.className = 'alt-list';
  const renderAlts = () => {
    altList.innerHTML = '';
    (answer.acceptableAlternatives || []).forEach((alt, i) => {
      const chip = document.createElement('span');
      chip.className = 'alt-chip';
      chip.appendChild(document.createTextNode(alt));
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Verwijderen';
      x.onclick = () => { answer.acceptableAlternatives.splice(i, 1); renderAlts(); markDirty(); };
      chip.appendChild(x);
      altList.appendChild(chip);
    });
  };
  renderAlts();
  const altRow = document.createElement('div');
  altRow.className = 'row';
  const altInput = document.createElement('input');
  altInput.type = 'text';
  altInput.placeholder = 'Bijvoorbeeld: Bonaparte';
  const commitAlt = () => {
    const v = altInput.value.trim();
    if (!v) return;
    answer.acceptableAlternatives = answer.acceptableAlternatives || [];
    if (!answer.acceptableAlternatives.includes(v)) answer.acceptableAlternatives.push(v);
    altInput.value = '';
    renderAlts();
    markDirty();
  };
  altInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitAlt(); } };
  // Ook vastleggen bij wegklikken, anders raakt een getypt alternatief zoek.
  altInput.onblur = commitAlt;
  const altAdd = document.createElement('button');
  altAdd.type = 'button';
  altAdd.className = 'btn-ghost btn-sm nowrap';
  altAdd.textContent = '+ Voeg toe';
  altAdd.onmousedown = (e) => e.preventDefault(); // blur niet laten voorgaan
  altAdd.onclick = commitAlt;
  altRow.append(altInput, altAdd);
  altField.append(altLbl, altList, altRow);
  block.appendChild(altField);

  // Hints
  const hintHead = document.createElement('div');
  hintHead.className = 'row';
  const hintLbl = document.createElement('label');
  hintLbl.textContent = 'Hints';
  hintLbl.style.marginBottom = '0';
  const count = document.createElement('span');
  count.className = 'tag hint-count ' + (answer.hints.length === 4 ? 'badge-ready' : 'badge-draft');
  count.textContent = `${answer.hints.length}/4`;
  hintHead.append(hintLbl, Object.assign(document.createElement('div'), { className: 'spacer' }), count);
  block.appendChild(hintHead);

  const list = document.createElement('div');
  list.className = 'hint-list';
  list.dataset.answerIndex = String(ai);
  answer.hints.forEach((hint, hi) => list.appendChild(hintRow(answer, ai, hint, hi)));
  block.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className = 'row';
  const add = document.createElement('button');
  add.className = 'btn-ghost btn-sm';
  add.textContent = '+ Hint';
  add.disabled = answer.hints.length >= 4;
  add.onclick = () => { answer.hints.push({ id: uid(), text: '' }); markDirty(); renderAnswerBlocks(); validateEditor(); };
  addRow.appendChild(add);
  block.appendChild(addRow);

  // Toelichting
  const explField = document.createElement('div');
  explField.className = 'field';
  const explLbl = document.createElement('label');
  explLbl.textContent = 'Toelichting (voor na afloop)';
  const expl = document.createElement('textarea');
  expl.value = answer.explanation || '';
  expl.placeholder = 'Optioneel: leg uit waarom deze vier hints kloppen.';
  expl.oninput = () => { answer.explanation = expl.value; markDirty(); };
  explField.append(explLbl, expl);
  block.appendChild(explField);

  // Drop-doel voor slepen
  block.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    block.classList.add('drop-target');
  });
  block.addEventListener('dragleave', () => block.classList.remove('drop-target'));
  block.addEventListener('drop', (e) => {
    e.preventDefault();
    block.classList.remove('drop-target');
    if (!dragging) return;
    moveHint(dragging.answerIndex, dragging.hintIndex, ai, state.editing.answers[ai].hints.length);
  });

  return block;
}

let dragging = null;

function hintRow(answer, ai, hint, hi) {
  const row = document.createElement('div');
  row.className = 'hint-row';
  row.draggable = true;
  row.dataset.answerIndex = String(ai);
  row.dataset.hintIndex = String(hi);

  const grip = document.createElement('span');
  grip.className = 'grip';
  grip.textContent = '⠿';
  grip.title = 'Sleep naar een ander antwoord';
  row.appendChild(grip);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = hint.text || '';
  input.placeholder = 'Waterloo';
  input.oninput = () => { hint.text = input.value; markDirty(); validateEditor(); };
  row.appendChild(input);

  // Verplaatsknoppen: op mobiel is slepen onhandig.
  const left = document.createElement('button');
  left.className = 'hint-move';
  left.type = 'button';
  left.textContent = '◀';
  left.title = 'Naar vorige antwoord';
  left.disabled = ai === 0;
  left.onclick = () => moveHint(ai, hi, ai - 1, state.editing.answers[ai - 1].hints.length);

  const right = document.createElement('button');
  right.className = 'hint-move';
  right.type = 'button';
  right.textContent = '▶';
  right.title = 'Naar volgende antwoord';
  right.disabled = ai >= state.editing.answers.length - 1;
  right.onclick = () => moveHint(ai, hi, ai + 1, state.editing.answers[ai + 1].hints.length);

  const del = document.createElement('button');
  del.className = 'hint-move';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Hint verwijderen';
  del.onclick = () => { answer.hints.splice(hi, 1); markDirty(); renderAnswerBlocks(); validateEditor(); };

  row.append(left, right, del);

  row.addEventListener('dragstart', (e) => {
    dragging = { answerIndex: ai, hintIndex: hi };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'hint'); } catch (err) {}
  });
  row.addEventListener('dragend', () => {
    dragging = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.drop-before').forEach((el) => el.classList.remove('drop-before'));
  });
  row.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.add('drop-before');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-before');
    if (!dragging) return;
    moveHint(dragging.answerIndex, dragging.hintIndex, ai, hi);
  });

  return row;
}

function moveHint(fromAnswer, fromHint, toAnswer, toHint) {
  const answers = state.editing.answers;
  if (fromAnswer === toAnswer && (fromHint === toHint || fromHint === toHint - 1)) return;
  const [hint] = answers[fromAnswer].hints.splice(fromHint, 1);
  if (!hint) return;
  let index = toHint;
  if (fromAnswer === toAnswer && fromHint < toHint) index--;
  answers[toAnswer].hints.splice(Math.max(0, Math.min(index, answers[toAnswer].hints.length)), 0, hint);
  markDirty();
  renderAnswerBlocks();
  validateEditor();
}

// Clientvalidatie is een spiegel van de servervalidatie; de server blijft leidend.
function validateEditor() {
  const p = state.editing;
  const errors = [];
  const warnings = [];
  if (!(p.title || '').trim()) errors.push('De puzzel heeft geen titel.');
  const hintTexts = [];
  const answerTexts = [];
  p.answers.forEach((a, i) => {
    const label = `Antwoord ${i + 1}`;
    if (!(a.text || '').trim()) errors.push(`${label} heeft geen tekst.`);
    else answerTexts.push(a.text.trim().toLowerCase());
    if (a.hints.length !== 4) errors.push(`${label} heeft precies 4 hints nodig (nu ${a.hints.length}).`);
    a.hints.forEach((h, j) => {
      const t = (h.text || '').trim();
      if (!t) errors.push(`${label}, hint ${j + 1} is leeg.`);
      else hintTexts.push(t.toLowerCase());
    });
  });
  const seen = new Set();
  hintTexts.forEach((t) => {
    if (seen.has(t)) warnings.push(`De hint "${t}" komt meerdere keren voor.`);
    else seen.add(t);
  });
  hintTexts.forEach((t) => { if (answerTexts.includes(t)) warnings.push(`De hint "${t}" is gelijk aan een antwoord.`); });

  const unique = (arr) => Array.from(new Set(arr));
  const errs = unique(errors);
  const warns = unique(warnings);

  const box = $('validation');
  box.innerHTML = '';

  if (!errs.length) {
    box.appendChild(vItem('v-ok', '✓ Speelklaar: 3 antwoorden, 12 hints.'));
  } else {
    // Eén samenvattende regel; de losse punten pas op verzoek, anders duwt een
    // lege nieuwe puzzel de antwoordblokken van het scherm.
    const filled = p.answers.reduce((n, a) => n + a.hints.filter((h) => (h.text || '').trim()).length, 0);
    const summary = vItem('v-error', `Nog niet speelklaar — ${filled}/12 hints ingevuld, ${errs.length} punt${errs.length === 1 ? '' : 'en'} open.`);
    const toggle = document.createElement('button');
    toggle.className = 'btn-ghost btn-sm';
    toggle.style.marginLeft = '.6rem';
    toggle.textContent = state.showValidationDetails ? 'Verberg details' : 'Toon details';
    toggle.onclick = () => { state.showValidationDetails = !state.showValidationDetails; validateEditor(); };
    summary.appendChild(toggle);
    box.appendChild(summary);
    if (state.showValidationDetails) errs.forEach((t) => box.appendChild(vItem('v-error', '✗ ' + t)));
  }

  warns.forEach((t) => box.appendChild(vItem('v-warn', '⚠ ' + t)));
  $('btn-preview').disabled = errs.length > 0;
  return { errors: errs, warnings: warns };
}

function vItem(cls, text) {
  const el = document.createElement('div');
  el.className = 'v-item ' + cls;
  el.textContent = text;
  return el;
}

async function savePuzzle(draft) {
  try {
    const { puzzle } = await api('/api/puzzles', {
      method: 'POST',
      body: JSON.stringify({ puzzle: state.editing, draft: !!draft })
    });
    state.editing.id = puzzle.id;
    markClean();
    toast(draft ? 'Opgeslagen als concept.' : 'Opgeslagen.', 'ok');
    await loadList();
    return true;
  } catch (err) {
    if (err.details && err.details.errors) {
      state.showValidationDetails = true;
      validateEditor();
      toast('Opslaan geweigerd: ' + err.details.errors[0], 'error');
    } else {
      toast(err.message, 'error');
    }
    return false;
  }
}

$('btn-save').addEventListener('click', () => savePuzzle(false));
$('btn-save-draft').addEventListener('click', () => savePuzzle(true));
$('editor-back').addEventListener('click', () => {
  if (state.dirty && !confirm('Er zijn niet-opgeslagen wijzigingen. Toch terug?')) return;
  showView('list');
  loadList();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && !$('view-editor').classList.contains('hidden')) {
    e.preventDefault();
    savePuzzle(false);
  }
});

// --- Voorbeeld speler ----------------------------------------------------
function renderPreview() {
  const hints = [];
  state.editing.answers.forEach((a) => a.hints.forEach((h) => hints.push(h.text)));
  for (let i = hints.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [hints[i], hints[j]] = [hints[j], hints[i]];
  }
  const wrap = $('preview-tiles');
  wrap.innerHTML = '';
  hints.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'ptile';
    el.textContent = t;
    wrap.appendChild(el);
  });
}
$('btn-preview').addEventListener('click', () => { renderPreview(); openModal('modal-preview'); });
$('preview-reshuffle').addEventListener('click', renderPreview);

// --- Import / export -----------------------------------------------------
$('btn-export').addEventListener('click', async () => {
  const data = await api('/api/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `puzzels-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`${data.puzzles.length} puzzels geëxporteerd.`, 'ok');
});

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const result = await api('/api/import', { method: 'POST', body: JSON.stringify({ data: parsed, mode: 'copy' }) });
    toast(`${result.added} puzzels geïmporteerd.`, 'ok');
    loadList();
  } catch (err) {
    toast('Importeren mislukt: ' + err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

// --- Instellingen --------------------------------------------------------
$('btn-settings').addEventListener('click', () => {
  $('d-total').value = state.defaults.totalSeconds;
  $('d-bonus').value = state.defaults.bonusSeconds;
  $('d-penalty').value = state.defaults.penaltySeconds;
  $('d-shuffle').value = state.defaults.shuffle ? '1' : '0';
  $('d-password').value = '';
  openModal('modal-settings');
});

$('settings-save').addEventListener('click', async () => {
  try {
    const { defaults } = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        totalSeconds: Number($('d-total').value),
        bonusSeconds: Number($('d-bonus').value),
        penaltySeconds: Number($('d-penalty').value),
        shuffle: $('d-shuffle').value === '1'
      })
    });
    state.defaults = defaults;
    const pw = $('d-password').value;
    if (pw) {
      await api('/api/host/password', { method: 'POST', body: JSON.stringify({ password: pw }) });
      toast('Wachtwoord gewijzigd.', 'ok');
    }
    closeModal('modal-settings');
    toast('Instellingen opgeslagen.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

// --- Sessie starten ------------------------------------------------------
function openStartModal(p) {
  state.pendingStartPuzzleId = p.id;
  $('start-puzzle-title').textContent = p.title;
  $('s-total').value = state.defaults.totalSeconds;
  $('s-bonus').value = state.defaults.bonusSeconds;
  $('s-penalty').value = state.defaults.penaltySeconds;
  $('s-shuffle').value = state.defaults.shuffle ? '1' : '0';
  $('s-save-defaults').checked = false;
  openModal('modal-start');
}

$('start-confirm').addEventListener('click', async () => {
  try {
    const { session } = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        puzzleId: state.pendingStartPuzzleId,
        saveDefaults: $('s-save-defaults').checked,
        settings: {
          totalSeconds: Number($('s-total').value),
          bonusSeconds: Number($('s-bonus').value),
          penaltySeconds: Number($('s-penalty').value),
          shuffle: $('s-shuffle').value === '1'
        }
      })
    });
    closeModal('modal-start');
    enterSession(session);
  } catch (err) { toast(err.message, 'error'); }
});

async function openSession(id) {
  try {
    const session = await api('/api/sessions/' + id);
    enterSession(session);
  } catch (err) { toast(err.message, 'error'); loadActiveSessions(); }
}

function enterSession(session) {
  state.session = session;
  state.logSignature = null;
  state.panelSignature = null;
  try { sessionStorage.setItem('sm_last_session', session.id); } catch (e) {}
  showView('live');
  renderSession(session);
  openStream(session.id);
}

// --- Live: SSE -----------------------------------------------------------
let liveWatchdog = null;
let lastLiveMessage = 0;

function openStream(id) {
  closeStream();
  const src = new EventSource('/api/sessions/' + id + '/stream');
  state.eventSource = src;
  const onState = (e) => { lastLiveMessage = Date.now(); renderSession(JSON.parse(e.data)); };
  src.addEventListener('state', onState);
  src.addEventListener('tick', onState);
  src.addEventListener('closed', () => { toast('Sessie is gesloten.', 'warn'); closeStream(); showView('list'); loadList(); });

  liveWatchdog = setInterval(async () => {
    if (Date.now() - lastLiveMessage < 6000) return;
    try {
      const data = await api('/api/sessions/' + id);
      lastLiveMessage = Date.now();
      renderSession(data);
    } catch (e) { /* de sessie kan gesloten zijn */ }
  }, 2500);
}

function closeStream() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  if (liveWatchdog) { clearInterval(liveWatchdog); liveWatchdog = null; }
}

async function action(payload) {
  if (!state.session) return;
  try {
    const data = await api(`/api/sessions/${state.session.id}/action`, { method: 'POST', body: JSON.stringify(payload) });
    lastLiveMessage = Date.now();
    renderSession(data);
  } catch (err) {
    if (err.code === 'time-up') toast('De tijd was al voorbij — dit telt niet meer. Je kunt het antwoord wel onthullen.', 'warn');
    else if (err.code === 'not-started') toast('Start eerst de klok.', 'warn');
    else toast(err.message, 'error');
  }
}

// --- Live: render --------------------------------------------------------
const LIVE_STATUS = {
  idle: 'Klaar om te beginnen',
  running: 'De klok loopt',
  paused: 'Gepauzeerd',
  ended: 'Ronde afgelopen'
};

function renderSession(s) {
  state.session = s;
  state.sessionClock = { remainingMs: s.remainingMs, running: s.running, at: Date.now() };
  paintLiveClock();

  $('live-title').textContent = s.title;
  $('live-code').textContent = s.code;
  $('live-status').textContent = LIVE_STATUS[s.status] + (s.endedReason === 'time' ? ' (tijd op)' : s.endedReason === 'complete' ? ' (alles gevonden)' : '');
  $('player-count').textContent = `${s.players || 0} kijker${(s.players || 0) === 1 ? '' : 's'}`;
  $('score-found').textContent = s.foundCount;
  $('score-total').textContent = s.answers.length;
  $('score-wrong').textContent = s.wrongCount;
  $('live-notes').textContent = s.notes || '';
  $('btn-undo').disabled = !s.canUndo;
  $('btn-start').disabled = s.status === 'running' || s.status === 'ended';
  $('btn-pause').disabled = s.status !== 'running';

  // De klok tikt elke seconde. Het logboek en het antwoordpaneel alleen
  // opnieuw opbouwen als er echt iets veranderd is, anders raakt de host bij
  // elke tik zijn toetsenbordfocus op een knop kwijt.
  const logSignature = s.log.length + '|' + (s.log.length ? s.log[s.log.length - 1].text : '');
  if (logSignature !== state.logSignature) {
    state.logSignature = logSignature;
    const log = $('live-log');
    log.innerHTML = '';
    s.log.slice().reverse().forEach((entry) => {
      const el = document.createElement('div');
      el.textContent = `${formatClock(entry.remainingMs)} — ${entry.text}`;
      log.appendChild(el);
    });
  }

  const panelSignature = s.answers.map((a) => `${a.id}:${a.found ? 1 : 0}${a.revealed ? 1 : 0}`).join('|');
  if (panelSignature !== state.panelSignature) {
    state.panelSignature = panelSignature;
    const panel = $('live-answers');
    panel.innerHTML = '';
    s.answers.forEach((a) => panel.appendChild(liveAnswer(a, s)));
  }
}

function liveAnswer(a, s) {
  const el = document.createElement('article');
  el.className = 'live-answer' + (a.found ? ' found' : (a.revealed ? ' revealed' : ''));
  el.style.setProperty('--group-color', GROUP_COLORS[a.group % 3]);

  const left = document.createElement('div');
  const text = document.createElement('div');
  text.className = 'answer-text';
  text.textContent = a.text;
  left.appendChild(text);

  if (a.acceptableAlternatives.length) {
    const alts = document.createElement('div');
    alts.className = 'alts';
    alts.innerHTML = 'Ook goed: ';
    a.acceptableAlternatives.forEach((alt, i) => {
      const b = document.createElement('b');
      b.textContent = alt;
      alts.appendChild(b);
      if (i < a.acceptableAlternatives.length - 1) alts.appendChild(document.createTextNode(', '));
    });
    left.appendChild(alts);
  }
  if (a.explanation) {
    const expl = document.createElement('div');
    expl.className = 'expl';
    expl.textContent = a.explanation;
    left.appendChild(expl);
  }
  el.appendChild(left);

  const actions = document.createElement('div');
  actions.className = 'answer-actions';
  if (a.found) {
    const flag = document.createElement('div');
    flag.className = 'found-flag';
    flag.textContent = '✓ Gevonden';
    actions.appendChild(flag);
  } else {
    const good = document.createElement('button');
    good.className = 'btn-good';
    good.textContent = '✓ Goed';
    good.onclick = () => action({ type: 'correct', answerId: a.id });
    actions.appendChild(good);
  }
  const reveal = document.createElement('button');
  reveal.className = 'btn-ghost btn-sm';
  reveal.textContent = a.revealed ? 'Onthuld' : 'Onthul';
  reveal.disabled = a.revealed;
  reveal.onclick = () => action({ type: 'reveal', answerId: a.id });
  actions.appendChild(reveal);
  el.appendChild(actions);

  const chips = document.createElement('div');
  chips.className = 'hint-chips';
  a.hints.forEach((h) => {
    const chip = document.createElement('span');
    chip.className = 'hint-chip';
    chip.textContent = h.text;
    chip.title = `Tegel ${h.order + 1} bij de speler`;
    chips.appendChild(chip);
  });
  el.appendChild(chips);
  return el;
}

function paintLiveClock() {
  const c = state.sessionClock;
  const ms = c.running ? Math.max(0, c.remainingMs - (Date.now() - c.at)) : c.remainingMs;
  const el = $('live-clock');
  el.textContent = formatClock(ms);
  el.classList.toggle('danger', ms <= 10000);
  el.classList.toggle('warn', ms > 10000 && ms <= 20000);
}
setInterval(paintLiveClock, 100);

// --- Live: knoppen -------------------------------------------------------
$('btn-start').addEventListener('click', () => action({ type: 'start' }));
$('btn-pause').addEventListener('click', () => action({ type: 'pause' }));
$('btn-reset').addEventListener('click', () => { if (confirm('Ronde resetten? Klok en gevonden antwoorden gaan terug naar het begin.')) action({ type: 'reset' }); });
$('btn-wrong').addEventListener('click', () => action({ type: 'wrong' }));
$('btn-undo').addEventListener('click', () => action({ type: 'undo' }));
$('btn-reveal-all').addEventListener('click', () => action({ type: 'revealAll' }));
document.querySelectorAll('[data-time]').forEach((b) => {
  b.addEventListener('click', () => action({ type: 'addTime', seconds: Number(b.dataset.time) }));
});

$('btn-end-session').addEventListener('click', async () => {
  if (!confirm('Sessie sluiten? De spelerslink werkt daarna niet meer.')) return;
  await api('/api/sessions/' + state.session.id, { method: 'DELETE' }).catch(() => {});
  closeStream();
  showView('list');
  loadList();
});

$('live-back').addEventListener('click', () => { showView('list'); loadList(); });

$('copy-link').addEventListener('click', async () => {
  const link = playerLink();
  try {
    await navigator.clipboard.writeText(link);
    toast('Link gekopieerd: ' + link, 'ok');
  } catch (e) {
    prompt('Kopieer deze link:', link);
  }
});
$('open-player').addEventListener('click', () => window.open(playerLink(), '_blank', 'noopener'));

function playerLink() {
  return `${location.origin}/p/${state.session.code}`;
}

// --- Volgende puzzel -----------------------------------------------------
$('btn-next-puzzle').addEventListener('click', () => {
  const sel = $('next-puzzle');
  sel.innerHTML = '';
  state.puzzles.filter((p) => p.complete && p.id !== state.session.puzzleId).forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.title;
    sel.appendChild(o);
  });
  if (!sel.children.length) { toast('Geen andere speelklare puzzel gevonden.', 'warn'); return; }
  openModal('modal-next');
});

$('next-confirm').addEventListener('click', async () => {
  try {
    const { session } = await api(`/api/sessions/${state.session.id}/next`, {
      method: 'POST',
      body: JSON.stringify({ puzzleId: $('next-puzzle').value })
    });
    closeModal('modal-next');
    closeStream();
    enterSession(session);
    toast('Volgende puzzel klaar. De speler houdt dezelfde link.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

// Sneltoetsen tijdens een live ronde.
document.addEventListener('keydown', (e) => {
  if ($('view-live').classList.contains('hidden')) return;
  if (e.target.matches('input, textarea, select')) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  if (e.code === 'Space') { e.preventDefault(); action({ type: state.session.running ? 'pause' : 'start' }); }
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    const a = state.session.answers[Number(e.key) - 1];
    if (a && !a.found) action({ type: 'correct', answerId: a.id });
  }
  if (e.key.toLowerCase() === 'x') action({ type: 'wrong' });
  if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); action({ type: 'undo' }); }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty && !$('view-editor').classList.contains('hidden')) { e.preventDefault(); e.returnValue = ''; }
});

// --- Boot ----------------------------------------------------------------
(async function boot() {
  try {
    const me = await api('/api/host/me');
    if (!me.host) { showView('login'); $('login-password').focus(); return; }
    await loadList();
    // Was er een live sessie open voor de herlaad? Ga er direct naar terug.
    let last = null;
    try { last = sessionStorage.getItem('sm_last_session'); } catch (e) {}
    if (last) {
      try { enterSession(await api('/api/sessions/' + last)); return; } catch (e) {}
    }
    showView('list');
  } catch (err) {
    showView('login');
  }
})();

setInterval(() => { if (!$('view-list').classList.contains('hidden')) loadActiveSessions(); }, 5000);
