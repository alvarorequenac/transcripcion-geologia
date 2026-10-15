// Whisper corriendo en el propio dispositivo (Transformers.js + ONNX Runtime).
import { pipeline, env } from '../vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;

let asr = null;
let loadedKey = '';

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const key = m.model + '|' + m.device + '|' + JSON.stringify(m.dtype);
      if (asr && loadedKey === key) { self.postMessage({ type: 'ready', device: m.device }); return; }
      asr = null;
      const progress_callback = (p) => self.postMessage({ type: 'progress', p });
      let device = m.device;
      try {
        asr = await pipeline('automatic-speech-recognition', m.model, { device, dtype: m.dtype, progress_callback });
      } catch (err) {
        if (!m.fallback) throw err;
        device = 'wasm';
        self.postMessage({ type: 'note', message: 'WebGPU falló al cargar el modelo; usando modo compatible (más lento).' });
        asr = await pipeline('automatic-speech-recognition', m.fallback.model || m.model, { device, dtype: m.fallback.dtype, progress_callback });
      }
      loadedKey = key;
      self.postMessage({ type: 'ready', device });
    } else if (m.type === 'run') {
      const out = await asr(m.audio, { language: 'spanish', task: 'transcribe', return_timestamps: true });
      self.postMessage({ type: 'result', id: m.id, text: out.text, chunks: out.chunks || [] });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
