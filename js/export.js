// Exportación a Word (.docx), PDF y texto.
import { get, byIndex } from './db.js';
import { loadScript } from './attachments.js';

export const fmtTime = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0');
};

export const fmtDate = (ms) => new Date(ms).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// Mezcla segmentos y marcas en orden cronológico.
export function buildItems(rec) {
  const items = [];
  const segs = [...rec.segments].sort((a, b) => a.start - b.start);
  const marks = [...(rec.markers || [])].sort((a, b) => a.t - b.t);
  let mi = 0;
  for (const s of segs) {
    while (mi < marks.length && marks[mi].t <= s.start) items.push({ kind: 'mark', m: marks[mi++] });
    items.push({ kind: 'seg', s });
  }
  while (mi < marks.length) items.push({ kind: 'mark', m: marks[mi++] });
  return items;
}

// Agrupa frases en párrafos legibles para los documentos.
export function toBlocks(rec) {
  const blocks = [];
  let cur = null;
  for (const it of buildItems(rec)) {
    if (it.kind === 'seg') {
      const s = it.s;
      if (cur && (s.start - cur.end > 3 || s.start - cur.start > 45)) { blocks.push(cur); cur = null; }
      if (!cur) cur = { type: 'text', start: s.start, end: s.end, text: '' };
      cur.text += (cur.text ? ' ' : '') + s.text; cur.end = s.end;
    } else {
      if (cur) { blocks.push(cur); cur = null; }
      blocks.push({ type: it.m.type, m: it.m });
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

async function loadMaterial(rec, opts) {
  const atts = (await byIndex('atts', 'rid', rec.id)).sort((a, b) => a.created - b.created);
  const used = new Set((rec.markers || []).filter(m => m.type === 'slide').map(m => m.aid));
  const cache = new Map();
  const slide = async (aid, n) => {
    const k = aid + ':' + n;
    if (!cache.has(k)) cache.set(k, await get('slides', [aid, n]));
    return cache.get(k);
  };
  const appendix = [];
  if (opts.slides) {
    for (const a of atts) {
      if (!used.has(a.id)) for (let n = 1; n <= a.n; n++) appendix.push({ att: a, n });
    }
  }
  return { atts, slide, appendix, byId: Object.fromEntries(atts.map(a => [a.id, a])) };
}

const blobToBytes = async (b) => new Uint8Array(await b.arrayBuffer());
const blobToDataURL = (b) => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

export const safeName = (s) => (s || 'clase').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'clase';

export async function exportDocx(rec, opts) {
  await loadScript('vendor/docx.umd.js');
  const D = window.docx;
  const mat = await loadMaterial(rec, opts);
  const kids = [];
  const grey = '5B6B67';
  kids.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: rec.title, font: 'Georgia' })] }));
  kids.push(new D.Paragraph({
    spacing: { after: 200 },
    children: [new D.TextRun({ text: `${fmtDate(rec.created)} · Duración ${fmtTime(rec.duration)}`, color: grey, size: 20 })],
  }));
  if (opts.slides && mat.atts.length) {
    kids.push(new D.Paragraph({
      spacing: { after: 200 },
      children: [new D.TextRun({ text: 'Material de la clase: ' + mat.atts.map(a => a.name).join(', '), color: grey, size: 20, italics: true })],
    }));
  }
  kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun({ text: 'Transcripción', font: 'Georgia' })] }));

  const imgPara = async (aid, n, caption) => {
    const sl = await mat.slide(aid, n);
    const out = [];
    const att = mat.byId[aid];
    out.push(new D.Paragraph({
      keepNext: true, spacing: { before: 200, after: 60 },
      children: [new D.TextRun({ text: `Diapositiva ${n}${att ? ' · ' + att.name : ''}`, bold: true, color: '1B6B55', size: 20 })],
    }));
    if (sl && sl.img) {
      const w = 440, h = Math.round(w * sl.h / sl.w);
      out.push(new D.Paragraph({
        spacing: { after: 160 },
        children: [new D.ImageRun({ data: await blobToBytes(sl.img), transformation: { width: w, height: h } })],
      }));
    }
    return out;
  };

  for (const b of toBlocks(rec)) {
    if (b.type === 'text') {
      kids.push(new D.Paragraph({
        spacing: { after: 140, line: 300 },
        children: [
          ...(opts.times ? [new D.TextRun({ text: `[${fmtTime(b.start)}] `, bold: true, color: grey, size: 18 })] : []),
          new D.TextRun({ text: b.text, size: 22 }),
        ],
      }));
    } else if (b.type === 'slide') {
      if (opts.slides) kids.push(...await imgPara(b.m.aid, b.m.n));
    } else if (b.type === 'star') {
      kids.push(new D.Paragraph({
        spacing: { before: 100, after: 100 },
        children: [new D.TextRun({ text: `★ Momento marcado${b.m.label ? ': ' + b.m.label : ''} (${fmtTime(b.m.t)})`, bold: true, color: 'A06A0C', size: 20 })],
      }));
    } else if (b.type === 'interrupt') {
      kids.push(new D.Paragraph({
        spacing: { before: 100, after: 100 },
        children: [new D.TextRun({ text: `⚠ El micrófono se interrumpió (${fmtTime(b.m.t)}); puede faltar audio en este tramo.`, italics: true, color: 'B3402B', size: 20 })],
      }));
    }
  }
  if (mat.appendix.length) {
    kids.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new D.TextRun({ text: 'Material de la clase', font: 'Georgia' })] }));
    for (const x of mat.appendix) kids.push(...await imgPara(x.att.id, x.n));
  }
  const doc = new D.Document({
    creator: 'Estrato',
    title: rec.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: {
        default: new D.Footer({
          children: [new D.Paragraph({
            alignment: D.AlignmentType.CENTER,
            children: [new D.TextRun({ children: ['Página ', D.PageNumber.CURRENT, ' de ', D.PageNumber.TOTAL_PAGES], size: 18, color: grey })],
          })],
        }),
      },
      children: kids,
    }],
  });
  const blob = await D.Packer.toBlob(doc);
  download(blob, safeName(rec.title) + '.docx');
}

