/**
 * Shared plumbing for the deployed functions.
 *
 * These exist because two things cannot happen in a browser: reading a bearer
 * credential, and creating a login. Both need the Supabase service key, which
 * bypasses row-level security entirely — so the rule for everything in this
 * directory is that the key is read from the environment, used, and never
 * returned, logged, or echoed in an error.
 *
 * The functions run on Vercel. `serve.mjs` covers the same ground for the local
 * and LAN builds, and the browser talks to whichever is there.
 */

const URL_BASE = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const configured = () => Boolean(URL_BASE && SERVICE_KEY);

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

/** PostgREST, as the service role. Bypasses RLS — only ever call it after the
 *  caller has been checked. */
export async function db(path, init = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(body?.message || `Database request failed (${r.status})`);
  return body;
}

/** The GoTrue admin API, as the service role. */
export async function auth(path, init = {}) {
  const r = await fetch(`${URL_BASE}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const e = new Error(body?.msg || body?.error_description || body?.message || `Auth request failed (${r.status})`);
    e.status = r.status;
    e.code = body?.error_code || body?.code;
    throw e;
  }
  return body;
}

/**
 * Who is calling, established from their own access token rather than from
 * anything they assert about themselves.
 *
 * The token is handed straight back to GoTrue for validation, so no signing key
 * or JWT library is needed here and an expired or forged token simply fails.
 * The profile is then read with the service key — reading it as the caller would
 * work too, but this way one code path covers the admin screen, where the point
 * is to see rows that are not your own.
 */
export async function caller(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  let user;
  try {
    user = await auth('user', { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return null;
  }
  if (!user?.id) return null;

  const rows = await db(`profile?id=eq.${user.id}&select=id,code,full_name,role,scope`);
  return rows?.[0] ? { ...rows[0], email: user.email } : { id: user.id, email: user.email, role: null, scope: [] };
}

/** Guard for the admin screen. Returns the caller, or answers the request. */
export async function requireAdmin(req, res) {
  const who = await caller(req);
  if (!who) { json(res, 401, { error: 'Sign in first.' }); return null; }
  if (who.role !== 'admin') { json(res, 403, { error: 'Administrators only.' }); return null; }
  return who;
}

/**
 * A secret from `app_secret`.
 *
 * Cached for the life of the warm instance so a conversation is not a database
 * round trip per turn, but only briefly — the reason to keep the key in a table
 * rather than a deploy variable is that rotating it should take effect without a
 * redeploy, and an hour-long cache would take that back.
 */
const cache = new Map();
const TTL_MS = 60_000;

export async function secret(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const rows = await db(`app_secret?name=eq.${encodeURIComponent(name)}&select=value`);
  const value = rows?.[0]?.value || '';
  cache.set(name, { value, at: Date.now() });
  return value;
}

/** Employee codes are folded to a deterministic address; the domain never
 *  receives mail and exists only so one code maps to one account. */
export const CODE_DOMAIN = 'bemmp.cyrix.internal';
export const codeToEmail = (code) => `${String(code).trim().toLowerCase()}@${CODE_DOMAIN}`;

export function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}
