// Turn photo GPS coordinates into place names ("Lagos, Nigeria") for events
// whose location is still empty. Uses OpenStreetMap's Nominatim service: only
// one rounded coordinate per event is sent, at most one request per second.
const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function format(addr) {
  if (!addr) return '';
  const place = addr.city || addr.town || addr.village || addr.municipality || addr.suburb || addr.county || '';
  const region = addr.country_code === 'us' ? addr.state : '';
  const country = addr.country_code === 'us' ? '' : addr.country;
  return [place, region, country].filter(Boolean).join(', ');
}

async function lookup(lat, lng, cache) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`; // ~1 km; also limits what is sent
  if (cache[key] !== undefined) return cache[key];
  const q = new URLSearchParams({ format: 'jsonv2', lat: lat.toFixed(2), lon: lng.toFixed(2), zoom: '10', 'accept-language': 'en' });
  const r = await fetch(`${ENDPOINT}?${q}`);
  if (!r.ok) throw new Error(`Place lookup failed (${r.status})`);
  const name = format((await r.json()).address);
  cache[key] = name;
  return name;
}

/** Fills empty event locations from photo GPS. Returns how many were filled. */
export async function fillLocations(state) {
  state.placeCache ||= {};
  let filled = 0;
  let first = true;
  for (const e of state.events) {
    if (e.location) continue;
    const pts = state.photos.filter((p) => p.eventId === e.id && p.lat != null && p.lng != null && (p.lat || p.lng));
    if (!pts.length) continue;
    const lat = median(pts.map((p) => p.lat)), lng = median(pts.map((p) => p.lng));
    const cached = state.placeCache[`${lat.toFixed(2)},${lng.toFixed(2)}`] !== undefined;
    if (!first && !cached) await wait(1100); // Nominatim usage policy: max 1 request/second
    first = false;
    try {
      const name = await lookup(lat, lng, state.placeCache);
      if (name && !e.location) {
        e.location = name;
        e.ai ||= {};
        e.ai.location = true; // flagged for review like other automatic text
        filled++;
      }
    } catch (err) {
      console.warn(err);
      break; // offline or rate-limited: try again next time
    }
  }
  return filled;
}
