// Optional AI assist: Claude looks at a shortlist of photos per event, ranks the
// best ones and drafts the title, description and captions. Only small copies
// of shortlisted photos are sent, and only when the user turns this on.
import { db } from './db.js';
import { decode, resize, toBlob, toDataURL, hamming } from './images.js';
import { EVENT_TYPES, fmtRange, ymd } from './curate.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.0.0/+esm';
const MODEL = 'claude-opus-5-5';
const MAX_CANDIDATES = 20; // photos sent per event
const KEY_STORE = 'timeline.anthropicKey';

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import(SDK_URL).then((m) => m.default || m.Anthropic));

export const key = {
  get() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ } },
};

const SYSTEM = `You help a married couple build the relationship timeline they submit with Form I-130 (a U.S. immigration petition), and a keepsake photo book of the same story.

For each event you receive the dates, any details the couple already typed, and a numbered shortlist of their photos from that event.

Choose and order the best photos for the timeline. A good photo:
- shows both partners together, faces clearly visible, eyes open, a natural pose;
- is sharp and well lit;
- shows context an immigration officer finds meaningful: the place, family or friends, the occasion (wedding, holidays, a shared home);
- adds variety — skip near-duplicates of a photo you already chose, and skip screenshots, documents, memes and photos with neither partner in them unless nothing better exists.
Rank only photos worth printing, best first.

Write in the first person plural ("we"), warm but plain and factual. Never invent facts: no names, places, relationships, occasions or dates that are not in the details given or clearly visible in the photos. If you cannot tell where or why something happened, describe what is visible instead ("Dinner together at a restaurant"). The couple will review everything before filing.`;

const schema = (k) => ({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'type', 'description', 'ranked'],
  properties: {
    title: { type: 'string', description: 'Short event title, at most 7 words, e.g. "Christmas with Ada\'s family".' },
    type: { type: 'string', enum: EVENT_TYPES.map((t) => t[0]) },
    description: { type: 'string', description: '1-3 sentences about the event.' },
    ranked: {
      type: 'array',
      description: `Best photos, best first, at most ${k}.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['photo', 'caption'],
        properties: {
          photo: { type: 'integer', description: 'The photo number from the shortlist.' },
          caption: { type: 'string', description: 'Caption of at most 12 words describing what is visible.' },
        },
      },
    },
  },
});

const STORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['story'],
  properties: { story: { type: 'string', description: 'An introduction of 3-5 sentences.' } },
};

function friendlyError(Anthropic, e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was not accepted. Check it and try again.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the model. Check your Anthropic Console settings.';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached. Wait a minute and try again.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Anthropic error ${e.status ?? ''}: ${e.message}`;
  return e.message || String(e);
}

async function ask(client, content, format) {
  const r = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: format } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (r.stop_reason === 'refusal') throw new Error('The AI declined this request.');
  if (r.stop_reason === 'max_tokens') throw new Error('The AI response was cut off.');
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

function shortlist(photos) {
  const sorted = photos.filter((p) => p.pick !== 'excluded').sort((a, b) => (b.pick === 'pinned') - (a.pick === 'pinned') || b.score - a.score);
  const out = [];
  for (const p of sorted) {
    if (out.length >= MAX_CANDIDATES) break;
    if (p.pick !== 'pinned' && out.some((q) => hamming(p.hash, q.hash) <= 6)) continue;
    out.push(p);
  }
  return out.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
}

async function imageBlock(p) {
  const blob = await db.get('blobs', `full:${p.id}`);
  const small = await toBlob(resize(await decode(blob), 640), 0.72);
  const data = (await toDataURL(small)).split(',')[1];
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

async function reviewEvent(client, state, e) {
  const all = state.photos.filter((p) => p.eventId === e.id);
  const list = shortlist(all);
  const k = Math.min(list.length, Math.max(state.settings.keepsakePerEvent, state.settings.filingPerEvent));
  const P = state.project;
  const known = [
    `Couple: ${P.petitioner || 'Partner 1'} and ${P.beneficiary || 'Partner 2'}.`,
    `Event dates: ${fmtRange(e.start, e.end)}.`,
    !e.auto && e.title ? `Title the couple chose: ${e.title}` : '',
    e.location ? `Location: ${e.location}` : '',
    e.description && !e.ai?.description ? `Couple's notes: ${e.description}` : '',
    e.documents ? `Documents: ${e.documents}` : '',
    `Choose at most ${k} photos.`,
  ].filter(Boolean).join('\n');
  const content = [{ type: 'text', text: known }];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    content.push({ type: 'text', text: `Photo ${i + 1}${p.takenAt ? ` — ${ymd(p.takenAt)}` : ''}${p.pick === 'pinned' ? ' (the couple pinned this one)' : ''}` });
    content.push(await imageBlock(p));
  }
  const res = await ask(client, content, schema(k));

  // Apply: only overwrite text the couple hasn't written themselves.
  e.ai ||= {};
  const mine = (f) => !e.ai[f] && e[f] && !(f === 'title' && e.auto);
  if (!mine('title') && res.title) { e.title = res.title; e.ai.title = true; }
  if (!mine('description') && res.description) { e.description = res.description; e.ai.description = true; }
  if ((e.auto || e.ai.type || e.type === 'other') && res.type) { e.type = res.type; e.ai.type = true; }
  e.auto = false; // keep this event when regrouping
  e.aiReviewed = true;
  for (const p of all) p.aiRank = null;
  (res.ranked || []).forEach((r, rank) => {
    const p = list[r.photo - 1];
    if (!p || p.aiRank != null) return;
    p.aiRank = rank;
    if ((!p.caption || p.captionAI) && r.caption) { p.caption = r.caption; p.captionAI = true; }
  });
}

/** Run AI on events. onProgress(done, total, text) */
export async function runAI(state, apiKey, { only, onProgress } = {}) {
  let Anthropic;
  try { Anthropic = await loadSdk(); } catch { throw new Error('Could not load the AI library. Check your internet connection.'); }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const todo = state.events.filter((e) => (only ? only.includes(e.id) : !e.aiReviewed) && state.photos.some((p) => p.eventId === e.id));
  let done = 0;
  const errors = [];
  const queue = [...todo];
  onProgress?.(0, todo.length, `Asking AI to review ${todo.length} event(s)…`);
  const worker = async () => {
    while (queue.length) {
      const e = queue.shift();
      try { await reviewEvent(client, state, e); } catch (err) { errors.push(friendlyError(Anthropic, err)); if (err instanceof Anthropic.AuthenticationError) queue.length = 0; }
      onProgress?.(++done, todo.length, `AI reviewed ${done} of ${todo.length} event(s)…`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // Keepsake introduction.
  if (state.events.length && !errors.length && (!state.project.story || state.project.storyAI)) {
    try {
      const P = state.project;
      const lines = state.events.filter((e) => e.title).map((e) => `- ${fmtRange(e.start, e.end)}: ${e.title}${e.location ? ` (${e.location})` : ''}${e.description ? ` — ${e.description}` : ''}`).join('\n');
      const res = await ask(client, [{ type: 'text', text: `Write a short, warm introduction for the first page of our keepsake photo book. Couple: ${P.petitioner || 'Partner 1'} and ${P.beneficiary || 'Partner 2'}. Use only these events:\n${lines}` }], STORY_SCHEMA);
      if (res.story) { P.story = res.story; P.storyAI = true; }
    } catch (err) { errors.push(friendlyError(Anthropic, err)); }
  }
  return { reviewed: done - errors.length, errors: [...new Set(errors)] };
}
