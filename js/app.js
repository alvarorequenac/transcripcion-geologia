import { db, get, put, all, byIndex, range, saveRec, deleteRecording, deleteAttachment, uid, cleanOrphans } from './db.js';
import { Recorder, PROFILES, recoverInterrupted, getAudioBlob, extFor, PCM_RATE } from './recorder.js';
import { PCMReader, analyze, envFromFrames, storePCM } from './vad.js';
import { WhisperClient, CloudClient, CLOUD, MODELS, capabilities, recommend, transcribe, applyGlossaryToRec, revertGlossary } from './transcriber.js';
import { DEFAULT_TERMS, CHILE_TERMS, parseTerms } from './glossary.js';
import { addAttachment } from './attachments.js';
import { findAll, highlight, snippet, esc, norm } from './search.js';
import { fmtTime, fmtDate, buildItems, exportDocx, exportPDF, exportTxt, download, safeName } from './export.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
const S = { recorder: null, draft: null, client: null, cap: null };

/* ---------- utilidades de interfaz ---------- */
function toast(msg, ms = 4200) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

function dialog(html, { onMount } = {}) {
  return new Promise((res) => {
    const dlg = $('#dlg');
    dlg.innerHTML = html;
    const done = (v) => { dlg.close(); res(v); };
    dlg.onclose = () => res(undefined);
    dlg.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v); });
    dlg.showModal();
    if (onMount) onMount(dlg, done);
  });
}
const confirmBox = async (msg, ok = 'Aceptar', danger = false) =>
  (await dialog(`<p>${esc(msg)}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-v="">Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-v="ok">${esc(ok)}</button></div>`)) === 'ok';
const askText = (label, value) => dialog(
  `<form method="dialog" class="stack"><label class="f" for="dtx">${esc(label)}</label><input id="dtx" type="text" value="${esc(value || '')}"><div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-v="">Cancelar</button><button class="btn primary" type="submit" value="ok">Guardar</button></div></form>`,
  { onMount: (dlg, done) => { const f = $('form', dlg); f.onsubmit = (e) => { e.preventDefault(); done($('#dtx', dlg).value.trim() || value); }; $('#dtx', dlg).focus(); } });

const DEFAULT_SET = new Set(parseTerms(DEFAULT_TERMS).map(t => t.toLowerCase()));
const mb = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1);
const durText = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function defaultTitle() {
  return 'Clase del ' + new Date().toLocaleDateString('es-CL', { day: 'numeric', month: 'long' }) + ', ' +
    new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

let wl = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.onrelease = () => { wl = null; }; }
    if (!on && wl) { await wl.release(); wl = null; }
  } catch {}
}

/* ---------- columna estratigráfica (nivel del audio) ---------- */
function drawStrata(canvas, env, domain) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const lo = cs.getPropertyValue('--strata-lo').split(',').map(Number);
  const hi = cs.getPropertyValue('--strata-hi').split(',').map(Number);
  const n = Math.max(domain || env.length, 1);
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor(x / W * n), i1 = Math.max(i0 + 1, Math.floor((x + 1) / W * n));
    if (i0 >= env.length) break;
    let v = -90;
    for (let i = i0; i < i1 && i < env.length; i++) v = Math.max(v, env[i]);
    const lv = Math.min(1, Math.max(0, (v + 66) / 44));
    const k = Math.pow(lv, 0.8);
    g.fillStyle = `rgb(${lo.map((a, j) => Math.round(a + (hi[j] - a) * k)).join(',')})`;
    const bh = H * (0.16 + 0.84 * lv);
    g.fillRect(x, (H - bh) / 2, 1, bh);
  }
  g.globalCompositeOperation = 'destination-out';
  for (let y = 5; y < H; y += 7) g.fillRect(0, y, W, 1.2);
  g.globalCompositeOperation = 'source-over';
}

