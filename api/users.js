import {
  auth, codeToEmail, configured, db, json, readBody, requireAdmin,
} from './_lib/server.js';

/**
 * Employee accounts, for the administrator.
 *
 * Creating a login is an `auth.admin` call and the browser cannot make one — the
 * publishable key has no such power, and giving it one would mean shipping the
 * service key to every visitor. So the whole of account management is here, and
 * every path starts by proving the caller is an admin against the database
 * rather than against anything the request claims.
 *
 *   GET    /api/users              list every account
 *   POST   /api/users              create one
 *   PATCH  /api/users              change role, contracts or name
 *   POST   /api/users?do=reset     put the password back to the employee code
 *   POST   /api/users?do=disable   revoke access without deleting the record
 */

const ROLES = new Set(['admin', 'director', 'project_head', 'coordinator', 'purchase']);
const CONTRACTS = new Set(['kl', 'ap']);

/**
 * The default password *is* the employee code, which is what makes "I've reset
 * it, sign in with your code twice" a sentence an administrator can say over the
 * phone without writing anything down.
 *
 * There is an asymmetry in GoTrue worth knowing before changing any of this:
 * creating a user with the admin key **bypasses** the password policy, while
 * updating one **enforces** it. So a code shorter than the policy minimum can be
 * given that password once, at creation, and never again — which is exactly what
 * makes `reset` the operation that can fail while `create` cannot.
 */
const MIN_PASSWORD = 6;

function validCode(code) {
  return /^[A-Za-z0-9._-]{2,40}$/.test(String(code || '').trim());
}

function cleanScope(scope) {
  if (!Array.isArray(scope)) return [];
  return [...new Set(scope.filter((s) => CONTRACTS.has(s)))];
}

