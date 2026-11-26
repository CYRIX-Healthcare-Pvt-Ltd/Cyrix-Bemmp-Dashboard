/**
 * Errors people hit, sent to the Ops page (0230). Before this, a page that broke in front of somebody
 * told nobody: the only record was the console of the phone it broke on.
 *
 * Catches what nothing else does — an uncaught error, a promise rejection nobody handled — and gives
 * the error boundary `reportError` for the crashes it catches. Each goes to `ops_report_error`, which
 * groups them by message, so one fault seen a thousand times is one row with a count.
 *
 * Sent: the message, the top of the stack, the path (no query string), the build and the browser.
 * Never what was on the screen or typed into it. Signed-in people only: the database drops the rest.
 *
 * At most 20 reports per page load and each distinct message once, so a render loop cannot flood
 * anything. Noise every browser makes (ResizeObserver, cross-origin "Script error.", extensions)
 * is skipped. Reporting never throws: a reporter that fails would report itself.
 *
 * The same file is in every Cyrix app's src/lib/reportErrors.ts; this is its JavaScript copy —
 * change one, change them all. No React.
 */

const MAX_PER_LOAD = 20
const NOISE = /ResizeObserver loop|^Script error\.?$|chrome-extension:|moz-extension:|safari-extension:/i

let db = null
let appId = ''
let release = null
const seen = new Set()

function describe(reason) {
  if (reason instanceof Error) return { message: reason.message || reason.name, stack: reason.stack ?? null }
  if (typeof reason === 'string') return { message: reason, stack: null }
  try { return { message: JSON.stringify(reason)?.slice(0, 300) ?? String(reason), stack: null } }
  catch { return { message: String(reason), stack: null } }
}

export function reportError(reason, where) {
  try {
    if (!db || seen.size >= MAX_PER_LOAD) return
    const { message, stack } = describe(reason)
    const text = (where ? `${where}: ` : '') + (message ?? '')
    if (!text.trim() || NOISE.test(text) || (stack && NOISE.test(stack))) return
    if (seen.has(text)) return
    seen.add(text)
    void db.rpc('ops_report_error', {
      p_app: appId,
      p_message: text.slice(0, 300),
      p_stack: stack ? stack.split('\n').slice(0, 8).join('\n').slice(0, 2000) : null,
      p_route: location.pathname,
      p_release: release,
      p_user_agent: navigator.userAgent.slice(0, 200),
    }).then(() => undefined, () => undefined)
  } catch {
    // never let reporting break the page
  }
}

/** Once, before React mounts. `app` is the module code: portal, kpi, spare, bemmp, revive, travel, tasks. */
export function startErrorReporting(client, app, build) {
  db = client
  appId = app
  release = build ?? null
  window.addEventListener('error', e => reportError(e.error ?? e.message))
  window.addEventListener('unhandledrejection', e => reportError(e.reason, 'Unhandled rejection'))
}
