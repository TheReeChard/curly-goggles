// Optional AI assist: an AI model looks at a shortlist of photos per event, ranks
// the best ones and drafts the title, description and captions. Only small copies
// of shortlisted photos are sent, only to the provider the couple chose, and only
// when they turn this on.
import { db } from './db.js';
import { decode, resize, toBlob, toDataURL, hamming } from './images.js';
import { EVENT_TYPES, fmtRange, ymd } from './curate.js';

const MAX_CANDIDATES = 20; // photos sent per event

// ---------------- providers ----------------
// Content passed to providers is neutral: [{ text }] or [{ image: <base64 jpeg> }].

class AIError extends Error {
  constructor(message, { fatal = false } = {}) { super(message); this.fatal = fatal; }
}

async function httpError(r, who) {
  let msg = '';
  try { const j = await r.json(); msg = j.error?.message || JSON.stringify(j).slice(0, 200); } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) return new AIError(`Your ${who} API key was not accepted. ${msg}`, { fatal: true });
  if (r.status === 429) return new AIError(`${who} rate limit or quota reached. Wait a minute, or check billing on your ${who} account. ${msg}`);
  return new AIError(`${who} error ${r.status}: ${msg}`);
}

async function post(url, headers, body, who) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch {
    throw new AIError(`Could not reach ${who}. Check your internet connection.`);
  }
  if (!r.ok) throw await httpError(r, who);
  return r.json();
}

// --- Claude (Anthropic SDK) ---
const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.0.0/+esm';
let anthropicSdk = null;
const claude = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  keyHint: 'sk-ant-…',
  keyUrl: 'console.anthropic.com',
  defaultModels: ['claude-opus-5-5'],
  async listModels() { return this.defaultModels; },
  async ask(apiKey, model, system, content, schema) {
    let Anthropic;
    try { Anthropic = await (anthropicSdk ||= import(ANTHROPIC_SDK).then((m) => m.default || m.Anthropic)); }
    catch { anthropicSdk = null; throw new AIError('Could not load the Claude library. Check your internet connection.'); }
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    let r;
    try {
      r = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        system,
        messages: [{
          role: 'user',
          content: content.map((c) => (c.image
            ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.image } }
            : { type: 'text', text: c.text })),
        }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AIError('Your Anthropic API key was not accepted. Check it and try again.', { fatal: true });
      if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('This Anthropic API key is not allowed to use the model. Check your Anthropic Console settings.', { fatal: true });
      if (e instanceof Anthropic.RateLimitError) throw new AIError('Anthropic rate limit reached. Wait a minute and try again.');
      if (e instanceof Anthropic.APIConnectionError) throw new AIError('Could not reach Anthropic. Check your internet connection.');
      if (e instanceof Anthropic.APIError) throw new AIError(`Anthropic error ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
    if (r.stop_reason === 'refusal') throw new AIError('Claude declined this request.');
    if (r.stop_reason === 'max_tokens') throw new AIError('The Claude response was cut off.');
    return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  },
};

// --- ChatGPT (OpenAI REST) ---
const openai = {
  id: 'openai',
  label: 'ChatGPT (OpenAI)',
  keyHint: 'sk-…',
  keyUrl: 'platform.openai.com/api-keys',
  async listModels(apiKey) {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) throw await httpError(r, 'OpenAI');
    const skip = /audio|realtime|tts|transcribe|whisper|search|image|instruct|embedding|dall-e|moderation|codex|computer|deep-research|-\d{4}-\d{2}-\d{2}$/i;
    return (await r.json()).data.map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !skip.test(id))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  },
  async ask(apiKey, model, system, content, schema) {
    const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
      model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: content.map((c) => (c.image
            ? { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${c.image}`, detail: 'low' } }
            : { type: 'text', text: c.text })),
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
    }, 'OpenAI');
    const msg = j.choices?.[0]?.message;
    if (msg?.refusal) throw new AIError(`ChatGPT declined this request: ${msg.refusal}`);
    if (j.choices?.[0]?.finish_reason === 'length') throw new AIError('The ChatGPT response was cut off.');
    return msg?.content || '';
  },
};

