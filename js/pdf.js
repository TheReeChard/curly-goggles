// PDF output: a plain, printable filing packet and a designed keepsake.
import { db } from './db.js';
import { decode, resize, crop, toBlob, toDataURL } from './images.js';
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
export async function filingPdf(state, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const P = state.project;
  const events = state.events;
  const photos = state.photos.filter((p) => p.filing);

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
    const n = state.photos.filter((p) => p.eventId === e.id && p.filing).length;
    const details = [e.description, e.documents && `Documents: ${e.documents}`].filter(Boolean).join('\n');
    const cells = [
      fmtRange(e.start, e.end),
      `${e.title}${e.type && e.type !== 'other' ? `\n(${typeLabel(e.type)})` : ''}`,
      e.location || '—',
      details || '—',
      n ? `${e.exhibit}-1${n > 1 ? ` to ${e.exhibit}-${n}` : ''}\n(${n} photo${n > 1 ? 's' : ''})` : '—',
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
  if (photos.length) {
    doc.addPage();
    doc.setFont('helvetica', 'bold').setFontSize(14).text('Index of Photographic Exhibits', M, M + 4);
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
      y += 8;
    }
  }

  // Photo pages: two per page, with labels
  const slotH = (PAGE_H - 2 * M - 20) / 2;
  const imgH = slotH - 46;
  const ordered = events.flatMap((e) =>
    state.photos.filter((p) => p.eventId === e.id && p.filing).sort((a, b) => a.exhibit.localeCompare(b.exhibit, undefined, { numeric: true })).map((p) => [p, e]));
  for (let i = 0; i < ordered.length; i++) {
    const [p, e] = ordered[i];
    onProgress?.(`Adding photo ${i + 1} of ${ordered.length}…`);
    if (i % 2 === 0) doc.addPage();
    const top = M + (i % 2) * (slotH + 20);
    const data = await imgData(p, 1600);
    if (data) {
      const [w, h] = fit(p.w, p.h, CW, imgH);
      doc.addImage(data, 'JPEG', M + (CW - w) / 2, top + (imgH - h) / 2, w, h, `f${p.id}`, 'FAST');
    }
    doc.setFont('helvetica', 'bold').setFontSize(10);
    doc.text(`Exhibit ${p.exhibit}`, M, top + imgH + 16);
    doc.setFont('helvetica', 'normal');
    const cap = [photoDate(p), e.location, e.title, p.caption].filter(Boolean).join(' · ');
    doc.text(doc.splitTextToSize(cap, CW - 70), M + 70, top + imgH + 16);
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
const INK = [43, 38, 36], ACCENT = [156, 74, 90], SOFT = [130, 118, 112], PAPER = [251, 247, 241];

function paper(doc) {
  doc.setFillColor(...PAPER).rect(0, 0, PAGE_W, PAGE_H, 'F');
}

export async function keepsakePdf(state, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const P = state.project;
  const chosen = state.photos.filter((p) => p.keepsake);
  const maxSide = chosen.length > 150 ? 1100 : 1500;

  // Cover with the best photo
  paper(doc);
  const hero = [...chosen].sort((a, b) => b.score - a.score)[0];
  if (hero) {
    const blob = await db.get('blobs', `full:${hero.id}`);
    if (blob) {
      const c = crop(await decode(blob), PAGE_W / 470, 1800);
      doc.addImage(await toDataURL(await toBlob(c, 0.88)), 'JPEG', 0, 0, PAGE_W, 470, 'hero', 'FAST');
    }
  }
  doc.setTextColor(...ACCENT).setFont('times', 'italic').setFontSize(16);
  doc.text(P.title?.trim() || 'Our Story', PAGE_W / 2, 545, { align: 'center' });
  doc.setTextColor(...INK).setFont('times', 'normal').setFontSize(34);
  doc.text(doc.splitTextToSize(names(P) || 'Us', CW), PAGE_W / 2, 590, { align: 'center' });
  const dated = state.events.filter((e) => e.start);
  if (dated.length) {
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...SOFT);
    const y0 = dated[0].start.slice(0, 4), y1 = (dated.at(-1).end || dated.at(-1).start).slice(0, 4);
    doc.text((y0 === y1 ? y0 : `${y0} — ${y1}`).split('').join(' '), PAGE_W / 2, 640, { align: 'center' });
  }
  doc.setDrawColor(...ACCENT).setLineWidth(0.8).line(PAGE_W / 2 - 30, 665, PAGE_W / 2 + 30, 665);

  // Events
  let y = PAGE_H;
  const bottom = PAGE_H - 56;
  const newPage = () => { doc.addPage(); paper(doc); y = M + 8; };
  let done = 0;
  for (const e of state.events) {
    const list = state.photos.filter((p) => p.eventId === e.id && p.keepsake).sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
    if (!list.length && !e.description && !e.title) continue;
    if (y > bottom - 260) newPage(); else y += 26;

    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...ACCENT);
    doc.text(fmtRange(e.start, e.end).toUpperCase(), M, y);
    y += 26;
    doc.setFont('times', 'normal').setFontSize(26).setTextColor(...INK);
    const t = doc.splitTextToSize(e.title || typeLabel(e.type), CW);
    doc.text(t, M, y);
    y += (t.length - 1) * 28 + 8;
    if (e.location) {
      doc.setFont('times', 'italic').setFontSize(13).setTextColor(...SOFT);
      doc.text(e.location, M, y + 10);
      y += 18;
    }
    if (e.description) {
      doc.setFont('times', 'normal').setFontSize(12).setTextColor(...INK);
      const d = doc.splitTextToSize(e.description, CW);
      doc.text(d, M, y + 14, { lineHeightFactor: 1.35 });
      y += d.length * 16 + 6;
    }
    y += 14;

    // Justified photo rows
    const GAP = 6, TARGET = list.length === 1 ? 360 : list.length <= 3 ? 230 : 165;
    let rowItems = [];
    const flush = async (last) => {
      if (!rowItems.length) return;
      const aspects = rowItems.map((p) => p.w / p.h);
      const sumA = aspects.reduce((a, b) => a + b, 0);
      let h = (CW - GAP * (rowItems.length - 1)) / sumA;
      if (last && h > TARGET) h = TARGET;
      h = Math.min(h, bottom - M - 8);
      if (y + h > bottom) newPage();
      const rowW = sumA * h + GAP * (rowItems.length - 1);
      let x = M + (CW - rowW) / 2;
      for (let i = 0; i < rowItems.length; i++) {
        const p = rowItems[i];
        const data = await imgData(p, maxSide);
        if (data) doc.addImage(data, 'JPEG', x, y, aspects[i] * h, h, `k${p.id}`, 'FAST');
        x += aspects[i] * h + GAP;
        onProgress?.(`Laying out photo ${++done} of ${chosen.length}…`);
      }
      y += h + GAP;
      rowItems = [];
    };
    for (const p of list) {
      rowItems.push(p);
      const sumA = rowItems.reduce((a, q) => a + q.w / q.h, 0);
      if (sumA * TARGET + GAP * (rowItems.length - 1) >= CW) await flush(false);
    }
    await flush(true);
  }

  const n = doc.getNumberOfPages();
  for (let i = 2; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('times', 'italic').setFontSize(9).setTextColor(...SOFT);
    doc.text(String(i - 1), PAGE_W / 2, PAGE_H - 26, { align: 'center' });
  }
  return doc;
}
