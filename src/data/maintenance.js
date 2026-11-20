/**
 * "Cyra is under maintenance" (the user, 20 Nov, after the morning's database
 * outage and before the Micro → Small restart).
 *
 * Two ways it shows:
 *  - By hand: SW Admin → Platform turns it on, now or From a date and time,
 *    for every app or chosen ones (KPI 0303). A bar under the header says so
 *    beforehand, as long before From as SW Admin chose (0304; 15 minutes
 *    unless changed). It stays on until SW Admin turns it off;
 *    after To the screen says "Taking a little longer". SW Admin and the Ops
 *    admins still get in (0305), with a red bar to remind them it is on.
 *  - By itself: when the database does not answer (server errors twice in a
 *    row while our own site does answer, so a phone's poor network is not
 *    taken for it), instead of an empty page. It looks again
 *    every 30 seconds and goes away by itself.
 *
 * The X is the splash's: its two halves pull apart and join again, as if being
 * repaired. The logo itself is never changed.
 *
 * The same file is in every Cyrix app's src/lib/maintenance.ts (BEMMP's is the
 * JavaScript copy, src/data/maintenance.js) — change one, change them all. No
 * React: it draws its own screen. Started in main.tsx with the app's code:
 * portal, kpi, travel, bemmp, revive, tasks, workplace, projects, pulse or cyra.
 *
 * Apps with a supabase-js client on the shared database call startMaintenance().
 * Pulse (a plain fetch with the portal's session) and Cyra (its own Supabase
 * project, so no session here: it reads the portal's /api/maintenance, cached
 * at the edge) call startMaintenanceFrom() with a source of their own (0305).
 */