// --- Gemini (Google REST) ---
// Gemini's responseSchema is an OpenAPI subset: no additionalProperties, upper-case types.
function geminiSchema(s) {
  const out = { type: String(s.type).toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = geminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  return out;
}
const gemini = {
  id: 'gemini',
  label: 'Gemini (Google)',
  keyHint: 'AIza…',
  keyUrl: 'aistudio.google.com/apikey',
  async listModels(apiKey) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': apiKey } });
    if (!r.ok) throw await httpError(r, 'Google');
    const skip = /embedding|tts|image|audio|live|aqa|learnlm|gemma|robotics|computer|native/i;
    return (await r.json()).models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini') && !skip.test(id))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  },
  async ask(apiKey, model, system, content, schema) {
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: content.map((c) => (c.image ? { inlineData: { mimeType: 'image/jpeg', data: c.image } } : { text: c.text })) }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(schema) },
    }, 'Google');
    if (j.promptFeedback?.blockReason) throw new AIError(`Gemini declined this request (${j.promptFeedback.blockReason}).`);
    const cand = j.candidates?.[0];
    if (cand?.finishReason === 'MAX_TOKENS') throw new AIError('The Gemini response was cut off.');
    if (cand?.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) throw new AIError(`Gemini stopped early (${cand.finishReason}).`);
    return (cand?.content?.parts || []).map((p) => p.text || '').join('');
  },
};

export const PROVIDERS = { anthropic: claude, openai, gemini };

const keyStore = (provider) => `timeline.key.${provider}`;
export const key = {
  get(provider) { try { return localStorage.getItem(keyStore(provider)) || (provider === 'anthropic' ? localStorage.getItem('timeline.anthropicKey') || '' : ''); } catch { return ''; } },
  set(provider, v) { try { v ? localStorage.setItem(keyStore(provider), v) : localStorage.removeItem(keyStore(provider)); } catch { /* storage blocked */ } },
};

// ---------------- prompts ----------------
const SYSTEM = `You help a married couple build the relationship timeline they submit with Form I-130 (a U.S. immigration petition), and a keepsake photo book of the same story.

For each event you receive the dates, any details the couple already typed, and a numbered shortlist of their photos from that event.

Choose and order the best photos for the timeline. A good photo:
- shows both partners together, faces clearly visible, eyes open, a natural pose;
- is sharp and well lit;
- shows context an immigration officer finds meaningful: the place, family or friends, the occasion (wedding, holidays, a shared home);
- adds variety — skip near-duplicates of a photo you already chose, and skip screenshots, documents, memes and photos with neither partner in them unless nothing better exists.
Rank only photos worth printing, best first.

When a photo lists the people recognized in it, you may use those names in its caption ("Richard and Ada with Mom at dinner"). Never name anyone who isn't listed.

Write in the first person plural ("we"), warm but plain and factual. Never invent facts: no names, places, relationships, occasions or dates that are not in the details given or clearly visible in the photos. If you cannot tell where or why something happened, describe what is visible instead ("Dinner together at a restaurant"). The couple will review everything before filing.

Reply only with JSON matching the requested schema.`;

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

async function askJSON(provider, apiKey, model, content, format) {
  const text = await provider.ask(apiKey, model, SYSTEM, content, format);
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new AIError('The AI reply could not be read. Try again, or pick a different model.');
  }
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

async function imageData(p) {
  const blob = await db.get('blobs', `full:${p.id}`);
  const small = await toBlob(resize(await decode(blob), 640), 0.72);
  return (await toDataURL(small)).split(',')[1];
}

