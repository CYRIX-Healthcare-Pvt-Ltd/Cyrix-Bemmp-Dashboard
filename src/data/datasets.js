/**
 * Shared ticket artifacts.
 *
 * A TM export uploaded in one browser used to stay in that browser. Everyone
 * else had to upload the same file for themselves, which on a deployment with no
 * server artifact — the Vercel one — meant the dashboard was empty until each
 * person went and found the workbook. Publishing puts it somewhere the team
 * shares.
 *
 * What travels is the built artifact, not the workbook: `meta.json` and the
 * concatenated `tickets.bin` columns. Parsing already happened in the browser
 * that uploaded it, so nobody else pays for it again.
 */

import { supabase } from './supabase.js';

const BUCKET = 'datasets';

const paths = (state) => ({
  meta: `${state}/meta.json.gz`,
  bin: `${state}/tickets.bin.gz`,
});

/*
 * Kerala's artifact is 27 MB of Int32Array columns, which is a great deal of
 * highly repetitive data — gzip takes it to a fraction of that. Every user
 * downloads this on every cold load, so the compression is the difference
 * between a usable page and a minute of waiting on an office connection.
 *
 * `CompressionStream` is missing on older Safari; there the bytes go up raw and
 * `encoding` records that, so a reader never has to guess.
 */
const canCompress = typeof CompressionStream !== 'undefined';
const canDecompress = typeof DecompressionStream !== 'undefined';

async function gzip(blob) {
  if (!canCompress) return blob;
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

async function gunzip(blob) {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/** Provenance for every contract this account may see. */
export async function listSharedDatasets() {
  if (!supabase) return {};
  const { data, error } = await supabase
    .from('dataset')
    .select('state, rows, min_day, max_day, filename, bytes, uploaded_at, encoding');
  if (error) return {};
  return Object.fromEntries(data.map((d) => [d.state, d]));
}

/**
 * Publishes a freshly parsed workbook for the whole team.
 *
 * Uploads before recording the row, so a failed upload cannot leave the table
 * advertising an artifact that is not there. The reverse order would show every
 * other user a dataset that 404s.
 */
export async function publishDataset(state, { meta, buffer, filename }) {
  if (!supabase) throw new Error('Not connected.');
  const p = paths(state);
  const encoding = canCompress ? 'gzip' : 'none';

  const metaBlob = await gzip(new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  const binBlob = await gzip(new Blob([buffer], { type: 'application/octet-stream' }));

  for (const [path, body] of [[p.meta, metaBlob], [p.bin, binBlob]]) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, body, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw new Error(`Could not publish ${path}: ${error.message}`);
  }

  const { error } = await supabase.from('dataset').upsert({
    state,
    rows: meta.rows,
    min_day: meta.dateRange.minDay,
    max_day: meta.dateRange.maxDay,
    filename: filename ?? null,
    bytes: binBlob.size + metaBlob.size,
    encoding,
    uploaded_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    uploaded_at: new Date().toISOString(),
  }, { onConflict: 'state' });
  if (error) throw new Error(`Published the files but could not record them: ${error.message}`);
}

/** Downloads a shared artifact. Returns null when there is none. */
export async function fetchSharedDataset(state, encoding = 'gzip') {
  if (!supabase) return null;
  const p = paths(state);

  const [metaRes, binRes] = await Promise.all([
    supabase.storage.from(BUCKET).download(p.meta),
    supabase.storage.from(BUCKET).download(p.bin),
  ]);
  if (metaRes.error || binRes.error) return null;

  const compressed = encoding === 'gzip';
  if (compressed && !canDecompress) {
    throw new Error('This browser cannot read the shared dataset. Upload the workbook instead.');
  }

  const metaBuf = compressed ? await gunzip(metaRes.data) : await metaRes.data.arrayBuffer();
  const buffer = compressed ? await gunzip(binRes.data) : await binRes.data.arrayBuffer();
  const meta = JSON.parse(new TextDecoder().decode(metaBuf));

  // The two objects are uploaded separately, so a half-finished publish would
  // pair a new meta with an old buffer and silently offset every column.
  const expected = meta.rows * meta.columns.length * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `The shared dataset is ${buffer.byteLength} bytes but its meta describes ${expected}`
      + ' — it was read mid-publish. Try again in a moment.',
    );
  }

  return { meta, buffer };
}
