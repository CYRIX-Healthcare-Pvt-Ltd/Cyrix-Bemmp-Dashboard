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

/*
 * Every publish writes a fresh folder, and the `dataset` row is the pointer.
 *
 * The two objects used to live at one fixed path each, overwritten in place —
 * and Storage serves them with `cache-control: max-age=3600`. So for an hour
 * after every publish a browser could hold the *previous* 27 MB `tickets.bin.gz`
 * in its own HTTP cache while fetching the new `meta.json.gz` over the network,
 * which is a meta describing 270,293 rows paired with a buffer holding 270,030.
 * Every figure would be read out of the wrong column, so the reader refuses it
 * and the page is dead until the cache expires. That is not a rare race: anyone
 * who opened the dashboard in the hour before a publish hit it, which is how a
 * publish at 05:05 took the deployment down for the morning.
 *
 * Versioned paths remove the failure rather than narrowing the window. A path is
 * written once and never rewritten, so the bytes behind a URL cannot change and
 * cacheing them is free — and switching versions is a single-row update, which
 * is atomic. A publish that dies halfway leaves a folder nobody points at.
 *
 * `version` is null for anything published before this, which still reads from
 * the old flat paths.
 */
const paths = (state, version) => {
  const dir = version ? `${state}/${version}` : state;
  return { meta: `${dir}/meta.json.gz`, bin: `${dir}/tickets.bin.gz` };
};

/* Sortable and legible in the Storage browser, which matters the day someone has
   to work out by hand which folder is live. */
const newVersion = () => new Date().toISOString().replace(/[:.]/g, '-');

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
    .select('state, rows, min_day, max_day, filename, bytes, uploaded_at, encoding, version');
  if (error) return {};
  return Object.fromEntries(data.map((d) => [d.state, d]));
}

/**
 * Publishes a freshly parsed workbook for the whole team.
 *
 * Uploads before recording the row, so a failed upload cannot leave the table
 * advertising an artifact that is not there. The reverse order would show every
 * other user a dataset that 404s. Because the folder is new, nothing is pointing
 * at these objects while they are being written, so a publish is invisible until
 * the row switches to it in one statement.
 */
export async function publishDataset(state, { meta, buffer, filename }) {
  if (!supabase) throw new Error('Not connected.');
  const encoding = canCompress ? 'gzip' : 'none';
  const version = newVersion();
  const p = paths(state, version);

  const metaBlob = await gzip(new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  const binBlob = await gzip(new Blob([buffer], { type: 'application/octet-stream' }));

  // Whatever this replaces, read before the switch so it can be swept up after.
  const { data: before } = await supabase
    .from('dataset').select('version').eq('state', state).maybeSingle();

  for (const [path, body] of [[p.bin, binBlob], [p.meta, metaBlob]]) {
    const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
      contentType: 'application/octet-stream',
      // The path is unique to this publish, so the bytes behind it can never
      // change. A year is safe, and a new export is simply a new URL.
      cacheControl: '31536000',
      upsert: false,
    });
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
    version,
    /*
     * The zone and district names, beside the pointer.
     *
     * They are already in `meta.dict`, derived from this export rather than
     * declared anywhere — which is what keeps them from going stale when a
     * contract gains a district. Recording them here changes nothing about
     * where they come from; it only means they can be read without
     * downloading and decoding 5 MB of tickets first.
     *
     * That is what lets scope be assigned from the shared administration
     * screen, which has no dataset loaded and no business loading one.
     *
     * `meta.dictionaries`, not `meta.dict`: the runtime dataset renames it
     * on the way in, and reading the runtime name here would have quietly
     * published two empty arrays.
     */
    zones: meta.dictionaries?.zone ?? [],
    districts: meta.dictionaries?.district ?? [],
    uploaded_by: (await supabase.auth.getUser()).data.user?.id ?? null,
    uploaded_at: new Date().toISOString(),
  }, { onConflict: 'state' });
  if (error) throw new Error(`Published the files but could not record them: ${error.message}`);

  /*
   * Sweep the version this one replaced. Best effort on purpose: the publish has
   * already succeeded by the time this runs, and a bucket carrying one stale
   * folder is a housekeeping matter, not something to report as a failure.
   *
   * A reader that is mid-download of the old version keeps what it has — its
   * request was signed before the delete.
   */
  const stale = paths(state, before?.version);
  await supabase.storage.from(BUCKET).remove([stale.bin, stale.meta]);
}

/**
 * Downloads a shared artifact. Returns null when there is none.
 *
 * Takes the whole `dataset` row rather than loose arguments — the version and
 * the encoding both come from it, and reading a version other than the one the
 * row names is the bug this is shaped to prevent.
 */
export async function fetchSharedDataset(state, { encoding = 'gzip', version = null } = {}) {
  if (!supabase) return null;
  const p = paths(state, version);

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

  /*
   * The two objects are uploaded separately, so a mismatched pair would silently
   * offset every column — every figure on the page wrong, and nothing to see.
   *
   * Versioned paths are what make this an assertion rather than something users
   * trip over: within a version the pair is written once and cannot drift. It
   * stays because the cost of being wrong here is a dashboard that is confidently
   * incorrect, and because a legacy flat-path artifact can still mismatch.
   */
  const expected = meta.rows * meta.columns.length * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `The shared dataset is ${buffer.byteLength} bytes but its meta describes ${expected}`
      + ' — the pair does not match. Re-publish the export from the Data panel.',
    );
  }

  return { meta, buffer };
}
