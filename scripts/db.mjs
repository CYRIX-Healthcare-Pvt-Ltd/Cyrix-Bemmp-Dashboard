/**
 * Runs a .sql file against the project database.
 *
 * Supabase retired the direct `db.<ref>.supabase.co` host, so the connection
 * goes through the session-mode pooler — which, unlike the transaction-mode port,
 * will run DDL. The region is not derivable from the project ref, so it is
 * configuration rather than something to guess at run time.
 *
 *   node scripts/db.mjs supabase/migrations/0001_meeting.sql
 *   node scripts/db.mjs --query "select count(*) from meeting_note"
 *
 * Reads SUPABASE_DB_HOST / SUPABASE_DB_PASSWORD / SUPABASE_PROJECT_REF from
 * .env.local. Nothing here is committed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

function loadEnv() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
loadEnv();

const REF = process.env.SUPABASE_PROJECT_REF;
const HOST = process.env.SUPABASE_DB_HOST;
const PASSWORD = process.env.SUPABASE_DB_PASSWORD;

if (!REF || !HOST || !PASSWORD) {
  console.error('SUPABASE_PROJECT_REF, SUPABASE_DB_HOST and SUPABASE_DB_PASSWORD must be in .env.local');
  process.exit(1);
}

export function client() {
  return new pg.Client({
    host: HOST,
    port: 5432,
    user: `postgres.${REF}`,
    password: PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const qIndex = args.indexOf('--query');
  const sql = qIndex >= 0
    ? args[qIndex + 1]
    : fs.readFileSync(args[0], 'utf8');

  const c = client();
  await c.connect();
  try {
    const res = await c.query(sql);
    const results = Array.isArray(res) ? res : [res];
    for (const r of results) {
      if (r.command === 'SELECT' && r.rows.length) console.table(r.rows);
      else if (r.command) console.log(`${r.command} ${r.rowCount ?? ''}`.trim());
    }
    console.log('ok');
  } finally {
    await c.end();
  }
}

// `pathToFileURL` rather than string-building the URL: on Windows the real
// `import.meta.url` is triple-slashed and percent-encodes the space in
// "Cyrix Coding", so a hand-made comparison silently never matches and the
// script exits 0 having done nothing at all.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