export default async function handler(req, res) {
  if (!configured()) {
    json(res, 503, { error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are not set on this deployment.' });
    return;
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') { await list(res); return; }

    const body = readBody(req);
    const action = req.query?.do || body.do;

    if (req.method === 'POST' && action === 'reset') { await reset(res, body); return; }
    if (req.method === 'POST' && action === 'disable') { await setBan(res, body, true); return; }
    if (req.method === 'POST' && action === 'enable') { await setBan(res, body, false); return; }
    if (req.method === 'POST') { await create(res, body, admin); return; }
    if (req.method === 'PATCH') { await update(res, body, admin); return; }

    json(res, 405, { error: `${req.method} is not supported here.` });
  } catch (e) {
    json(res, e.status === 422 ? 400 : 500, { error: e.message });
  }
}

/* ------------------------------------------------------------------ list -- */

async function list(res) {
  const profiles = await db('profile?select=id,code,full_name,role,scope,created_at&order=code');

  /*
   * Last sign-in comes from GoTrue rather than the profile, because it is the
   * auth system's fact and duplicating it would mean writing on every login.
   * A failure here is not a failure of the page — the list is still the list.
   */
  let byId = new Map();
  try {
    const page = await auth('admin/users?per_page=200');
    byId = new Map((page.users || []).map((u) => [u.id, u]));
  } catch { /* the list renders without it */ }

  json(res, 200, {
    users: profiles.map((p) => ({
      ...p,
      last_sign_in_at: byId.get(p.id)?.last_sign_in_at ?? null,
      disabled: Boolean(byId.get(p.id)?.banned_until
        && new Date(byId.get(p.id).banned_until) > new Date()),
    })),
  });
}

/* ---------------------------------------------------------------- create -- */

async function create(res, body, admin) {
  const code = String(body.code || '').trim();
  if (!validCode(code)) {
    json(res, 400, { error: 'A code is 2–40 characters, letters and digits.' });
    return;
  }
  // Not an error, but the admin should hear it now rather than the first time
  // they try to reset this account and cannot.
  const shortCode = code.length < MIN_PASSWORD;
  if (!ROLES.has(body.role)) { json(res, 400, { error: 'Pick a role.' }); return; }

  const scope = body.role === 'admin' ? [] : cleanScope(body.scope);
  if (body.role !== 'admin' && !scope.length) {
    json(res, 400, { error: 'Assign at least one contract.' });
    return;
  }

  let user;
  try {
    user = await auth('admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: codeToEmail(code),
        password: code,
        // Nobody reads mail at this domain; the address is an identifier.
        email_confirm: true,
        user_metadata: { code, created_by: admin.code },
      }),
    });
  } catch (e) {
    if (/already been registered|already exists/i.test(e.message)) {
      json(res, 409, { error: `${code} already has an account.` });
      return;
    }
    if (e.code === 'weak_password' || /password/i.test(e.message)) {
      json(res, 400, { error: `"${code}" is not accepted as a password: ${e.message}` });
      return;
    }
    throw e;
  }

  /*
   * The profile is what the app actually reads. If this insert fails the auth
   * user is removed again — an account that can sign in but has no profile
   * lands on "no contract is assigned to you" with no way forward, which is
   * worse than the creation having plainly failed.
   */
  try {
    const [profile] = await db('profile', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: user.id,
        code,
        full_name: body.full_name || null,
        role: body.role,
        scope,
      }),
    });
    json(res, 201, {
      user: profile,
      defaultPassword: code,
      warning: shortCode
        ? `"${code}" is under ${MIN_PASSWORD} characters. It works as the password now, `
          + 'but the policy will refuse it on a later reset — use a longer code if you '
          + 'want "reset to default" to keep working.'
        : null,
    });
  } catch (e) {
    await auth(`admin/users/${user.id}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

/* ---------------------------------------------------------------- update -- */

async function update(res, body, admin) {
  if (!body.id) { json(res, 400, { error: 'Which account?' }); return; }

  const patch = {};
  if (body.full_name !== undefined) patch.full_name = body.full_name || null;
  if (body.role !== undefined) {
    if (!ROLES.has(body.role)) { json(res, 400, { error: 'Unknown role.' }); return; }
    patch.role = body.role;
  }
  if (body.scope !== undefined) patch.scope = cleanScope(body.scope);

  // An admin removing their own admin role locks the last door behind them, and
  // nothing in the app can undo it — only the database directly.
  if (body.id === admin.id && patch.role && patch.role !== 'admin') {
    json(res, 400, { error: 'You cannot remove your own administrator role.' });
    return;
  }
  if (!Object.keys(patch).length) { json(res, 400, { error: 'Nothing to change.' }); return; }

  const rows = await db(`profile?id=eq.${body.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!rows?.length) { json(res, 404, { error: 'No such account.' }); return; }
  json(res, 200, { user: rows[0] });
}

/* ----------------------------------------------------------------- reset -- */

async function reset(res, body) {
  if (!body.id) { json(res, 400, { error: 'Which account?' }); return; }
  const rows = await db(`profile?id=eq.${body.id}&select=code`);
  const code = rows?.[0]?.code;
  if (!code) { json(res, 404, { error: 'No such account.' }); return; }

  try {
    await auth(`admin/users/${body.id}`, {
      method: 'PUT',
      body: JSON.stringify({ password: code }),
    });
  } catch (e) {
    /*
     * The asymmetry described at the top of this file. Recreating the account
     * would get around it — that is what the seed script does — but it issues a
     * new user id, and `meeting_note.updated_by` points at the old one, so every
     * entry this person made would lose its author. That is not a trade to make
     * on the admin's behalf without saying so.
     */
    if (e.code === 'weak_password' || /password/i.test(e.message)) {
      json(res, 400, {
        error: `"${code}" is ${code.length} characters, and the password policy needs at `
          + `least ${MIN_PASSWORD}. This account can only get its code back as a password `
          + 'by being recreated, which would detach its name from the meeting entries it '
          + 'has already made. Set a longer password in Supabase instead.',
      });
      return;
    }
    throw e;
  }
  json(res, 200, { ok: true, password: code });
}

/* --------------------------------------------------------------- disable -- */

/**
 * Banned rather than deleted. The meeting notes carry `updated_by`, and deleting
 * the account would either orphan that history or take it with it — neither is a
 * thing to do to an audit trail because somebody left.
 */
async function setBan(res, body, disabled) {
  if (!body.id) { json(res, 400, { error: 'Which account?' }); return; }
  await auth(`admin/users/${body.id}`, {
    method: 'PUT',
    body: JSON.stringify({ ban_duration: disabled ? '876000h' : 'none' }),
  });
  json(res, 200, { ok: true, disabled });
}
