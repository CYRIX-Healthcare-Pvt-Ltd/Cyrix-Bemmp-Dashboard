/**
 * Reads an .xlsx the user picked, entirely in the browser.
 *
 * Zip entries are inflated with the built-in `DecompressionStream('deflate-raw')`
 * and the worksheet is consumed row by row as it arrives, so a 46 MB workbook
 * (275 MB of XML) never exists in memory as a whole. No libraries involved.
 *
 * The row pipeline itself lives in shared/schema.mjs, which is the same code the
 * Node build script runs — an uploaded workbook and a prebuilt artifact therefore
 * produce identical figures.
 */
import {
  Builder, createCellRegex, sharedStringText, detectState, STATE_BY_ID,
} from '../../shared/schema.mjs';

/* ------------------------------------------------------------------ zip ---- */

/** Reads the zip central directory so entries can be inflated by name. */
async function readCentralDirectory(file) {
  const tailLen = Math.min(file.size, 66560); // 64 KB comment + 22 byte EOCD
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .xlsx file (no zip directory found).');

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);

  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cd = new DataView(cdBuf);
  const bytes = new Uint8Array(cdBuf);
  const decoder = new TextDecoder();

  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const compressedSize = cd.getUint32(p + 20, true);
    const uncompressedSize = cd.getUint32(p + 24, true);
    const fnLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + fnLen));
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

/** A stream of one entry's decompressed bytes. */
async function openEntry(file, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`Missing ${name} — is this a real Excel workbook?`);

  // The local header repeats the name/extra fields at their own lengths.
  const head = new DataView(
    await file.slice(e.localOffset, e.localOffset + 30).arrayBuffer(),
  );
  const dataStart = e.localOffset + 30
    + head.getUint16(26, true) + head.getUint16(28, true);

  const slice = file.slice(dataStart, dataStart + e.compressedSize);
  return e.method === 0
    ? slice.stream()
    : slice.stream().pipeThrough(new DecompressionStream('deflate-raw'));
}

/** The first worksheet, whatever it is named. */
function sheetEntryName(entries) {
  for (const name of entries.keys()) {
    if (name.startsWith('xl/worksheets/') && name.endsWith('.xml')) return name;
  }
  throw new Error('No worksheet found in the workbook.');
}

/* ------------------------------------------------------------- streaming --- */

/**
 * Yields each complete slice ending in `delim`, decoding incrementally so the
 * whole entry is never held as one string.
 */
async function* chunkedBy(stream, delim, onBytes) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes?.(value.byteLength);
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf(delim)) !== -1) {
        yield buf.slice(0, i);
        buf = buf.slice(i + delim.length);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ------------------------------------------------------------------ main --- */

/**
 * Parses `file` into the same artifact the build script writes.
 *
 * @param {File} file
 * @param {object} opts
 * @param {string} [opts.stateId] override the state guessed from the filename
 * @param {(p: {phase: string, pct: number, detail?: string}) => void} [opts.onProgress]
 * @returns {Promise<{buffer: ArrayBuffer, meta: object}>}
 */
export async function parseWorkbook(file, { stateId, onProgress } = {}) {
  const state = stateId ? STATE_BY_ID[stateId] : detectState(file.name);
  if (!state) {
    throw new Error(
      `Could not tell which contract "${file.name}" belongs to. `
      + 'Rename it to include KL or AP, or pick the contract before uploading.',
    );
  }

  const report = (phase, pct, detail) => onProgress?.({ phase, pct, detail });
  report('Reading workbook', 0);

  const entries = await readCentralDirectory(file);
  const sheet = sheetEntryName(entries);

  // Shared strings first — the worksheet references them by index.
  const ssEntry = entries.get('xl/sharedStrings.xml');
  const shared = [];
  if (ssEntry) {
    const total = ssEntry.compressedSize || 1;
    let seen = 0;
    const stream = await openEntry(file, entries, 'xl/sharedStrings.xml');
    for await (const si of chunkedBy(stream, '</si>', (n) => { seen += n; })) {
      shared.push(sharedStringText(si));
      if ((shared.length & 8191) === 0) {
        report('Reading text', Math.min(20, (seen / total) * 20), `${shared.length.toLocaleString()} strings`);
      }
    }
  }
  report('Reading text', 20, `${shared.length.toLocaleString()} strings`);

  const builder = new Builder(state);
  const fieldOf = builder.fieldOf;
  const cellRe = createCellRegex();
  const field = {};

  const sheetTotal = entries.get(sheet).compressedSize || 1;
  let sheetSeen = 0;

  const stream = await openEntry(file, entries, sheet);
  for await (const row of chunkedBy(stream, '</row>', (n) => { sheetSeen += n; })) {
    if (row.indexOf('<row r="1"') !== -1) continue; // header

    for (const k in field) delete field[k];
    let seen = false;
    cellRe.lastIndex = 0;
    let m;
    while ((m = cellRe.exec(row)) !== null) {
      const [, col, type, raw] = m;
      if (raw === undefined) continue;
      const name = fieldOf[col];
      if (!name) continue;
      field[name] = type === 's' ? shared[+raw] : raw;
      seen = true;
    }
    if (!seen) continue;

    builder.addRow(field);

    if ((builder.rows & 8191) === 0) {
      report(
        'Reading tickets',
        20 + Math.min(75, (sheetSeen / sheetTotal) * 75),
        `${builder.rows.toLocaleString()} rows`,
      );
    }
  }

  report('Summarising', 96, `${builder.rows.toLocaleString()} rows`);
  const result = builder.finish();
  report('Done', 100, `${result.meta.rows.toLocaleString()} tickets`);
  return result;
}
