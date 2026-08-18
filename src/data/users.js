/**
 * Account management, from the browser's side.
 *
 * Every call goes to `/api/users`, never to Supabase directly. That is not a
 * layering preference: creating a login is an `auth.admin` operation, and the
 * only key that can perform one is the service key — which bypasses row-level
 * security entirely and must therefore never be in a page. The function holds
 * it, and re-checks that the caller is an admin against the database on every
 * request rather than trusting anything the page says about itself.
 */

import { supabase } from './supabase.js';

const BASE = (import.meta.env?.VITE_ADMIN_URL || '/api/users').replace(/\/+$/, '');

/*
 * Order is seniority-ish rather than alphabetical, because the picker is read
 * top to bottom by somebody deciding what to give a new joiner.
 *
 * Only two of these ids are load-bearing anywhere: `admin` gates the Accounts
 * tab, and `director` is the one role that cannot type in the meeting grid.
 * Everything else is a designation, which is why adding the three field roles
 * needed no permission code — see `canEditMeeting` in supabase.js.
 */
export const ROLES = [
  { id: 'admin', label: 'Administrator', hint: 'Manages accounts. Sees every contract.' },
  { id: 'project_head', label: 'Project head', hint: 'Full working access to their contracts.' },
  { id: 'divisional_manager', label: 'Divisional manager', hint: 'Works the meeting across their division.' },
  { id: 'zonal_manager', label: 'Zonal manager', hint: 'Works the meeting across their zone.' },
  { id: 'district_incharge', label: 'District incharge', hint: 'Works the meeting for their district.' },
  { id: 'coordinator', label: 'Coordinator', hint: 'Runs the daily penalty meeting.' },
  { id: 'purchase', label: 'Purchase', hint: 'Fills the purchasing fields on open calls.' },
  { id: 'director', label: 'Director', hint: 'Reads every figure. Cannot edit the meeting.' },
];

export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]));

async function call(method, body, params = '') {
  if (!supabase) throw new Error('Not connected.');
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Sign in again.');

  const r = await fetch(`${BASE}${params}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* fall through */ }

  if (!r.ok) {
    /*
     * A deployment with no functions answers with the SPA's index.html rather
     * than JSON, so an unparseable body means the endpoint is not there — which
     * is a different problem from a rejected request, and saying so saves
     * somebody reading a stack trace about unexpected "<".
     */
    if (!parsed) {
      throw new Error(
        r.status === 404
          ? 'The account service is not deployed on this host.'
          : `The account service failed (${r.status}).`,
      );
    }
    throw new Error(parsed.error || `Request failed (${r.status}).`);
  }
  return parsed;
}

export const listUsers = () => call('GET').then((d) => d.users ?? []);

export const createUser = (fields) => call('POST', fields);

export const updateUser = (id, patch) => call('PATCH', { id, ...patch }).then((d) => d.user);

/** Back to the employee code, which is the rule the whole scheme rests on. */
export const resetPassword = (id) => call('POST', { id }, '?do=reset');

export const setDisabled = (id, disabled) => call(
  'POST', { id }, disabled ? '?do=disable' : '?do=enable',
);

/**
 * The account audit trail, newest first.
 *
 * Read through the same endpoint as everything else here rather than straight
 * from PostgREST — `account_audit` does have a select policy for admins, but
 * routing it through `requireAdmin` keeps one place deciding who may see account
 * history instead of a policy and a component having to agree.
 */
export const listAccountLog = (limit = 200) => call('GET', null, `?do=log&limit=${limit}`)
  .then((d) => d.entries ?? []);
