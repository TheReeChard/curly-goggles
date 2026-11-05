import { db } from './db.js';
import { decode, resize, toBlob, analyze, getFaceDetector } from './images.js';
import * as G from './google.js';
import { fromFiles } from './importers.js';
import { EVENT_TYPES, regroup, select, checks, fmtRange, fmtDate, ymd, uid, sortEvents } from './curate.js';
import { filingPdf, keepsakePdf } from './pdf.js';
import { runAI, key as aiKey, PROVIDERS } from './ai.js';
import { fillLocations } from './places.js';
import { scanFaces, applyNames, peopleToName, faceThumb, personName, peopleText, ROLES } from './people.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  project: { petitioner: '', beneficiary: '', receipt: '', title: '', story: '' },
  settings: { filingPerEvent: 3, filingMax: 60, keepsakePerEvent: 12, autoAI: true, aiProvider: 'anthropic', aiModels: {}, placeNames: true, findPeople: true },
  photos: [],
  events: [],
  people: [],
};

// ---------- persistence ----------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { photos, events, project, settings, people } = state;
      await db.put('meta', 'state', JSON.parse(JSON.stringify({ photos, events, project, settings, people })));
    } catch (e) { console.warn('save failed', e); }
  }, 400);
}
async function load() {
  try {
    const s = await db.get('meta', 'state');
    if (s) Object.assign(state, s, { settings: { ...state.settings, ...s.settings }, project: { ...state.project, ...s.project } });
  } catch (e) { console.warn('load failed', e); }
}

// ---------- thumbnails (lazy) ----------
const urlCache = new Map();
async function thumbUrl(id, kind = 'thumb') {
  const k = `${kind}:${id}`;
  if (urlCache.has(k)) return urlCache.get(k);
  const blob = await db.get('blobs', k);
  const url = blob ? URL.createObjectURL(blob) : '';
  urlCache.set(k, url);
  return url;
}
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    io.unobserve(en.target);
    thumbUrl(en.target.dataset.id).then((u) => { if (u) en.target.src = u; });
  }
}, { rootMargin: '300px' });

// ---------- progress ----------
function progress(done, total, text) {
  const box = $('#progress');
  box.hidden = total === 0;
  $('#progress .bar span').style.width = total ? `${(100 * done) / total}%` : '0';
  $('#progress-text').textContent = text || '';
}

