// Find faces in every photo, group the same person across photos, and let the
// couple name them. Runs entirely in the browser (face-api / TensorFlow.js);
// no photo or face data is sent anywhere.
import { db } from './db.js';
import { decode, resize, toBlob } from './images.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.esm.js';
const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
const SAME_PERSON = 0.5; // descriptor distance; lower = stricter

export const ROLES = [
  ['', 'Who is this?'],
  ['petitioner', 'Petitioner (U.S. citizen / green card holder)'],
  ['beneficiary', 'Spouse (beneficiary)'],
  ['family', 'Family'],
  ['friend', 'Friend'],
  ['ignore', 'Not important / stranger'],
];

let apiPromise = null;
function loadApi() {
  apiPromise ||= (async () => {
    const faceapi = await import(LIB);
    try { await faceapi.tf.setBackend('webgl'); } catch { /* falls back to CPU */ }
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
    ]);
    return faceapi;
  })().catch((e) => { apiPromise = null; throw new Error(`Could not load face recognition: ${e.message}`); });
  return apiPromise;
}

const dist = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
};
const round = (n, k = 3) => Math.round(n * 10 ** k) / 10 ** k;

/** Detect faces + descriptors for photos not scanned yet. */
export async function scanFaces(state, onProgress) {
  const todo = state.photos.filter((p) => !p.faceScan);
  if (!todo.length) return 0;
  onProgress?.(0, todo.length, 'Loading face recognition (first time only, ~12 MB)…');
  const faceapi = await loadApi();
  const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
  let done = 0;
  for (const p of todo) {
    try {
      const blob = await db.get('blobs', `full:${p.id}`);
      const img = resize(await decode(blob), 720);
      const res = await faceapi.detectAllFaces(img, opts).withFaceLandmarks().withFaceDescriptors();
      p.faceList = res
        .filter((r) => r.detection.box.width * r.detection.box.height > img.width * img.height * 0.0015)
        .map((r) => {
          const b = r.detection.box;
          return { b: [round(b.x / img.width), round(b.y / img.height), round(b.width / img.width), round(b.height / img.height)], d: Array.from(r.descriptor, (v) => round(v, 4)) };
        });
      p.faces = p.faceList.length;
    } catch (e) {
      console.warn('face scan failed', p.name, e);
      p.faceList = [];
    }
    p.faceScan = true;
    onProgress?.(++done, todo.length, `Looking for faces… ${done} of ${todo.length}`);
    if (done % 10 === 0) await new Promise((r) => setTimeout(r)); // keep the page responsive
  }
  cluster(state);
  return done;
}

/** Assign every face to a person (existing or new). Named people are kept. */
export function cluster(state) {
  state.people ||= [];
  const people = state.people;
  for (const pp of people) pp.count = 0;
  for (const p of state.photos) {
    for (const f of p.faceList || []) {
      let best = null, bestD = SAME_PERSON;
      for (const pp of people) {
        const d = dist(f.d, pp.c);
        if (d < bestD) { best = pp; bestD = d; }
      }
      if (!best) {
        best = { id: Math.random().toString(36).slice(2, 9), name: '', role: '', c: f.d.slice(), n: 0, count: 0, sample: null };
        people.push(best);
      }
      if (!f.pid || f.pid !== best.id) {
        // running mean of the descriptor
        best.c = best.c.map((v, i) => round((v * best.n + f.d[i]) / (best.n + 1), 4));
        best.n++;
      }
      f.pid = best.id;
      best.count++;
      const area = f.b[2] * f.b[3];
      if (!best.sample || area > best.sample.area) best.sample = { photo: p.id, b: f.b, area };
    }
  }
  // drop people that no longer appear and were never named
  state.people = people.filter((pp) => pp.count > 0 || pp.name);
  applyNames(state);
}

/** Recompute photo.people / photo.couple from the names the couple gave. */
export function applyNames(state) {
  const byId = new Map((state.people || []).map((pp) => [pp.id, pp]));
  for (const p of state.photos) {
    const names = [];
    let couple = 0;
    for (const f of p.faceList || []) {
      const pp = byId.get(f.pid);
      if (!pp || pp.role === 'ignore') continue;
      const name = personName(state, pp);
      if (name && !names.includes(name)) names.push(name);
      if (pp.role === 'petitioner' || pp.role === 'beneficiary') couple |= pp.role === 'petitioner' ? 1 : 2;
    }
    p.people = names;
    p.couple = (couple & 1) + ((couple & 2) >> 1); // 0, 1 or 2 partners in the photo
  }
}

export function personName(state, pp) {
  if (pp.role === 'petitioner') return state.project.petitioner?.trim() || pp.name;
  if (pp.role === 'beneficiary') return state.project.beneficiary?.trim() || pp.name;
  return pp.name?.trim() || '';
}

/** "Richard and Ada with Mom and Tunde" */
export function peopleText(state, p) {
  const names = p.people || [];
  if (!names.length) return '';
  const partners = [state.project.petitioner, state.project.beneficiary].map((s) => s?.trim()).filter(Boolean);
  const a = names.filter((n) => partners.includes(n));
  const b = names.filter((n) => !partners.includes(n));
  const join = (l) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);
  return a.length && b.length ? `${join(a)} with ${join(b)}` : join(names);
}

/** People to show in "Who's who": most frequent first. */
export function peopleToName(state, limit = 16) {
  return [...(state.people || [])]
    .filter((pp) => pp.count >= 2 || pp.name || pp.role)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

const faceCache = new Map();
export async function faceThumb(pp) {
  const k = `${pp.id}:${pp.sample?.photo}`;
  if (faceCache.has(k)) return faceCache.get(k);
  const blob = await db.get('blobs', `full:${pp.sample.photo}`);
  const img = await decode(blob);
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const [x, y, w, h] = pp.sample.b;
  const side = Math.min(Math.max(w * W, h * H) * 1.6, W, H);
  const cx = (x + w / 2) * W, cy = (y + h / 2) * H;
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  c.getContext('2d').drawImage(img, Math.max(0, Math.min(W - side, cx - side / 2)), Math.max(0, Math.min(H - side, cy - side / 2)), side, side, 0, 0, 160, 160);
  const url = URL.createObjectURL(await toBlob(c, 0.85));
  faceCache.set(k, url);
  return url;
}

