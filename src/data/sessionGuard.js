import { supabase } from './supabase.js'

/**
 * Is this sign-in still good? Asked each minute and on coming back to the
 * page (0149; the user, 8 Oct: signed out "within a minute" when somebody
 * chooses "sign out from all devices" on another one).
 *
 *   revoked  signed out here too, and back to the Cyrix sign-in
 *   pending  a second device still waiting for its code: the portal asks
 */
export function startSessionGuard() {
  if (!supabase) return
  const db = supabase
  const look = async () => {
    const { data: { session } } = await db.auth.getSession()
    if (!session) return
    const { data, error } = await db.rpc('my_session_state')
    if (error) return
    if (data === 'revoked') {
      await db.auth.signOut({ scope: 'local' })
      window.location.assign('/')
    } else if (data === 'pending' && window.location.hostname === 'app.cyrix.in') {
      // Only where the portal is, to ask for the code. A localhost or Vercel sign-in is its own.
      window.location.assign('/')
    }
  }
  window.setInterval(() => { void look() }, 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void look()
  })
  void look()
}
