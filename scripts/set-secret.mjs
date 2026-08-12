/**
 * Puts a server-side secret into the `app_secret` table.
 *
 *   node scripts/set-secret.mjs openai_api_key OPENAI_API_KEY
 *
 * The second argument names an entry in `.env.local` — the value is never
 * given on the command line, because a command line ends up in shell history,
 * in a scrollback buffer, and in whatever is recording the terminal.
 *
 * `app_secret` has row-level security on and no policy at all, so the browser
 * cannot read it under any key it holds. Only the service key can, and only
 * from inside the api/ functions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { client } from './db.mjs';

function envValue(name) {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) throw new Error('.env.local not found');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  throw new Error(`${name} is not set in .env.local`);
}

async function main() {
  const [name, envName] = process.argv.slice(2);
  if (!name || !envName) {
    console.error('usage: node scripts/set-secret.mjs <secret-name> <ENV_VAR_IN_ENV_LOCAL>');
    process.exit(1);
  }
  const value = envValue(envName);

  const c = client();
  await c.connect();
  try {
    await c.query(
      `insert into app_secret (name, value, updated_at) values ($1, $2, now())
         on conflict (name) do update set value = excluded.value, updated_at = now()`,
      [name, value],
    );
    // Length and first characters only. Printing the secret back would undo the
    // point of not passing it as an argument.
    const { rows } = await c.query(
      'select name, length(value) as chars, left(value, 8) as starts_with, updated_at'
      + ' from app_secret order by name',
    );
    console.table(rows);
  } finally {
    await c.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