function coupleLine(P) {
  const a = P.petitioner?.trim(), b = P.beneficiary?.trim();
  if (a && b) return `The couple: ${a} (petitioner) and ${b} (spouse).`;
  if (a || b) return `One partner is ${a || b}; the other's name was not given, so don't name them.`;
  return "The couple's names were not given; don't use names for them.";
}

async function reviewEvent(provider, apiKey, model, state, e) {
  const all = state.photos.filter((p) => p.eventId === e.id);
  const list = shortlist(all);
  const k = Math.min(list.length, Math.max(state.settings.keepsakePerEvent, state.settings.filingPerEvent));
  const P = state.project;
  const known = [
    coupleLine(P),
    `Event dates: ${fmtRange(e.start, e.end)}.`,
    !e.auto && e.title && !e.ai?.title ? `Title the couple chose: ${e.title}` : '',
    e.location ? `Location: ${e.location}` : '',
    e.description && !e.ai?.description ? `Couple's notes: ${e.description}` : '',
    e.documents ? `Documents: ${e.documents}` : '',
    `Choose at most ${k} photos.`,
  ].filter(Boolean).join('\n');
  const content = [{ text: known }];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    content.push({ text: `Photo ${i + 1}${p.takenAt ? ` — ${ymd(p.takenAt)}` : ''}${p.people?.length ? ` — people recognized: ${p.people.join(', ')}` : ''}${p.pick === 'pinned' ? ' (the couple pinned this one)' : ''}` });
    content.push({ image: await imageData(p) });
  }
  const res = await askJSON(provider, apiKey, model, content, schema(k));

  // Apply: only overwrite text the couple hasn't written themselves.
  e.ai ||= {};
  const mine = (f) => !e.ai[f] && e[f] && !(f === 'title' && e.auto);
  if (!mine('title') && res.title) { e.title = res.title; e.ai.title = true; }
  if (!mine('description') && res.description) { e.description = res.description; e.ai.description = true; }
  if ((e.auto || e.ai.type || e.type === 'other') && EVENT_TYPES.some((t) => t[0] === res.type)) { e.type = res.type; e.ai.type = true; }
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

/** Run AI on events. opts: { provider, apiKey, model, only, onProgress(done, total, text) } */
export async function runAI(state, { provider: pid, apiKey, model, only, onProgress } = {}) {
  const provider = PROVIDERS[pid];
  if (!provider) throw new AIError('Choose an AI provider.');
  if (!model) throw new AIError('Choose a model.');
  const todo = state.events.filter((e) => (only ? only.includes(e.id) : !e.aiReviewed) && state.photos.some((p) => p.eventId === e.id));
  let done = 0;
  const errors = [];
  const queue = [...todo];
  onProgress?.(0, todo.length, `Asking ${provider.label} to review ${todo.length} event(s)…`);
  const worker = async () => {
    while (queue.length) {
      const e = queue.shift();
      try { await reviewEvent(provider, apiKey, model, state, e); } catch (err) {
        errors.push(err.message || String(err));
        if (err.fatal) queue.length = 0;
      }
      onProgress?.(++done, todo.length, `AI reviewed ${done} of ${todo.length} event(s)…`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // Keepsake introduction.
  if (state.events.length && !errors.length && (!state.project.story || state.project.storyAI)) {
    try {
      const P = state.project;
      const lines = state.events.filter((e) => e.title).map((e) => `- ${fmtRange(e.start, e.end)}: ${e.title}${e.location ? ` (${e.location})` : ''}${e.description ? ` — ${e.description}` : ''}`).join('\n');
      const res = await askJSON(provider, apiKey, model, [{ text: `Write a short, warm introduction for the first page of our keepsake photo book. ${coupleLine(P)} Use only these events:\n${lines}` }], STORY_SCHEMA);
      if (res.story) { P.story = res.story; P.storyAI = true; }
    } catch (err) { errors.push(err.message || String(err)); }
  }
  return { reviewed: done - errors.length, errors: [...new Set(errors)] };
}
