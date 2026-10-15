// Grabadora: audio de alta calidad (Opus) + copia PCM 16 kHz para transcribir.
import { put, get, del, saveRec, chunkRange, pcmRange, delRange } from './db.js';

export const PCM_RATE = 16000;
export const PCM_CHUNK = PCM_RATE * 10; // 10 s por bloque

export const PROFILES = {
  aula: {
    label: 'Aula (recomendado)',
    desc: 'Reduce el ruido de fondo y nivela el volumen. Sirve cuando el profesor habla a distancia.',
    constraints: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    compressor: true, gain: 1,
  },
  lejana: {
    label: 'Sala grande o voz lejana',
    desc: 'Igual que Aula, con más ganancia. Úsalo si la barra casi no se mueve cuando habla el profesor.',
    constraints: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    compressor: true, gain: 2,
  },
  fiel: {
    label: 'Máxima fidelidad',
    desc: 'Sin procesamiento del navegador. Ideal con un micrófono externo cerca de la voz.',
    constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    compressor: false, gain: 1,
  },
};

const WORKLET = `class T extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0;}
process(i,o){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0;}}}return true;}}
registerProcessor('pcm-tap',T);`;

export function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
  if (!window.MediaRecorder) return '';
  return list.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

export function extFor(mime) {
  if (/mp4/.test(mime)) return 'm4a';
  if (/ogg/.test(mime)) return 'ogg';
  return 'webm';
}

const AC = window.AudioContext || window.webkitAudioContext;

