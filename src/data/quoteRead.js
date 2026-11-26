/**
 * Reading a quotation (the user, 14 Nov): its QTN number, To and grand total, and a signed copy's QTN number, so the
 * tracker can show them and say whether the signed copy is the same quotation. Text PDFs are read as text; a scan or
 * photo is read with Tesseract, as Travel reads bills. What is read is only shown, never trusted to decide anything.
 */

/** "QTN 402 /CHC/PVMP/2026 - 27" → "QTN402/CHC/PVMP/2026-27"; a looser "QTN 402" → "QTN402". */
export function qtnOf(text) {
  const t = String(text ?? '').replace(/[ \s]+/g, ' ');
  const full = t.match(/Q\s*T\s*N\s*[-:.]?\s*(\d[\d ]{0,6})\s*\/\s*([A-Z ]{2,8}?)\s*\/\s*([A-Z ]{2,8}?)\s*\/\s*(\d[\d ]{3,5}?)\s*-\s*(\d[\d ]?\d?)/i);
  if (full) {
    const k = (s) => s.replace(/ /g, '');
    return `QTN${k(full[1])}/${k(full[2]).toUpperCase()}/${k(full[3]).toUpperCase()}/${k(full[4])}-${k(full[5])}`;
  }
  const loose = t.match(/Q\s*T\s*N\s*[-:.]?\s*(\d[\d ]{0,6}\d|\d)/i);
  return loose ? `QTN${loose[1].replace(/ /g, '')}` : null;
}

/** The number itself (402), which is what a signed copy is matched on. */
export const qtnKey = (q) => String(q ?? '').match(/QTN(\d+)/i)?.[1]?.replace(/^0+/, '') ?? null;

/** The lines after "To," up to "Sub:", joined: "Carmel Hospital, Aluva". */
function toOf(text) {
  const m = String(text ?? '').match(/\bTo\s*,?\s*\n([\s\S]{1,240}?)\n\s*(?:Sub\b|Subject\b|Dear\b|Kind\s*Attn)/i);
  if (!m) return null;
  const lines = m[1].split('\n').map((l) => l.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim().replace(/[\s,.]+$/, '')).filter(Boolean);
  return lines.length ? lines.slice(0, 3).join(', ') : null;
}

/** The last amount on the GRAND TOTAL line (the total with taxes). */
function totalOf(text) {
  const line = String(text ?? '').match(/GRAND\s*TOTAL([^\n]*)/i);
  if (!line) return null;
  const nums = line[1].match(/\d[\d,]*(?:\.\d+)?/g);
  if (!nums?.length) return null;
  const n = Number(nums[nums.length - 1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "Date: 13 / 11 /202 6" → "2026-11-13". */
function dateOf(text) {
  const m = String(text ?? '').match(/Date\s*[:.-]?\s*(\d[\d ]{0,4})\/([\d ]{1,5})\/(\d[\d ]{3,6})/i);
  if (!m) return null;
  const [d, mo, y] = [m[1], m[2], m[3]].map((s) => s.replace(/ /g, ''));
  if (y.length !== 4 || +d < 1 || +d > 31 || +mo < 1 || +mo > 12) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function readQuoteText(text) {
  return { qtn_no: qtnOf(text), qtn_to: toOf(text), total: totalOf(text), date: dateOf(text) };
}

/* ----------------------------------------------------------- in the app -- */

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let pdfjsP = null;
function pdfjs() {
  pdfjsP ??= (async () => {
    const lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    return lib;
  })();
  return pdfjsP;
}
export const loadPdf = async (data) => (await pdfjs()).getDocument({ data }).promise;

/** Tesseract on an image or canvas; the worker is made once and kept. */
let ocrP = null;
async function ocr(img) {
  ocrP ??= import('tesseract.js').then(({ createWorker }) => createWorker('eng'));
  const w = await ocrP;
  const { data } = await w.recognize(img);
  return data.text ?? '';
}

/** A page of a PDF drawn big enough to read. */
async function pageCanvas(doc, n, width = 1800) {
  const page = await doc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / v1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c;
}

/**
 * A picked file read: { sha256, qtn_no, qtn_to, total, date }. A PDF with text is read as text; a PDF without (a scan)
 * has its first page read by OCR; a photo is read by OCR. Signed copies need only the QTN number, so only the first
 * page. Never throws: what cannot be read comes back empty.
 */
export async function readQuoteFile(file, { signed = false } = {}) {
  const buf = await file.arrayBuffer();
  const out = { sha256: await sha256(buf.slice(0)), qtn_no: null, qtn_to: null, total: null, date: null };
  try {
    if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
      const doc = await loadPdf(new Uint8Array(buf));
      let text = '';
      for (let i = 1; i <= Math.min(doc.numPages, signed ? 1 : 6); i++) {
        const t = await (await doc.getPage(i)).getTextContent();
        text += `${t.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('')}\n`;
      }
      if (text.replace(/\s/g, '').length < 40) text = await ocr(await pageCanvas(doc, 1));
      Object.assign(out, readQuoteText(text));
    } else if (/^image\//i.test(file.type)) {
      const url = URL.createObjectURL(file);
      try { Object.assign(out, readQuoteText(await ocr(url))); } finally { URL.revokeObjectURL(url); }
    }
  } catch { /* unread stays empty */ }
  if (signed) { out.qtn_to = null; out.total = null; out.date = null; }
  return out;
}
