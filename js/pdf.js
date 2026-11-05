// PDF output: a plain, printable filing packet and a designed keepsake.
import { db } from './db.js';
import { decode, resize, toBlob, toDataURL, sliceRanges, sliceData } from './images.js';
import { peopleText } from './people.js';
import { fmtDate, fmtRange, typeLabel, ymd } from './curate.js';

const PAGE_W = 612, PAGE_H = 792, M = 48; // US Letter, points
const CW = PAGE_W - 2 * M;
const photoDate = (p) => (p.takenAt ? fmtDate(ymd(p.takenAt)) : 'Date unknown');

async function imgData(p, maxSide) {
  const blob = await db.get('blobs', `full:${p.id}`);
  if (!blob) return null;
  if (!maxSide || Math.max(p.w, p.h) <= maxSide) return toDataURL(blob);
  return toDataURL(await toBlob(resize(await decode(blob), maxSide), 0.8));
}

function fit(w, h, bw, bh) {
  const s = Math.min(bw / w, bh / h);
  return [w * s, h * s];
}

function names(project) {
  const a = project.petitioner?.trim(), b = project.beneficiary?.trim();
  return a && b ? `${a} & ${b}` : a || b || '';
}

// ===================== Filing packet =====================
// Attachments (e.g. long chat screenshots), decoded and split into pieces.
const docsOf = (state, e) => (state.docs || []).filter((d) => d.eventId === e.id);
async function prepareDocs(state, colAspect) {
  const out = new Map();
  for (const d of state.docs || []) {
    const blob = await db.get('blobs', `doc:${d.id}`);
    if (!blob) continue;
    const img = await decode(blob);
    out.set(d.id, { img, ranges: sliceRanges(img, colAspect) });
  }
  return out;
}