// ---------- import pipeline ----------
let importing = false;
async function importItems(items, getBlob) {
  const known = new Set(state.photos.map((p) => p.key));
  const todo = items.filter((it) => !known.has(it.key));
  if (!todo.length) { progress(0, 0); toast('Those photos are already in your timeline.'); return; }
  importing = true;
  getFaceDetector(); // start loading the model early
  let done = 0, failed = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        const blob = it.blob || (await getBlob(it));
        if (it.getGps && it.lat == null) Object.assign(it, (await it.getGps()) || {});
        const bmp = await decode(blob);
        const full = resize(bmp, 1600);
        const thumb = resize(full, 360);
        const a = await analyze(full);
        const id = uid();
        await db.put('blobs', `full:${id}`, await toBlob(full, 0.86));
        await db.put('blobs', `thumb:${id}`, await toBlob(thumb, 0.8));
        bmp.close?.();
        state.photos.push({
          id, key: it.key, name: it.name, source: it.source || 'file',
          takenAt: it.takenAt ?? null, dateGuessed: !!it.dateGuessed, lat: it.lat ?? null, lng: it.lng ?? null,
          w: full.width, h: full.height, ...a, pick: 'auto', caption: '', eventId: null,
        });
      } catch (e) {
        failed++;
        console.warn('import failed', it.name, e);
      }
      done++;
      progress(done, todo.length, `Sorting and scoring photos… ${done} of ${todo.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  importing = false;
  regroup(state);
  refresh();
  progress(0, 0);
  toast(`Added ${done - failed} photo${done - failed === 1 ? '' : 's'}${failed ? ` (${failed} couldn't be read)` : ''}.`);
  await autoFaces();
  await autoPlaces();
  if (currentKey() && state.settings.autoAI) await doAI();
}

// ---------- people ----------
let nameTimer;
let scanning = false;
async function autoFaces(force) {
  if ((!state.settings.findPeople && !force) || scanning) return;
  if (!state.photos.some((p) => !p.faceScan)) { renderPeople(); return; }
  scanning = true;
  $('#people-scan').disabled = true;
  try {
    await scanFaces(state, (d, t, text) => { progress(d, t, text); $('#people-status').textContent = text; });
    $('#people-status').textContent = '';
    refresh();
  } catch (e) {
    $('#people-status').textContent = e.message;
  } finally {
    scanning = false;
    $('#people-scan').disabled = false;
    progress(0, 0);
  }
}

function renderPeople() {
  const box = $('#people');
  const list = peopleToName(state);
  if (!list.length) {
    box.innerHTML = `<p class="muted small">${state.photos.some((p) => p.faceScan) ? 'No one appears in more than one photo yet.' : 'Add photos, then click "Find people".'}</p>`;
    return;
  }
  const opts = ROLES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  box.innerHTML = list.map((pp) => `<div class="person${pp.role ? ' done' : ''}" data-pid="${pp.id}">
      <img alt="" data-face="${pp.id}">
      <div class="pmeta">
        <select data-pk="role">${opts.replace(`value="${pp.role}"`, `value="${pp.role}" selected`)}</select>
        <input data-pk="name" placeholder="Name" value="${esc(personName(state, pp))}" ${pp.role === 'ignore' ? 'disabled' : ''}>
        <span class="muted small">in ${pp.count} photo${pp.count === 1 ? '' : 's'}</span>
      </div>
    </div>`).join('');
  for (const pp of list) faceThumb(pp).then((u) => { const img = box.querySelector(`[data-face="${pp.id}"]`); if (img) img.src = u; }).catch(() => {});
  const unnamed = list.filter((pp) => !pp.role).length;
  $('#people-status').textContent = unnamed ? `${unnamed} ${unnamed === 1 ? 'person needs' : 'people need'} a name. Pick who each person is: the two of you first.` : '';
}

function onPersonChange(ev) {
  const el = ev.target.closest('[data-pk]');
  const card = ev.target.closest('[data-pid]');
  if (!el || !card) return;
  const pp = state.people.find((x) => x.id === card.dataset.pid);
  const P = state.project;
  if (el.dataset.pk === 'role') {
    pp.role = el.value;
    const field = pp.role === 'petitioner' || pp.role === 'beneficiary' ? pp.role : null;
    if (field && !P[field]?.trim() && pp.name) P[field] = pp.name;
  } else {
    pp.name = el.value.trim();
    if (pp.role === 'petitioner' || pp.role === 'beneficiary') P[pp.role] = pp.name;
    if (!pp.role && pp.name) pp.role = 'family';
  }
  // the same name given to two groups = the same person
  applyNames(state);
  fillForms();
  refresh();
}

// ---------- place names ----------
async function autoPlaces() {
  if (!state.settings.placeNames) return;
  if (!state.photos.some((p) => p.lat != null)) return;
  const n = await fillLocations(state);
  if (n) { refresh(); toast(`Added the location to ${n} event${n === 1 ? '' : 's'} from photo GPS. Check them.`); }
}

// ---------- AI ----------
const sessionKeys = {};
const provider = () => state.settings.aiProvider || 'anthropic';
const currentKey = () => sessionKeys[provider()] || aiKey.get(provider());
let aiRunning = false;
async function doAI(only) {
  const status = (t) => { $('#ai-status').textContent = t; };
  const k = currentKey();
  const P = PROVIDERS[provider()];
  if (!k) { status(`Add your ${P.label} API key first.`); $('#ai-key').focus(); return; }
  if (aiRunning || importing) return;
  if (!state.photos.length) { status('Add photos first.'); return; }
  aiRunning = true;
  $$('#ai-run, [data-act=ai]').forEach((b) => (b.disabled = true));
  try {
    const model = $('#ai-model').value || state.settings.aiModels?.[provider()];
    const res = await runAI(state, { provider: provider(), apiKey: k, model, only, onProgress: (d, t, text) => { progress(d, t, text); status(text); } });
    regroup(state);
    refresh();
    status(res.errors.length
      ? `Finished with problems: ${res.errors.join(' ')}`
      : `${P.label} chose photos and drafted text for ${res.reviewed} event(s). Everything marked ✨ is a draft — please read it.`);
  } catch (e) {
    status(e.message);
  } finally {
    aiRunning = false;
    progress(0, 0);
    $$('#ai-run, [data-act=ai]').forEach((b) => (b.disabled = false));
  }
}
async function loadModels() {
  const pid = provider();
  const P = PROVIDERS[pid];
  const sel = $('#ai-model');
  const k = currentKey();
  const saved = state.settings.aiModels?.[pid];
  const fill = (ids, note) => {
    sel.innerHTML = ids.map((id) => `<option${id === saved ? ' selected' : ''}>${esc(id)}</option>`).join('') || '<option value="">—</option>';
    $('#ai-model-note').textContent = note || '';
  };
  if (!k && pid !== 'anthropic') return fill([], 'Enter your key to see the available models.');
  try {
    fill(await P.listModels(k), pid === 'anthropic' ? '' : 'Pick the newest full-size model for the best results.');
  } catch (e) {
    fill(saved ? [saved] : [], e.message);
  }
}
function setupAI() {
  const input = $('#ai-key'), remember = $('#ai-remember'), pick = $('#ai-provider');
  state.settings.aiModels ||= {};
  pick.innerHTML = Object.values(PROVIDERS).map((P) => `<option value="${P.id}">${esc(P.label)}</option>`).join('');
  const showProvider = () => {
    const P = PROVIDERS[provider()];
    pick.value = P.id;
    const saved = aiKey.get(P.id);
    input.value = sessionKeys[P.id] || saved;
    input.placeholder = P.keyHint;
    remember.checked = !!saved;
    $('#ai-key-label').textContent = `${P.label} API key`;
    $('#ai-key-url').textContent = P.keyUrl;
    $('#ai-who').textContent = P.label.replace(/ \(.*/, '');
    loadModels();
  };
  const apply = () => {
    sessionKeys[provider()] = input.value.trim();
    aiKey.set(provider(), remember.checked ? sessionKeys[provider()] : '');
  };
  pick.onchange = () => { state.settings.aiProvider = pick.value; save(); showProvider(); };
  input.onchange = () => { apply(); loadModels(); };
  remember.onchange = apply;
  $('#ai-model').onchange = (e) => { state.settings.aiModels[provider()] = e.target.value; save(); };
  $('#place-names').checked = state.settings.placeNames;
  $('#place-names').onchange = (e) => { state.settings.placeNames = e.target.checked; save(); if (e.target.checked) autoPlaces(); };
  $('#ai-auto').checked = state.settings.autoAI;
  $('#ai-auto').onchange = (e) => { state.settings.autoAI = e.target.checked; save(); };
  $('#ai-run').onclick = () => { apply(); doAI(); };
  showProvider();
}

async function handleFiles(files) {
  if (importing || !files?.length) return;
  progress(0, 1, 'Reading files…');
  try {
    const { items, skipped } = await fromFiles(files);
    if (skipped.length) toast(`${skipped.length} HEIC photo(s) skipped — this browser can't open them. Download them from Google Photos as JPG, or use Google sign-in.`, 8000);
    if (!items.length) { progress(0, 0); if (!skipped.length) toast('No photos found in those files.'); return; }
    await importItems(items);
  } catch (e) {
    progress(0, 0);
    toast(`Couldn't read those files: ${e.message}`, 8000);
  }
}

