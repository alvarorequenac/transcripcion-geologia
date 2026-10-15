// Material de la clase: PDF y PowerPoint (.pptx) convertidos a diapositivas con texto buscable.
import { put, uid } from './db.js';

const loaded = new Map();
export function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);
  const p = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
  loaded.set(src, p);
  return p;
}

const toBlob = (canvas, type = 'image/jpeg', q = 0.82) => new Promise(r => canvas.toBlob(r, type, q));

async function processPDF(file, aid, onProgress) {
  await loadScript('vendor/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const slides = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1500 / v1.width);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const tc = await page.getTextContent();
    let text = '', lastY = null;
    for (const it of tc.items) {
      const y = it.transform ? it.transform[5] : 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !/\s$/.test(text)) text += ' ';
      text += it.str; lastY = y;
    }
    const img = await toBlob(c);
    const rec = { aid, n, text: text.replace(/[ \t]+\n/g, '\n').trim(), img, w: c.width, h: c.height };
    await put('slides', rec);
    slides.push({ n, text: rec.text });
    c.width = c.height = 0;
    if (onProgress) onProgress(n / pdf.numPages);
  }
  return slides;
}

function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? line + ' ' + word : word;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = word; } else line = t;
    }
    lines.push(line);
  }
  return lines;
}

async function processPPTX(file, aid, onProgress) {
  await loadScript('vendor/jszip.min.js');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const xml = async (p) => { const f = zip.file(p); return f ? parser.parseFromString(await f.async('string'), 'application/xml') : null; };
  const pres = await xml('ppt/presentation.xml');
  const rels = await xml('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) throw new Error('El archivo no parece un PowerPoint (.pptx) válido.');
  const relMap = {};
  for (const r of rels.getElementsByTagName('Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
  const order = [];
  for (const s of pres.getElementsByTagName('p:sldId')) {
    const rid = s.getAttribute('r:id');
    if (relMap[rid]) order.push('ppt/' + relMap[rid].replace(/^\.?\/?(ppt\/)?/, ''));
  }
  const slides = [];
  for (let i = 0; i < order.length; i++) {
    const path = order[i];
    const doc = await xml(path);
    if (!doc) continue;
    const paras = [];
    for (const p of doc.getElementsByTagName('a:p')) {
      const t = [...p.getElementsByTagName('a:t')].map(x => x.textContent).join('');
      if (t.trim()) paras.push(t.trim());
    }
    const text = paras.join('\n');
    // imágenes de la diapositiva
    const relDoc = await xml(path.replace('slides/', 'slides/_rels/') + '.rels');
    const imgs = [];
    if (relDoc) {
      const rmap = {};
      for (const r of relDoc.getElementsByTagName('Relationship')) rmap[r.getAttribute('Id')] = r.getAttribute('Target');
      for (const b of doc.getElementsByTagName('a:blip')) {
        const id = b.getAttribute('r:embed');
        const tg = rmap[id];
        if (!tg) continue;
        const mp = 'ppt/' + tg.replace(/^\.\.\//, '');
        if (!/\.(png|jpe?g|gif|webp)$/i.test(mp)) continue;
        const f = zip.file(mp);
        if (f) {
          const bytes = await f.async('uint8array');
          const ext = mp.split('.').pop().toLowerCase();
          try { imgs.push(await createImageBitmap(new Blob([bytes], { type: ext === 'jpg' ? 'image/jpeg' : 'image/' + ext }))); } catch {}
        }
      }
    }
    // tarjeta 16:9 con el texto y las imágenes
    const W = 1280, H = 720;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e8eeec'; ctx.fillRect(0, 0, W, 10);
    const hasImg = imgs.length > 0;
    const textW = hasImg ? 640 : W - 120;
    let y = 70;
    ctx.fillStyle = '#12201d';
    paras.forEach((p, k) => {
      const title = k === 0;
      ctx.font = title ? 'bold 44px Georgia, serif' : '30px system-ui, sans-serif';
      const lines = wrap(ctx, (title ? '' : '• ') + p, textW);
      for (const l of lines) { if (y > H - 40) return; ctx.fillText(l, 60, y); y += title ? 54 : 40; }
      y += title ? 18 : 8;
    });
    if (hasImg) {
      const areaX = 740, areaW = W - areaX - 50, areaH = H - 120;
      const h = areaH / Math.min(imgs.length, 2);
      imgs.slice(0, 2).forEach((im, k) => {
        const r = Math.min(areaW / im.width, (h - 16) / im.height);
        const w = im.width * r, hh = im.height * r;
        ctx.drawImage(im, areaX + (areaW - w) / 2, 70 + k * h + (h - 16 - hh) / 2, w, hh);
      });
    }
    const img = await toBlob(c);
    await put('slides', { aid, n: i + 1, text, img, w: W, h: H });
    slides.push({ n: i + 1, text });
    if (onProgress) onProgress((i + 1) / order.length);
    await new Promise(r => setTimeout(r));
  }
  return slides;
}

export async function addAttachment(file, rid, onProgress) {
  const name = file.name;
  const kind = /\.pdf$/i.test(name) || file.type === 'application/pdf' ? 'pdf'
    : /\.pptx$/i.test(name) ? 'pptx' : null;
  if (!kind) {
    if (/\.ppt$/i.test(name)) throw new Error('Los .ppt antiguos no se pueden leer. En PowerPoint usa Archivo → Guardar como → .pptx o PDF.');
    throw new Error('Formato no compatible. Usa PDF o PowerPoint (.pptx).');
  }
  const aid = uid();
  const slides = kind === 'pdf' ? await processPDF(file, aid, onProgress) : await processPPTX(file, aid, onProgress);
  if (!slides.length) throw new Error('No se encontraron diapositivas en el archivo.');
  const att = { id: aid, rid, name, kind, size: file.size, n: slides.length, created: Date.now(), blob: file, titles: slides.map(s => (s.text.split('\n')[0] || '').slice(0, 90)) };
  await put('atts', att);
  return att;
}
