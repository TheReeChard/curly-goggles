// Grouping photos into events, choosing the best photos, exhibit labels, gap checks.
import { hamming } from './images.js';

export const EVENT_TYPES = [
  ['met', 'How we met'],
  ['first-meeting', 'First time meeting in person'],
  ['visit', 'Visit'],
  ['trip', 'Trip together'],
  ['family', 'Time with family / friends'],
  ['engagement', 'Engagement'],
  ['wedding', 'Wedding / marriage'],
  ['moved-in', 'Moved in together'],
  ['lease', 'Lease / mortgage / home'],
  ['finances', 'Joint finances (bank, taxes, bills)'],
  ['insurance', 'Insurance / benefits'],
  ['child', 'Child'],
  ['apart', 'Time apart (and why)'],
  ['other', 'Other'],
];
export const typeLabel = (t) => (EVENT_TYPES.find((x) => x[0] === t) || EVENT_TYPES.at(-1))[1];

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const parseYmd = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const fmtOpts = { month: 'short', day: 'numeric', year: 'numeric' };
export const fmtDate = (s) => (s ? parseYmd(s).toLocaleDateString('en-US', fmtOpts) : 'Date unknown');
export const fmtRange = (a, b) => {
  if (!a) return 'Date unknown';
  if (!b || a === b) return fmtDate(a);
  const A = parseYmd(a), B = parseYmd(b);
  if (A.getFullYear() === B.getFullYear()) {
    if (A.getMonth() === B.getMonth())
      return `${A.toLocaleDateString('en-US', { month: 'short' })} ${A.getDate()}–${B.getDate()}, ${A.getFullYear()}`;
    return `${A.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${B.toLocaleDateString('en-US', fmtOpts)}`;
  }
  return `${fmtDate(a)} – ${fmtDate(b)}`;
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const GAP_MS = 36 * 3600 * 1000;

function inRange(ms, e) {
  if (ms == null || !e.start) return false;
  const d = ymd(ms);
  return d >= e.start && d <= (e.end || e.start);
}

export function sortEvents(events) {
  return events.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || (a.end || '').localeCompare(b.end || ''));
}

/** Assign photos to events. Events the user has edited (auto=false) are kept;
 *  everything else is rebuilt by clustering photos by date. */
export function regroup(state) {
  const manual = state.events.filter((e) => !e.auto);
  const manualIds = new Set(manual.map((e) => e.id));
  const oldAuto = state.events.filter((e) => e.auto);
  const loose = [];
  for (const p of state.photos) {
    if (p.eventId && manualIds.has(p.eventId) && p.eventLocked) continue;
    const m = manual.find((e) => inRange(p.takenAt, e));
    if (m) { if (p.eventId !== m.id) m.aiReviewed = false; p.eventId = m.id; continue; }
    if (p.eventId && manualIds.has(p.eventId)) continue;
    loose.push(p);
  }
  const dated = loose.filter((p) => p.takenAt != null).sort((a, b) => a.takenAt - b.takenAt);
  const undated = loose.filter((p) => p.takenAt == null);
  const clusters = [];
  for (const p of dated) {
    const last = clusters.at(-1);
    if (last && p.takenAt - last.at(-1).takenAt <= GAP_MS) last.push(p);
    else clusters.push([p]);
  }
  if (undated.length) clusters.push(undated);

  const used = new Set();
  const autos = clusters.map((c) => {
    // keep a stable id when most of the cluster came from the same old event
    const counts = {};
    for (const p of c) if (p.eventId) counts[p.eventId] = (counts[p.eventId] || 0) + 1;
    const prev = oldAuto.find((e) => !used.has(e.id) && counts[e.id] > 0 &&
      counts[e.id] === Math.max(...Object.values(counts)));
    const id = prev ? prev.id : uid();
    used.add(id);
    const dates = c.filter((p) => p.takenAt != null).map((p) => ymd(p.takenAt));
    const start = dates[0] || '';
    const end = dates.at(-1) || '';
    for (const p of c) p.eventId = id;
    return {
      ...(prev || { type: 'other', location: '', description: '', documents: '' }),
      id,
      auto: true,
      start,
      end,
      title: start ? (start === end ? 'Moments together' : 'Time together') : 'Undated photos',
    };
  });
  state.events = sortEvents([...manual, ...autos]);
}

function similar(a, b, strict) {
  const h = hamming(a.hash, b.hash);
  if (h <= (strict ? 10 : 6)) return true;
  return strict && a.takenAt && b.takenAt && Math.abs(a.takenAt - b.takenAt) < 90_000 && h <= 22;
}

// Ranking: photos the AI ranked come first (in its order); after an AI review,
// photos it didn't choose are only used if the couple pins them.
const rankScore = (p) => (p.aiRank != null ? 2 - p.aiRank * 0.01 : p.score);

function pickFrom(list, k, strict, aiReviewed) {
  const pinned = list.filter((p) => p.pick === 'pinned');
  const rest = list.filter((p) => p.pick !== 'pinned' && p.pick !== 'excluded' && (!aiReviewed || p.aiRank != null || p.eventLocked))
    .sort((a, b) => rankScore(b) - rankScore(a));
  const out = [...pinned];
  for (const p of rest) {
    if (out.length >= Math.max(k, pinned.length)) break;
    if (out.some((q) => similar(p, q, strict))) continue;
    out.push(p);
  }
  return out;
}