// ---------- Google ----------
function setupGoogle() {
  const status = (t) => { $('#g-status').textContent = t; };
  if (!G.isConfigured()) {
    $('#g-signin').disabled = true;
    status('Google sign-in isn\'t set up yet: add your Client ID to js/config.js (see README).');
    return;
  }
  G.prepare().catch((e) => status(e.message));
  $('#g-signin').onclick = async () => {
    try {
      await G.signIn();
      $('#g-pick').disabled = false;
      $('#g-signin').textContent = 'Switch Google account';
      $('#g-signin').classList.remove('primary');
      $('#g-signin').classList.add('ghost');
      status('Signed in. Now choose your photos.');
    } catch (e) { status(e.message); }
  };
  let picking = null; // AbortController while waiting for Google's picker
  $('#g-pick').onclick = async () => {
    if (picking) { picking.abort(); return; } // button acts as "Cancel" while waiting
    if (importing) return;
    if (!G.isSignedIn()) { status('Your sign-in expired. Sign in again.'); $('#g-pick').disabled = true; $('#g-signin').textContent = 'Sign in with Google'; return; }
    const win = window.open('about:blank', '_blank');
    picking = new AbortController();
    $('#g-pick').textContent = 'Cancel';
    let session;
    try {
      session = await G.pick(win, status, {
        signal: picking.signal,
        onLink: (uri) => {
          const box = $('#g-status');
          box.innerHTML = '';
          const a = document.createElement('a');
          a.href = uri; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = 'Open Google Photos to choose your photos';
          box.append(a, ' — then tap Done there and come back to this page.');
        },
      });
      picking = null;
      $('#g-pick').textContent = 'Choose photos';
      if (session.videos) toast(`Skipped ${session.videos} video${session.videos === 1 ? "" : "s"}. Only photos can go in the PDFs.`, 6000);
      if (!session.items.length) { status("No photos were selected, only videos."); return; }
      status(`Downloading ${session.items.length} photos…`);
      const items = session.items.map((m) => ({
        key: `gp:${m.id}`,
        name: m.mediaFile?.filename || m.id,
        source: 'google',
        takenAt: m.createTime ? Date.parse(m.createTime) : null,
        item: m,
        getGps: () => G.gps(m),
      }));
      await importItems(items, (it) => G.download(it.item));
      status('Done. You can pick more photos any time.');
    } catch (e) {
      status(e.message);
      progress(0, 0);
    } finally {
      picking = null;
      $('#g-pick').textContent = 'Choose photos';
      if (session) G.endSession(session.sessionId);
      try { if (win && !win.closed) win.close(); } catch {}
    }
  };
}