/* ---------- router ---------- */
let cleanup = null;
async function route() {
  const rec = S.recorder && (S.recorder.state === 'recording' || S.recorder.state === 'paused');
  const h = location.hash.replace(/^#/, '') || '/';
  if (rec && h !== '/') { location.hash = '#/'; toast('Detén la grabación antes de salir de esta pantalla.'); return; }
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  $$('.top nav a').forEach(a => a.removeAttribute('aria-current'));
  const mark = (k) => $(`[data-nav=${k}]`).setAttribute('aria-current', 'page');
  view.innerHTML = '';
  window.scrollTo(0, 0);
  try {
    if (h === '/') { mark('rec'); cleanup = await viewRecord(); }
    else if (h === '/clases') { mark('lib'); cleanup = await viewLibrary(); }
    else if (h.startsWith('/clase/')) { mark('lib'); cleanup = await viewDetail(decodeURIComponent(h.slice(7).split('?')[0]), h.includes('?transcribir')); }
    else location.hash = '#/';
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="alert bad"><b>Algo salió mal.</b><br>${esc(e.message || String(e))}</div>`;
  }
}
window.addEventListener('hashchange', route);

/* ====================================================================
   GRABAR
   ==================================================================== */
async function viewRecord() {
  if (!S.draft) S.draft = { rid: uid(), atts: [], cur: null };
  const D = S.draft;
  const cfg = Object.assign({ deviceId: '', profile: 'aula', bitrate: 128000, gain: PROFILES.aula.gain }, lsGet('estrato.audio', {}));
  const hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  view.innerHTML = `
  <h1>Grabar una clase</h1>
  ${hasMic ? '' : '<div class="alert bad">Este navegador no permite grabar audio. Prueba con Chrome, Edge, Firefox o Safari actualizados, abriendo la página con https.</div>'}
  <div id="alerts"></div>
  <section class="panel stack" aria-label="Grabadora">
    <div><label class="f" for="title">Nombre de la clase</label>
      <input id="title" type="text" placeholder="Ej.: Petrología ígnea, clase 5" autocomplete="off"></div>
    <div class="strata" id="live" role="img" aria-label="Nivel del audio a lo largo de la grabación"><canvas></canvas><div class="empty">Aquí se irá formando una columna de capas con el volumen de la clase</div></div>
    <div class="meter" aria-hidden="true"><div class="bar"></div><div class="hold"></div></div>
    <p class="small muted" id="hint">Pulsa «Probar micrófono» y habla como lo haría el profesor para ajustar la posición del teléfono.</p>
    <div class="row" style="gap:18px">
      <button class="rec-btn" id="recBtn" aria-label="Iniciar grabación" ${hasMic ? '' : 'disabled'}><i></i></button>
      <div><div class="timer" id="timer">0:00</div><div id="chips" class="row" style="margin-top:6px"></div></div>
    </div>
    <div class="row">
      <button class="btn" id="test" ${hasMic ? '' : 'disabled'}>Probar micrófono</button>
      <button class="btn" id="pause" hidden>Pausar</button>
      <button class="btn" id="star" hidden>★ Marcar momento</button>
    </div>
  </section>

  <details class="panel" id="settings">
    <summary>Calidad de audio</summary>
    <div class="stack">
      <div><label class="f" for="mic">Micrófono</label><select id="mic"><option value="">Predeterminado del dispositivo</option></select>
        <p class="small muted" style="margin-top:6px">Un micrófono externo (USB, Bluetooth o de solapa) cerca de la voz mejora mucho el resultado.</p></div>
      <div role="radiogroup" aria-label="Perfil de captura" class="stack">
        ${Object.entries(PROFILES).map(([k, p]) => `<label class="opt"><input type="radio" name="profile" value="${k}" ${cfg.profile === k ? 'checked' : ''}><span><b>${p.label}</b><span class="small muted">${p.desc}</span></span></label>`).join('')}
      </div>
      <div><label class="f" for="gain">Ganancia de entrada: <span id="gainv"></span></label><input id="gain" type="range" min="0.5" max="4" step="0.1"></div>
      <div><label class="f" for="bitrate">Calidad de compresión</label>
        <select id="bitrate"><option value="96000">Estándar (96 kbps)</option><option value="128000">Alta (128 kbps)</option><option value="192000">Muy alta (192 kbps)</option><option value="256000">Máxima (256 kbps)</option></select>
        <p class="small muted" style="margin-top:6px">128 kbps ya es transparente para voz. Una clase de 90 min pesa ≈ 85 MB a 128 kbps.</p></div>
    </div>
  </details>

  <section class="panel stack" aria-label="Material de la clase">
    <div class="row between"><h2 style="margin:0">Material de la clase</h2>
      <label class="btn sm" for="file">Adjuntar PDF o PPTX</label><input id="file" type="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" multiple hidden></div>
    <p class="small muted" id="matHelp">Adjunta la presentación del profesor. Mientras grabas, cambia de diapositiva aquí y quedará marcada en la transcripción en el momento exacto.</p>
    <div id="matProg" class="progress" hidden><div></div></div>
    <div id="matList" class="row"></div>
    <div id="viewer" class="viewer stack" hidden></div>
  </section>`;

  const el = {
    title: $('#title'), live: $('#live canvas'), bar: $('.meter .bar'), hold: $('.meter .hold'), hint: $('#hint'),
    rec: $('#recBtn'), timer: $('#timer'), chips: $('#chips'), test: $('#test'), pause: $('#pause'), star: $('#star'),
    mic: $('#mic'), gain: $('#gain'), gainv: $('#gainv'), bitrate: $('#bitrate'), alerts: $('#alerts'),
  };
  el.title.value = S.draftTitle || '';
  el.title.oninput = () => { S.draftTitle = el.title.value; };
  el.gain.value = cfg.gain; el.bitrate.value = String(cfg.bitrate);
  const gainLabel = () => { el.gainv.textContent = `×${(+el.gain.value).toFixed(1)} (${(20 * Math.log10(+el.gain.value)).toFixed(0)} dB)`; };
  gainLabel();
  const timers = [];
  const alertBox = (html, cls = '') => { el.alerts.innerHTML = html ? `<div class="alert ${cls}">${html}</div>` : ''; };

  /* --- grabadora --- */
  const state = () => (S.recorder ? S.recorder.state : 'idle');
  const saveCfg = () => lsSet('estrato.audio', cfg);

  function wire(r) {
    r.addEventListener('level', (e) => {
      const { peak, peakHold, db } = e.detail;
      const pct = Math.min(100, Math.max(0, (db + 66) / 60 * 100));
      el.bar.style.width = pct + '%';
      el.bar.classList.toggle('hot', peak > 0.97);
      el.hold.style.left = Math.min(99, Math.max(0, (20 * Math.log10(peakHold + 1e-6) + 66) / 60 * 100)) + '%';
      if (peak > 0.97) el.hint.textContent = 'El audio se está saturando. Aleja el micrófono o baja la ganancia.';
      else if (db < -55) el.hint.textContent = 'No se escucha nada (o casi). Acerca el micrófono o sube la ganancia.';
      else if (db < -42) el.hint.textContent = 'Nivel bajo. Si es la voz del profesor, acerca el micrófono o sube la ganancia.';
      else el.hint.textContent = 'Nivel bueno: la barra se mueve en la zona media cuando habla el profesor.';
    });
    r.addEventListener('warn', (e) => {
      const k = e.detail.kind;
      if (k === 'lost') alertBox('<b>El micrófono se interrumpió</b> (¿llamada, otra app o se desconectó?). Intentando reconectar; la grabación sigue y quedará una marca en la transcripción.', 'bad');
      else if (k === 'recovered') { alertBox(''); toast('Micrófono recuperado: la grabación continúa.'); }
      else if (k === 'ctx') alertBox('El audio del navegador se pausó. Vuelve a esta pestaña para que continúe.', 'bad');
      else if (k === 'low') toast('Llevas varios segundos casi sin señal. Revisa el micrófono.');
      else if (k === 'mr') alertBox('El grabador reportó un error. Detén y guarda lo grabado hasta ahora.', 'bad');
    });
    r.addEventListener('marker', () => updateChips());
  }

  async function ensureOpen() {
    if (S.recorder && S.recorder.state !== 'idle' && S.recorder.state !== 'stopped') return S.recorder;
    const r = new Recorder({ rid: D.rid, deviceId: cfg.deviceId, profile: cfg.profile, gain: +el.gain.value, bitrate: cfg.bitrate });
    try {
      await r.open();
    } catch (e) {
      const m = e.name === 'NotAllowedError' ? 'El navegador no tiene permiso para usar el micrófono. Habilítalo en el candado de la barra de direcciones y vuelve a intentar.'
        : e.name === 'NotFoundError' ? 'No se detectó ningún micrófono.' : (e.message || String(e));
      alertBox('<b>No se pudo abrir el micrófono.</b> ' + esc(m), 'bad');
      throw e;
    }
    S.recorder = r; wire(r); alertBox('');
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    el.mic.innerHTML = '<option value="">Predeterminado del dispositivo</option>' + devs.filter(d => d.deviceId && d.deviceId !== 'default').map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Micrófono')}</option>`).join('');
    el.mic.value = cfg.deviceId;
    return r;
  }

  function closePreview() {
    if (S.recorder && S.recorder.state === 'open') { S.recorder.close(); S.recorder = null; }
    el.bar.style.width = '0'; el.hold.style.left = '0';
    el.test.textContent = 'Probar micrófono';
  }

  const reopenIfPreview = async () => {
    if (S.recorder && S.recorder.state === 'open') { closePreview(); try { await ensureOpen(); el.test.textContent = 'Detener prueba'; } catch {} }
  };

  el.test.onclick = async () => {
    if (S.recorder && S.recorder.state === 'open') { closePreview(); return; }
    try { await ensureOpen(); el.test.textContent = 'Detener prueba'; } catch {}
  };
  el.mic.onchange = () => { cfg.deviceId = el.mic.value; saveCfg(); reopenIfPreview(); };
  $$('input[name=profile]').forEach(r => r.onchange = () => {
    cfg.profile = r.value; cfg.gain = PROFILES[r.value].gain; el.gain.value = cfg.gain; gainLabel(); saveCfg(); reopenIfPreview();
  });
  el.gain.oninput = () => { cfg.gain = +el.gain.value; gainLabel(); if (S.recorder) S.recorder.setGain(cfg.gain); };
  el.gain.onchange = saveCfg;
  el.bitrate.onchange = () => { cfg.bitrate = +el.bitrate.value; saveCfg(); };

  function updateChips() {
    const r = S.recorder;
    if (!r || (r.state !== 'recording' && r.state !== 'paused')) { el.chips.innerHTML = ''; return; }
    const stars = r.markers.filter(m => m.type === 'star').length;
    const ints = r.markers.filter(m => m.type === 'interrupt').length;
    el.chips.innerHTML =
      `<span class="chip ${r.state === 'paused' ? 'warn' : 'bad'}">${r.state === 'paused' ? 'En pausa' : 'Grabando'}</span>` +
      (stars ? `<span class="chip warn">★ ${stars}</span>` : '') +
      (ints ? `<span class="chip bad">${ints} interrupción${ints > 1 ? 'es' : ''}</span>` : '') +
      (r.clips > 20 ? '<span class="chip bad">Saturación</span>' : '');
  }

  function syncUI() {
    const st = state();
    const active = st === 'recording' || st === 'paused';
    el.rec.classList.toggle('on', active);
    el.rec.setAttribute('aria-label', active ? 'Detener y guardar' : 'Iniciar grabación');
    el.pause.hidden = !active; el.star.hidden = !active;
    el.test.hidden = active;
    el.pause.textContent = st === 'paused' ? 'Reanudar' : 'Pausar';
    el.mic.disabled = active; $$('input[name=profile]').forEach(r => r.disabled = active); el.bitrate.disabled = active;
    $('.top .dot').hidden = !active;
    updateChips();
  }

  el.rec.onclick = async () => {
    if (!hasMic) return;
    const st = state();
    if (st === 'recording' || st === 'paused') {
      if (!(await confirmBox('¿Detener y guardar la grabación?', 'Detener y guardar'))) return;
      el.rec.disabled = true;
      const r = S.recorder;
      try {
        const rec = await r.stop();
        rec.title = (el.title.value || '').trim() || defaultTitle();
        // los adjuntos del borrador ya apuntan a este id
        await saveRec(rec);
        await keepAwake(false);
        S.recorder = null; S.draft = null; S.draftTitle = '';
        location.hash = '#/clase/' + encodeURIComponent(rec.id) + '?transcribir';
      } catch (e) { toast('No se pudo guardar: ' + e.message); el.rec.disabled = false; }
      return;
    }
    try {
      const r = await ensureOpen();
      r.title = el.title.value.trim() || defaultTitle();
      await r.begin(D.cur ? { type: 'slide', aid: D.cur.aid, n: D.cur.n } : undefined);
      navigator.storage && navigator.storage.persist && navigator.storage.persist();
      el.test.textContent = 'Probar micrófono';
      syncUI();
    } catch (e) { console.error(e); if (e.name !== 'NotAllowedError') toast('No se pudo iniciar: ' + (e.message || e)); }
  };
  el.pause.onclick = () => { const r = S.recorder; if (!r) return; r.state === 'paused' ? r.resume() : r.pause(); syncUI(); };
  el.star.onclick = () => { S.recorder && S.recorder.addMarker({ type: 'star' }); toast('Momento marcado'); };

  timers.push(setInterval(() => {
    const r = S.recorder;
    el.timer.textContent = fmtTime(r && (r.state === 'recording' || r.state === 'paused') ? r.elapsed : 0);
    if (r && (r.state === 'recording' || r.state === 'paused')) updateChips();
  }, 250));
  const drawLive = () => {
    const r = S.recorder;
    drawStrata(el.live, r ? r.env : [], Math.max(r ? r.env.length : 0, 120));
    $('#live .empty').hidden = !!(r && r.env.length);
  };
  timers.push(setInterval(drawLive, 1000));
  drawLive();
  const onResize = () => drawLive();
  window.addEventListener('resize', onResize);

  // estado si se vuelve a la pantalla con la grabadora activa
  syncUI();
  if (S.recorder && S.recorder.state === 'open') { wire(S.recorder); el.test.textContent = 'Detener prueba'; }
  else if (S.recorder) wire(S.recorder);

  /* --- material --- */
  let slideURL = null;
  async function showSlide() {
    const box = $('#viewer');
    if (!D.atts.length) { box.hidden = true; return; }
    if (!D.cur) D.cur = { aid: D.atts[0].id, n: 1 };
    const att = D.atts.find(a => a.id === D.cur.aid) || D.atts[0];
    const sl = await get('slides', [att.id, D.cur.n]);
    if (slideURL) URL.revokeObjectURL(slideURL);
    slideURL = sl && sl.img ? URL.createObjectURL(sl.img) : '';
    box.hidden = false;
    box.innerHTML = `
      <div class="row">${D.atts.length > 1 ? `<select id="attSel" aria-label="Archivo">${D.atts.map(a => `<option value="${a.id}" ${a.id === att.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}</div>
      <img src="${slideURL}" alt="Diapositiva ${D.cur.n} de ${att.n}">
      <div class="row between">
        <button class="btn" id="prev" aria-label="Diapositiva anterior" ${D.cur.n <= 1 ? 'disabled' : ''}>‹ Anterior</button>
        <span class="muted">Diapositiva <b>${D.cur.n}</b> de ${att.n}</span>
        <button class="btn" id="next" aria-label="Diapositiva siguiente" ${D.cur.n >= att.n ? 'disabled' : ''}>Siguiente ›</button>
      </div>`;
    const go = (n) => {
      D.cur = { aid: att.id, n };
      const r = S.recorder;
      if (r && r.state === 'recording') r.addMarker({ type: 'slide', aid: att.id, n });
      showSlide();
    };
    $('#prev').onclick = () => go(D.cur.n - 1);
    $('#next').onclick = () => go(D.cur.n + 1);
    const sel = $('#attSel');
    if (sel) sel.onchange = () => { D.cur = { aid: sel.value, n: 1 }; const r = S.recorder; if (r && r.state === 'recording') r.addMarker({ type: 'slide', aid: sel.value, n: 1 }); showSlide(); };
  }
  function renderList() {
    $('#matList').innerHTML = D.atts.map(a => `<span class="chip ok">${esc(a.name)} · ${a.n} diap. <button class="x" data-rm="${a.id}" aria-label="Quitar ${esc(a.name)}" style="background:none;border:none;color:inherit;cursor:pointer;font-size:1rem">×</button></span>`).join('');
    $$('[data-rm]').forEach(b => b.onclick = async () => {
      await deleteAttachment(b.dataset.rm);
      D.atts = D.atts.filter(a => a.id !== b.dataset.rm);
      if (D.cur && D.cur.aid === b.dataset.rm) D.cur = null;
      renderList(); showSlide();
    });
  }
  $('#file').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    const prog = $('#matProg');
    for (const f of files) {
      prog.hidden = false; prog.firstElementChild.style.width = '0';
      try {
        const att = await addAttachment(f, D.rid, (p) => { prog.firstElementChild.style.width = Math.round(p * 100) + '%'; });
        D.atts.push(att);
        if (!D.cur) D.cur = { aid: att.id, n: 1 };
        renderList(); await showSlide();
      } catch (err) { toast(err.message || String(err), 7000); }
    }
    prog.hidden = true;
  };
  renderList(); showSlide();

  // si se está grabando, avisar al intentar cerrar la pestaña
  const beforeUnload = (e) => { if (S.recorder && (S.recorder.state === 'recording' || S.recorder.state === 'paused')) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  return () => {
    timers.forEach(clearInterval);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('beforeunload', beforeUnload);
    if (slideURL) URL.revokeObjectURL(slideURL);
    if (S.recorder && S.recorder.state === 'open') closePreview();
  };
}

/* ====================================================================
   CLASES (biblioteca)
   ==================================================================== */
async function viewLibrary() {
  const recs = (await all('recs')).filter(r => r.status !== 'recording').sort((a, b) => b.created - a.created);
  view.innerHTML = `
  <h1>Mis clases</h1>
  <div class="tbar"><input id="gq" type="search" placeholder="Buscar una palabra en todas las transcripciones" aria-label="Buscar en todas las clases"></div>
  <div id="ghits"></div>
  <div class="list" id="list"></div>
  <div class="row" style="margin-top:16px"><label class="btn" for="imp">Importar un audio existente</label><input id="imp" type="file" accept="audio/*,video/mp4,video/webm" hidden></div>
  <div id="impProg" class="progress" style="margin-top:10px" hidden><div></div></div>
  <p class="small muted" id="store" style="margin-top:16px">Todo se guarda solo en este navegador. Si borras los datos del sitio, se pierden las clases: descarga el audio y los documentos que quieras conservar.</p>`;

  const list = $('#list');
  if (!recs.length) list.innerHTML = '<div class="panel"><p><b>Aún no hay clases.</b></p><p class="muted">Graba la primera desde «Grabar», o importa un audio que ya tengas.</p><a class="btn primary" href="#/">Ir a grabar</a></div>';
  list.innerHTML += recs.map(r => {
    const tr = r.transcript || {};
    const badge = r.segments && r.segments.length ? (tr.state === 'partial' ? '<span class="chip warn">Transcripción parcial</span>' : '<span class="chip ok">Transcrita</span>') : '<span class="chip">Sin transcribir</span>';
    return `<a class="card" href="#/clase/${encodeURIComponent(r.id)}"><h3>${esc(r.title)}</h3><div class="row small muted"><span>${fmtDate(r.created)}</span><span>${durText(r.duration || 0)}</span>${badge}${r.recovered ? '<span class="chip bad">Recuperada</span>' : ''}</div></a>`;
  }).join('');

  $('#gq').oninput = (e) => {
    const q = e.target.value.trim();
    const box = $('#ghits');
    if (q.length < 2) { box.innerHTML = ''; return; }
    let n = 0, html = '';
    for (const r of recs) {
      const hits = [];
      for (const s of r.segments || []) { const rg = findAll(s.text, q); if (rg.length) hits.push({ s, rg }); }
      const tm = findAll(r.title, q).length;
      if (!hits.length && !tm) continue;
      n += hits.length;
      html += `<div class="panel"><h3><a href="#/clase/${encodeURIComponent(r.id)}">${esc(r.title)}</a></h3>` +
        hits.slice(0, 5).map(h => `<div class="hit"><a href="#/clase/${encodeURIComponent(r.id)}?t=${h.s.start}" data-t="${h.s.start}" data-id="${r.id}">${fmtTime(h.s.start)}</a> ${snippet(h.s.text, h.rg)}</div>`).join('') +
        (hits.length > 5 ? `<p class="small muted">y ${hits.length - 5} más…</p>` : '') + '</div>';
    }
    box.innerHTML = (html || '<p class="muted">Sin resultados.</p>') + (n ? `<p class="small muted">${n} coincidencia${n > 1 ? 's' : ''} en total.</p>` : '');
    $$('#ghits a[data-t]').forEach(a => a.onclick = () => { S.jump = { id: a.dataset.id, t: +a.dataset.t }; });
  };

  $('#imp').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const prog = $('#impProg'); prog.hidden = false; prog.firstElementChild.style.width = '5%';
    try {
      const rec = await importAudio(f, (p) => { prog.firstElementChild.style.width = Math.round(5 + p * 90) + '%'; });
      location.hash = '#/clase/' + encodeURIComponent(rec.id) + '?transcribir';
    } catch (err) { toast(err.message || String(err), 8000); prog.hidden = true; }
  };

  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(({ usage, quota }) => {
      if (usage != null) $('#store').textContent += ` Espacio usado: ${mb(usage)} MB de ${mb(quota)} MB disponibles.`;
    });
  }
  return () => {};
}

