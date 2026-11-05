// Tiny IndexedDB wrapper with an in-memory fallback (private windows, blocked storage).
const DB_NAME = 'i130-timeline';
const VERSION = 1;
let dbPromise = null;
const memory = { blobs: new Map(), meta: new Map() };
let useMemory = false;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    }).catch((e) => { console.warn('IndexedDB unavailable, using memory only', e); useMemory = true; return null; });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  if (useMemory || !d) return fn(null, memory[store]);
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  put: (store, key, val) => run(store, 'readwrite', (s, m) => (s ? s.put(val, key) : void m.set(key, val))),
  get: (store, key) => run(store, 'readonly', (s, m) => (s ? s.get(key) : m.get(key))),
  del: (store, key) => run(store, 'readwrite', (s, m) => (s ? s.delete(key) : void m.delete(key))),
  clear: (store) => run(store, 'readwrite', (s, m) => (s ? s.clear() : void m.clear())),
  get persistent() { return !useMemory; },
};