// ---------- rendering ----------
function refresh() {
  select(state);
  renderEvents();
  renderChecks();
  renderSummary();
  renderPeople();
  $('[data-field=story]').value = state.project.story || '';
  $('[data-field=story]').classList.toggle('ai', !!state.project.storyAI);
  save();
}

function renderSummary() {
  const n = state.photos.length;
  const f = state.photos.filter((p) => p.filing).length;
  const k = state.photos.filter((p) => p.keepsake).length;
  $('#photo-summary').textContent = n
    ? `${n} photos in ${state.events.length} events · ${f} chosen for the filing PDF · ${k} for the keepsake`
    : 'No photos yet.';
}

function renderChecks() {
  $('#warnings').innerHTML = checks(state).map((c) => `<li class="${c.level}">${esc(c.text)}</li>`).join('');
}

const expanded = new Set();
function photoTile(p) {
  const cls = p.filing ? 'filing' : p.keepsake ? 'keepsake' : 'out';
  const badge = p.filing ? `<b>★ ${esc(p.exhibit)}</b>` : p.keepsake ? '<b>♥</b>' : '';
  const pin = p.pick === 'pinned' ? '<i title="Always include">📌</i>' : p.pick === 'excluded' ? '<i title="Left out">⦸</i>' : '';
  return `<button class="ph ${cls}" data-photo="${p.id}" title="${esc(p.name)}"><img data-id="${p.id}" alt="">${badge}${pin}</button>`;
}

