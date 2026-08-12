/**
 * Creates the accounts from the workbook's `login` sheet.
 *
 * Codes and passwords are exactly as the business specified them. They are very
 * short and identical to each other, which GoTrue's own sign-up flow would
 * refuse — the admin endpoint does not apply the password policy, which is the
 * only reason this works. Whoever changes these later should raise the policy
 * too, or the first person to use "forgot password" will be unable to set the
 * same value back.
 *
 *   node scripts/seed-users.mjs [--dry]
 *
 * Idempotent: an account that already exists has its password and profile reset
 * to match this file rather than being duplicated.
 */

import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
loadEnv();

const BASE = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SERVICE_KEY;
const DOMAIN = 'bemmp.cyrix.internal';

/**
 * Straight from the `login` sheet. Role and scope are separate columns there and
 * stay separate here: the AP account is a Director who nonetheless sees only
 * Andhra, so collapsing them into one field would lose that.
 */
const ACCOUNTS = [
  /*
   * The administrator. Scope is empty on purpose — `in_scope()` grants an admin
   * every contract from the role, so listing them here would be a copy that goes
   * stale the day a third contract is added.
   *
   * From here on, accounts are made in the app rather than in this file. This
   * one has to be seeded because there is nobody to make it.
   */
  { code: 'Admin', role: 'admin', scope: [], name: 'Administrator' },
  { code: 'DIR', role: 'director', scope: ['kl', 'ap'], name: 'Directors' },
  { code: 'KL', role: 'project_head', scope: ['kl'], name: 'Kerala project head' },
  { code: 'AP', role: 'director', scope: ['ap'], name: 'Andhra director' },
  { code: 'KLCoord', role: 'coordinator', scope: ['kl'], name: 'Kerala coordinator' },
  { code: 'APCoord', role: 'coordinator', scope: ['ap'], name: 'Andhra coordinator' },
  { code: 'KLPur', role: 'purchase', scope: ['kl'], name: 'Kerala purchase' },
  { code: 'APPur', role: 'purchase', scope: ['ap'], name: 'Andhra purchase' },
];

const H = {
  apikey: SECRET,
  Authorization: `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
};

async function call(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, { headers: H, ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** GoTrue has no "get by email", so the page is walked. Seven accounts, one page. */
async function existingByEmail() {
  const out = new Map();
  for (let page = 1; page <= 20; page++) {
    const data = await call(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = data.users ?? [];
    for (const u of users) out.set(u.email, u.id);
    if (users.length < 200) break;
  }
  return out;
}

async function main() {
  if (!BASE || !SECRET) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be in .env.local');
    process.exit(1);
  }
  const dry = process.argv.includes('--dry');
  /*
   * `--only CODE` exists because a bare re-run is not as harmless as "idempotent"
   * suggests. Refreshing an account whose password is under the policy minimum
   * takes the delete-and-recreate path below, which issues a new user id — and
   * `meeting_note.updated_by` points at the old one, so every entry that person
   * made loses its author. Adding one account should not touch the other seven.
   */
  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt >= 0 ? process.argv[onlyAt + 1]?.toLowerCase() : null;

  const existing = await existingByEmail();
  console.log(`${existing.size} account(s) already present\n`);

  for (const acct of ACCOUNTS) {
    if (only && acct.code.toLowerCase() !== only) continue;
    const email = `${acct.code.toLowerCase()}@${DOMAIN}`;
    const password = acct.code; // as specified — see the note at the top
    const known = existing.get(email);

    if (dry) {
      console.log(`${acct.code.padEnd(8)} ${known ? 'update' : 'create'}  ${acct.role.padEnd(13)} ${acct.scope.join('+')}`);
      continue;
    }

    const create = async () => (await call('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, email_confirm: true }),
    })).id;

    let id = known;
    if (id) {
      try {
        await call(`/auth/v1/admin/users/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ password, email_confirm: true }),
        });
      } catch (e) {
        // Create bypasses the password policy but update enforces it, so a
        // password this short can be set once and never changed. Recreating the
        // account is the only way to make it match this file. Safe while seeding:
        // `profile` cascades and is rewritten below, and `meeting_note.updated_by`
        // is `on delete set null`, so no meeting entry is lost.
        if (!/weak_password/.test(e.message)) throw e;
        await call(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
        id = await create();
        console.log(`${''.padEnd(8)} (recreated — the policy refuses this password on update)`);
      }
    } else {
      id = await create();
    }

    await call('/rest/v1/profile?on_conflict=id', {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{
        id, code: acct.code, full_name: acct.name, role: acct.role, scope: acct.scope,
      }]),
    });

    console.log(`${acct.code.padEnd(8)} ${known ? 'updated' : 'created'}  ${acct.role.padEnd(13)} ${acct.scope.join('+')}`);
  }

  console.log('\ndone');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
