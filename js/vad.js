// Lectura del PCM guardado y detección de voz (para no transcribir silencio ni ruido).
import { get, put } from './db.js';
import { PCM_RATE, PCM_CHUNK } from './recorder.js';

export class PCMReader {
  constructor(rec) {
    this.rid = rec.id;
    this.length = rec.pcmSamples;
    this.rate = PCM_RATE;
    this.cache = new Map();
  }
  async chunk(i) {
    if (this.cache.has(i)) return this.cache.get(i);
    const r = await get('pcm', [this.rid, i]);
    const a = r ? new Int16Array(r.buf) : new Int16Array(0);
    this.cache.set(i, a);
    if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    return a;
  }
  // Devuelve muestras [start, end) como Float32 en -1..1
  async read(start, end) {
    end = Math.min(end, this.length);
    const out = new Float32Array(Math.max(0, end - start));
    let pos = start;
    while (pos < end) {
      const ci = Math.floor(pos / PCM_CHUNK);
      const off = pos - ci * PCM_CHUNK;
      const ch = await this.chunk(ci);
      const n = Math.min(end - pos, PCM_CHUNK - off, ch.length - off);
      if (n <= 0) break;
      for (let k = 0; k < n; k++) out[pos - start + k] = ch[off + k] / 32768;
      pos += n;
    }
    return out;
  }
}

// Guarda un audio ya decodificado (Float32 mono 16 kHz) como bloques PCM.
export async function storePCM(rid, f32) {
  let idx = 0;
  for (let s = 0; s < f32.length; s += PCM_CHUNK) {
    const part = f32.subarray(s, Math.min(f32.length, s + PCM_CHUNK));
    const i16 = new Int16Array(part.length);
    for (let k = 0; k < part.length; k++) {
      const v = part[k] > 1 ? 1 : part[k] < -1 ? -1 : part[k];
      i16[k] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    await put('pcm', { rid, idx: idx++, buf: i16.buffer });
  }
  return { chunks: idx, samples: f32.length };
}

const FRAME = 320; // 20 ms a 16 kHz
export const FRAME_SEC = FRAME / PCM_RATE;

export async function analyze(reader, onProgress) {
  const n = Math.floor(reader.length / FRAME);
  const db = new Float32Array(n);
  const STEP = FRAME * 1500; // 30 s
  for (let s = 0; s < n * FRAME; s += STEP) {
    const e = Math.min(n * FRAME, s + STEP);
    const x = await reader.read(s, e);
    const f0 = s / FRAME;
    for (let f = 0; f < (e - s) / FRAME; f++) {
      let sum = 0;
      for (let k = 0; k < FRAME; k++) { const v = x[f * FRAME + k]; sum += v * v; }
      db[f0 + f] = 10 * Math.log10(sum / FRAME + 1e-10);
    }
    if (onProgress) onProgress(Math.min(1, e / (n * FRAME)));
    await new Promise(r => setTimeout(r));
  }
  return db;
}

// Devuelve ventanas de hasta ~28 s con voz, cortadas en los momentos más silenciosos.
export function planWindows(db) {
  const n = db.length;
  if (!n) return { windows: [], speechSec: 0 };
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(0.1 * (n - 1))];
  const hi = sorted[Math.floor(0.95 * (n - 1))];
  const thr = Math.max(floor + Math.max(7, (hi - floor) * 0.3), -62);
  const sp = new Uint8Array(n);
  // Sin contraste entre silencio y voz (ruido o habla continua): mejor transcribir todo que descartarlo.
  const flat = (hi - floor) < 12 && hi > -50;
  for (let i = 0; i < n; i++) sp[i] = (flat || db[i] > thr) ? 1 : 0;

  // tramos de voz
  let runs = [];
  for (let i = 0; i < n;) {
    if (!sp[i]) { i++; continue; }
    let j = i; while (j < n && sp[j]) j++;
    if (j - i >= 8) runs.push([i, j]);
    i = j;
  }
  // unir pausas cortas (<0.8 s) y agregar margen
  const merged = [];
  for (const r of runs) {
    const l = merged[merged.length - 1];
    if (l && r[0] - l[1] < 40) l[1] = r[1]; else merged.push([r[0], r[1]]);
  }
  const regions = merged.map(([a, b]) => [Math.max(0, a - 12), Math.min(n, b + 12)]);

  // suavizado para elegir puntos de corte
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) { const q = i + k; if (q >= 0 && q < n) { s += db[q]; c++; } }
    sm[i] = s / c;
  }
  const MAX = 1400; // 28 s
  let wins = [];
  for (const [a, b] of regions) {
    let s = a;
    while (b - s > MAX) {
      let best = s + MAX, bv = Infinity;
      for (let k = s + MAX - 300; k <= s + MAX; k++) if (sm[k] < bv) { bv = sm[k]; best = k; }
      wins.push([s, best]); s = best;
    }
    wins.push([s, b]);
  }
  // unir ventanas cercanas mientras no pasen de 28 s
  const out = [];
  for (const w of wins) {
    const l = out[out.length - 1];
    if (l && w[0] - l[1] < 75 && w[1] - l[0] <= MAX) l[1] = w[1]; else out.push([w[0], w[1]]);
  }
  let speech = 0;
  for (const [a, b] of out) speech += b - a;
  return {
    windows: out.map(([a, b]) => ({ s: a * FRAME_SEC, e: b * FRAME_SEC })),
    speechSec: speech * FRAME_SEC,
  };
}

// Nivel por segundo (dB) para la columna de estratos de audios importados.
export function envFromFrames(db) {
  const per = Math.round(1 / FRAME_SEC);
  const out = [];
  for (let i = 0; i + per <= db.length; i += per) {
    let s = 0;
    for (let k = 0; k < per; k++) s += Math.pow(10, db[i + k] / 10);
    out.push(Math.round(10 * Math.log10(s / per + 1e-9)));
  }
  return out;
}