/** Fetch a URL as a MaintenanceSource read (status 0 when the network failed). */
export async function readJson(url, init = {}) {
    try {
        const r = await fetch(url, { cache: 'no-store', ...init });
        if (!r.ok)
            return { data: null, error: { status: r.status }, status: r.status };
        return { data: await r.json(), error: null, status: r.status };
    }
    catch (e) {
        return { data: null, error: e ?? {}, status: 0 };
    }
}
const BLACK = '22,8 44,8 66,40 44,72 22,72 44,40';
const RED = '98,8 76,8 54,40 76,72 98,72 76,40';
const dark = () => {
    const r = document.documentElement;
    if (r.classList.contains('dark') || r.getAttribute('data-theme') === 'dark')
        return true;
    if (r.getAttribute('data-theme') === 'light')
        return false;
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    catch {
        return false;
    }
};
const when = (iso, now) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).replace(/\s?([ap])m$/i, ' $1m').toLowerCase();
    const day = (x) => x.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (day(d) === day(now))
        return time;
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) + ', ' + time;
};
const CSS = `
@keyframes cyx-m-l{0%,20%{transform:translateX(0)}45%,65%{transform:translateX(-14px) rotate(-8deg)}90%,100%{transform:translateX(0)}}
@keyframes cyx-m-r{0%,20%{transform:translateX(0)}45%,65%{transform:translateX(14px) rotate(8deg)}90%,100%{transform:translateX(0)}}
@keyframes cyx-m-w{0%,30%{opacity:0;transform:translateY(6px) rotate(0)}45%{opacity:1;transform:translateY(0) rotate(-25deg)}55%{transform:rotate(25deg)}65%{opacity:1;transform:rotate(-15deg)}80%,100%{opacity:0;transform:translateY(6px) rotate(0)}}
@keyframes cyx-m-d{0%,100%{opacity:.25}50%{opacity:1}}
.cyx-m{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center}
.cyx-m-l{animation:cyx-m-l 2.6s cubic-bezier(.65,0,.35,1) infinite;transform-box:fill-box;transform-origin:center}
.cyx-m-r{animation:cyx-m-r 2.6s cubic-bezier(.65,0,.35,1) infinite;transform-box:fill-box;transform-origin:center}
.cyx-m-w{animation:cyx-m-w 2.6s ease infinite;transform-box:fill-box;transform-origin:center}
.cyx-m-d{width:7px;height:7px;border-radius:50%;background:#ED1C24;animation:cyx-m-d 1.2s ease infinite}
@media (prefers-reduced-motion: reduce){.cyx-m-l,.cyx-m-r,.cyx-m-w,.cyx-m-d{animation:none}}
.cyx-m-bar{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 72px);transform:translateX(-50%);z-index:2147483500;display:flex;align-items:center;gap:12px;width:min(520px,calc(100% - 32px));box-sizing:border-box;padding:12px 16px;border-radius:12px;background:#111318;color:#f4f5f7;border-left:4px solid #ED1C24;box-shadow:0 10px 30px rgba(0,0,0,.35);font:500 14px/1.4 system-ui,sans-serif}
.cyx-m-bar.cyx-m-admin{background:#ce2434;color:#fff;border-left:0}
.cyx-m-bar svg{flex-shrink:0}
.cyx-m-bar button{flex-shrink:0;padding:8px 14px;border:0;border-radius:8px;background:#ce2434;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer}
`;
export function startMaintenance(db, app) {
    if (!db)
        return;
    startMaintenanceFrom(app, {
        signedIn: async () => {
            const { data: { session } } = await db.auth.getSession().catch(() => ({ data: { session: null } }));
            return !!session;
        },
        read: async () => {
            try {
                return await db.rpc('platform_maintenance');
            }
            catch {
                return { data: null, error: {}, status: 0 };
            }
        },
        watch: recheck => { db.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT')
            recheck(); }); },
    });
}
export function startMaintenanceFrom(app, source) {
    if (typeof window === 'undefined')
        return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    // ---- the screen ----
    let screen = null;
    let line = null;
    const hideScreen = () => { screen?.remove(); screen = null; line = null; };
    const showScreen = (sub) => {
        if (!screen) {
            const dk = dark();
            screen = document.createElement('div');
            screen.className = 'cyx-m';
            screen.setAttribute('role', 'alert');
            screen.style.background = dk ? '#111318' : '#ffffff';
            screen.style.color = dk ? '#f4f5f7' : '#111318';
            screen.innerHTML = `
        <svg width="120" height="80" viewBox="0 0 120 80" aria-hidden="true">
          <polygon class="cyx-m-l" points="${BLACK}" fill="${dk ? '#f4f5f7' : '#000000'}"/>
          <polygon class="cyx-m-r" points="${RED}" fill="#ED1C24"/>
        </svg>
        <svg class="cyx-m-w" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${dk ? '#9aa0aa' : '#6b7280'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5"/></svg>
        <p style="margin:0;font-size:19px;font-weight:600">Cyra is under maintenance</p>
        <p data-line style="margin:0;font-size:14px;opacity:.75"></p>
        <div style="display:flex;gap:7px"><span class="cyx-m-d"></span><span class="cyx-m-d" style="animation-delay:.2s"></span><span class="cyx-m-d" style="animation-delay:.4s"></span></div>`;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Try again';
            btn.style.cssText = `margin-top:6px;padding:10px 20px;border-radius:10px;border:1px solid ${dk ? '#3a3f48' : '#d1d5db'};background:transparent;color:inherit;font:500 15px system-ui,sans-serif;cursor:pointer`;
            btn.onclick = () => { void check(true); };
            screen.appendChild(btn);
            document.body.appendChild(screen);
            line = screen.querySelector('[data-line]');
        }
        if (line) {
            line.textContent = sub;
            line.style.display = sub ? '' : 'none';
        }
    };
    // ---- the bar (notice before, or the reminder for SW Admin) ----
    let bar = null;
    let barText = '';
    const hideBar = () => { bar?.remove(); bar = null; barText = ''; };
    const showBar = (text, key) => {
        try {
            if (key && sessionStorage.getItem('cyrix.maintenanceSeen') === key) {
                hideBar();
                return;
            }
        }
        catch { /* refused */ }
        if (bar && barText === text)
            return;
        hideBar();
        bar = document.createElement('div');
        bar.className = key ? 'cyx-m-bar' : 'cyx-m-bar cyx-m-admin';
        bar.setAttribute('role', 'status');
        bar.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${key ? '#ED1C24' : '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5"/></svg>`;
        const span = document.createElement('span');
        span.style.cssText = 'flex:1;min-width:0';
        span.textContent = text;
        bar.appendChild(span);
        if (key) {
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.textContent = 'OK';
            ok.onclick = () => { try {
                sessionStorage.setItem('cyrix.maintenanceSeen', key);
            }
            catch { /* refused */ } hideBar(); };
            bar.appendChild(ok);
        }
        document.body.appendChild(bar);
        barText = text;
    };
    // ---- the check ----
    let failures = 0;
    let auto = false;
    let timer;
    const next = (ms) => { window.clearTimeout(timer); timer = window.setTimeout(() => { void check(false); }, ms); };
    const check = async (pressed) => {
        if (!await source.signedIn().catch(() => false)) {
            hideScreen();
            hideBar();
            next(60_000);
            return;
        }
        const res = await source.read().catch(() => ({ data: null, error: {}, status: 0 }));
        let broken = source.auto !== false && !!res.error && (res.status === 0 || res.status >= 500) && navigator.onLine !== false;
        if (broken) {
            // Only when our own site answers: otherwise it is the phone's network, not us.
            try {
                await fetch(`${window.location.origin}/?alive=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
            }
            catch {
                broken = false;
            }
        }
        if (broken) {
            failures++;
            if (failures >= 2 || auto) {
                auto = true;
                hideBar();
                showScreen('');
            }
            next(30_000);
            return;
        }
        failures = 0;
        if (auto) {
            auto = false;
            hideScreen();
            // Back after an outage: the page under it may have loaded empty.
            if (pressed || document.visibilityState === 'visible') {
                window.location.reload();
                return;
            }
        }
        if (res.error || !res.data) {
            hideScreen();
            hideBar();
            next(60_000);
            return;
        }
        const s = res.data;
        const now = s.now ? new Date(s.now) : new Date();
        const forMe = !s.apps?.length || s.apps.includes(app);
        const from = s.from ? new Date(s.from) : null;
        const started = !!s.on && forMe && (!from || now >= from);
        const soon = !!s.on && forMe && !!from && now < from && from.getTime() - now.getTime() <= (s.notice_min ?? 15) * 60_000;
        const admin = !!s.admin || (started && !!source.isAdmin && await source.isAdmin().catch(() => false));
        const back = s.to ? (now < new Date(s.to) ? `Back by ${when(s.to, now)}` : 'Taking a little longer') : '';
        if (started && !admin) {
            hideBar();
            showScreen(back);
        }
        else {
            const wasOn = !!screen;
            hideScreen();
            if (wasOn && pressed) {
                window.location.reload();
                return;
            }
            if (started && admin)
                showBar('Maintenance is on — only admins can use the apps', null);
            else if (soon && from)
                showBar(`Maintenance from ${when(from.toISOString(), now)}${s.to ? ` · back by ${when(s.to, now)}` : ''}`, from.toISOString());
            else
                hideBar();
        }
        // Every minute; every 15 seconds in the last minutes before From.
        next(soon && from && from.getTime() - now.getTime() < 90_000 ? 15_000 : 60_000);
    };
    // ?maintenance shows the screen as it would look, ?maintenance=soon the bar before it, ?maintenance=admin SW Admin's bar (as ?splash does).
    const preview = new URLSearchParams(window.location.search).get('maintenance');
    if (preview !== null) {
        const t = new Date(Date.now() + 30 * 60_000).toISOString();
        if (preview === 'soon')
            showBar(`Maintenance from ${when(new Date(Date.now() + 10 * 60_000).toISOString(), new Date())} · back by ${when(t, new Date())}`, 'preview');
        else if (preview === 'admin')
            showBar('Maintenance is on — only admins can use the apps', null);
        else
            showScreen(`Back by ${when(t, new Date())}`);
        return;
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible')
        void check(false); });
    source.watch?.(() => { void check(false); });
    void check(false);
}
