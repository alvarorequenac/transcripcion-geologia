// Orquesta la transcripción: detecta voz, parte en ventanas y las envía a Whisper.
import { saveRec } from './db.js';
import { PCMReader, analyze, planWindows } from './vad.js';
import { buildGlossary, applyGlossary, parseTerms, CHILE_SPEECH } from './glossary.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  // frases típicas que Whisper inventa en silencios: solo se descartan si el tramo es corto (no una frase real de clase)
  if (JUNK.some(r => r.test(t)) && (t.split(' ').length <= 8 || /^[\s♪\.\-–—…]+$|^[\[\(]/.test(t))) return '';
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


/* ---------- Transcripción en la nube (Whisper Large v3 por API) ---------- */
export const CLOUD = {
  groq: { label: 'Groq · Whisper Large v3 (gratis)', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3', keyUrl: 'https://console.groq.com/keys' },
  openai: { label: 'OpenAI · Whisper', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys' },
};

export function encodeWav(f32, rate = 16000) {
  const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
  const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) { const x = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

// Misma interfaz que WhisperClient (load/run), pero envía cada tramo de voz a la API.
export class CloudClient {
  constructor({ provider, key, terms, dialect }) {
    this.dialect = dialect === 'es' ? 'es' : 'cl';
    this.cfg = CLOUD[provider] || CLOUD.groq; this.key = (key || '').trim();
    this.terms = (terms || []); this.tail = ''; this.last = 0; this.onNote = null;
  }
  async load(_k, _cap, _p, onNote) { this.onNote = onNote; if (!this.key) throw new Error('Falta la clave de API.'); }
  _prompt() {
    let list = '';
    for (const t of this.terms) { if ((list + t).length > 250) break; list += (list ? ', ' : '') + t; }
    const head = (this.dialect === 'cl' ? 'Clase de Geología en español de Chile, en Concepción. ' + CHILE_SPEECH : 'Clase de Geología en español.') + (list ? ' Términos: ' + list + '.' : '');
    return (head + (this.tail ? ' ' + this.tail : '')).slice(-520);
  }
  async run(audio) {
    const wav = encodeWav(audio);
    for (let attempt = 0; attempt < 6; attempt++) {
      const gap = 3300 - (Date.now() - this.last); // respeta ≈ 20 solicitudes por minuto
      if (gap > 0) await sleep(gap);
      const fd = new FormData();
      fd.append('file', wav, 'tramo.wav'); fd.append('model', this.cfg.model); fd.append('language', 'es');
      fd.append('response_format', 'verbose_json'); fd.append('temperature', '0'); fd.append('prompt', this._prompt());
      let res;
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 120000);
      try { this.last = Date.now(); res = await fetch(this.cfg.url, { method: 'POST', headers: { Authorization: 'Bearer ' + this.key }, body: fd, signal: ac.signal }); }
      catch (e) { clearTimeout(to); if (attempt >= 3) throw new Error('No hay conexión con el servicio de transcripción. Revisa tu internet y pulsa «Continuar».'); await sleep(2500 * (attempt + 1)); continue; }
      clearTimeout(to);
      if (res.ok) {
        const j = await res.json();
        const chunks = [];
        for (const sg of j.segments || []) {
          if (sg.no_speech_prob > 0.6 && sg.avg_logprob < -0.8) continue;
          if (sg.compression_ratio > 2.4) continue;
          chunks.push({ text: sg.text, timestamp: [sg.start, sg.end] });
        }
        if (!j.segments) chunks.push({ text: j.text, timestamp: [0, audio.length / 16000] });
        const text = chunks.map(c => c.text).join(' ');
        if (text.trim()) this.tail = text.trim().slice(-180);
        return { text, chunks };
      }
      if (res.status === 401 || res.status === 403) throw new Error('El proveedor rechazó la clave de API (' + res.status + '). Revísala y vuelve a intentar.');
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get('retry-after')) || 20;
        if (ra > 120) throw new Error(`Se alcanzó el límite gratuito de ${this.cfg.label}. Vuelve a pulsar «Continuar» en ${Math.ceil(ra / 60)} min; lo ya transcrito está guardado.`);
        if (this.onNote) this.onNote(`Límite de velocidad del proveedor: esperando ${Math.ceil(ra)} s…`);
        await sleep(ra * 1000 + 500); continue;
      }
      if (res.status >= 500) { await sleep(3000); continue; }
      const body = await res.text().catch(() => '');
      throw new Error(`El proveedor respondió con error ${res.status}. ${body.slice(0, 160)}`);
    }
    throw new Error('El servicio no respondió tras varios intentos. Pulsa «Continuar» más tarde.');
  }
  terminate() {}
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
