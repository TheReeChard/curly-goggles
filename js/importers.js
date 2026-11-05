// Turn local files (photos, Google Takeout folders, .zip files) into import items:
// { key, name, blob, takenAt (ms|null), lat, lng }
const IMG = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;
const base = (p) => p.split('/').pop();

async function takeoutJsonMap(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!/\.json$/i.test(e.name)) continue;
    try {
      const j = JSON.parse(await e.text());
      if (!j.photoTakenTime && !j.creationTime) continue;
      // "IMG_1.JPG.json", "IMG_1.JPG.supplemental-metadata.json", truncated variants…
      const title = j.title || base(e.name).replace(/\.json$/i, '').replace(/\.supplemental-metad?a?t?a?$/i, '');
      map.set(title.toLowerCase(), j);
    } catch { /* not a Takeout sidecar */ }
  }
  return map;
}

function fromSidecar(j) {
  const ts = Number(j?.photoTakenTime?.timestamp || j?.creationTime?.timestamp || 0);
  const geo = j?.geoData || j?.geoDataExif;
  const ok = geo && (geo.latitude || geo.longitude);
  return { takenAt: ts ? ts * 1000 : null, lat: ok ? geo.latitude : null, lng: ok ? geo.longitude : null };
}

async function fromExif(blob) {
  try {
    const x = await window.exifr.parse(blob, { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude'] });
    const d = x?.DateTimeOriginal || x?.CreateDate;
    return { takenAt: d instanceof Date && !isNaN(d) ? d.getTime() : null, lat: x?.latitude ?? null, lng: x?.longitude ?? null };
  } catch {
    return { takenAt: null, lat: null, lng: null };
  }
}

// entries: [{ name, size, lastModified?, blob(), text() }]
async function build(entries) {
  const sidecars = await takeoutJsonMap(entries);
  const items = [];
  const skipped = [];
  for (const e of entries) {
    if (!IMG.test(e.name)) continue;
    const name = base(e.name);
    if (/\.(heic|heif)$/i.test(name)) { skipped.push(name); continue; }
    const blob = await e.blob();
    let meta = sidecars.has(name.toLowerCase()) ? fromSidecar(sidecars.get(name.toLowerCase())) : null;
    if (!meta?.takenAt) {
      const ex = await fromExif(blob);
      meta = { ...ex, lat: meta?.lat ?? ex.lat, lng: meta?.lng ?? ex.lng };
    }
    const guessed = !meta.takenAt && e.lastModified;
    items.push({
      key: `file:${name}:${blob.size}`,
      name,
      blob,
      takenAt: meta.takenAt || e.lastModified || null,
      dateGuessed: !!guessed,
      lat: meta.lat,
      lng: meta.lng,
    });
  }
  // Every Takeout sidecar's date + location, so photos already picked through
  // Google (which come without location) can get it from a Takeout export.
  const geo = [...sidecars].map(([name, j]) => ({ name, ...fromSidecar(j) })).filter((g) => g.lat != null);
  return { items, skipped, geo };
}

export async function fromFiles(fileList) {
  const files = [...fileList];
  const entries = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await window.JSZip.loadAsync(f);
      zip.forEach((path, z) => {
        if (z.dir || path.startsWith('__MACOSX')) return;
        entries.push({
          name: path,
          lastModified: z.date ? z.date.getTime() : null,
          blob: () => z.async('blob'),
          text: () => z.async('string'),
        });
      });
    } else {
      entries.push({
        name: f.webkitRelativePath || f.name,
        lastModified: f.lastModified,
        blob: async () => f,
        text: () => f.text(),
      });
    }
  }
  return build(entries);
}
