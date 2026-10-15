// Almacenamiento local (IndexedDB). Todo queda en el dispositivo.
const NAME = 'estrato-db';
let dbp;

export function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('recs', { keyPath: 'id' });
      d.createObjectStore('chunks', { keyPath: ['rid', 'idx'] });
      d.createObjectStore('pcm', { keyPath: ['rid', 'idx'] });
      d.createObjectStore('audio', { keyPath: 'rid' });
      const a = d.createObjectStore('atts', { keyPath: 'id' });
      a.createIndex('rid', 'rid');
      d.createObjectStore('slides', { keyPath: ['aid', 'n'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let r;
    try { r = fn(s); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transacción cancelada'));
  });
}

export const put = (store, val) => run(store, 'readwrite', s => s.put(val));
export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const all = (store) => run(store, 'readonly', s => s.getAll());
export const byIndex = (store, index, key) => run(store, 'readonly', s => s.index(index).getAll(key));
export const range = (store, lo, hi) => run(store, 'readonly', s => s.getAll(IDBKeyRange.bound(lo, hi)));
export const delRange = (store, lo, hi) => run(store, 'readwrite', s => s.delete(IDBKeyRange.bound(lo, hi)));

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

const RB = (rid) => [[rid, -Infinity], [rid, Infinity]];

export async function deleteRecording(rid) {
  const atts = await byIndex('atts', 'rid', rid);
  for (const a of atts) await deleteAttachment(a.id);
  await delRange('chunks', ...RB(rid));
  await delRange('pcm', ...RB(rid));
  await del('audio', rid);
  await del('recs', rid);
}

export async function deleteAttachment(aid) {
  await delRange('slides', [aid, -Infinity], [aid, Infinity]);
  await del('atts', aid);
}

export const pcmRange = (rid) => range('pcm', ...RB(rid));
export const chunkRange = (rid) => range('chunks', ...RB(rid));

export async function saveRec(rec) {
  rec.updated = Date.now();
  await put('recs', rec);
}

// Elimina adjuntos de borradores que nunca se guardaron como clase.
export async function cleanOrphans() {
  const recs = new Set((await all('recs')).map(r => r.id));
  const atts = await all('atts');
  for (const a of atts) if (!recs.has(a.rid) && !(a.rid || '').startsWith('draft:keep')) {
    if (Date.now() - (a.created || 0) > 6 * 3600 * 1000) await deleteAttachment(a.id);
  }
}