export class Recorder extends EventTarget {
  constructor({ rid, deviceId = '', profile = 'aula', gain = 1, bitrate = 128000, title = '' }) {
    super();
    Object.assign(this, { rid, deviceId, profile, gain, bitrate, title });
    this.state = 'idle'; // idle | open | recording | paused | stopped
    this.markers = [];
    this.env = [];          // nivel medio por segundo (dB), para la columna de estratos
    this.samples = 0;
    this.pcmIdx = 0;
    this.chunkIdx = 0;
    this.curN = 0;
    this.cur = new Int16Array(PCM_CHUNK);
    this._wq = Promise.resolve();
    this.clips = 0;
    this.frames = 0;
    this.lowSecs = 0;
    this._envAcc = 0; this._envN = 0; this._envLast = 0;
    this.pcmOK = false;
    this.wallBase = 0; this.wallStart = 0;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async _stream() {
    const prof = PROFILES[this.profile];
    const base = { channelCount: 1, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 16 }, ...prof.constraints };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: this.deviceId ? { ...base, deviceId: { exact: this.deviceId } } : base,
      });
    } catch (e) {
      if (this.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        return navigator.mediaDevices.getUserMedia({ audio: base });
      }
      throw e;
    }
  }

  // Abre el micrófono y el medidor de nivel (sin grabar todavía).
  async open() {
    if (this.state !== 'idle') return;
    const prof = PROFILES[this.profile];
    this.stream = await this._stream();
    const ctx = this.ctx = new AC({ latencyHint: 'playback' });
    this.src = ctx.createMediaStreamSource(this.stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7;
    this.hp = hp;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.gain;
    let last = this.gainNode;
    this.src.connect(hp); hp.connect(this.gainNode);
    if (prof.compressor) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -28; c.knee.value = 24; c.ratio.value = 3; c.attack.value = 0.01; c.release.value = 0.3;
      last.connect(c); last = c;
    }
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    last.connect(this.analyser);
    this.dest = ctx.createMediaStreamDestination();
    last.connect(this.dest);
    this._watchTrack();
    this.buf = new Float32Array(this.analyser.fftSize);
    this.meterTimer = setInterval(() => this._meter(), 60);
    this._onVis = () => this._visibility();
    document.addEventListener('visibilitychange', this._onVis);
    ctx.onstatechange = () => this._ctxState();
    this.state = 'open';
    this.devices = this.stream.getAudioTracks()[0]?.label || '';
  }

  setGain(g) { this.gain = g; if (this.gainNode) this.gainNode.gain.value = g; }

  _watchTrack() {
    const tr = this.stream.getAudioTracks()[0];
    if (!tr) return;
    tr.onended = () => this._lost('ended');
    tr.onmute = () => { this.emit('warn', { kind: 'mute' }); };
    tr.onunmute = () => { this.emit('warn', { kind: 'unmute' }); };
  }

  _ctxState() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running' && (this.state === 'recording' || this.state === 'open')) {
      this.emit('warn', { kind: 'ctx', state: this.ctx.state });
      this._tryResume();
    }
  }

  async _tryResume() {
    try { if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume(); } catch {}
    try { if (this.tapCtx && this.tapCtx.state !== 'running') await this.tapCtx.resume(); } catch {}
  }

  _visibility() {
    if (document.visibilityState === 'visible') {
      this._wake();
      this._tryResume();
      const tr = this.stream && this.stream.getAudioTracks()[0];
      if (!tr || tr.readyState === 'ended') this._lost('ended');
    }
  }

  async _wake() {
    try {
      if ('wakeLock' in navigator && !this.lock && (this.state === 'recording' || this.state === 'paused')) {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.onrelease = () => { this.lock = null; };
      }
    } catch {}
  }

  _lost() {
    if (this.reacquiring || (this.state !== 'recording' && this.state !== 'paused' && this.state !== 'open')) return;
    this.reacquiring = true;
    const recording = this.state === 'recording' || this.state === 'paused';
    if (recording) { this.addMarker({ type: 'interrupt' }); }
    this.emit('warn', { kind: 'lost' });
    const attempt = async () => {
      if (!this.reacquiring) return;
      try {
        const s = await this._stream();
        try { this.src.disconnect(); } catch {}
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = s;
        this.src = this.ctx.createMediaStreamSource(s);
        this.src.connect(this.hp);
        this._watchTrack();
        await this._tryResume();
        this.reacquiring = false;
        if (recording) this.addMarker({ type: 'resume' });
        this.emit('warn', { kind: 'recovered' });
      } catch {
        this._retry = setTimeout(attempt, 3000);
      }
    };
    setTimeout(attempt, 800);
  }

  _meter() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0, sum = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > peak) peak = v; sum += v * v; }
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-6);
    this.peakHold = Math.max(peak, (this.peakHold || 0) * 0.94);
    if (this.state === 'recording') {
      if (peak >= 0.99) this.clips++;
      this.frames++;
      this._envAcc += rms * rms; this._envN++;
      const t = this.elapsed;
      if (t - this._envLast >= 1) {
        const p = this._envAcc / Math.max(1, this._envN);
        this.env.push(Math.round(10 * Math.log10(p + 1e-9)));
        this._envAcc = 0; this._envN = 0; this._envLast = Math.floor(t);
        this.lowSecs = db < -52 ? this.lowSecs + 1 : 0;
        if (this.lowSecs === 8) this.emit('warn', { kind: 'low' });
      }
    }
    this.emit('level', { peak, peakHold: this.peakHold, rms, db, clips: this.clips });
  }

  get elapsed() {
    if (this.pcmOK) return this.samples / PCM_RATE;
    const w = this.state === 'recording' ? (performance.now() - this.wallStart) / 1000 : 0;
    return this.wallBase + w;
  }

  addMarker(m) {
    const mk = { ...m, t: Math.round(this.elapsed * 10) / 10 };
    this.markers.push(mk);
    this.emit('marker', mk);
    return mk;
  }

  async begin(initialMarker) {
    if (this.state !== 'open') throw new Error('El micrófono no está listo');
    const mime = this.mime = pickMime();
    const rec = this.rec = {
      id: this.rid, title: this.title || 'Clase sin título', created: Date.now(), updated: Date.now(),
      status: 'recording', mime, bitrate: this.bitrate, profile: this.profile, gain: this.gain,
      duration: 0, pcmChunks: 0, pcmSamples: 0, segments: [], markers: [], env: [],
      transcript: { state: 'none', done: 0, total: 0 },
    };
    await put('recs', rec);
    // Copia PCM 16 kHz (para transcribir con memoria acotada)
    try {
      this.tapCtx = new AC({ sampleRate: PCM_RATE });
      await this.tapCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
      const tapSrc = this.tapCtx.createMediaStreamSource(this.dest.stream);
      const node = new AudioWorkletNode(this.tapCtx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mute = this.tapCtx.createGain(); mute.gain.value = 0;
      tapSrc.connect(node); node.connect(mute); mute.connect(this.tapCtx.destination);
      node.port.onmessage = (e) => this._pcm(e.data);
      this.pcmOK = true;
    } catch (err) {
      console.warn('PCM tap no disponible', err);
      this.pcmOK = false;
    }
    this.mr = new MediaRecorder(this.dest.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: this.bitrate });
    this.mr.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        const idx = this.chunkIdx++;
        this._wq = this._wq.then(() => put('chunks', { rid: this.rid, idx, blob: e.data })).catch(console.error);
      }
    };
    this.mr.onerror = () => { this.emit('warn', { kind: 'mr' }); };
    this.mr.start(1000);
    this.wallStart = performance.now();
    this.state = 'recording';
    if (initialMarker) this.addMarker(initialMarker);
    this._wake();
    this.saveTimer = setInterval(() => this._checkpoint(), 3000);
    this.emit('state', this.state);
  }

  _pcm(f32) {
    if (this.state !== 'recording') return;
    for (let i = 0; i < f32.length; i++) {
      const s = f32[i] > 1 ? 1 : f32[i] < -1 ? -1 : f32[i];
      this.cur[this.curN++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.curN === PCM_CHUNK) this._flushPCM();
    }
    this.samples += f32.length;
  }

  _flushPCM() {
    if (!this.curN) return;
    const buf = this.cur.slice(0, this.curN).buffer;
    const idx = this.pcmIdx++;
    this.curN = 0;
    this._wq = this._wq.then(() => put('pcm', { rid: this.rid, idx, buf })).catch(console.error);
  }

  async _checkpoint() {
    if (!this.rec) return;
    Object.assign(this.rec, {
      duration: this.elapsed, pcmChunks: this.pcmIdx, markers: this.markers, env: this.env,
    });
    try {
      // guarda también el bloque PCM en curso, para no perder los últimos segundos si algo se cierra
      if (this.pcmOK && this.curN) await put('pcm', { rid: this.rid, idx: this.pcmIdx, buf: this.cur.slice(0, this.curN).buffer });
      await saveRec({ ...this.rec });
    } catch {}
  }

  pause() {
    if (this.state !== 'recording') return;
    this.wallBase = this.elapsed;
    this.mr.pause();
    this.state = 'paused';
    this.emit('state', this.state);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.mr.resume();
    this.wallStart = performance.now();
    this.state = 'recording';
    this.emit('state', this.state);
  }

  async stop() {
    if (this.state !== 'recording' && this.state !== 'paused') return null;
    clearInterval(this.saveTimer);
    const duration = this.elapsed;
    await new Promise((res) => { this.mr.onstop = res; try { this.mr.stop(); } catch { res(); } });
    this.state = 'stopped';
    this._flushPCM();
    await this._wq;
    this.rec.duration = duration;
    this.rec.pcmSamples = this.samples;
    this.rec.pcmChunks = this.pcmIdx;
    this.rec.markers = this.markers;
    this.rec.env = this.env;
    this.rec.quality = {
      clipPct: this.frames ? Math.round(1000 * this.clips / this.frames) / 10 : 0,
      pcm: this.pcmOK,
    };
    this.close();
    const rec = await finalizeRecording(this.rec);
    this.emit('state', 'stopped');
    return rec;
  }

  close() {
    clearInterval(this.meterTimer); clearInterval(this.saveTimer); clearTimeout(this._retry);
    this.reacquiring = false;
    document.removeEventListener('visibilitychange', this._onVis);
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
    try { this.tapCtx && this.tapCtx.close(); } catch {}
    try { this.lock && this.lock.release(); } catch {}
    this.lock = null;
    if (this.state !== 'stopped') this.state = 'idle';
  }
}

