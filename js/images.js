// Image decoding, resizing and quality analysis. Everything runs locally.

export async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

const dims = (src) => [src.naturalWidth || src.width, src.naturalHeight || src.height];

export function resize(src, maxSide) {
  const [w, h] = dims(src);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Center-crop to an aspect ratio (w/h).
export function crop(src, aspect, maxSide) {
  const [w, h] = dims(src);
  let cw = w, ch = h;
  if (w / h > aspect) cw = h * aspect; else ch = w / aspect;
  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * s);
  c.height = Math.round(ch * s);
  c.getContext('2d').drawImage(src, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return c;
}

export const toBlob = (canvas, q = 0.85) =>
  new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));

export const toDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

// ---------- Face detection (optional; loads from CDN) ----------
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
let detectorPromise = null;
export function getFaceDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      try {
        const vision = await import(`${MP}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
        return await vision.FaceDetector.createFromOptions(files, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.5,
        });
      } catch (e) {
        console.warn('Face detection unavailable; ranking on sharpness and lighting only.', e);
        return null;
      }
    })();
  }
  return detectorPromise;
}

// ---------- Quality analysis ----------
function gray(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
  return { g, w, h };
}

function dHash(src) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  c.getContext('2d').drawImage(src, 0, 0, 9, 8);
  const { g } = gray(c);
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
export function hamming(a, b) {
  if (!a || !b) return 64;
  let n = 0;
  for (let i = 0; i < a.length; i++) n += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return n;
}

export async function analyze(canvas) {
  const small = resize(canvas, 256);
  const { g, w, h } = gray(small);
  let sum = 0, sq = 0, n = 0, bright = 0, clipped = 0;
  for (let i = 0; i < g.length; i++) {
    bright += g[i];
    if (g[i] < 0.02 || g[i] > 0.98) clipped++;
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = (4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]) * 255;
      sum += l; sq += l * l; n++;
    }
  }
  const mean = sum / n;
  const lapVar = sq / n - mean * mean;
  const brightness = bright / g.length;
  const clipFrac = clipped / g.length;

  const sharp = Math.min(1, Math.log1p(lapVar) / Math.log1p(400));
  const exposure = Math.max(0, 1 - Math.abs(brightness - 0.5) * 1.6 - clipFrac * 1.5);

  let faces = null, faceArea = 0;
  const detector = await getFaceDetector();
  if (detector) {
    try {
      const mid = resize(canvas, 640);
      const res = detector.detect(mid);
      const area = mid.width * mid.height;
      const dets = (res.detections || []).filter((d) => {
        const b = d.boundingBox;
        return b && (b.width * b.height) / area > 0.002;
      });
      faces = dets.length;
      for (const d of dets) faceArea = Math.max(faceArea, (d.boundingBox.width * d.boundingBox.height) / area);
    } catch (e) { console.warn('face detect failed', e); }
  }

  let faceScore = 0.5; // neutral when detection is unavailable
  if (faces !== null) {
    faceScore = [0.3, 0.65, 1, 0.9, 0.85, 0.8][Math.min(faces, 5)];
    if (faces > 0 && faceArea < 0.006) faceScore *= 0.8; // faces very small / far away
  }

  const [W, H] = [canvas.width, canvas.height];
  const resPenalty = Math.max(W, H) < 800 ? 0.85 : 1;
  const score = (0.35 * sharp + 0.2 * exposure + 0.45 * faceScore) * resPenalty;

  return {
    hash: dHash(canvas),
    sharp: +sharp.toFixed(3),
    exposure: +exposure.toFixed(3),
    faces,
    score: +score.toFixed(4),
  };
}