function renderEvents() {
  const box = $('#events');
  const opts = EVENT_TYPES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  box.innerHTML = state.events.map((e, idx) => {
    const ps = state.photos.filter((p) => p.eventId === e.id)
      .sort((a, b) => (b.filing - a.filing) || (b.keepsake - a.keepsake) || (b.score - a.score));
    const show = expanded.has(e.id) ? ps : ps.slice(0, 24);
    const nf = ps.filter((p) => p.filing).length, nk = ps.filter((p) => p.keepsake).length;
    return `<article class="event${e.auto ? ' auto' : ''}" data-id="${e.id}">
      <div class="ev-head">
        <input class="ev-title${e.ai?.title ? ' ai' : ''}" data-k="title" value="${esc(e.title)}" placeholder="Name this event" aria-label="Event name">
        <select data-k="type" aria-label="Event type">${opts.replace(`value="${e.type}"`, `value="${e.type}" selected`)}</select>
      </div>
      <div class="ev-fields">
        <label>From<input type="date" data-k="start" value="${esc(e.start)}"></label>
        <label>To<input type="date" data-k="end" value="${esc(e.end)}"></label>
        <label class="grow">Where<input class="${e.ai?.location ? 'ai' : ''}" data-k="location" value="${esc(e.location)}" placeholder="City, country"></label>
      </div>
      <textarea class="${e.ai?.description ? 'ai' : ''}" data-k="description" rows="2" placeholder="What happened? Who was there?">${esc(e.description)}</textarea>
      <input data-k="documents" value="${esc(e.documents)}" placeholder="Documents for this event (e.g. boarding passes, lease, receipts)">
      ${ps.length ? `<div class="strip">${show.map(photoTile).join('')}</div>` : ''}
      <div class="ev-foot">
        <span class="muted">${fmtRange(e.start, e.end)} · ${ps.length} photo${ps.length === 1 ? '' : 's'}${ps.length ? ` · ★ ${nf} · ♥ ${nk}` : ''}${e.exhibit ? ` · Exhibit ${e.exhibit}` : ''}</span>
        <span class="row">
          ${Object.values(e.ai || {}).some(Boolean) ? '<span class="chip">✨ AI draft</span>' : ''}
          ${ps.length ? `<button class="ghost sm" data-act="ai">✨ ${e.aiReviewed ? 'Redo' : 'Choose & write'} with AI</button>` : ''}
          ${ps.length > 24 ? `<button class="ghost sm" data-act="expand">${expanded.has(e.id) ? 'Show fewer' : `Show all ${ps.length}`}</button>` : ''}
          ${idx > 0 ? '<button class="ghost sm" data-act="merge">Merge into previous</button>' : ''}
          <button class="ghost sm danger" data-act="delete">Delete</button>
        </span>
      </div>
    </article>`;
  }).join('') || '<p class="muted">Your events will appear here after you add photos, or add one yourself.</p>';
  $$('img[data-id]', box).forEach((img) => io.observe(img));
}

// ---------- event editing ----------
function onEventInput(ev) {
  const el = ev.target.closest('[data-k]');
  const card = ev.target.closest('.event');
  if (!el || !card) return;
  const e = state.events.find((x) => x.id === card.dataset.id);
  const k = el.dataset.k;
  e[k] = el.value;
  e.auto = false;
  if (e.ai?.[k]) { e.ai[k] = false; el.classList.remove('ai'); }
  card.classList.remove('auto');
  if (k === 'start' && e.end && e.end < e.start) e.end = e.start;
  if (k === 'start' || k === 'end') {
    sortEvents(state.events);
    regroup(state);
    refresh();
  } else {
    select(state);
    renderChecks();
    save();
  }
}

function onEventClick(ev) {
  const ph = ev.target.closest('[data-photo]');
  if (ph) return openPhoto(ph.dataset.photo);
  const act = ev.target.closest('[data-act]')?.dataset.act;
  const card = ev.target.closest('.event');
  if (!act || !card) return;
  const i = state.events.findIndex((x) => x.id === card.dataset.id);
  const e = state.events[i];
  if (act === 'ai') { doAI([e.id]); return; }
  if (act === 'expand') { expanded.has(e.id) ? expanded.delete(e.id) : expanded.add(e.id); renderEvents(); return; }
  if (act === 'merge') {
    const prev = state.events[i - 1];
    for (const p of state.photos) if (p.eventId === e.id) { p.eventId = prev.id; p.eventLocked = true; }
    if (e.start && (!prev.start || e.start < prev.start)) prev.start = e.start;
    const end = e.end || e.start;
    if (end && (!prev.end || end > prev.end)) prev.end = end;
    prev.auto = false;
    state.events.splice(i, 1);
  }
  if (act === 'delete') {
    const n = state.photos.filter((p) => p.eventId === e.id).length;
    if (!confirm(n ? `Delete "${e.title}"? Its ${n} photos will be regrouped by date, not deleted.` : `Delete "${e.title}"?`)) return;
    state.events.splice(i, 1);
    for (const p of state.photos) if (p.eventId === e.id) { p.eventId = null; p.eventLocked = false; }
    regroup(state);
  }
  refresh();
}

