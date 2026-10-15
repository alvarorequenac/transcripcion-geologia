// Búsqueda sin distinguir mayúsculas ni tildes.
const norm1 = (c) => {
  let n = (c.normalize('NFD')[0] || c).toLowerCase();
  return n.length === 1 ? n : n[0];
};
export function norm(s) {
  let o = '';
  for (let i = 0; i < s.length; i++) o += norm1(s[i]);
  return o;
}

export function findAll(text, q) {
  const nq = norm(q.trim());
  if (!nq) return [];
  const nt = norm(text);
  const out = [];
  let i = 0;
  while ((i = nt.indexOf(nq, i)) !== -1) { out.push([i, i + nq.length]); i += nq.length; }
  return out;
}

export const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function highlight(text, ranges) {
  if (!ranges.length) return esc(text);
  let o = '', p = 0;
  for (const [a, b] of ranges) { o += esc(text.slice(p, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; p = b; }
  return o + esc(text.slice(p));
}

export function snippet(text, ranges, ctx = 60) {
  const [a, b] = ranges[0];
  const s = Math.max(0, a - ctx), e = Math.min(text.length, b + ctx);
  const pre = s > 0 ? '…' : '', post = e < text.length ? '…' : '';
  return pre + highlight(text.slice(s, e), ranges.filter(r => r[0] >= s && r[1] <= e).map(r => [r[0] - s, r[1] - s])) + post;
}
