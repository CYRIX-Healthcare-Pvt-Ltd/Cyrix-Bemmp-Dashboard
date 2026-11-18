/*
  The quotation the Coordinator makes in the tracker, drawn as the company's Word letter (QTN405 Carmel Hospital Aluva.docx,
  the user, 16 Nov): letterhead logo top left, the grey CYRIX band down the right, the address band at the foot, the seal at
  the signature. Page 1 is the covering letter, then the table (Sl No · Description · Unit Price · Qty · Total Price · GST % ·
  Tax Amount · Total with Taxes, as their Excel), terms, bank details and the signature.
*/
import { jsPDF } from 'jspdf';
import { embedFonts } from './pdfFonts.js';

const BASE = `${String(import.meta.env?.BASE_URL || '/').replace(/\/+$/, '')}/qt-letter/`;
const imgs = {};
async function img(name) {
  if (!imgs[name]) {
    imgs[name] = fetch(BASE + name).then((r) => { if (!r.ok) throw new Error('The letterhead could not be loaded.'); return r.blob(); })
      .then((b) => new Promise((ok, bad) => { const f = new FileReader(); f.onload = () => ok(f.result); f.onerror = bad; f.readAsDataURL(b); }))
      .catch((e) => { delete imgs[name]; throw e; });
  }
  return imgs[name];
}

export const DEFAULT_TERMS = [
  'Firm order is to be given to us with 100% amount in advance to CYRIX HEALTH CARE PVT LTD, COCHIN.',
  'Basic GST is included.',
  'This quotation is valid for one month from the date of this quotation.',
  'Delivery date is within 2-3 weeks, after receiving the PO.',
  "The quotation is based on the initial inspection. If the reported complaint persists after replacing the spare, any additional spare(s) required for further rectification will be charged separately. A separate quotation for the additional spare(s) will be provided for the customer's approval before proceeding.",
];
export const DEFAULT_SUBJECT = 'Quotation for Spares.';

const BANK = [['Bank Name:', 'Axis Bank Ltd., Thevara, Ernakulam, Kerala'], ['Account No:', '923030013425190'], ['IFSC Code:', 'UTIB0002991']];