// ---------- photo dialog ----------
let current = null;
function eventPhotos(p) {
  return state.photos.filter((q) => q.eventId === p.eventId)
    .sort((a, b) => (b.filing - a.filing) || (b.keepsake - a.keepsake) || (b.score - a.score));
}
async function openPhoto(id) {
  const p = state.photos.find((x) => x.id === id);
  if (!p) return;
  current = p;
  const dlg = $('#photo-dialog');
  $('#dlg-img').src = await thumbUrl(id, 'full');
  const who = peopleText(state, p);
  const faces = who || (p.faces == null ? 'faces: not checked' : `${p.faces} face${p.faces === 1 ? '' : 's'}`);
  $('#dlg-meta').textContent = `${p.takenAt ? fmtDate(ymd(p.takenAt)) : 'Date unknown'}${p.dateGuessed ? ' (guessed)' : ''} · ${faces} · sharpness ${Math.round(p.sharp * 100)}% · score ${Math.round(p.score * 100)}`
    + (p.filing ? ` · Exhibit ${p.exhibit}` : p.keepsake ? ' · keepsake' : ' · not chosen')
    + (p.aiRank != null ? ` · AI pick #${p.aiRank + 1}` : '');
  $('#dlg-caption').value = p.caption || '';
  $('#dlg-caption').classList.toggle('ai', !!p.captionAI);
  $('#dlg-event').innerHTML = state.events.map((e) => `<option value="${e.id}"${e.id === p.eventId ? ' selected' : ''}>${esc(e.title)} — ${esc(fmtRange(e.start, e.end))}</option>`).join('');
  $$('#dlg-pick button').forEach((b) => b.classList.toggle('on', b.dataset.pick === p.pick));
  if (!dlg.open) dlg.showModal();
}
function setupDialog() {
  const dlg = $('#photo-dialog');
  $('#dlg-caption').oninput = (e) => { current.caption = e.target.value; current.captionAI = false; e.target.classList.remove('ai'); renderChecks(); save(); };
  $('#dlg-event').onchange = (e) => { current.eventId = e.target.value; current.eventLocked = true; refresh(); openPhoto(current.id); };
  $('#dlg-pick').onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    current.pick = b.dataset.pick;
    refresh();
    openPhoto(current.id);
  };
  const step = (d) => {
    const list = eventPhotos(current);
    const i = list.indexOf(current);
    const next = list[(i + d + list.length) % list.length];
    if (next) openPhoto(next.id);
  };
  $('#dlg-prev').onclick = () => step(-1);
  $('#dlg-next').onclick = () => step(1);
  dlg.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  dlg.addEventListener('close', () => { $('#dlg-img').src = ''; });
}

