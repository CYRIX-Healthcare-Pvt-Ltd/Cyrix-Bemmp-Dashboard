/**
 * Persists workbooks the user uploaded, so they survive a reload.
 *
 * IndexedDB rather than localStorage: the artifacts are 12-25 MB of binary, well
 * past the ~5 MB string budget localStorage allows. Everything stays on the
 * user's machine — nothing here is ever sent anywhere.
 */

const DB_NAME = 'bemmp';
const DB_VERSION = 1;
const STORE = 'uploads';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Available only over HTTPS or localhost; degrades to in-memory if absent. */
export const storageAvailable = typeof indexedDB !== 'undefined';

export async function putUpload(stateId, { buffer, meta, filename }) {
  if (!storageAvailable) return;
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.put({
    buffer, meta, filename, uploadedAt: new Date().toISOString(),
  }, stateId));
  db.close();
}

export async function getUpload(stateId) {
  if (!storageAvailable) return null;
  const db = await openDb();
  const value = await tx(db, 'readonly', (s) => s.get(stateId));
  db.close();
  return value ?? null;
}

/** Summaries for every stored upload, without pulling the binaries into memory. */
export async function listUploads() {
  if (!storageAvailable) return {};
  const db = await openDb();
  const keys = await tx(db, 'readonly', (s) => s.getAllKeys());
  const out = {};
  for (const key of keys) {
    const value = await tx(db, 'readonly', (s) => s.get(key));
    if (!value) continue;
    out[key] = {
      filename: value.filename,
      uploadedAt: value.uploadedAt,
      rows: value.meta.rows,
      name: value.meta.name,
      short: value.meta.short,
    };
  }
  db.close();
  return out;
}

export async function deleteUpload(stateId) {
  if (!storageAvailable) return;
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(stateId));
  db.close();
}