/** Recompute which photos go in the filing PDF / keepsake, and exhibit labels. */
export function select(state) {
  const { filingPerEvent, filingMax, keepsakePerEvent } = state.settings;
  const byEvent = new Map(state.events.map((e) => [e.id, []]));
  for (const p of state.photos) {
    p.filing = p.keepsake = false;
    p.exhibit = '';
    if (byEvent.has(p.eventId)) byEvent.get(p.eventId).push(p);
  }
  const filingByEvent = new Map();
  const reviewed = new Set(state.events.filter((e) => e.aiReviewed).map((e) => e.id));
  for (const [id, list] of byEvent) {
    filingByEvent.set(id, pickFrom(list, filingPerEvent, true, reviewed.has(id)));
    for (const p of pickFrom(list, keepsakePerEvent, false, reviewed.has(id))) p.keepsake = true;
  }
  // Global cap for the filing set: trim lowest-scoring auto picks, keeping ≥1 per event.
  let total = [...filingByEvent.values()].reduce((n, l) => n + l.length, 0);
  while (total > filingMax) {
    let worst = null, worstList = null;
    for (const l of filingByEvent.values()) {
      if (l.length <= 1) continue;
      for (const p of l) if (p.pick !== 'pinned' && (!worst || rankScore(p) < rankScore(worst))) { worst = p; worstList = l; }
    }
    if (!worst) break;
    worstList.splice(worstList.indexOf(worst), 1);
    total--;
  }
  // Exhibit letters in timeline order.
  let letter = 0;
  for (const e of state.events) {
    const l = (filingByEvent.get(e.id) || []).sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
    e.exhibit = l.length ? exhibitLetter(letter++) : '';
    l.forEach((p, i) => { p.filing = true; p.keepsake = true; p.exhibit = `${e.exhibit}-${i + 1}`; });
  }
}

function exhibitLetter(i) {
  let s = '';
  i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Things an officer may ask about. Returns [{level:'warn'|'info'|'ok', text}] */
export function checks(state) {
  const out = [];
  const evs = state.events.filter((e) => e.start);
  const has = (...t) => state.events.some((e) => t.includes(e.type));
  if (!state.photos.length && !state.events.length) return [{ level: 'info', text: 'Add photos or events to see suggestions.' }];

  if (!has('met')) out.push({ level: 'warn', text: 'Add a "How we met" event — the timeline should start there.' });
  if (!has('wedding')) out.push({ level: 'warn', text: 'Add your wedding / marriage date (it should match your marriage certificate).' });
  if (!has('moved-in', 'lease')) out.push({ level: 'warn', text: 'Nothing shows you living together (lease, mortgage, shared address). If you live apart, add a "Time apart" event explaining why.' });
  if (!has('finances', 'insurance')) out.push({ level: 'warn', text: 'No shared finances or insurance yet. Joint bank statements, taxes filed jointly, shared bills or beneficiary designations are strong evidence.' });

  const met = state.events.find((e) => e.type === 'met' && e.start);
  if (met) for (const e of evs) if (e !== met && e.start < met.start)
    out.push({ level: 'warn', text: `"${e.title}" (${fmtDate(e.start)}) is dated before you met (${fmtDate(met.start)}). Check the dates — inconsistencies come up at interviews.` });

  for (const e of evs) if (e.end && e.end < e.start) out.push({ level: 'warn', text: `"${e.title}" ends before it starts.` });

  for (let i = 1; i < evs.length; i++) {
    const a = parseYmd(evs[i - 1].end || evs[i - 1].start), b = parseYmd(evs[i].start);
    const days = Math.round((b - a) / 86400000);
    if (days > 120) out.push({ level: 'info', text: `About ${Math.round(days / 30)} months with nothing between "${evs[i - 1].title}" (${fmtDate(evs[i - 1].end || evs[i - 1].start)}) and "${evs[i].title}" (${fmtDate(evs[i].start)}). Consider adding evidence for this period (call logs, messages, money transfers, visits).` });
  }

  const noPlace = state.events.filter((e) => !e.location && state.photos.some((p) => p.eventId === e.id && p.filing));
  if (noPlace.length) out.push({ level: 'info', text: `${noPlace.length} event(s) with filing photos have no location. Officers like to see where each photo was taken.` });
  const generic = state.events.filter((e) => e.auto);
  if (generic.length) out.push({ level: 'info', text: `${generic.length} photo group(s) still have a generic name. Give each one a short title (e.g. "Visit to Lagos for Christmas").` });
  const undated = state.photos.filter((p) => p.takenAt == null || p.dateGuessed).length;
  if (undated) out.push({ level: 'info', text: `${undated} photo(s) had no date in the file, so their dates are guesses. Check them or move them to the right event.` });
  const aiText = state.events.reduce((n, e) => n + Object.values(e.ai || {}).filter(Boolean).length, 0)
    + state.photos.filter((p) => p.captionAI && (p.filing || p.keepsake)).length
    + (state.project.storyAI && state.project.story ? 1 : 0);
  if (aiText) out.push({ level: 'warn', text: `${aiText} title(s), description(s), location(s) or caption(s) were filled in automatically (by AI or from photo GPS). Read each one and correct anything that isn't exactly right — you are responsible for what you file. (They are highlighted until you edit them.)` });
  const nFiling = state.photos.filter((p) => p.filing).length;
  if (nFiling > 80) out.push({ level: 'warn', text: `${nFiling} photos in the filing PDF. A focused set (about 20–60) is easier for an officer to review.` });
  if (!out.some((o) => o.level === 'warn')) out.push({ level: 'ok', text: 'No major gaps found. Still double-check every date against your documents.' });
  return out;
}
