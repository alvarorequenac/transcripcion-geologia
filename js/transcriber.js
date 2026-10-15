// Orquesta la transcripción: detecta voz, parte en ventanas y las envía a Whisper.
import { saveRec } from './db.js';
import { PCMReader, analyze, planWindows } from './vad.js';
import { buildGlossary, applyGlossary, parseTerms } from './glossary.js';

export const MODELS = {
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Precisión máxima',
    sub: 'Whisper Large v3 Turbo · descarga ≈1,5 GB (una sola vez)',
    needs: 'webgpu-f16',
  },
  small: {
    id: 'onnx-community/whisper-small',
    label: 'Equilibrado',
    sub: 'Whisper Small · descarga ≈0,3–0,5 GB',
    needs: null,
  },
  base: {
    id: 'onnx-community/whisper-base',
    label: 'Rápido',
    sub: 'Whisper Base · descarga ≈0,15 GB · menos preciso',
    needs: null,
  },
};

export async function capabilities() {
  const cap = { webgpu: false, f16: false, mobile: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) };
  try {
    if (navigator.gpu) {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) { cap.webgpu = true; cap.f16 = ad.features.has('shader-f16'); }
    }
  } catch {}
  return cap;
}

export function recommend(cap) {
  if (cap.webgpu && cap.f16 && !cap.mobile) return 'turbo';
  return 'small';
}

function config(key, cap) {
  const m = MODELS[key];
  if (key === 'turbo') {
    return { model: m.id, device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } };
  }
  if (cap.webgpu) {
    return {
      model: m.id, device: 'webgpu',
      dtype: { encoder_model: cap.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' },
      fallback: { dtype: 'q8' },
    };
  }
  return { model: m.id, device: 'wasm', dtype: 'q8' };
}

const JUNK = [
  /amara\.org/i, /subt[ií]tulos? (realizados|por|en espa[ñn]ol)/i, /gracias por ver/i, /suscr[ií]be/i,
  /^\s*[\[\(]?\s*(m[úu]sica|aplausos|risas|silencio)\s*[\]\)]?\s*\.?\s*$/i, /^[\s♪\.\-–—…]+$/,
  /dale like/i, /hasta la pr[óo]xima/i,
];

export function cleanText(t) {
  t = (t || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (JUNK.some(r => r.test(t))) return '';
  // colapsa bucles repetidos (alucinaciones): una frase de 1–8 palabras repetida 4 o más veces
  const w = t.split(' ');
  for (let n = 1; n <= 8; n++) {
    for (let i = 0; i + n * 4 <= w.length; i++) {
      let reps = 1;
      while (i + (reps + 1) * n <= w.length &&
        w.slice(i, i + n).join(' ').toLowerCase() === w.slice(i + reps * n, i + (reps + 1) * n).join(' ').toLowerCase()) reps++;
      if (reps >= 4) { w.splice(i + n, (reps - 1) * n); }
    }
  }
  return w.join(' ');
}

export class WhisperClient {
  constructor() { this.w = null; this.pending = new Map(); this.seq = 0; this.files = new Map(); }

  _spawn() {
    this.w = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    this.w.onmessage = (e) => this._msg(e.data);
    this.w.onerror = (e) => {
      const err = new Error('No se pudo iniciar el motor de transcripción: ' + (e.message || 'error del worker'));
      this._failAll(err);
    };
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.rej(err);
    this.pending.clear();
    if (this.loadRej) { this.loadRej(err); this.loadRej = null; }
  }

  _msg(m) {
    if (m.type === 'progress') {
      const p = m.p;
      if (p.file && (p.status === 'progress' || p.status === 'done')) {
        const f = this.files.get(p.file) || { loaded: 0, total: 0 };
        if (p.status === 'progress') { f.loaded = p.loaded; f.total = p.total; } else { f.loaded = f.total || f.loaded; }
        this.files.set(p.file, f);
        let l = 0, t = 0;
        for (const v of this.files.values()) { l += v.loaded; t += v.total; }
        if (this.onProgress) this.onProgress({ loaded: l, total: t, file: p.file });
      }
    } else if (m.type === 'ready') {
      this.device = m.device;
      if (this.loadRes) { this.loadRes(m.device); this.loadRes = null; this.loadRej = null; }
    } else if (m.type === 'note') {
      if (this.onNote) this.onNote(m.message);
    } else if (m.type === 'result') {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p.res(m); }
    } else if (m.type === 'error') {
      const err = new Error(m.message);
      if (m.id != null && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.rej(err); }
      else if (this.loadRej) { this.loadRej(err); this.loadRej = null; this.loadRes = null; }
    }
  }

  load(key, cap, onProgress, onNote) {
    if (!this.w) this._spawn();
    this.onProgress = onProgress; this.onNote = onNote;
    this.files = new Map();
    const cfg = config(key, cap);
    return new Promise((res, rej) => {
      this.loadRes = res; this.loadRej = rej;
      this.w.postMessage({ type: 'load', ...cfg });
    });
  }

  run(audio) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.w.postMessage({ type: 'run', id, audio }, [audio.buffer]);
    });
  }

  terminate() { if (this.w) { this.w.terminate(); this.w = null; } }
}