export async function filingPdf(state, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const P = state.project;
  const events = state.events;
  const photos = state.photos.filter((p) => p.filing);
  const DOC_TOP = M + 28, DOC_H = PAGE_H - M - 40 - DOC_TOP, DOC_W = (CW - 24) / 2;
  onProgress?.('Preparing screenshots…');
  const docParts = await prepareDocs(state, DOC_W / DOC_H);
  const docPages = (d) => Math.ceil((docParts.get(d.id)?.ranges.length || 0) / 2);

  // Cover
  doc.setFont('times', 'bold').setFontSize(24);
  doc.text('Relationship Timeline', PAGE_W / 2, 220, { align: 'center' });
  doc.setFont('times', 'normal').setFontSize(13);
  doc.text('Evidence of a bona fide marital relationship', PAGE_W / 2, 248, { align: 'center' });
  doc.text('Submitted in support of Form I-130, Petition for Alien Relative', PAGE_W / 2, 266, { align: 'center' });
  let y = 330;
  doc.setFontSize(12);
  const row = (k, v) => {
    if (!v) return;
    doc.setFont('times', 'bold').text(k, 170, y);
    doc.setFont('times', 'normal').text(v, 290, y);
    y += 22;
  };
  row('Petitioner:', P.petitioner);
  row('Beneficiary:', P.beneficiary);
  row('Receipt number:', P.receipt);
  row('Prepared:', new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
  y += 20;
  doc.setFontSize(11);
  doc.text(`Contents: timeline of ${events.length} events · ${photos.length} photographs (Exhibits ${events.find((e) => e.exhibit)?.exhibit || '—'}–${[...events].reverse().find((e) => e.exhibit)?.exhibit || '—'})`, PAGE_W / 2, y, { align: 'center' });

  // Timeline table
  doc.addPage();
  const cols = [
    ['Date', 82], ['Event', 108], ['Location', 82], ['Details', 170], ['Exhibits', 74],
  ];
  const header = () => {
    doc.setFont('helvetica', 'bold').setFontSize(14).text('Timeline of Relationship', M, M + 4);
    y = M + 22;
    doc.setFillColor(235, 235, 235).rect(M, y, CW, 18, 'F');
    doc.setFontSize(9);
    let x = M + 4;
    for (const [t, w] of cols) { doc.text(t, x, y + 12); x += w; }
    y += 18;
  };
  header();
  doc.setFont('helvetica', 'normal').setFontSize(9);
  for (const e of events) {
    const np = state.photos.filter((p) => p.eventId === e.id && p.filing).length;
    const nd = docsOf(state, e).length;
    const n = np + nd;
    const details = [e.description, e.documents && `Documents: ${e.documents}`].filter(Boolean).join('\n');
    const cells = [
      fmtRange(e.start, e.end),
      `${e.title}${e.type && e.type !== 'other' ? `\n(${typeLabel(e.type)})` : ''}`,
      e.location || '—',
      details || '—',
      n ? `${e.exhibit}-1${n > 1 ? ` to ${e.exhibit}-${n}` : ''}\n(${[np && `${np} photo${np > 1 ? 's' : ''}`, nd && `${nd} document${nd > 1 ? 's' : ''}`].filter(Boolean).join(', ')})` : '—',
    ];
    const lines = cells.map((c, i) => doc.splitTextToSize(String(c), cols[i][1] - 8));
    const h = Math.max(...lines.map((l) => l.length)) * 11 + 8;
    if (y + h > PAGE_H - M) { doc.addPage(); header(); doc.setFont('helvetica', 'normal').setFontSize(9); }
    let x = M + 4;
    lines.forEach((l, i) => {
      doc.setFont('helvetica', i === 1 ? 'bold' : 'normal');
      doc.text(l, x, y + 12);
      x += cols[i][1];
    });
    y += h;
    doc.setDrawColor(200).line(M, y, M + CW, y);
  }

  // Exhibit index
  if (photos.length || (state.docs || []).length) {
    doc.addPage();
    doc.setFont('helvetica', 'bold').setFontSize(14).text('Index of Exhibits', M, M + 4);
    y = M + 28;
    doc.setFontSize(9);
    for (const e of events.filter((ev) => ev.exhibit)) {
      if (y > PAGE_H - M - 30) { doc.addPage(); y = M; }
      doc.setFont('helvetica', 'bold').text(`Exhibit ${e.exhibit} — ${e.title} (${fmtRange(e.start, e.end)})`, M, y);
      y += 13;
      doc.setFont('helvetica', 'normal');
      for (const p of state.photos.filter((q) => q.eventId === e.id && q.filing).sort((a, b) => a.exhibit.localeCompare(b.exhibit, undefined, { numeric: true }))) {
        if (y > PAGE_H - M) { doc.addPage(); y = M; }
        const line = doc.splitTextToSize(`${p.exhibit}   ${photoDate(p)}${e.location ? ` · ${e.location}` : ''}${p.caption ? ` · ${p.caption}` : ''}`, CW - 14);
        doc.text(line, M + 14, y);
        y += line.length * 11;
      }
      for (const d of docsOf(state, e)) {
        if (y > PAGE_H - M) { doc.addPage(); y = M; }
        const k = docPages(d);
        const line = doc.splitTextToSize(`${d.exhibit}   ${d.caption || d.name} (${k} page${k === 1 ? '' : 's'})`, CW - 14);
        doc.text(line, M + 14, y);
        y += line.length * 11;
      }
      y += 8;
    }
  }

  // Photo pages: a continuous 2x2 grid across events (a wide photo takes a
  // full row), each labeled with its exhibit number, date, place and caption.
  const ROW_H = (PAGE_H - 2 * M - 30) / 2, CAP_H = 44, IMG_H = ROW_H - CAP_H - 8, COL_W = (CW - 20) / 2;
  let gRow = 0, gCol = 0, needPage = true;
  const advanceRow = () => { gCol = 0; if (++gRow >= 2) { gRow = 0; needPage = true; } };
  const takeSlot = (wide) => {
    if (wide && gCol === 1) advanceRow();
    if (needPage) { doc.addPage(); needPage = false; }
    const slot = { row: gRow, col: wide ? 0 : gCol };
    if (wide || gCol === 1) advanceRow(); else gCol = 1;
    return slot;
  };
  const total = photos.length;
  let count = 0;
  for (const e of events) {
  const ordered = state.photos.filter((p) => p.eventId === e.id && p.filing).sort((a, b) => a.exhibit.localeCompare(b.exhibit, undefined, { numeric: true }));
  for (const p of ordered) {
    onProgress?.(`Adding photo ${++count} of ${total}…`);
    const wide = p.w / p.h > 1.25;
    const slot = takeSlot(wide);
    const top = M + slot.row * (ROW_H + 15);
    const x = M + slot.col * (COL_W + 20);
    const w0 = wide ? CW : COL_W;
    const data = await imgData(p, 1600);
    if (data) {
      const [w, h] = fit(p.w, p.h, w0, IMG_H);
      doc.addImage(data, 'JPEG', x + (w0 - w) / 2, top + (IMG_H - h), w, h, `f${p.id}`, 'FAST');
    }
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(0);
    doc.text(`Exhibit ${p.exhibit}`, x, top + IMG_H + 14);
    doc.setFont('helvetica', 'normal').setFontSize(8.5);
    const cap = [photoDate(p), e.location, e.title, p.caption || peopleText(state, p)].filter(Boolean).join(' · ');
    doc.text(doc.splitTextToSize(cap, w0).slice(0, 3), x, top + IMG_H + 26);
  }
  // Attachments: long screenshots split into two columns per page.
  for (const d of docsOf(state, e)) {
    const part = docParts.get(d.id);
    if (!part) continue;
    const W = part.img.naturalWidth || part.img.width;
    const pages = Math.ceil(part.ranges.length / 2);
    for (let i = 0; i < part.ranges.length; i++) {
      if (i % 2 === 0) {
        doc.addPage();
        doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(0);
        doc.text(`Exhibit ${d.exhibit}`, M, M + 4);
        doc.setFont('helvetica', 'normal');
        doc.text(doc.splitTextToSize(`${d.caption || d.name} · ${e.title} (${fmtRange(e.start, e.end)}) · page ${i / 2 + 1} of ${pages}`, CW - 70), M + 70, M + 4);
      }
      const [y0, y1] = part.ranges[i];
      const h = DOC_W * ((y1 - y0) / W);
      const x = M + (i % 2) * (DOC_W + 24);
      doc.addImage(sliceData(part.img, y0, y1, 900), 'JPEG', x, DOC_TOP, DOC_W, h, `d${d.id}${i}`, 'FAST');
      doc.setDrawColor(190).setLineWidth(0.5).rect(x, DOC_TOP, DOC_W, h);
      doc.setFontSize(8).setTextColor(110).text(`${i + 1}/${part.ranges.length}`, x + DOC_W / 2, DOC_TOP + h + 12, { align: 'center' });
      doc.setTextColor(0);
    }
    gRow = 0; gCol = 0; needPage = true; // photos after a screenshot start a new page
  }
  }

  // Footer
  const n = doc.getNumberOfPages();
  for (let i = 2; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110);
    doc.text(names(P), M, PAGE_H - 24);
    doc.text(`Page ${i} of ${n}`, PAGE_W - M, PAGE_H - 24, { align: 'right' });
    doc.setTextColor(0);
  }
  return doc;
}

