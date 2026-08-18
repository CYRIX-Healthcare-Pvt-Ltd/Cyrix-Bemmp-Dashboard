/**
 * Supabase access: authentication, and the meeting notes that go with it.
 *
 * Ticket data deliberately does not come from here. It is still built from the
 * TM export into `public/data`, or parsed from an upload in the browser — the
 * dashboard's figures have to work with no network and no account, which is what
 * makes the static build usable. What Supabase holds is the part that exists
 * nowhere else: what people typed in the daily meeting, and who they are.
 *
 * The publishable key is meant to be in the bundle. It identifies the project
 * and nothing more; row-level security decides what any given session may read
 * or write, which is why the policies in supabase/migrations are the real access
 * control and the hidden tab is only a courtesy.
 */

import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env?.VITE_SUPABASE_URL ?? '';
const KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '';

/**
 * Null when the deployment has no Supabase configured.
 *
 * That is a supported state rather than an error: a build with no env vars is
 * the offline/on-prem case, and it still has to show the dashboard. Everything
 * that needs an account checks `isConfigured()` and steps aside if not.
 */
export const supabase = URL && KEY
  ? createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  : null;

export const isConfigured = () => supabase !== null;

/**
 * People sign in with the employee code they already use — E1042, KLCoord —
 * not an email address. Supabase Auth is email-and-password underneath, so the
 * code is folded into a deterministic address on this domain. The domain is
 * never sent anywhere and never has to receive mail; it exists so that one
 * account maps to one code, case-insensitively.
 */
const CODE_DOMAIN = 'bemmp.cyrix.internal';

export const codeToEmail = (code) => `${String(code).trim().toLowerCase()}@${CODE_DOMAIN}`;

/** True for an address this app minted, so the UI can show the code back. */
export const emailToCode = (email) => (
  email?.endsWith(`@${CODE_DOMAIN}`) ? email.slice(0, -(CODE_DOMAIN.length + 1)) : email
);

export async function signIn(code, password) {
  if (!supabase) throw new Error('Sign-in is not configured on this deployment.');
  const { data, error } = await supabase.auth.signInWithPassword({
    email: codeToEmail(code),
    password,
  });
  // GoTrue answers a bad code and a bad password identically, which is the
  // behaviour we want — the message is deliberately not narrowed here.
  if (error) throw new Error('That employee code and password do not match.');
  return data.session;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

/**
 * The row that says what this account may see. Separate from `auth.users`
 * because role and scope are the business's data, not the auth provider's —
 * and because the sheet this came from has a Director who only sees Andhra, so
 * the two cannot be collapsed into one field.
 */
export async function loadProfile() {
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getUser();
  const id = auth?.user?.id;
  if (!id) return null;

  /*
   * Filtered by id rather than left to row-level security to return one row.
   *
   * It used to rely on the policy, which was true while every account could see
   * exactly its own profile. An administrator can now see all of them, so the
   * unfiltered query returns nine and `maybeSingle` fails on it — the admin
   * would be the one account unable to load its own profile.
   */
  const { data, error } = await supabase
    .from('profile')
    .select('id, code, full_name, role, scope, zones, districts')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * What to call somebody: the first word of their name.
 *
 * "Kevin", not "Kevin R" and not `E1427` — an employee code is what you type to
 * get in, not what you want read back at you on every screen and by the
 * assistant. The code is the fallback rather than the first choice, because it
 * is always present but nobody thinks of it as a name.
 */
export function firstName(profile) {
  const full = (profile?.full_name || '').trim();
  return full ? full.split(/\s+/)[0] : (profile?.code ?? '');
}

/** Directors read every tab but the meeting: it is a working surface, not a report. */
export const canEditMeeting = (profile) => Boolean(profile) && profile.role !== 'director';

export const isAdmin = (profile) => profile?.role === 'admin';

/**
 * An admin sees every contract without any being listed against them.
 *
 * Their `scope` column is deliberately empty: writing {'kl','ap'} into it would
 * be a copy that goes stale the day a third contract is added, and the person
 * who adds it is the same person who would have to remember. The database's
 * `in_scope()` asks the role for exactly this reason; this is the same test on
 * the client, and the database is still the one enforcing it.
 */
export const canSeeState = (profile, stateId) => (
  isAdmin(profile) || Boolean(profile?.scope?.includes(stateId))
);
