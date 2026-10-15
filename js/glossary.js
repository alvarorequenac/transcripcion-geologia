// Glosario de geología: corrige términos técnicos que Whisper suele deformar.
export const DEFAULT_TERMS = `plagioclasa, feldespato, feldespato potásico, ortoclasa, microclina, cuarzo, olivino, piroxeno, ortopiroxeno, clinopiroxeno, anfíbol, hornblenda, biotita, moscovita, clorita, epidota, granate, circón, apatito, magnetita, ilmenita, pirita, calcopirita, calcita, dolomita, yeso, halita, granito, granodiorita, tonalita, diorita, gabro, peridotita, basalto, andesita, dacita, riolita, traquita, fonolita, obsidiana, pumita, toba, ignimbrita, brecha, conglomerado, arenisca, limolita, lutita, caliza, gneis, esquisto, filita, pizarra, cuarcita, mármol, anfibolita, migmatita, magma, lava, intrusivo, extrusivo, plutón, batolito, dique, xenolito, fenocristal, vesícula, porfírica, afanítica, fanerítica, vítrea, subducción, tectónica, litosfera, astenosfera, discordancia, estratigrafía, diaclasa, sinclinal, anticlinal, rumbo, manteo, meteorización, sedimentación, diagénesis, metamorfismo, anatexis, cristalización fraccionada, birrefringencia, clivaje, exfoliación, fractura concoidea, Mohs, Paleozoico, Mesozoico, Cenozoico, Triásico, Jurásico, Cretácico, Devónico, Carbonífero, Pérmico, Cuaternario, Pleistoceno, Holoceno, Cordillera de la Costa, Cordillera de los Andes, Concepción, Bío Bío`;

export function parseTerms(s) {
  return (s || '').split(/[,\n;]+/).map(x => x.trim()).filter(Boolean);
}

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

export function buildGlossary(terms) {
  const byLen = new Map();
  const list = terms.map(t => {
    const words = t.split(/\s+/);
    return { t, k: words.length, n: strip(t).replace(/\s+/g, ' ') };
  });
  for (const g of list) {
    const key = g.k;
    if (!byLen.has(key)) byLen.set(key, []);
    byLen.get(key).push(g);
  }
  return byLen;
}

// Devuelve { text, changed } con los términos corregidos.
export function applyGlossary(text, gl) {
  const toks = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ w: m[0], i: m.index }));
  const reps = [];
  let changed = 0;
  for (let p = 0; p < toks.length; p++) {
    for (const [k, terms] of gl) {
      if (p + k > toks.length) continue;
      const seg = toks.slice(p, p + k);
      // las palabras de la ventana deben ir seguidas por espacios
      let ok = true;
      for (let q = 1; q < k; q++) {
        const gap = text.slice(seg[q - 1].i + seg[q - 1].w.length, seg[q].i);
        if (!/^\s+$/.test(gap)) { ok = false; break; }
      }
      if (!ok) continue;
      const orig = text.slice(seg[0].i, seg[k - 1].i + seg[k - 1].w.length);
      const n = strip(orig).replace(/\s+/g, ' ');
      if (n.length < 6) continue;
      let best = null, bs = 0;
      for (const g of terms) {
        if (Math.abs(g.n.length - n.length) > 2 || g.n[0] !== n[0]) continue;
        const s = 1 - lev(n, g.n) / Math.max(n.length, g.n.length);
        if (s > bs) { bs = s; best = g; }
      }
      if (best && bs >= 0.84 && orig !== best.t) {
        let rep = best.t;
        if (/^\p{Lu}/u.test(orig) && !/^\p{Lu}/u.test(rep)) rep = rep[0].toUpperCase() + rep.slice(1);
        if (rep !== orig) { reps.push({ a: seg[0].i, b: seg[k - 1].i + seg[k - 1].w.length, rep }); changed++; p += k - 1; break; }
      }
    }
  }
  let out = text;
  for (let r = reps.length - 1; r >= 0; r--) out = out.slice(0, reps[r].a) + reps[r].rep + out.slice(reps[r].b);
  return { text: out, changed };
}


// Vocabulario de Geología de Chile y del habla chilena: sesga a Whisper hacia la ortografía correcta.
export const CHILE_TERMS = [
  'Cordillera de Nahuelbuta', 'Cuenca de Arauco', 'Batolito Costero', 'Zona de Falla Liquiñe-Ofqui', 'Bahía de Concepción',
  'Lota', 'Coronel', 'Penco', 'Tomé', 'Santa Juana', 'Biobío', 'Ñuble', 'Atacama', 'Antofagasta', 'Copiapó', 'Altiplano',
  'Precordillera', 'Depresión Intermedia', 'Zona Volcánica Sur', 'Zona Volcánica Central', 'volcán Villarrica', 'Llaima',
  'Antuco', 'Chaitén', 'Calbuco', 'Nevados de Chillán', 'Laguna del Maule', 'placa de Nazca', 'placa Sudamericana',
  'fosa Chile-Perú', 'Dorsal de Chile', 'terremoto de Valdivia', 'pórfido cuprífero', 'Chuquicamata', 'El Teniente',
  'Escondida', 'Sernageomin', 'Universidad de Concepción', 'UdeC',
];
export const CHILE_SPEECH = 'Habla coloquial chilena: "po", "cachai", "al tiro", "ya", "bacán", "fome".';