const num = (n) => Number(n) || 0;
const r2 = (n) => Math.round(num(n) * 100) / 100;
export const fmt = (n) => r2(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Each line's totals and the grand totals. */
export function quoteTotals(items) {
  const lines = (items ?? []).map((it) => {
    const total = r2(num(it.price) * num(it.qty));
    const tax = r2((total * num(it.gst)) / 100);
    return { total, tax, with: r2(total + tax) };
  });
  const sum = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
  return { lines, total: sum('total'), tax: sum('tax'), with: sum('with') };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function upto99(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function upto999(n) { const h = Math.floor(n / 100); const r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r ? upto99(r) : ''].filter(Boolean).join(' and '); }
/** 17640 → "Rupees Seventeen Thousand Six Hundred and Forty Only" (Indian grouping: crore, lakh, thousand). */
export function inWords(amount) {
  const a = r2(amount); let n = Math.floor(a); const paise = Math.round((a - n) * 100);
  if (n === 0 && !paise) return 'Rupees Zero Only';
  const parts = [];
  for (const [d, w] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    const k = Math.floor(n / d); if (k) { parts.push(`${k >= 100 ? upto999(k) : upto99(k)} ${w}`); n %= d; }
  }
  if (n) parts.push(upto999(n));
  return `Rupees ${parts.join(' ')}${paise ? ` and ${upto99(paise)} Paise` : ''} Only`;
}

const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/** The PDF of a quotation: { qtn_no, date, to, place, subject, items: [{ desc, price, qty, gst }], terms } → Blob. */
export async function makeQuotePdf(q) {
  const [logo, side, foot, seal] = await Promise.all(['logo.png', 'side.png', 'footer.png', 'seal.jpg'].map(img));
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210; const H = 297; const L = 23.8; const R = 14.7; const CW = W - L - R;
  const TOP = 44; const BOTTOM = H - 36;
  const frame = () => {
    pdf.addImage(side, 'PNG', 161.1, 0, 48.7, 254.3, 'side', 'FAST');
    pdf.addImage(logo, 'PNG', 0, 0, 80.1, 36.3, 'logo', 'FAST');
    pdf.addImage(foot, 'PNG', 0, H - 31.4, W, 31.4, 'foot', 'FAST');
  };
  const newPage = () => { pdf.addPage(); frame(); return TOP; };
  const text = (t, x, y, o = {}) => { pdf.text(t, x, y, o); };
  // Arimo, Helvetica's widths, put into the PDF: the same on every phone (the user, 18 Nov: "lock for all quotations").
  const setFam = await embedFonts(pdf, ['Arimo']);
  const font = (style = 'normal', size = 11, rgb = [17, 17, 17]) => { setFam('Arimo', style === 'bold'); pdf.setFontSize(size); pdf.setTextColor(...rgb); };
  const para = (t, y, size = 11, gapAfter = 3, style = 'normal') => {
    font(style, size);
    const lines = pdf.splitTextToSize(t, CW);
    lines.forEach((ln, i) => text(ln, L, y + i * size * 0.43));
    return y + lines.length * size * 0.43 + gapAfter;
  };

  // Page 1: the covering letter.
  frame();
  let y = TOP;
  font('bold', 12); text(q.qtn_no ?? '', L, y);
  font('normal', 11); text(`Date: ${dmy(q.date)}`, W - R - 18, y, { align: 'right' });
  y += 10;
  font('normal', 11); text('To,', L, y); y += 5.5;
  font('bold', 11);
  for (const ln of [q.to, q.place].filter(Boolean).flatMap((s) => pdf.splitTextToSize(String(s), CW - 30))) { text(ln, L, y); y += 5.2; }
  y += 4;
  font('bold', 11); text(`Sub: ${q.subject || DEFAULT_SUBJECT}`, L, y); y += 10;
  y = para('Greetings from Cyrix Healthcare Pvt Ltd!!!', y, 11, 4);
  y = para('We sincerely appreciate your continued trust in our products and services. As per your requirement, we are pleased to submit our quotation of spare for your kind consideration.', y, 11, 4);
  y = para('At Cyrix Healthcare, we are committed to providing high-quality medical equipment and reliable service support that meet your clinical and operational needs. We believe this proposal will align well with your expectations and add value to your facility’s healthcare delivery.', y, 11, 4);
  y = para('Please find the detailed quotation attached for your review. Should you require any further clarification or technical discussion, we will be glad to assist at your convenience.', y, 11, 4);
  y = para('Thank you for the opportunity to serve your esteemed organization.', y, 11, 8);
  font('normal', 11); text('With Regards,', L, y); y += 3;
  pdf.addImage(seal, 'JPEG', L - 3.8, y, 29.1, 24, 'seal', 'FAST'); y += 27;
  font('bold', 11); text('Cyrix Healthcare Pvt Ltd', L, y);

  // Page 2: the table.
  y = newPage();
  const { lines, total, tax, with: grand } = quoteTotals(q.items);
  // Sl No · Description · Unit Price · Qty · Total Price · GST % · Tax Amount · Total with Taxes
  const cols = [11, 52, 20, 10, 21, 13, 20, 24.5];
  const xs = cols.reduce((a, w) => [...a, a[a.length - 1] + w], [L]);
  const heads = ['Sl No', 'Description', 'Unit Price', 'Qty', 'Total Price', 'GST %', 'Tax Amount', 'Total with Taxes'];
  const PAD = 1.6;
  const grid = (top, h, from = 0) => { xs.slice(from).forEach((x) => pdf.line(x, top, x, top + h)); pdf.line(xs[from], top + h, xs[8], top + h); };
  const header = () => {
    font('bold', 9);
    const hl = heads.map((h, i) => pdf.splitTextToSize(h, cols[i] - PAD * 2));
    const n = Math.max(...hl.map((l) => l.length)), hh = n * 3.8 + 4;
    hl.forEach((l, i) => {
      const top = y + (hh - l.length * 3.8) / 2 + 2.9;
      l.forEach((ln, k) => text(ln, xs[i] + cols[i] / 2, top + k * 3.8, { align: 'center' }));
    });
    pdf.line(L, y, xs[8], y); grid(y, hh);
    y += hh;
  };
  const cell = (t, i, yy, bold) => {
    font(bold ? 'bold' : 'normal', 9.5);
    if (i === 1) return; // description is drawn wrapped by the row
    text(String(t), xs[i] + cols[i] / 2, yy, { align: 'center' });
  };
  pdf.setDrawColor(0, 0, 0); pdf.setLineWidth(0.25);
  header();
  (q.items ?? []).forEach((it, n) => {
    font('normal', 10);
    const desc = pdf.splitTextToSize(String(it.desc ?? ''), cols[1] - PAD * 2);
    const h = Math.max(desc.length * 4.4 + 5, 11);
    if (y + h > BOTTOM) { y = newPage(); pdf.line(L, y, xs[8], y); header(); }
    const ty = y + (h - desc.length * 4.4) / 2 + 3.2;
    desc.forEach((ln, k) => text(ln, xs[1] + PAD, ty + k * 4.4));
    [n + 1, '', fmt(it.price), fmt(it.qty), fmt(lines[n].total), `${num(it.gst)}%`, fmt(lines[n].tax), fmt(lines[n].with)].forEach((v, i) => cell(v, i, y + h / 2 + 1.3, i === 7));
    grid(y, h);
    y += h;
  });
  if (y + 8 > BOTTOM) { y = newPage(); pdf.line(L, y, xs[8], y); }
  // GRAND TOTAL across Sl No to Qty, as in Word.
  font('bold', 9.5); text('GRAND TOTAL', (xs[0] + xs[4]) / 2, y + 5.4, { align: 'center' });
  cell(fmt(total), 4, y + 5.4, true); cell(fmt(tax), 6, y + 5.4, true); cell(fmt(grand), 7, y + 5.4, true);
  [xs[0], xs[4], xs[5], xs[6], xs[7], xs[8]].forEach((x) => pdf.line(x, y, x, y + 8)); pdf.line(L, y + 8, xs[8], y + 8);
  y += 13;
  font('bold', 9.5); y = para(`Amount in words: ${inWords(grand)}`, y, 9.5, 5, 'bold');

  // Terms, the closing words, the bank and the signature: each block moves whole to a new page when it does not fit.
  const need = (h) => { if (y + h > BOTTOM) y = newPage(); };
  const terms = (q.terms ?? DEFAULT_TERMS).filter((t) => String(t).trim());
  if (terms.length) {
    need(14);
    font('bold', 11); text('TERMS AND CONDITIONS', L, y); y += 6;
    terms.forEach((t, i) => {
      font('normal', 10);
      const ls = pdf.splitTextToSize(String(t), CW - 7);
      need(ls.length * 4.4 + 1.5);
      text(`${i + 1}.`, L, y);
      ls.forEach((ln, k) => text(ln, L + 6, y + k * 4.4));
      y += ls.length * 4.4 + 1.5;
    });
    y += 3;
  }
  const closing = 'Hope this quotation meets with your approval. If you have any queries regarding the product, please do not hesitate to contact us. We look forward to receiving your valuable order at the earliest. Thanking you and assuring you of our best services always, we remain.';
  font('normal', 10); need(pdf.splitTextToSize(closing, CW).length * 4.4 + 4);
  y = para(closing, y, 10, 4);
  need(34);
  y = para('Please make Payment through RTGS / NEFT to the following Account.', y, 10, 2);
  // The bank details as in Word: plain cells, black lines.
  const bw = CW - 6, kw = bw * 0.35;
  pdf.setDrawColor(0, 0, 0); pdf.setLineWidth(0.25);
  pdf.rect(L, y, bw, 7.5);
  font('normal', 10); text('Cyrix Healthcare Pvt Ltd - Account Details', L + 3.5, y + 5.1);
  y += 7.5;
  BANK.forEach(([k, v]) => {
    pdf.rect(L, y, kw, 7.5); pdf.rect(L + kw, y, bw - kw, 7.5);
    font('normal', 10); text(k, L + 3.5, y + 5.1); text(v, L + kw + 3.5, y + 5.1);
    y += 7.5;
  });
  y += 7;
  need(36);
  font('normal', 11); text('Yours truly,', L, y); y += 2;
  pdf.addImage(seal, 'JPEG', L + 5, y, 25.6, 21, 'seal', 'FAST');
  font('bold', 11); text('For Cyrix Healthcare', L + 36, y + 12);
  y += 25;
  font('normal', 10.5); text('Authorized Signatory', L, y);

  return pdf.output('blob');
}

/** The file name of a quotation: "TEST-QTN1-CHC-PVMP-2026-27 Carmel hospital, Aluva.pdf". */
export const quoteFileName = (q) => `${String(q.qtn_no ?? 'Quotation').replace(/[\\/:*?"<>|]+/g, '-')}${q.to ? ` ${q.to}` : ''}`.replace(/[\\/:*?"<>|]+/g, ' ').trim();