// ---------- export / project ----------
async function exportPdf(kind) {
  const status = (t) => { $('#export-status').textContent = t; };
  if (!state.events.length) return status('Add photos or events first.');
  const btns = $$('#pdf-filing, #pdf-keepsake');
  btns.forEach((b) => (b.disabled = true));
  try {
    select(state);
    const doc = await (kind === 'filing' ? filingPdf : keepsakePdf)(state, status);
    const who = [state.project.petitioner, state.project.beneficiary].map((s) => s?.trim().split(/\s+/).pop()).filter(Boolean).join('-') || 'our';
    doc.save(`${who}-${kind === 'filing' ? 'relationship-timeline-I-130' : 'keepsake-timeline'}.pdf`);
    status('PDF ready. Print it at 100% scale on US Letter paper.');
  } catch (e) {
    console.error(e);
    status(`Couldn't make the PDF: ${e.message}`);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

async function saveProject() {
  const status = (t) => { $('#export-status').textContent = t; };
  status('Packing your project…');
  const zip = new window.JSZip();
  const { photos, events, project, settings, people } = state;
  zip.file('project.json', JSON.stringify({ version: 1, photos, events, project, settings, people }));
  let i = 0;
  for (const p of photos) {
    const full = await db.get('blobs', `full:${p.id}`);
    const thumb = await db.get('blobs', `thumb:${p.id}`);
    if (full) zip.file(`photos/${p.id}.jpg`, full);
    if (thumb) zip.file(`thumbs/${p.id}.jpg`, thumb);
    if (++i % 50 === 0) status(`Packing photos… ${i} of ${photos.length}`);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timeline-project-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  status('Project file saved. Keep it somewhere safe — it contains your photos.');
}

async function openProject(file) {
  const status = (t) => { $('#export-status').textContent = t; };
  try {
    const zip = await window.JSZip.loadAsync(file);
    const data = JSON.parse(await zip.file('project.json').async('string'));
    if (state.photos.length && !confirm('Replace the timeline in this browser with the one in this file?')) return;
    await db.clear('blobs');
    urlCache.clear();
    let i = 0;
    for (const p of data.photos) {
      const full = zip.file(`photos/${p.id}.jpg`), thumb = zip.file(`thumbs/${p.id}.jpg`);
      if (full) await db.put('blobs', `full:${p.id}`, new Blob([await full.async('arraybuffer')], { type: 'image/jpeg' }));
      if (thumb) await db.put('blobs', `thumb:${p.id}`, new Blob([await thumb.async('arraybuffer')], { type: 'image/jpeg' }));
      if (++i % 50 === 0) status(`Loading photos… ${i} of ${data.photos.length}`);
    }
    Object.assign(state, { photos: data.photos, events: data.events, people: data.people || [], project: data.project, settings: { ...state.settings, ...data.settings } });
    fillForms();
    refresh();
    status('Project loaded.');
  } catch (e) {
    status(`That doesn't look like a project file: ${e.message}`);
  }
}

async function clearAll() {
  if (!confirm('Delete everything in this browser (photos, events, details)? Your photos in Google Photos are not affected.')) return;
  await db.clear('blobs');
  await db.clear('meta');
  urlCache.clear();
  Object.assign(state, { photos: [], events: [], people: [], project: { petitioner: '', beneficiary: '', receipt: '', title: '', story: '' } });
  fillForms();
  refresh();
}

function fillForms() {
  $$('[data-field]').forEach((el) => { el.value = state.project[el.dataset.field] || ''; });
  $$('[data-setting]').forEach((el) => { el.value = state.settings[el.dataset.setting]; });
}

// ---------- toast ----------
let toastTimer;
function toast(text, ms = 4000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- boot ----------
async function boot() {
  await load();
  fillForms();
  $$('[data-field]').forEach((el) => {
    el.oninput = () => {
      state.project[el.dataset.field] = el.value;
      if (el.dataset.field === 'petitioner' || el.dataset.field === 'beneficiary') { applyNames(state); clearTimeout(nameTimer); nameTimer = setTimeout(refresh, 600); }
      if (el.dataset.field === 'story') { state.project.storyAI = false; el.classList.remove('ai'); renderChecks(); }
      save();
    };
  });
  $$('[data-setting]').forEach((el) => {
    el.onchange = () => {
      const v = Math.max(1, Math.round(Number(el.value) || 1));
      state.settings[el.dataset.setting] = v;
      el.value = v;
      refresh();
    };
  });
  $('#f-files').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  $('#f-folder').onchange = (e) => { handleFiles(e.target.files); e.target.value = ''; };
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging'); handleFiles(e.dataTransfer.files); });
  $('#events').addEventListener('change', onEventInput);
  $('#events').addEventListener('click', onEventClick);
  $('#add-event').onclick = () => {
    state.events.unshift({ id: uid(), auto: false, title: '', type: 'met', start: '', end: '', location: '', description: '', documents: '' });
    refresh();
    $('#events .ev-title')?.focus();
  };
  $('#regroup').onclick = () => {
    const autoIds = new Set(state.events.filter((e) => e.auto).map((e) => e.id));
    for (const p of state.photos) if (!p.eventLocked && (!p.eventId || autoIds.has(p.eventId))) p.eventId = null;
    regroup(state);
    refresh();
  };
  $('#pdf-filing').onclick = () => exportPdf('filing');
  $('#pdf-keepsake').onclick = () => exportPdf('keepsake');
  $('#save-project').onclick = saveProject;
  $('#open-project').onchange = (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
  $('#clear-all').onclick = clearAll;
  setupDialog();
  setupGoogle();
  setupAI();
  $('#people-scan').onclick = () => autoFaces(true);
  $('#find-people').checked = state.settings.findPeople;
  $('#find-people').onchange = (e) => { state.settings.findPeople = e.target.checked; save(); if (e.target.checked) autoFaces(); };
  $('#people').addEventListener('change', onPersonChange);
  if (!db.persistent) toast('This browser is blocking storage, so your work won\'t be saved between visits. Use "Save project file".', 9000);
  refresh();
}
boot();

// expose for debugging / tests
window.__timeline = { state, refresh };