const latin = (s) => s
  .replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/★/g, '*').replace(/⚠/g, '!')
  .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '?');

export async function exportPDF(rec, opts) {
  await loadScript('vendor/jspdf.umd.min.js');
  const { jsPDF } = window.jspdf;
  const mat = await loadMaterial(rec, opts);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const PW = 595, PH = 842, M = 56, CW = PW - 2 * M;
  let y = M;
  const need = (h) => { if (y + h > PH - M) { pdf.addPage(); y = M; } };
  const text = (s, { size = 11, style = 'normal', color = [20, 32, 29], gap = 1.45, after = 6, font = 'helvetica' } = {}) => {
    pdf.setFont(font, style); pdf.setFontSize(size); pdf.setTextColor(...color);
    const lines = pdf.splitTextToSize(latin(s), CW);
    for (const l of lines) { need(size * gap); y += size * gap * 0.82; pdf.text(l, M, y); y += size * gap * 0.18; }
    y += after;
  };
  text(rec.title, { size: 22, style: 'bold', font: 'times', after: 4 });
  text(`${fmtDate(rec.created)} · Duración ${fmtTime(rec.duration)}`, { size: 10, color: [91, 107, 103], after: 4 });
  if (opts.slides && mat.atts.length) text('Material de la clase: ' + mat.atts.map(a => a.name).join(', '), { size: 10, style: 'italic', color: [91, 107, 103], after: 10 });
  text('Transcripción', { size: 15, style: 'bold', font: 'times', after: 6 });

  const slideBlock = async (aid, n) => {
    const sl = await mat.slide(aid, n);
    const att = mat.byId[aid];
    const w = Math.min(CW, 380), h = sl && sl.img ? w * sl.h / sl.w : 0;
    need(20 + h + 12);
    text(`Diapositiva ${n}${att ? ' · ' + att.name : ''}`, { size: 10, style: 'bold', color: [27, 107, 85], after: 3 });
    if (sl && sl.img) {
      pdf.addImage(await blobToDataURL(sl.img), 'JPEG', M, y, w, h, undefined, 'FAST');
      pdf.setDrawColor(200, 210, 206); pdf.rect(M, y, w, h);
      y += h + 12;
    }
  };

  for (const b of toBlocks(rec)) {
    if (b.type === 'text') {
      text((opts.times ? `[${fmtTime(b.start)}] ` : '') + b.text, { size: 11, after: 7 });
    } else if (b.type === 'slide') {
      if (opts.slides) await slideBlock(b.m.aid, b.m.n);
    } else if (b.type === 'star') {
      text(`★ Momento marcado${b.m.label ? ': ' + b.m.label : ''} (${fmtTime(b.m.t)})`, { size: 10, style: 'bold', color: [160, 106, 12], after: 6 });
    } else if (b.type === 'interrupt') {
      text(`⚠ El micrófono se interrumpió (${fmtTime(b.m.t)}); puede faltar audio en este tramo.`, { size: 10, style: 'italic', color: [179, 64, 43], after: 6 });
    }
  }
  if (mat.appendix.length) {
    pdf.addPage(); y = M;
    text('Material de la clase', { size: 15, style: 'bold', font: 'times', after: 8 });
    for (const x of mat.appendix) await slideBlock(x.att.id, x.n);
  }
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(120, 130, 127);
    pdf.text(`Página ${i} de ${total}`, PW / 2, PH - 28, { align: 'center' });
  }
  download(pdf.output('blob'), safeName(rec.title) + '.pdf');
}

export async function exportTxt(rec, opts) {
  const lines = [rec.title, `${fmtDate(rec.created)} · Duración ${fmtTime(rec.duration)}`, ''];
  const atts = await byIndex('atts', 'rid', rec.id);
  for (const b of toBlocks(rec)) {
    if (b.type === 'text') lines.push((opts.times ? `[${fmtTime(b.start)}] ` : '') + b.text, '');
    else if (b.type === 'slide') {
      const a = atts.find(x => x.id === b.m.aid);
      lines.push(`--- Diapositiva ${b.m.n}${a ? ' (' + a.name + ')' : ''} ---`);
      const sl = await get('slides', [b.m.aid, b.m.n]);
      if (sl && sl.text) lines.push(sl.text);
      lines.push('');
    } else if (b.type === 'star') lines.push(`★ Momento marcado${b.m.label ? ': ' + b.m.label : ''} (${fmtTime(b.m.t)})`, '');
    else if (b.type === 'interrupt') lines.push(`⚠ Interrupción del micrófono (${fmtTime(b.m.t)})`, '');
  }
  download(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), safeName(rec.title) + '.txt');
}

export { download };