function normalizeRMS(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const rms = Math.sqrt(s / Math.max(1, x.length));
  if (rms < 1e-4) return x;
  const g = Math.min(10, 0.08 / rms); // ≈ -22 dBFS, ganancia máx. +20 dB
  if (g > 1.05) for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * g));
  return x;
}

// Ejecuta (o retoma) la transcripción de una clase.
export async function transcribe(rec, { client, modelKey, cap, glossary, onStatus, shouldStop }) {
  const reader = new PCMReader(rec);
  if (!reader.length) throw new Error('Esta clase no tiene audio disponible para transcribir.');
  const tr = rec.transcript = rec.transcript || { state: 'none', done: 0, total: 0 };

  onStatus({ phase: 'analyze', pct: 0 });
  const db = await analyze(reader, (p) => onStatus({ phase: 'analyze', pct: p }));
  const { windows, speechSec } = planWindows(db);
  tr.total = windows.length;
  tr.speechSec = speechSec;
  tr.model = modelKey;
  if (!windows.length) {
    tr.state = 'done'; tr.done = 0; await saveRec(rec);
    onStatus({ phase: 'empty' });
    return rec;
  }
  const gl = glossary && glossary.length ? buildGlossary(glossary) : null;
  const t0 = performance.now();
  const startAt = tr.done || 0;
  let doneSpeech = 0, sessionSpeech = 0;
  for (let i = 0; i < startAt; i++) doneSpeech += windows[i].e - windows[i].s;

  tr.state = 'partial';
  for (let i = startAt; i < windows.length; i++) {
    if (shouldStop && shouldStop()) { await saveRec(rec); onStatus({ phase: 'stopped', done: i, total: windows.length }); return rec; }
    const w = windows[i];
    const s0 = Math.floor(w.s * reader.rate), e0 = Math.ceil(w.e * reader.rate);
    const audio = normalizeRMS(await reader.read(s0, e0));
    const r = await client.run(audio);
    const added = [];
    const chunks = (r.chunks && r.chunks.length) ? r.chunks : [{ text: r.text, timestamp: [0, w.e - w.s] }];
    for (const c of chunks) {
      let text = cleanText(c.text);
      if (!text) continue;
      const ts = c.timestamp || [0, w.e - w.s];
      const a = w.s + (ts[0] || 0);
      const b = w.s + (ts[1] == null ? (w.e - w.s) : ts[1]);
      const seg = { id: `${i}-${added.length}`, start: Math.round(a * 10) / 10, end: Math.round(Math.max(a, b) * 10) / 10, text, w: i };
      if (gl) {
        const g = applyGlossary(text, gl);
        if (g.changed) { seg.orig = text; seg.text = g.text; }
      }
      added.push(seg);
    }
    rec.segments.push(...added);
    tr.done = i + 1;
    doneSpeech += w.e - w.s;
    sessionSpeech += w.e - w.s;
    const el = (performance.now() - t0) / 1000;
    const rate = sessionSpeech / Math.max(1, el);
    const remain = (speechSec - doneSpeech) / Math.max(0.01, rate);
    await saveRec(rec);
    onStatus({ phase: 'run', done: tr.done, total: windows.length, pct: doneSpeech / speechSec, eta: remain, added });
  }
  tr.state = 'done';
  await saveRec(rec);
  onStatus({ phase: 'done' });
  return rec;
}

export function applyGlossaryToRec(rec, terms) {
  const gl = buildGlossary(terms);
  let n = 0;
  for (const s of rec.segments) {
    if (s.edited) continue;
    const base = s.orig || s.text;
    const g = applyGlossary(base, gl);
    if (g.changed) { s.orig = base; s.text = g.text; n += g.changed; }
  }
  return n;
}

export function revertGlossary(rec) {
  for (const s of rec.segments) if (s.orig && !s.edited) { s.text = s.orig; delete s.orig; }
}

export { parseTerms };