async function importAudio(file, onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let buf;
  try {
    const ctx = new AC({ sampleRate: PCM_RATE });
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
  } catch (e) {
    throw new Error('No se pudo leer ese archivo de audio. Si es muy largo, pruébalo en partes o conviértelo a MP3/M4A.');
  }
  const ch = buf.numberOfChannels;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch; }
  const rid = uid();
  const { chunks, samples } = await storePCM(rid, mono);
  await put('audio', { rid, blob: file });
  const rec = {
    id: rid, title: file.name.replace(/\.[^.]+$/, ''), created: Date.now(), updated: Date.now(), status: 'ready',
    mime: file.type || 'audio/mpeg', imported: true, duration: samples / PCM_RATE, pcmChunks: chunks, pcmSamples: samples,
    segments: [], markers: [], env: [], transcript: { state: 'none', done: 0, total: 0 },
  };
  const db_ = await analyze(new PCMReader(rec), onProgress);
  rec.env = envFromFrames(db_);
  await saveRec(rec);
  return rec;
}

/* ====================================================================
   DETALLE DE UNA CLASE
   ==================================================================== */
async function viewDetail(id, autoTranscribe) {
  const rec = await get('recs', id);
  if (!rec) { view.innerHTML = '<div class="alert bad">No encontré esa clase. <a href="#/clases">Volver a Clases</a></div>'; return () => {}; }
  rec.segments = rec.segments || []; rec.markers = rec.markers || [];
  const blob = await getAudioBlob(id);
  let atts = (await byIndex('atts', 'rid', id)).sort((a, b) => a.created - b.created);
  S.cap = S.cap || await capabilities();
  const cap = S.cap;
  const urls = [];
  const mkURL = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const disposers = [];
  let tab = 'tx';
  const jump = S.jump && S.jump.id === id ? S.jump.t : (+(location.hash.match(/[?&]t=([\d.]+)/) || [])[1] || null);
  S.jump = null;

  view.innerHTML = `
  <div class="row between" style="align-items:flex-start">
    <div><h1 id="ttl" style="margin-bottom:2px">${esc(rec.title)}</h1>
      <div class="small muted">${fmtDate(rec.created)} · ${durText(rec.duration || 0)}${rec.imported ? ' · audio importado' : ''}</div></div>
    <div class="row"><button class="btn sm" id="ren">Renombrar</button><button class="btn sm danger" id="del">Eliminar</button></div>
  </div>
  ${rec.recovered ? '<div class="alert bad">Esta grabación se cortó de forma inesperada (batería, cierre de la pestaña). Se rescató todo lo guardado hasta ese momento.</div>' : ''}
  ${rec.quality && rec.quality.clipPct > 2 ? `<div class="alert">El audio se saturó en ${rec.quality.clipPct}% del tiempo; algunas palabras pueden transcribirse peor.</div>` : ''}
  ${blob ? '' : '<div class="alert bad">No encontré el audio de esta clase.</div>'}
  <section class="panel player" aria-label="Reproductor">
    <div class="strata" id="seek" role="slider" tabindex="0" aria-label="Posición del audio" aria-valuemin="0" aria-valuemax="${Math.round(rec.duration || 0)}" aria-valuenow="0"><canvas></canvas><div class="head"></div></div>
    <div class="ctrls">
      <button class="btn primary" id="play" aria-label="Reproducir">▶ Reproducir</button>
      <button class="btn sm" id="back" aria-label="Retroceder 10 segundos">−10 s</button>
      <button class="btn sm" id="fwd" aria-label="Adelantar 10 segundos">+10 s</button>
      <span class="time" id="time">0:00 / ${fmtTime(rec.duration || 0)}</span>
    </div>
    <details class="popts"><summary class="small muted">Velocidad, voz clara y marcas</summary>
      <div class="row" style="margin-top:8px">
        <select id="rate" aria-label="Velocidad" style="width:auto;min-height:36px"><option value="0.75">0,75×</option><option value="1" selected>1×</option><option value="1.25">1,25×</option><option value="1.5">1,5×</option><option value="2">2×</option></select>
        <label class="row small"><input type="checkbox" id="clear"> Voz clara (filtra graves y nivela el volumen)</label>
        <button class="btn sm" id="starHere">★ Marcar aquí</button>
      </div>
    </details>
    <audio id="aud" preload="metadata"></audio>
  </section>

  <div class="tabs" role="tablist">
    <button role="tab" id="t-tx" aria-selected="true">Transcripción</button>
    <button role="tab" id="t-mat" aria-selected="false">Material</button>
    <button role="tab" id="t-ex" aria-selected="false">Exportar</button>
  </div>
  <div id="pane"></div>`;

  /* ---- reproductor ---- */
  const aud = $('#aud'); const seekEl = $('#seek'); const canvas = $('canvas', seekEl);
  const dur = () => rec.duration || aud.duration || 0;
  if (blob) aud.src = mkURL(blob);
  aud.addEventListener('loadedmetadata', () => {
    if (!isFinite(aud.duration)) {
      aud.currentTime = 1e7;
      aud.addEventListener('timeupdate', () => { aud.currentTime = 0; }, { once: true });
    }
  });
  const drawSeek = () => {
    drawStrata(canvas, rec.env || [], rec.env && rec.env.length ? rec.env.length : 0);
    $$('.tick', seekEl).forEach(t => t.remove());
    for (const m of rec.markers) {
      const t = document.createElement('div');
      t.className = 'tick ' + (m.type === 'slide' ? 'slide' : m.type === 'interrupt' ? 'interrupt' : '');
      if (m.type === 'resume') continue;
      t.style.left = (m.t / Math.max(1, dur()) * 100) + '%';
      seekEl.insertBefore(t, $('.head', seekEl));
    }
  };
  drawSeek();
  const onResize = () => drawSeek();
  window.addEventListener('resize', onResize); disposers.push(() => window.removeEventListener('resize', onResize));
  const seek = (t, play) => { aud.currentTime = Math.max(0, Math.min(dur(), t)); if (play) aud.play().catch(() => {}); };
  const pointerSeek = (e) => { const r = seekEl.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * dur()); };
  seekEl.addEventListener('pointerdown', (e) => { seekEl.setPointerCapture(e.pointerId); pointerSeek(e); seekEl.onpointermove = pointerSeek; });
  seekEl.addEventListener('pointerup', () => { seekEl.onpointermove = null; });
  seekEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { seek(aud.currentTime + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { seek(aud.currentTime - 5); e.preventDefault(); }
  });
  $('#play').onclick = () => (aud.paused ? aud.play().catch(() => toast('No se pudo reproducir el audio.')) : aud.pause());
  $('#back').onclick = () => seek(aud.currentTime - 10);
  $('#fwd').onclick = () => seek(aud.currentTime + 10);
  $('#rate').onchange = (e) => { aud.playbackRate = +e.target.value; };
  aud.addEventListener('play', () => { $('#play').textContent = '❚❚ Pausar'; });
  aud.addEventListener('pause', () => { $('#play').textContent = '▶ Reproducir'; });
  let lastSeg = null;
  aud.addEventListener('timeupdate', () => {
    const t = aud.currentTime;
    $('.head', seekEl).style.left = (t / Math.max(1, dur()) * 100) + '%';
    seekEl.setAttribute('aria-valuenow', Math.round(t));
    $('#time').textContent = `${fmtTime(t)} / ${fmtTime(dur())}`;
    highlightNow(t);
  });

  // “Voz clara”: filtro pasa-altos + realce de claridad + compresión suave en la reproducción
  let fx = null;
  $('#clear').onchange = (e) => {
    try {
      if (!fx) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(aud);
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
        const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 2800; pres.gain.value = 3; pres.Q.value = 0.8;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -32; comp.knee.value = 24; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.25;
        const mk = ctx.createGain(); mk.gain.value = 2.2;
        fx = { ctx, src, chain: [hp, pres, comp, mk] };
        disposers.push(() => ctx.close());
      }
      fx.ctx.resume();
      fx.src.disconnect();
      if (e.target.checked) { let p = fx.src; for (const n of fx.chain) { p.connect(n); p = n; } p.connect(fx.ctx.destination); }
      else fx.src.connect(fx.ctx.destination);
    } catch (err) { toast('Tu navegador no permite el filtro de voz.'); e.target.checked = false; }
  };
  $('#starHere').onclick = async () => { rec.markers.push({ type: 'star', t: Math.round(aud.currentTime * 10) / 10 }); await saveRec(rec); drawSeek(); if (tab === 'tx') renderTranscript(); toast('Momento marcado'); };

  /* ---- cabecera ---- */
  $('#ren').onclick = async () => { const v = await askText('Nombre de la clase', rec.title); if (v) { rec.title = v; await saveRec(rec); $('#ttl').textContent = v; } };
  $('#del').onclick = async () => {
    if (await confirmBox(`¿Eliminar «${rec.title}» con su audio, transcripción y material? No se puede deshacer.`, 'Eliminar', true)) {
      await deleteRecording(rec.id); toast('Clase eliminada'); location.hash = '#/clases';
    }
  };

  /* ---- pestañas ---- */
  const pane = $('#pane');
  const setTab = (t) => {
    tab = t;
    for (const k of ['tx', 'mat', 'ex']) $('#t-' + k).setAttribute('aria-selected', String(k === t));
    pane.innerHTML = '';
    ({ tx: paneTranscript, mat: paneMaterial, ex: paneExport })[t]();
  };
  $('#t-tx').onclick = () => setTab('tx'); $('#t-mat').onclick = () => setTab('mat'); $('#t-ex').onclick = () => setTab('ex');

  /* ================= TRANSCRIPCIÓN ================= */
  let segEls = new Map();
  let saveT = null;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(() => saveRec(rec).catch(console.error), 700); };
  disposers.push(() => { clearTimeout(saveT); if (S.dirty) saveRec(rec); });
  const thumbCache = new Map();
  const slideThumb = async (aid, n) => {
    const k = aid + ':' + n;
    if (!thumbCache.has(k)) { const s = await get('slides', [aid, n]); thumbCache.set(k, s && s.img ? mkURL(s.img) : ''); }
    return thumbCache.get(k);
  };
  let slideTexts = null;
  const loadSlideTexts = async () => {
    if (slideTexts) return slideTexts;
    slideTexts = [];
    for (const a of atts) for (const s of await range('slides', [a.id, -Infinity], [a.id, Infinity])) slideTexts.push({ aid: a.id, n: s.n, text: s.text || '', name: a.name });
    return slideTexts;
  };

  function highlightNow(t) {
    if (tab !== 'tx') return;
    let cur = null;
    for (const s of rec.segments) { if (s.start <= t + 0.05 && t < s.end + 0.6) cur = s; if (s.start > t) break; }
    if (cur === lastSeg) return;
    if (lastSeg && segEls.get(lastSeg.id)) segEls.get(lastSeg.id).classList.remove('now');
    lastSeg = cur;
    const e = cur && segEls.get(cur.id);
    if (e) {
      e.classList.add('now');
      if ($('#follow') && $('#follow').checked && !aud.paused) {
        const r = e.getBoundingClientRect();
        if (r.top < 200 || r.bottom > innerHeight - 40) e.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  function paneTranscript() {
    const has = rec.segments.length > 0;
    const tr = rec.transcript || {};
    pane.innerHTML = `
      <div id="tpanel"></div>
      <div id="tsearch" ${has ? '' : 'hidden'}>
        <div class="tbar"><input id="q" type="search" placeholder="Buscar una palabra en la transcripción y el material" aria-label="Buscar"><button class="btn sm" id="qprev" aria-label="Coincidencia anterior">↑</button><button class="btn sm" id="qnext" aria-label="Siguiente coincidencia">↓</button></div>
        <div id="qinfo" class="small muted" style="margin-bottom:8px"></div>
        <div id="results"></div>
        <label class="row small" style="margin:6px 0 10px"><input type="checkbox" id="follow" checked> Seguir el audio</label>
      </div>
      <div class="transcript" id="tlist"></div>`;
    renderTPanel();
    renderTranscript();
    const q = $('#q');
    let qi = -1;
    const run = async () => {
      const text = q.value.trim();
      renderTranscript();
      const res = $('#results'), info = $('#qinfo');
      if (text.length < 1) { res.innerHTML = ''; info.textContent = ''; qi = -1; return; }
      const hits = $$('.seg.hitnow');
      let slideHits = [];
      for (const s of await loadSlideTexts()) { const rg = findAll(s.text, text); if (rg.length) slideHits.push({ s, rg }); }
      info.textContent = `${hits.length} frase${hits.length === 1 ? '' : 's'} en la transcripción` + (slideHits.length ? ` · ${slideHits.length} diapositiva${slideHits.length > 1 ? 's' : ''}` : '');
      res.innerHTML = slideHits.slice(0, 8).map((h, i) => `<div class="hit"><a href="#" data-sl="${i}">Diapositiva ${h.s.n} · ${esc(h.s.name)}</a> ${snippet(h.s.text.replace(/\s+/g, ' '), findAll(h.s.text.replace(/\s+/g, ' '), text))}</div>`).join('');
      $$('[data-sl]', res).forEach(a => a.onclick = (e) => { e.preventDefault(); matSel = { aid: slideHits[+a.dataset.sl].s.aid, n: slideHits[+a.dataset.sl].s.n }; setTab('mat'); });
      qi = -1;
    };
    let qt; q.oninput = () => { clearTimeout(qt); qt = setTimeout(run, 180); };
    const step = (d) => {
      const hits = $$('.seg.hitnow'); if (!hits.length) return;
      qi = (qi + d + hits.length) % hits.length;
      hits[qi].scrollIntoView({ block: 'center', behavior: 'smooth' });
      $('#qinfo').textContent = `Coincidencia ${qi + 1} de ${hits.length}`;
    };
    $('#qprev').onclick = () => step(-1); $('#qnext').onclick = () => step(1);
    q.onkeydown = (e) => { if (e.key === 'Enter') step(e.shiftKey ? -1 : 1); };

    const list = $('#tlist');
    list.onclick = async (e) => {
      const ts = e.target.closest('.ts'); if (ts) { seek(+ts.dataset.t, true); return; }
      const x = e.target.closest('.x'); if (x) {
        rec.markers.splice(+x.dataset.mi, 1); await saveRec(rec); drawSeek(); renderTranscript(); return;
      }
      const im = e.target.closest('img[data-aid]'); if (im) { dialog(`<img class="big" src="${im.src}" alt=""><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" data-v="">Cerrar</button></div>`); return; }
      const go = e.target.closest('[data-seek]'); if (go) seek(+go.dataset.seek, true);
    };
    list.oninput = (e) => {
      const t = e.target.closest('.tx'); if (!t) return;
      const s = rec.segments.find(x => x.id === t.dataset.id);
      if (s) { s.text = t.textContent; s.edited = true; saveSoon(); }
    };
    list.onkeydown = (e) => { if (e.key === 'Enter' && e.target.classList.contains('tx')) { e.preventDefault(); e.target.blur(); } };
    list.onpaste = (e) => { if (e.target.classList.contains('tx')) { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain')); } };
    if (jump != null && !pane.dataset.jumped) {
      pane.dataset.jumped = '1';
      const seg = rec.segments.find(s => s.end >= jump) || rec.segments[0];
      seek(jump);
      setTimeout(() => { const e = seg && segEls.get(seg.id); if (e) e.scrollIntoView({ block: 'center' }); }, 100);
    }
  }

  function renderTranscript() {
    const list = $('#tlist'); if (!list) return;
    const q = ($('#q') && $('#q').value.trim()) || '';
    const items = buildItems(rec);
    let html = '';
    const markerIdx = new Map(rec.markers.map((m, i) => [m, i]));
    for (const it of items) {
      if (it.kind === 'seg') {
        const s = it.s; const rg = q ? findAll(s.text, q) : [];
        html += `<div class="seg ${rg.length ? 'hitnow' : ''}" data-id="${s.id}"><button class="ts" data-t="${s.start}" aria-label="Escuchar desde ${fmtTime(s.start)}">${fmtTime(s.start)}</button><div class="tx" contenteditable="true" spellcheck="true" lang="es" data-id="${s.id}">${highlight(s.text, rg)}</div></div>`;
      } else {
        const m = it.m; const mi = markerIdx.get(m);
        if (m.type === 'star') html += `<div class="mk star"><span>★ Momento marcado · <a href="#" data-seek="${m.t}" onclick="return false">${fmtTime(m.t)}</a></span><button class="x" data-mi="${mi}" aria-label="Quitar marca">×</button></div>`;
        else if (m.type === 'interrupt') html += `<div class="mk interrupt"><span>⚠ El micrófono se interrumpió a los ${fmtTime(m.t)}; puede faltar audio</span></div>`;
        else if (m.type === 'resume') html += `<div class="mk resume">↳ El micrófono volvió a los ${fmtTime(m.t)}</div>`;
        else if (m.type === 'slide') {
          const a = atts.find(x => x.id === m.aid);
          html += `<div class="mk slide"><div class="row between"><span>Diapositiva ${m.n}${a ? ' · ' + esc(a.name) : ''} · <a href="#" data-seek="${m.t}" onclick="return false">${fmtTime(m.t)}</a></span><button class="x" data-mi="${mi}" aria-label="Quitar diapositiva de la transcripción">×</button></div><img data-aid="${m.aid}" data-n="${m.n}" alt="Diapositiva ${m.n}" loading="lazy"></div>`;
        }
      }
    }
    if (!html) html = rec.transcript && rec.transcript.state === 'done' ? '<p class="muted">No se detectó voz en este audio.</p>' : '';
    list.innerHTML = html;
    segEls = new Map($$('.seg', list).map(e => [e.dataset.id, e]));
    lastSeg = null;
    $$('img[data-aid]', list).forEach(async (im) => { im.src = await slideThumb(im.dataset.aid, +im.dataset.n); });
    highlightNow(aud.currentTime || 0);
  }

  /* ---- panel de transcripción ---- */
  let stopFlag = false, running = false;
  function renderTPanel() {
    const box = $('#tpanel'); if (!box) return;
    const tr = rec.transcript || {};
    const has = rec.segments.length > 0;
    const rec_ = recommend(cap);
    const pick = tr.model && MODELS[tr.model] && tr.state !== 'done' ? tr.model : rec_;
    const canTurbo = cap.webgpu && cap.f16;
    const gl = lsGet('estrato.glossary', DEFAULT_TERMS);
    const cl = Object.assign({ engine: (cap.mobile || !canTurbo) ? 'cloud' : 'local', provider: 'groq', key: '', dialect: 'cl' }, lsGet('estrato.cloud', {}));
    const optsHtml = Object.entries(MODELS).map(([k, m]) => {
      const dis = k === 'turbo' && !canTurbo;
      return `<label class="opt ${dis ? 'disabled' : ''}"><input type="radio" name="model" value="${k}" ${pick === k ? 'checked' : ''} ${dis ? 'disabled' : ''}><span><b>${m.label}${k === rec_ ? ' (recomendado)' : ''}</b><span class="small muted">${m.sub}${dis ? '. Requiere WebGPU con soporte de 16 bits (Chrome o Edge recientes en computador).' : ''}</span></span></label>`;
    }).join('');
    const inner = `
      <div class="stack" role="radiogroup" aria-label="Dónde transcribir">
        <label class="opt"><input type="radio" name="eng" value="cloud" ${cl.engine === 'cloud' ? 'checked' : ''}><span><b>En la nube · Whisper Large v3 (recomendado)</b><span class="small muted">La opción más precisa y funciona rápido en cualquier celular. Necesita internet y una clave gratuita. El audio de la clase se envía al proveedor solo para transcribirlo.</span></span></label>
        <label class="opt"><input type="radio" name="eng" value="local" ${cl.engine === 'local' ? 'checked' : ''}><span><b>En este dispositivo</b><span class="small muted">Privado y sin internet, pero menos preciso en celulares.</span></span></label>
      </div>
      <div id="cloudbox" class="stack" style="margin-top:12px" ${cl.engine === 'cloud' ? '' : 'hidden'}>
        <div><label class="f" for="prov">Proveedor</label><select id="prov">${Object.entries(CLOUD).map(([k, c]) => `<option value="${k}" ${cl.provider === k ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div><label class="f" for="dial">Variante del español</label><select id="dial"><option value="cl" ${cl.dialect !== 'es' ? 'selected' : ''}>Español de Chile (recomendado)</option><option value="es" ${cl.dialect === 'es' ? 'selected' : ''}>Español general</option></select>
          <p class="small muted" style="margin:6px 0 0">En la variante chilena se reconocen mejor las expresiones del habla chilena («po», «cachai», «al tiro») y los nombres de la geología de Chile.</p></div>
        <div><label class="f" for="akey">Clave de API</label><input id="akey" type="password" autocomplete="off" spellcheck="false" value="${esc(cl.key)}" placeholder="Pega aquí tu clave">
          <p class="small muted" style="margin:6px 0 0">Gratis en <a id="keylink" href="${CLOUD[cl.provider].keyUrl}" target="_blank" rel="noopener">${CLOUD[cl.provider].keyUrl.replace('https://', '')}</a> (crea una cuenta y pulsa «Create API key»). La clave queda guardada solo en este dispositivo.</p></div>
      </div>
      <div id="localbox" style="margin-top:12px" ${cl.engine === 'local' ? '' : 'hidden'}>
      ${!cap.webgpu ? '<div class="alert">Este navegador no tiene WebGPU: transcribir funciona, pero será bastante más lento. Chrome o Edge recientes, en computador o Android, son la mejor opción.</div>' : ''}
      <div class="stack" id="mopts" role="radiogroup" aria-label="Modelo de transcripción">${optsHtml}</div>
      <p class="small muted" style="margin-top:10px">El modelo se descarga una sola vez y queda guardado para usarlo sin conexión.</p></div>
      <details style="margin-top:12px"><summary class="small"><b>Glosario de términos geológicos</b></summary>
        <p class="small muted" style="margin-top:8px">Whisper suele deformar palabras técnicas. Los términos de esta lista (separados por comas) se usan para corregir las que se parezcan mucho. Agrega los de tu curso.</p>
        <textarea id="gl" aria-label="Glosario">${esc(gl)}</textarea>
        <label class="row small" style="margin-top:8px"><input type="checkbox" id="usegl" ${lsGet('estrato.usegl', true) ? 'checked' : ''}> Corregir términos con este glosario</label>
      </details>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="go">${tr.state === 'partial' && tr.done ? 'Continuar transcripción' : has ? 'Volver a transcribir' : 'Transcribir en español'}</button>
        ${has ? '<button class="btn sm" id="applygl">Aplicar glosario al texto actual</button><button class="btn sm ghost" id="revgl">Deshacer correcciones del glosario</button>' : ''}
      </div>
      <p class="small muted" style="margin-top:10px">Mantén esta pestaña abierta y la pantalla encendida mientras se transcribe.</p>
      <div id="run" hidden class="stack" style="margin-top:12px">
        <div id="runtxt" class="small"></div>
        <div class="progress"><div id="runbar"></div></div>
        <div id="runlast" class="small muted" style="font-family:var(--serif)"></div>
        <button class="btn sm" id="stop">Pausar transcripción</button>
      </div>`;
    box.innerHTML = has && tr.state === 'done'
      ? `<details class="panel"><summary>Volver a transcribir o ajustar el glosario</summary>${inner}</details>`
      : `<section class="panel"><h2>${has ? 'Transcripción incompleta' : 'Transcribir esta clase'}</h2>${inner}</section>`;
    $('#go').onclick = start;
    const syncEng = () => { const c = $('input[name=eng]:checked').value === 'cloud'; $('#cloudbox').hidden = !c; $('#localbox').hidden = c; };
    $$('input[name=eng]').forEach(r => r.onchange = syncEng);
    $('#prov').onchange = (e) => { const k = CLOUD[e.target.value].keyUrl; const l = $('#keylink'); l.href = k; l.textContent = k.replace('https://', ''); };
    $('#gl').onchange = (e) => lsSet('estrato.glossary', e.target.value);
    $('#usegl').onchange = (e) => lsSet('estrato.usegl', e.target.checked);
    if ($('#applygl')) {
      $('#applygl').onclick = async () => { const n = applyGlossaryToRec(rec, parseTerms($('#gl').value)); await saveRec(rec); renderTranscript(); toast(n ? `${n} término${n > 1 ? 's' : ''} corregido${n > 1 ? 's' : ''}` : 'No encontré términos para corregir'); };
      $('#revgl').onclick = async () => { revertGlossary(rec); await saveRec(rec); renderTranscript(); toast('Correcciones deshechas'); };
    }
    $('#stop').onclick = () => { stopFlag = true; $('#stop').disabled = true; $('#runtxt').textContent = 'Pausando al terminar este tramo…'; };
  }

  async function start() {
    if (running) return;
    const engine = ($('input[name=eng]:checked') || {}).value || 'local';
    const provider = $('#prov').value, apiKey = $('#akey').value.trim();
    const dialect = $('#dial').value;
    lsSet('estrato.cloud', { engine, provider, key: apiKey, dialect });
    if (engine === 'cloud' && !apiKey) { toast('Pega primero tu clave de API (es gratis, el enlace está arriba).', 6000); $('#akey').focus(); return; }
    const key = engine === 'cloud' ? 'cloud-' + provider : (($('input[name=model]:checked') || {}).value || recommend(cap));
    const tr = rec.transcript = rec.transcript || { state: 'none', done: 0, total: 0 };
    if (rec.segments.length && tr.state === 'done') {
      if (!(await confirmBox('Al volver a transcribir se pierden las ediciones que hayas hecho al texto. ¿Continuar?', 'Volver a transcribir', true))) return;
    }
    if (tr.state === 'done' || tr.model !== key) { if (tr.state !== 'partial' || tr.model !== key) { rec.segments = []; tr.done = 0; tr.state = 'none'; } }
    const userTerms = parseTerms($('#gl').value);
    const terms = $('#usegl').checked ? (dialect === 'cl' ? [...userTerms, ...CHILE_TERMS] : userTerms) : null;
    lsSet('estrato.glossary', $('#gl').value);
    running = true; stopFlag = false;
    $('#go').disabled = true; $('#run').hidden = false; $('#stop').disabled = false;
    const runtxt = $('#runtxt'), bar = $('#runbar'), last = $('#runlast');
    keepAwake(true);
    let failHtml = '';
    const client = engine === 'cloud' ? new CloudClient({ provider, key: apiKey, dialect, terms: [...userTerms.filter(t => !DEFAULT_SET.has(t.toLowerCase())), ...(dialect === 'cl' ? CHILE_TERMS : []), ...userTerms] }) : (S.client = S.client || new WhisperClient());
    try {
      runtxt.textContent = engine === 'cloud' ? 'Conectando con el servicio de transcripción…' : 'Preparando el modelo…';
      await client.load(key, cap, (p) => {
        if (p.total) { bar.style.width = Math.round(p.loaded / p.total * 100) + '%'; runtxt.textContent = `Descargando el modelo: ${mb(p.loaded)} de ${mb(p.total)} MB (solo la primera vez)`; }
      }, (n) => toast(n, 7000));
      bar.style.width = '0';
      let sinceRender = 0;
      await transcribe(rec, {
        client, modelKey: key, cap, glossary: terms,
        shouldStop: () => stopFlag,
        onStatus: (s) => {
          if (s.phase === 'analyze') { runtxt.textContent = `Detectando dónde hay voz… ${Math.round(s.pct * 100)}%`; bar.style.width = Math.round(s.pct * 100) + '%'; }
          else if (s.phase === 'run') {
            bar.style.width = Math.round(s.pct * 100) + '%';
            runtxt.textContent = `Transcribiendo… ${Math.round(s.pct * 100)}% · tramo ${s.done} de ${s.total}` + (isFinite(s.eta) ? ` · faltan ≈ ${fmtTime(s.eta)}` : '');
            if (s.added.length) last.textContent = '…' + s.added[s.added.length - 1].text.slice(-140);
            if (++sinceRender >= 3) { sinceRender = 0; renderTranscript(); $('#tsearch').hidden = false; }
          }
        },
      });
      renderTranscript();
      toast(rec.transcript.state === 'done' ? (rec.segments.length ? 'Transcripción lista' : 'No se detectó voz en el audio') : 'Transcripción en pausa: puedes continuar cuando quieras');
    } catch (e) {
      console.error(e);
      const m = String(e.message || e);
      const adv = engine === 'cloud' ? '' : /memory|alloc|OOM|out of/i.test(m) ? 'Falta memoria en este dispositivo: prueba con el modo Equilibrado o Rápido.'
        : /fetch|network|load failed|Failed to|404|403/i.test(m) ? 'No se pudo descargar el modelo. Revisa tu conexión a internet (solo se necesita la primera vez) y vuelve a intentar.'
        : 'Prueba con otro modelo o recarga la página; lo ya transcrito está guardado.';
      failHtml = `<div class="alert bad"><b>No se pudo transcribir.</b> ${adv}<br><span class="small">${esc(m)}</span></div>`;
    } finally {
      running = false; keepAwake(false);
      if (tab === 'tx') { renderTPanel(); $('#tsearch').hidden = rec.segments.length === 0; renderTranscript(); if (failHtml) { $('#tpanel').insertAdjacentHTML('afterbegin', failHtml); $('#tpanel').scrollIntoView({ block: 'start' }); } }
    }
  }
  disposers.push(() => { stopFlag = true; });

  /* ================= MATERIAL ================= */
  let matSel = null;
  function paneMaterial() {
    if (!matSel && atts.length) matSel = { aid: atts[0].id, n: 1 };
    pane.innerHTML = `
      <div class="row between"><h2 style="margin:0">Material de la clase</h2>
        <label class="btn sm" for="mfile">Adjuntar PDF o PPTX</label><input id="mfile" type="file" accept=".pdf,.pptx,application/pdf" multiple hidden></div>
      <div id="mprog" class="progress" style="margin:10px 0" hidden><div></div></div>
      ${atts.length ? '' : '<div class="panel" style="margin-top:12px"><p><b>Sin material adjunto.</b></p><p class="muted">Adjunta el PDF o PowerPoint del profesor. Verás cada diapositiva y podrás insertarla en la transcripción, en el momento del audio donde se mostró. Si tu archivo es un PPT antiguo, guárdalo como PDF o .pptx.</p></div>'}
      <div id="mbody"></div>`;
    $('#mfile').onchange = async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      const prog = $('#mprog');
      for (const f of files) {
        prog.hidden = false; prog.firstElementChild.style.width = '0';
        try {
          const att = await addAttachment(f, rec.id, (p) => { prog.firstElementChild.style.width = Math.round(p * 100) + '%'; });
          atts.push(att); slideTexts = null; if (!matSel) matSel = { aid: att.id, n: 1 };
        } catch (err) { toast(err.message || String(err), 7000); }
      }
      paneMaterial();
    };
    if (atts.length) renderMat();
  }

  async function renderMat() {
    const body = $('#mbody'); if (!body) return;
    const att = atts.find(a => a.id === matSel.aid) || atts[0];
    matSel = { aid: att.id, n: Math.min(matSel.n, att.n) };
    const sl = await get('slides', [att.id, matSel.n]);
    const t = Math.round(aud.currentTime * 10) / 10;
    const placed = rec.markers.filter(m => m.type === 'slide' && m.aid === att.id && m.n === matSel.n);
    body.innerHTML = `
      <div class="row" style="margin:10px 0">
        <select id="msel" aria-label="Archivo" style="max-width:100%">${atts.map(a => `<option value="${a.id}" ${a.id === att.id ? 'selected' : ''}>${esc(a.name)} (${a.n} diap.)</option>`).join('')}</select>
        <button class="btn sm danger" id="mrm">Quitar este archivo</button>
      </div>
      <div class="viewer stack">
        <img src="${sl && sl.img ? mkURL(sl.img) : ''}" alt="Diapositiva ${matSel.n}">
        <div class="row between">
          <button class="btn" id="mprev" ${matSel.n <= 1 ? 'disabled' : ''}>‹ Anterior</button>
          <span class="muted">Diapositiva <b>${matSel.n}</b> de ${att.n}</span>
          <button class="btn" id="mnext" ${matSel.n >= att.n ? 'disabled' : ''}>Siguiente ›</button>
        </div>
        <div class="row">
          <button class="btn primary" id="mins">Insertar en la transcripción en ${fmtTime(t)}</button>
          ${placed.length ? `<span class="small muted">Ya está en: ${placed.map(m => `<a href="#" data-seek="${m.t}" onclick="return false">${fmtTime(m.t)}</a>`).join(', ')}</span>` : ''}
        </div>
        <p class="small muted" style="margin:0">Reproduce el audio hasta el momento en que el profesor mostró esta diapositiva y pulsa «Insertar». El botón usa el punto actual del reproductor.</p>
        ${sl && sl.text ? `<details><summary class="small">Texto de la diapositiva</summary><p style="white-space:pre-wrap">${esc(sl.text)}</p></details>` : ''}
      </div>
      <h3 style="margin-top:18px">Todas las diapositivas</h3>
      <div class="slides-grid" id="grid">${Array.from({ length: att.n }, (_, i) => `<button class="thumb ${i + 1 === matSel.n ? 'sel' : ''}" data-n="${i + 1}" aria-label="Ir a la diapositiva ${i + 1}"><img alt="" data-n="${i + 1}"><span>${i + 1}. ${esc((att.titles && att.titles[i]) || '')}</span></button>`).join('')}</div>`;
    $('#msel').onchange = (e) => { matSel = { aid: e.target.value, n: 1 }; renderMat(); };
    $('#mprev').onclick = () => { matSel.n--; renderMat(); };
    $('#mnext').onclick = () => { matSel.n++; renderMat(); };
    $('#mins').onclick = async () => {
      rec.markers.push({ type: 'slide', aid: att.id, n: matSel.n, t: Math.round(aud.currentTime * 10) / 10 });
      await saveRec(rec); drawSeek(); toast(`Diapositiva ${matSel.n} insertada en ${fmtTime(aud.currentTime)}`); renderMat();
    };
    $('#mrm').onclick = async () => {
      if (!(await confirmBox(`¿Quitar «${att.name}» de esta clase?`, 'Quitar', true))) return;
      await deleteAttachment(att.id);
      rec.markers = rec.markers.filter(m => m.aid !== att.id); await saveRec(rec);
      atts = atts.filter(a => a.id !== att.id); matSel = atts[0] ? { aid: atts[0].id, n: 1 } : null; slideTexts = null; drawSeek(); paneMaterial();
    };
    body.querySelectorAll('[data-seek]').forEach(a => a.onclick = (e) => { e.preventDefault(); seek(+a.dataset.seek, true); });
    $('#grid').onclick = (e) => { const b = e.target.closest('.thumb'); if (b) { matSel.n = +b.dataset.n; renderMat(); window.scrollTo({ top: 0 }); } };
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting) {
        io.unobserve(en.target);
        get('slides', [att.id, +en.target.dataset.n]).then(s => { if (s && s.img) en.target.src = mkURL(s.img); });
      }
    }, { rootMargin: '200px' });
    $$('#grid img').forEach(i => io.observe(i));
    disposers.push(() => io.disconnect());
  }

  /* ================= EXPORTAR ================= */
  function paneExport() {
    const ex = Object.assign({ times: true, slides: true }, lsGet('estrato.export', {}));
    pane.innerHTML = `
      <section class="panel stack">
        <h2>Descargar</h2>
        <label class="row"><input type="checkbox" id="xt" ${ex.times ? 'checked' : ''}> Incluir marcas de tiempo</label>
        <label class="row"><input type="checkbox" id="xs" ${ex.slides ? 'checked' : ''}> Incluir las diapositivas</label>
        <p class="small muted" style="margin:0">Las diapositivas aparecen donde las insertaste en la transcripción. Los archivos sin ninguna diapositiva insertada se agregan completos al final.</p>
        <div class="row">
          <button class="btn primary" id="xw" ${rec.segments.length ? '' : 'disabled'}>Word (.docx)</button>
          <button class="btn primary" id="xp" ${rec.segments.length ? '' : 'disabled'}>PDF</button>
          <button class="btn" id="xtxt" ${rec.segments.length ? '' : 'disabled'}>Texto (.txt)</button>
        </div>
        ${rec.segments.length ? '' : '<p class="small muted" style="margin:0">Primero transcribe la clase para poder exportar el texto.</p>'}
        <div id="xmsg" class="small muted"></div>
      </section>
      <section class="panel stack">
        <h2>Audio original</h2>
        <p class="small muted" style="margin:0">Guarda una copia del audio fuera del navegador (${blob ? mb(blob.size) + ' MB' : ''}).</p>
        <div><button class="btn" id="xa" ${blob ? '' : 'disabled'}>Descargar audio</button></div>
      </section>`;
    const opts = () => { const o = { times: $('#xt').checked, slides: $('#xs').checked }; lsSet('estrato.export', o); return o; };
    const wrap = (fn, label) => async () => {
      $('#xmsg').textContent = `Generando ${label}…`;
      $$('#pane .btn').forEach(b => b.disabled = true);
      try { await fn(rec, opts()); $('#xmsg').textContent = `${label} listo: revisa tus descargas.`; }
      catch (e) { console.error(e); $('#xmsg').textContent = ''; toast('No se pudo generar el archivo: ' + (e.message || e), 8000); }
      $$('#pane .btn').forEach(b => { if (!(b.id === 'xa' && !blob)) b.disabled = false; });
    };
    $('#xw').onclick = wrap(exportDocx, 'el documento de Word');
    $('#xp').onclick = wrap(exportPDF, 'el PDF');
    $('#xtxt').onclick = wrap(exportTxt, 'el archivo de texto');
    $('#xa').onclick = () => download(blob, safeName(rec.title) + '.' + extFor(rec.mime || blob.type));
  }

  setTab('tx');
  if (autoTranscribe && !rec.segments.length) {
    const p = $('#tpanel'); if (p) p.scrollIntoView({ block: 'start' });
  }

  return () => { disposers.forEach(f => { try { f(); } catch {} }); urls.forEach(u => URL.revokeObjectURL(u)); aud.pause(); };
}

/* ---------- arranque ---------- */
(async function init() {
  try {
    await db();
    const recs = await all('recs');
    const rescued = await recoverInterrupted(recs);
    if (rescued.length) toast(`Se rescató ${rescued.length} grabación interrumpida. Está en «Clases».`, 8000);
    cleanOrphans();
  } catch (e) { console.error(e); }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  route();
})();