// Une los bloques de audio en un solo archivo y marca la clase como lista.
export async function finalizeRecording(rec) {
  const chunks = await chunkRange(rec.id);
  if (chunks.length) {
    const blob = new Blob(chunks.map(c => c.blob), { type: (rec.mime || 'audio/webm').split(';')[0] });
    await put('audio', { rid: rec.id, blob });
    await delRange('chunks', [rec.id, -Infinity], [rec.id, Infinity]);
  }
  if (!rec.pcmSamples) {
    const pcm = await pcmRange(rec.id);
    if (pcm.length) {
      rec.pcmChunks = pcm.length;
      rec.pcmSamples = (pcm.length - 1) * PCM_CHUNK + pcm[pcm.length - 1].buf.byteLength / 2;
      if (!rec.duration || rec.recovered) rec.duration = rec.pcmSamples / PCM_RATE;
    }
  }
  rec.status = 'ready';
  await saveRec(rec);
  return rec;
}

// Si la pestaña se cerró grabando, rescata lo que se alcanzó a guardar.
export async function recoverInterrupted(recs) {
  const out = [];
  for (const r of recs) {
    if (r.status === 'recording') {
      r.recovered = true;
      await finalizeRecording(r);
      out.push(r);
    }
  }
  return out;
}

export async function getAudioBlob(rid) {
  const a = await get('audio', rid);
  return a ? a.blob : null;
}