// ===================== Keepsake =====================
// A designed photo book: full-bleed cover, story page, a chapter opener per
// event, then pages that rotate through several layouts (feature, polaroids,
// grid, duo, mosaic, full page), photos cropped around faces, a milestones
// timeline for events without photos, and a closing page.
const INK = [43, 38, 36], ACCENT = [156, 74, 90], SOFT = [130, 118, 112], PAPER = [251, 247, 241], WHITE = [255, 255, 255];
const KM = 36, KG = 10, KCW = PAGE_W - 2 * KM;

function faceCrop(img, p, aspect, maxSide) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  let cw = W, ch = H;
  if (W / H > aspect) cw = H * aspect; else ch = W / aspect;
  let cx = W / 2, cy = H * 0.45;
  const fl = p.faceList || [];
  if (fl.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const f of fl) { x0 = Math.min(x0, f.b[0]); y0 = Math.min(y0, f.b[1]); x1 = Math.max(x1, f.b[0] + f.b[2]); y1 = Math.max(y1, f.b[1] + f.b[3]); }
    cx = ((x0 + x1) / 2) * W;
    cy = ((y0 + y1) / 2) * H;
  }
  const sx = Math.max(0, Math.min(W - cw, cx - cw / 2));
  const sy = Math.max(0, Math.min(H - ch, cy - ch * 0.42)); // faces slightly above center
  const s = Math.min(1, maxSide / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * s));
  c.height = Math.max(1, Math.round(ch * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, cw, ch, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

export async function keepsakePdf(state, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const P = state.project;
  const chosen = state.photos.filter((p) => p.keepsake);
  const scale = chosen.length > 200 ? 1.6 : 2.2; // pixels per point
  const labels = {};
  let done = 0;
  let imgN = 0;
  const caption = (p) => p.caption || peopleText(state, p);
  const best = (list) => [...list].sort((a, b) => (a.aiRank ?? 99) - (b.aiRank ?? 99) || (b.couple || 0) - (a.couple || 0) || b.score - a.score)[0];

  const alpha = (a) => doc.setGState(new doc.GState({ opacity: a }));
  const paper = () => doc.setFillColor(...PAPER).rect(0, 0, PAGE_W, PAGE_H, 'F');
  const page = (label) => { doc.addPage(); paper(); labels[doc.getNumberOfPages()] = label; };

  async function prep(p, w, h) {
    const blob = await db.get('blobs', `full:${p.id}`);
    if (!blob) return null;
    const img = await decode(blob);
    const data = faceCrop(img, p, w / h, Math.min(1700, Math.max(w, h) * scale));
    img.close?.();
    onProgress?.(`Designing your keepsake… photo ${++done} of ${chosen.length}`);
    return data;
  }
  const put = (data, x, y, w, h) => { if (data) doc.addImage(data, 'JPEG', x, y, w, h, `k${imgN++}`, 'FAST'); };
  async function image(p, x, y, w, h) { put(await prep(p, w, h), x, y, w, h); }
  // White mat with a soft shadow.
  async function framed(p, x, y, w, h, pad = 6) {
    alpha(0.16);
    doc.setFillColor(40, 30, 25).rect(x - pad + 2.5, y - pad + 3.5, w + 2 * pad, h + 2 * pad, 'F');
    alpha(1);
    doc.setFillColor(...WHITE).rect(x - pad, y - pad, w + 2 * pad, h + 2 * pad, 'F');
    await image(p, x, y, w, h);
  }
  function capText(text, x, y, w, align = 'left', size = 10) {
    if (!text) return;
    doc.setFont('times', 'italic').setFontSize(size).setTextColor(...SOFT);
    const lines = doc.splitTextToSize(text, w).slice(0, 2);
    doc.text(lines, align === 'center' ? x + w / 2 : x, y, { align });
  }
  // Draw synchronously inside a rotation about (cx, cy).
  function rotated(cx, cy, deg, draw) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    doc.advancedAPI((d) => {
      d.saveGraphicsState();
      d.setCurrentTransformationMatrix(new d.Matrix(c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c));
      draw();
      d.restoreGraphicsState();
    });
  }
  async function polaroid(p, cx, cy, w, h, deg) {
    const data = await prep(p, w, h);
    rotated(cx, cy, deg, () => {
      const x = cx - w / 2, y = cy - h / 2, pad = 11, bottom = 44;
      alpha(0.18);
      doc.setFillColor(40, 30, 25).rect(x - pad + 3, y - pad + 4, w + 2 * pad, h + pad + bottom, 'F');
      alpha(1);
      doc.setFillColor(...WHITE).rect(x - pad, y - pad, w + 2 * pad, h + pad + bottom, 'F');
      put(data, x, y, w, h);
      capText(caption(p), x, y + h + 22, w, 'center', 11);
    });
  }

  // ---- Layouts: each draws one page from the front of `list` ----
  const top = KM + 6, bottom = PAGE_H - 54, CH = bottom - top;
  const L = {
    full: { n: 1, async draw([a], label) {
      page(label);
      await image(a, 0, 0, PAGE_W, PAGE_H - 92);
      capText(caption(a), KM, PAGE_H - 62, KCW, 'center', 12);
    } },
    duo: { n: 2, async draw([a, b], label) {
      page(label);
      const w = (KCW - KG * 2) / 2, h = CH - 70;
      await framed(a, KM + 4, top + 20, w, h);
      await framed(b, KM + w + KG * 2 - 4, top + 50, w, h - 30);
      capText(caption(a), KM + 4, top + 20 + h + 26, w);
      capText(caption(b), KM + w + KG * 2 - 4, top + 20 + h + 26, w);
    } },
    feature: { n: 3, async draw([a, b, c], label) {
      page(label);
      const wl = KCW * 0.62, wr = KCW - wl - KG, h = CH - 30, hr = (h - KG) / 2;
      await image(a, KM, top, wl, h);
      await image(b, KM + wl + KG, top, wr, hr);
      await image(c, KM + wl + KG, top + hr + KG, wr, hr);
      capText(caption(a), KM, top + h + 18, wl);
    } },
    polaroids: { n: 3, async draw(ps, label) {
      page(label);
      const spots = [[KM + 150, top + 150, -6], [PAGE_W - KM - 160, top + 345, 5], [KM + 190, top + 545, -2.5]];
      for (let i = 0; i < ps.length; i++) await polaroid(ps[i], spots[i][0], spots[i][1], 218, 218, spots[i][2]);
    } },
    grid: { n: 4, async draw(ps, label) {
      page(label);
      const w = (KCW - KG) / 2, h = (CH - KG - 24) / 2;
      for (let i = 0; i < ps.length; i++) await image(ps[i], KM + (i % 2) * (w + KG), top + Math.floor(i / 2) * (h + KG), w, h);
    } },
    mosaic: { n: 4, async draw([a, ...rest], label) {
      page(label);
      const h1 = CH * 0.56, h2 = CH - h1 - KG - 24, w3 = (KCW - 2 * KG) / 3;
      await image(a, KM, top, KCW, h1);
      for (let i = 0; i < rest.length; i++) await image(rest[i], KM + i * (w3 + KG), top + h1 + KG, w3, h2);
    } },
  };
  const cycle = ['feature', 'polaroids', 'grid', 'duo', 'mosaic'];
  let ci = 0;
  async function layoutPages(list, label) {
    let rest = [...list];
    while (rest.length) {
      let name;
      if (rest.length === 1) name = 'full';
      else if (rest.length === 2) name = 'duo';
      else if (rest.length === 3) name = ['feature', 'polaroids'][ci++ % 2];
      else if (rest.length === 4) name = ['grid', 'mosaic'][ci++ % 2];
      else name = cycle[ci++ % cycle.length];
      const t = L[name];
      await t.draw(rest.slice(0, t.n), label);
      rest = rest.slice(t.n);
    }
  }

  // ---- Cover ----
  paper();
  const hero = best(chosen.filter((p) => (p.couple || 0) >= 2).length ? chosen.filter((p) => p.couple >= 2) : chosen);
  if (hero) {
    await image(hero, 0, 0, PAGE_W, PAGE_H);
    for (let i = 0; i < 40; i++) { // soft dark fade behind the names (each band adds a little)
      alpha(0.045);
      doc.setFillColor(20, 14, 12).rect(0, PAGE_H - 400 + i * 10, PAGE_W, 400 - i * 10, 'F');
    }
    alpha(1);
  }
  const coverInk = hero ? WHITE : INK;
  doc.setTextColor(...(hero ? [235, 205, 210] : ACCENT)).setFont('times', 'italic').setFontSize(17);
  doc.text(P.title?.trim() || 'Our Story', PAGE_W / 2, PAGE_H - 180, { align: 'center' });
  doc.setTextColor(...coverInk).setFont('times', 'normal').setFontSize(38);
  doc.text(doc.splitTextToSize(names(P) || 'Us', KCW), PAGE_W / 2, PAGE_H - 130, { align: 'center' });
  const dated = state.events.filter((e) => e.start);
  if (dated.length) {
    const y0 = dated[0].start.slice(0, 4), y1 = (dated.at(-1).end || dated.at(-1).start).slice(0, 4);
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...(hero ? [220, 210, 205] : SOFT));
    doc.text((y0 === y1 ? y0 : `${y0}  —  ${y1}`).split('').join(' '), PAGE_W / 2, PAGE_H - 92, { align: 'center' });
  }

  // ---- Story ----
  if (P.story?.trim()) {
    page('');
    doc.setFont('times', 'normal').setFontSize(90).setTextColor(...ACCENT);
    alpha(0.25); doc.text('“', PAGE_W / 2, PAGE_H / 2 - 120, { align: 'center' }); alpha(1);
    doc.setFont('times', 'italic').setFontSize(16).setTextColor(...INK);
    const lines = doc.splitTextToSize(P.story.trim(), KCW - 110);
    const h = lines.length * 16 * 1.6;
    doc.text(lines, PAGE_W / 2, (PAGE_H - h) / 2, { align: 'center', lineHeightFactor: 1.6 });
    doc.setDrawColor(...ACCENT).setLineWidth(0.8).line(PAGE_W / 2 - 28, (PAGE_H + h) / 2 + 24, PAGE_W / 2 + 28, (PAGE_H + h) / 2 + 24);
  }

  // ---- Milestones (events without photos) ----
  let pendingMilestones = [];
  function flushMilestones() {
    if (!pendingMilestones.length) return;
    page('Milestones');
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...ACCENT);
    doc.text('M I L E S T O N E S', KM, top + 14);
    let y = top + 60;
    const lineX = KM + 118;
    const startY = y - 14;
    for (const e of pendingMilestones) {
      const d = e.description ? doc.splitTextToSize(e.description, KCW - 140) : [];
      const h = 26 + d.length * 15 + 26;
      if (y + h > bottom) {
        doc.setDrawColor(...ACCENT).setLineWidth(0.6).line(lineX, startY, lineX, y - 20);
        page('Milestones'); y = top + 30;
      }
      doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...SOFT);
      doc.text(fmtRange(e.start, e.end).toUpperCase(), lineX - 16, y, { align: 'right' });
      doc.setFillColor(...ACCENT).circle(lineX, y - 3, 4, 'F');
      doc.setFont('times', 'normal').setFontSize(17).setTextColor(...INK).text(e.title || typeLabel(e.type), lineX + 18, y + 1);
      if (d.length) doc.setFont('times', 'normal').setFontSize(11.5).setTextColor(...INK).text(d, lineX + 18, y + 20, { lineHeightFactor: 1.35 });
      y += h;
    }
    doc.setDrawColor(...ACCENT).setLineWidth(0.6).line(lineX, startY, lineX, y - 40);
    pendingMilestones = [];
  }

  // ---- Chat screenshots in phone frames, two per page ----
  const PH_W = (KCW - 50) / 2, PH_H = CH - 80, PH_PAD = 9;
  const phoneParts = await prepareDocs(state, (PH_W - 2 * PH_PAD) / (PH_H - 2 * PH_PAD - 16));
  function phonePages(d, label) {
    const part = phoneParts.get(d.id);
    if (!part) return;
    const W = part.img.naturalWidth || part.img.width;
    for (let i = 0; i < part.ranges.length; i++) {
      if (i % 2 === 0) {
        page(label);
        doc.setFont('times', 'italic').setFontSize(15).setTextColor(...ACCENT);
        doc.text(d.caption || 'Our messages', PAGE_W / 2, top + 12, { align: 'center' });
      }
      const [y0, y1] = part.ranges[i];
      const iw = PH_W - 2 * PH_PAD, ih = iw * ((y1 - y0) / W);
      const x = KM + 12 + (i % 2) * (PH_W + 26), y = top + 34 + (i % 2) * 18;
      const fh = ih + 2 * PH_PAD + 16;
      alpha(0.18);
      doc.setFillColor(40, 30, 25).roundedRect(x + 3, y + 4, PH_W, fh, 20, 20, 'F');
      alpha(1);
      doc.setFillColor(34, 30, 28).roundedRect(x, y, PH_W, fh, 20, 20, 'F');
      doc.setFillColor(70, 64, 60).roundedRect(x + PH_W / 2 - 18, y + 6, 36, 5, 2.5, 2.5, 'F'); // speaker
      doc.addImage(sliceData(part.img, y0, y1, 800), 'JPEG', x + PH_PAD, y + PH_PAD + 12, iw, ih, `p${d.id}${i}`, 'FAST');
    }
  }

  // ---- Chapters ----
  let chapter = 0;
  for (const e of state.events) {
    const list = state.photos.filter((p) => p.eventId === e.id && p.keepsake).sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
    const docs = docsOf(state, e);
    if (!list.length && !docs.length) { if (e.title || e.description) pendingMilestones.push(e); continue; }
    flushMilestones();
    chapter++;
    const label = e.title || typeLabel(e.type);
    const lead = best(list);
    page(label);
    // Opener: full-bleed lead photo, then the chapter text.
    const heroH = lead ? 400 : 120;
    if (lead) await image(lead, 0, 0, PAGE_W, heroH);
    let y = heroH + 44;
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...ACCENT);
    doc.text(`C H A P T E R   ${String(chapter).padStart(2, '0')}     ·     ${fmtRange(e.start, e.end).toUpperCase()}`, KM, y);
    y += 36;
    doc.setFont('times', 'normal').setFontSize(32).setTextColor(...INK);
    const t = doc.splitTextToSize(label, KCW);
    doc.text(t, KM, y);
    y += (t.length - 1) * 34 + 8;
    if (e.location) { doc.setFont('times', 'italic').setFontSize(14).setTextColor(...SOFT).text(e.location, KM, y + 14); y += 24; }
    doc.setDrawColor(...ACCENT).setLineWidth(0.8).line(KM, y + 14, KM + 44, y + 14);
    y += 36;
    if (e.description) {
      doc.setFont('times', 'normal').setFontSize(13).setTextColor(...INK);
      const d = doc.splitTextToSize(e.description, KCW - 60).slice(0, Math.floor((bottom - y) / 19));
      doc.text(d, KM, y, { lineHeightFactor: 1.45 });
      y += d.length * 13 * 1.45;
    }
    // Fill the rest of the opener with a row of framed photos.
    let rest = list.filter((p) => p !== lead);
    const space = bottom - y - 34;
    if (space > 115 && rest.length >= 2) {
      const k = Math.min(3, rest.length);
      const w = (KCW - 16 - (k - 1) * 22) / k, h = Math.min(space, w * 0.82);
      for (let i = 0; i < k; i++) await framed(rest[i], KM + 8 + i * (w + 22), bottom - h - 8, w, h, 5);
      rest = rest.slice(k);
    }
    await layoutPages(rest, label);
    for (const d of docs) phonePages(d, label);
  }
  flushMilestones();

  // ---- Closing page ----
  page('');
  const last = best(chosen.filter((p) => p !== hero)) || hero;
  if (last) await polaroid(last, PAGE_W / 2, PAGE_H / 2 - 60, 300, 300, -3);
  doc.setFont('times', 'italic').setFontSize(22).setTextColor(...ACCENT);
  doc.text('To be continued…', PAGE_W / 2, PAGE_H - 140, { align: 'center' });

  // ---- Running footer ----
  const n = doc.getNumberOfPages();
  for (let i = 2; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...SOFT);
    if (labels[i]) doc.text(labels[i].toUpperCase().split('').join(' ').slice(0, 90), KM, PAGE_H - 26);
    doc.text(String(i - 1), PAGE_W - KM, PAGE_H - 26, { align: 'right' });
  }
  return doc;
}
