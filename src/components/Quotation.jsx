import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SideNav from './SideNav.jsx';
import Picker from './Picker.jsx';
import { ProjectMasthead } from './ProjectHome.jsx';
import { supabase } from '../data/supabase.js';
import {
  loadList, loadOne, loadFacilities, loadEquipmentAt, loadPeople, loadTargets, loadEvents,
  raise, raiseStock, accept, tlApprove, tlDecline, editOwn, reopen, addNote, transfer, consume, resume, act,
  saveFacility, savePerson, removePerson, saveTargets, uploadPhoto, photoUrl, exportAll, tatOf, statusOf, findPerson, workOf,
  STEPS, stepOf, roleOfStep, ACTIONS, TAT_STEPS, NO_ACCEPT, clockOf, spanText, dayText, whenText, todayIst,
  periodRange, money, withTax, person,
} from '../data/quotation.js';
import '../medtronic.css';
import '../pm.css';
import '../quotation.css';

/**
 * Quotation tracker (the user, 11 Nov 2026): the spare-quotation workflow
 * from the Google Apps Script, in our own design. Phone first: one "To do"
 * list that opens on what waits for you, a big Accept on each card, the next
 * step's form on the same card, a clock that turns amber then red, and every
 * decision asked first.
 */

const PERIODS = [['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];
const SEND_BY = ['Courier', 'Transport', 'Post', 'By hand'];
const TAXES = [0, 5, 18]; // 12 and 28 not used (the user, 12 Nov)
const PV_ABOVE = 40000;
/** What every form may want from the app: past vendors, recent hospitals, who is signed in. */
const QtCtx = createContext({ vendors: [], recent: [], code: '', lead: false, pools: {} });
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* the draft is only lost on reload */ } },
};
const ROLE_NAME = { engineer: 'Engineer', team_lead: 'Team Lead', coordinator: 'Coordinator', purchase: 'Purchase', pv: 'PV', observer: 'Observer', viewer: 'Viewer' };

function tabsFor(me) {
  const r = me.role; const t = [{ id: 'dashboard', label: 'Dashboard', short: 'Dashboard' }, { id: 'requests', label: 'Requests', short: 'Requests' }];
  if (r === 'engineer' || r === 'team_lead') t.push({ id: 'new', label: 'New request', short: 'New' });
  if (r === 'coordinator') t.push({ id: 'new', label: 'Stock request', short: 'Stock req' });
  t.push({ id: 'stock', label: 'Stock register', short: 'Stock' });
  if (r === 'coordinator' || me.lead) t.push({ id: 'hospitals', label: 'Hospitals', short: 'Hospitals' });
  if (me.lead) t.push({ id: 'settings', label: 'Settings', short: 'Settings' });
  return t;
}

export default function QuotationApp({ me, profile, narrow, switcher, onSignOut }) {
  const [tab, setTab] = useState('dashboard');
  const [period, setPeriod] = useState({ id: 'month', from: '', to: '' });
  const [list, setList] = useState(null);
  const [targets, setTargets] = useState({});
  const [failed, setFailed] = useState(null);
  const [openId, setOpenId] = useState(() => new URLSearchParams(window.location.search).get('q'));
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());

  const reload = useCallback(() => {
    const [from, to] = periodRange(period);
    return Promise.all([loadList(from, to), loadTargets()])
      .then(([l, t]) => { setList(l ?? []); setTargets(t ?? {}); setFailed(null); })
      .catch((e) => setFailed(e.message));
  }, [period]);

  useEffect(() => {
    reload();
    const check = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); clearInterval(tick); };
  }, [reload]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const [preset, setPreset] = useState(null);
  const [todoSub, setTodoSub] = useState(null);
  const open = (id, choice = null) => {
    setOpenId(id); setPreset(choice);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('q', id); else u.searchParams.delete('q');
    window.history.replaceState(null, '', u);
  };

  const code = profile?.code ?? '';
  // Who can accept a step nobody holds yet, by role (the user, 12 Nov: "accept pending" shows them).
  const [pools, setPools] = useState({});
  useEffect(() => {
    loadPeople().then((x) => {
      const m = {};
      for (const p of x ?? []) if (p.active) (m[p.role] ??= []).push({ id: p.employee_id, name: p.name, test: /- *test/i.test(p.name ?? '') });
      setPools(m);
    }).catch(() => {});
  }, []);
  const ctx = useMemo(() => {
    const count = new Map();
    for (const r of list ?? []) for (const x of [r.orig_vendor, r.comp_vendor, r.vendor]) { const t = x?.trim(); if (t) count.set(t, (count.get(t) ?? 0) + 1); }
    const vendors = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x]) => x);
    const seen = [...(store.get(`qt-recent-hosp:${code}`) ?? [])];
    if (me.role === 'engineer') for (const r of [...(list ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) if (r.kind === 'request' && r.facility_id) seen.push(r.facility_id);
    return { vendors, recent: [...new Set(seen)].slice(0, 5), code, lead: Boolean(me.lead), pools };
  }, [list, code, me.role, me.lead, pools]);
  const tabs = tabsFor(me);
  const mine = list?.filter((r) => r.mine && !r.done) ?? [];
  const sub = `Quotation tracker · ${ROLE_NAME[me.role] ?? ''}${me.lead && me.role !== 'viewer' ? ' (lead)' : ''}${list ? ` · ${mine.length} to do` : ''}`;
  const done = (msg) => { setToast(msg); reload(); };

  return (
    <QtCtx.Provider value={ctx}>
    <div className="app qt-app">
      <ProjectMasthead profile={profile} narrow={narrow} sub={sub}
                       right={<div className="qt-head-right"><Bell onOpen={open} />{switcher}</div>} onSignOut={onSignOut} />
      <div className="shell">
        <SideNav tabs={tabs.map((t) => ({ ...t, label: t.id === 'requests' && mine.length ? `${t.label} · ${mine.length}` : t.label }))}
                 active={tab} onSelect={(t) => { if (t === 'requests') setTodoSub(null); setTab(t); }} onSignOut={onSignOut} signedIn={Boolean(profile)} profile={profile} roleLabel={ROLE_NAME[me.role] ?? null} showAccountControls={!narrow} />
        <div className="work">
          {toast && <div className="mt-toast" role="status">{toast}</div>}
          {failed ? (
            <div className="status-msg">
              <p>The quotation tracker could not load just now.</p>
              <p className="status-detail">{failed}</p>
              <button type="button" className="mt-btn" onClick={reload}>Try again</button>
            </div>
          ) : !list ? (
            <div className="status-msg"><div className="loader" aria-hidden="true" /></div>
          ) : (
            <div className="tabview" key={tab}>
              {tab === 'requests' && <Work me={me} list={list} mine={mine} targets={targets} now={now} period={period} setPeriod={setPeriod} onOpen={open} onDone={done} view={todoSub} setView={setTodoSub} />}
              {tab === 'new' && (me.role === 'coordinator'
                ? <StockForm onDone={(m) => { done(m); setTab('requests'); setTodoSub('others'); }} />
                : <RaiseForm me={me} onDone={(m) => { done(m); setTab('requests'); setTodoSub('others'); }} />)}
              {tab === 'stock' && <StockRegister me={me} list={list} onOpen={open} onDone={done} />}
              {tab === 'dashboard' && <Dashboard me={me} list={list} targets={targets} period={period} setPeriod={setPeriod} onToast={setToast} onGo={(v) => { setTodoSub(v); setTab('requests'); }} />}
              {tab === 'hospitals' && <Hospitals />}
              {tab === 'settings' && <Settings targets={targets} onDone={done} />}
            </div>
          )}
        </div>
      </div>
      {openId && <RequestSheet id={openId} preset={preset} me={me} targets={targets} now={now} onClose={() => open(null)} onChanged={done}
                                 onFinished={(stillMine) => { open(null); reload(); setTab('requests'); setTodoSub(stillMine ? 'mine' : null); }} />}
    </div>
    </QtCtx.Provider>
  );
}

/* ================================================================ bits == */

const Icon = ({ d, size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const I = {
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  swap: <><path d="M4 8h13l-3.5-3.5" /><path d="M20 16H7l3.5 3.5" /></>,
  hourglass: <><path d="M7 4h10M7 20h10" /><path d="M8 4c0 4 8 4 8 8s-8 4-8 8M16 4c0 4-8 4-8 8s8 4 8 8" /></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="13" r="3.2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  down: <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>,
};

/** The role a request now waits with (a stock return goes to the Coordinator). */
const roleOfReq = (r) => (r.step === 'return_dispatch' && r.kind === 'stock' ? 'coordinator' : roleOfStep(r.step));

/** Nobody has accepted the step yet (the user, 12 Nov). */
const acceptPending = (r) => !r.done && !r.accepted_at && !NO_ACCEPT.has(r.step) && Boolean(roleOfStep(r.step));

/** Who can accept it: the step's own person, else everybody of the role (test accounts only on test requests). */
function acceptBy(r, pools) {
  const role = roleOfStep(r.step);
  const own = { team_lead: r.team_lead_name, engineer: r.engineer_name, coordinator: r.coord_name, purchase: r.purchase_name }[role];
  if (own) return [own];
  const test = /- *test/i.test(r.engineer_name ?? '');
  return (pools?.[role] ?? []).filter((p) => p.test === test).map((p) => p.name);
}
const orNames = (xs) => (xs.length <= 1 ? xs[0] ?? '' : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

// A number that counts up to its value, and again whenever it changes (the user, 12 Nov: "make dynamic").
function CountUp({ n }) {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const a = from.current, b = n ?? 0;
    if (a === b || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { from.current = b; setV(b); return undefined; }
    let raf; const t0 = performance.now(), dur = 600;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const x = Math.round(a + (b - a) * e); from.current = x; setV(x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return <span key={n} className="qt-count">{v}</span>;
}

function PendingChip({ r, now, withRole }) {
  if (!acceptPending(r)) return null;
  const since = r.step_since ? new Date(r.step_since).getTime() : null;
  return (
    <span className="qt-pending-chip">
      <Icon d={I.hourglass} size={12} />Accept pending{withRole ? ` · ${stepOf(r.step).who}` : since ? ` · ${gapLabel((now ?? Date.now()) - since)}` : ''}
    </span>
  );
}

function StepBadge({ r }) {
  const s = stepOf(r.step);
  return <span className="qt-badge" data-tone={s.tone} data-role={roleOfStep(r.step) ?? undefined}>{statusOf(r)}</span>;
}

/** The clock is for whoever holds the request; in lists leads also see everyone's, but inside a request it shows only to its holder (the user, 11 Nov). */
function Clock({ r, targets, now }) {
  const { lead } = useContext(QtCtx);
  const c = clockOf(r, targets, now);
  if (!c || (!r.mine && !lead)) return null;
  return (
    <span className="qt-clock" data-tone={c.tone} title={c.accepted ? 'Since accepted' : 'Waiting to be accepted'}>
      <Icon d={I.clock} size={14} />{c.accepted || !r.mine ? '' : <span className="qt-clock-word">Waiting </span>}{c.text}
    </span>
  );
}

function Err({ text, at }) {
  if (!text) return null;
  return <p className="mt-err qt-err" role="alert" ref={at}>{text}</p>;
}

/** "Write the compatible vendor." → the Vendor box under Compatible, marked red until it is touched. */
const norm = (x) => String(x ?? '').toLowerCase().replace(/\(.*?\)|[%₹.,]/g, ' ').replace(/\bnumber\b/g, 'no').replace(/\bquantity\b/g, 'qty').replace(/\s+/g, ' ').trim();
function markMissing(root, msg) {
  const m = /^(?:Write|Choose) the (.+?)\.?$/i.exec(String(msg ?? '').trim()) ?? /^The (compatible rate) must/i.exec(String(msg ?? ''));
  if (!root || !m) return null;
  let name = norm(m[1]);
  const nth = /^(.*?) and qty of spare (\d+)$/.exec(name);
  if (nth) { root = root.querySelectorAll('.qt-spare-card')[Number(nth[2]) - 1] ?? root; name = nth[1]; }
  name = name.replace(/^how it is sent$/, 'sent by').replace(/^(reason|question) .*/, '$1').replace(/^what to .*/, 'remarks');
  const words = new Set(name.split(' '));
  let best = null; let score = 0;
  for (const box of root.querySelectorAll('.pm-in')) {
    const label = norm(box.querySelector(':scope > span')?.textContent);
    if (!label) continue;
    const lw = label.split(' ');
    if (!lw.every((w) => words.has(w)) && !(label === 'remarks' && words.has('reason'))) continue;
    const kind = norm(box.closest('.qt-quote-in')?.querySelector('.qt-quote-kind')?.textContent);
    const sc = lw.length * 2 + (kind && kind.split(' ').some((w) => words.has(w)) ? 1 : 0) - (label === 'remarks' ? 1 : 0);
    if (sc > score) { best = box; score = sc; }
  }
  if (!best) return null;
  best.classList.add('is-bad');
  const off = () => best.classList.remove('is-bad');
  best.addEventListener('input', off, { once: true });
  best.addEventListener('click', off, { once: true });
  return best;
}

/** An error shown where the button is, and scrolled to (the user's rule). */
function useErr() {
  const [err, setErr] = useState(null);
  const at = useRef(null);
  const show = (e, marks) => {
    const msg = e?.message ?? e;
    setErr(msg);
    setTimeout(() => {
      const root = at.current?.closest('.qt-action, .qt-raise, .pm-form');
      const field = (marks ?? [msg]).map((m) => markMissing(root, m)).find(Boolean);
      (field ?? at.current)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field?.querySelector('input:not([type=hidden]), textarea')?.focus({ preventScroll: true });
    }, 40);
  };
  return [err, show, () => setErr(null), at];
}

/** Every decision asks first (the user's rule): what, which request, whose, how much. */
function Confirm({ title, lines, ok = 'Yes', tone, busy, err, onOk, onCancel }) {
  return createPortal(
    <div className="modal-scrim qt-scrim-top" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal mt-modal" role="dialog" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2></div>
        <div className="modal-body">
          {lines.filter(Boolean).map((l, i) => <p key={i} className="pm-confirm-line">{l}</p>)}
          {err && <p className="mt-err" role="alert">{err}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="mt-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`mt-btn mt-btn-primary${tone === 'bad' ? ' qt-btn-bad' : ''}`} onClick={onOk} disabled={busy}>{busy ? 'Please wait…' : ok}</button>
        </div>
      </div>
    </div>, document.body);
}

/** A result: OK only, never a cross (the user's rule). */
function Notice({ title, onOk }) {
  return createPortal(
    <div className="modal-scrim qt-scrim-top" role="presentation">
      <div className="modal mt-modal qt-notice" role="alertdialog" aria-label={title}>
        <div className="modal-body"><span className="qt-notice-tick"><Icon d={I.check} size={26} /></span><p>{title}</p></div>
        <div className="modal-foot"><button type="button" className="mt-btn mt-btn-primary" onClick={onOk} autoFocus>OK</button></div>
      </div>
    </div>, document.body);
}

/** A press that asks first, then runs; the error stays in the box. */
function useAsk() {
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const box = ask && (
    <Confirm {...ask} busy={busy} err={err} onCancel={() => { setAsk(null); setErr(null); }}
             onOk={async () => {
               setBusy(true); setErr(null);
               try { const m = await ask.run(); setAsk(null); ask.after?.(m); } catch (e) { if (e.toField) setAsk(null); else setErr(e.message); } finally { setBusy(false); }
             }} />
  );
  return [setAsk, box];
}

function Thumb({ path, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let on = true; photoUrl(path).then((u) => { if (on) setUrl(u); }).catch(() => {}); return () => { on = false; }; }, [path]);
  const pdf = /\.pdf$/i.test(path);
  const retried = useRef(false);
  return (
    <button type="button" className="qt-thumb" onClick={() => url && (pdf ? window.open(url, '_blank', 'noopener') : onOpen())} aria-label="See the photo">
      {pdf ? <span className="qt-thumb-pdf">PDF</span> : url ? <img src={url} alt="" onError={() => { if (!retried.current) { retried.current = true; photoUrl(path, true).then(setUrl).catch(() => {}); } }} /> : <span className="qt-thumb-wait" />}
    </button>
  );
}

/** One group's photos (spare, equipment, slips); a press opens the viewer on that group only (the user, 14 Nov). */
function Photos({ paths, name }) {
  const [at, setAt] = useState(null);
  if (!paths?.length) return null;
  const pics = paths.filter((p) => !/\.pdf$/i.test(p));
  return (
    <>
      <div className="qt-thumbs">{paths.map((p) => <Thumb key={p} path={p} onOpen={() => setAt(pics.indexOf(p))} />)}</div>
      {at != null && at >= 0 && <Viewer paths={pics} start={at} name={name} onClose={() => setAt(null)} />}
    </>
  );
}

/**
  The photo viewer: ‹ › within the group (keys ← → and a swipe too), zoom by wheel, pinch or double press, drag to
  move when zoomed, ⤓ download (the user, 14 Nov).
*/
function Viewer({ paths, start, name, onClose }) {
  const [i, setI] = useState(start);
  const [urls, setUrls] = useState({});
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);
  const pinch = useRef(null);
  const swipe = useRef(null);
  const n = paths.length;
  const go = (d) => { setI((k) => (k + d + n) % n); setZ({ s: 1, x: 0, y: 0 }); };
  useEffect(() => {
    let on = true;
    [i, (i + 1) % n, (i - 1 + n) % n].forEach((k) => {
      if (urls[paths[k]]) return;
      photoUrl(paths[k]).then((u) => { if (on) setUrls((o) => ({ ...o, [paths[k]]: u })); }).catch(() => {});
    });
    return () => { on = false; };
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' && n > 1) go(1);
      else if (e.key === 'ArrowLeft' && n > 1) go(-1);
    };
    window.addEventListener('keydown', key);
    const was = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = was; };
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps

  const clamp = (s) => Math.min(5, Math.max(1, s));
  /** Zoom by k around the point (cx, cy) measured from the screen's centre. */
  const zoomAt = (k, cx, cy) => setZ((o) => {
    const s = clamp(o.s * k);
    if (s === 1) return { s: 1, x: 0, y: 0 };
    const f = s / o.s;
    return { s, x: cx - (cx - o.x) * f, y: cy - (cy - o.y) * f };
  });
  const fromCentre = (e) => ({ cx: e.clientX - window.innerWidth / 2, cy: e.clientY - window.innerHeight / 2 });
  const stage = useRef(null);
  useEffect(() => {
    const el = stage.current; if (!el) return undefined;
    const wheel = (e) => { e.preventDefault(); const { cx, cy } = fromCentre(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, cx, cy); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const down = (e) => {
    if (e.touches?.length === 2) {
      const [a, b] = e.touches;
      pinch.current = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s: z.s };
      drag.current = null; swipe.current = null; return;
    }
    const p = e.touches?.[0] ?? e;
    if (z.s > 1) drag.current = { x: p.clientX - z.x, y: p.clientY - z.y };
    else swipe.current = { x: p.clientX, y: p.clientY };
  };
  const move = (e) => {
    if (pinch.current && e.touches?.length === 2) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const s = clamp(pinch.current.s * (d / pinch.current.d));
      setZ((o) => (s === 1 ? { s: 1, x: 0, y: 0 } : { ...o, s }));
      return;
    }
    const p = e.touches?.[0] ?? e;
    if (drag.current) setZ((o) => ({ ...o, x: p.clientX - drag.current.x, y: p.clientY - drag.current.y }));
  };
  const up = (e) => {
    const p = e.changedTouches?.[0] ?? e;
    if (swipe.current && n > 1) {
      const dx = p.clientX - swipe.current.x, dy = p.clientY - swipe.current.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    }
    drag.current = null; pinch.current = null; swipe.current = null;
  };
  const dbl = (e) => { if (z.s > 1) setZ({ s: 1, x: 0, y: 0 }); else { const { cx, cy } = fromCentre(e); zoomAt(2.5, cx, cy); } };

  const save = async () => {
    const u = urls[paths[i]]; if (!u) return;
    setBusy(true);
    const ext = (paths[i].match(/\.(\w+)$/)?.[1] ?? 'jpg').toLowerCase();
    const file = `${name ? `${name}-` : ''}${i + 1}.${ext}`;
    try {
      const blob = await (await fetch(u)).blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = href; a.download = file; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
    } catch { window.open(u, '_blank', 'noopener'); } finally { setBusy(false); }
  };

  const url = urls[paths[i]];
  return createPortal(
    <div className="qt-lightbox" role="dialog" aria-label="Photo" onClick={(e) => { if (e.target === e.currentTarget && z.s === 1) onClose(); }}>
      <div ref={stage} className="qt-lb-stage" onClick={(e) => { if (e.target === e.currentTarget && z.s === 1) onClose(); }}
           onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={up}
           onTouchStart={down} onTouchMove={move} onTouchEnd={up} onDoubleClick={dbl}>
        {url ? <img src={url} alt="" draggable={false} className={z.s > 1 ? 'qt-lb-zoomed' : ''}
                    style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }} />
             : <span className="qt-thumb-wait" />}
      </div>
      <div className="qt-lb-bar">
        {n > 1 && <span className="qt-lb-count">{i + 1} / {n}</span>}
        <button type="button" className="mt-sheet-x qt-lb-btn" onClick={() => void save()} disabled={!url || busy} aria-label="Download" title="Download"><Icon d={I.down} size={19} /></button>
        <button type="button" className="mt-sheet-x qt-lb-btn" onClick={onClose} aria-label="Close" title="Close"><Icon d={I.x} size={20} /></button>
      </div>
      {n > 1 && <>
        <button type="button" className="qt-lb-arrow qt-lb-prev" onClick={() => go(-1)} aria-label="Previous photo"><Icon d={I.back} size={26} /></button>
        <button type="button" className="qt-lb-arrow qt-lb-next" onClick={() => go(1)} aria-label="Next photo"><Icon d={I.back} size={26} /></button>
      </>}
    </div>, document.body);
}

/** Camera or gallery, several at once; uploaded into the folder given. */
function PhotoAdd({ folder, paths, onChange, label, max = 6 }) {
  label = label ?? (max > 1 ? 'Add photos' : 'Photo'); // '' shows the camera alone
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const add = async (files) => {
    setBusy(true); setErr(null);
    try {
      const out = [...paths];
      for (const f of [...files].slice(0, max - paths.length)) out.push(await uploadPhoto(folder, f));
      onChange(out);
    } catch (e) { setErr(e.message); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <div className="qt-photo-add">
      <div className="qt-thumbs">
        {paths.map((p) => (
          <span key={p} className="qt-thumb-wrap">
            <Thumb path={p} onOpen={() => {}} />
            <button type="button" className="qt-thumb-x" onClick={() => onChange(paths.filter((x) => x !== p))} aria-label="Remove the photo"><Icon d={I.x} size={12} /></button>
          </span>
        ))}
        {paths.length < max && (
          <button type="button" className="qt-camera" onClick={() => input.current?.click()} disabled={busy} aria-label={label || 'Add a photo'}>
            <Icon d={I.camera} size={22} />{(label || busy) && <span>{busy ? 'Adding…' : label}</span>}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => e.target.files?.length && add(e.target.files)} />
      {err && <p className="mt-err qt-err" role="alert">{err}</p>}
    </div>
  );
}

const Field = ({ label, children, wide }) => <label className={`pm-in${wide ? ' qt-wide' : ''}`}><span>{label}</span>{children}</label>;
/** Rupees with Indian commas while typing (12,000 · 1,20,000); the number itself is what is kept. */
const commas = (x) => {
  if (x === '' || x == null) return '';
  const [a, b] = String(x).split('.');
  return `${a === '' ? '0' : Number(a).toLocaleString('en-IN')}${b !== undefined ? `.${b}` : ''}`;
};
function MoneyInput({ value, onChange, ...rest }) {
  return (
    <input type="text" inputMode="decimal" autoComplete="off" value={commas(value)} {...rest}
           onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, '').replace(/^(\d*\.\d{0,2}).*$/, '$1'))} />
  );
}

/** Tax % as one row of presses: 0 · 5 · 18. */
function TaxChips({ value, onChange }) {
  return (
    <div className="pm-in"><span>Tax %</span>
      <div className="qt-tax" role="radiogroup" aria-label="Tax %">
        {TAXES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={value !== '' && value != null && Number(value) === t} onClick={() => onChange(String(t))}>{t}<span className="qt-pct">%</span></button>
        ))}
      </div>
    </div>
  );
}

/** Vendor typed, or pressed from the vendors already used. */
function VendorInput({ value, onChange, label = 'Vendor' }) {
  return (
    <div className="pm-in"><span>{label}</span>
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </div>
  );
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));

function PeriodBar({ period, setPeriod, children }) {
  return (
    <div className="mt-period">
      <div className="segmented" role="tablist" aria-label="Period">
        {PERIODS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={period.id === id} onClick={() => setPeriod((p) => ({ ...p, id }))}>{label}</button>
        ))}
      </div>
      {period.id === 'custom' && (
        <div className="mt-range">
          <label className="mt-field"><span>From</span><input type="date" value={period.from} max={period.to || undefined} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} /></label>
          <label className="mt-field"><span>To</span><input type="date" value={period.to} min={period.from || undefined} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} /></label>
        </div>
      )}
      {children}
    </div>
  );
}

function Search({ value, onChange, placeholder }) {
  return (
    <div className="field-search mt-search qt-search">
      <Icon d={I.search} size={16} />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

const hay = (r) => [r.no, r.hospital, r.district, r.spare, r.part_no, r.equipment, r.make, r.model, r.serial, r.engineer_name, r.engineer_code,
  r.pr_no, r.po_no, r.track_no, r.item_code, r.ref_no, statusOf(r)].filter(Boolean).join(' ').toLowerCase();
const matches = (r, q) => q.trim().toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay(r).includes(w));

/* ============================================================== bell == */

function Bell({ onOpen }) {
  const [msgs, setMsgs] = useState([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => supabase?.rpc('my_app_messages', { p_app: 'bemmp' }).then(({ data }) => setMsgs((data ?? []).filter((m) => /[?&]q=/.test(m.url ?? '')))), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const unread = msgs.filter((m) => m.unread).length;
  const toggle = () => {
    setOpen((o) => !o);
    if (!open && unread) supabase.rpc('mark_app_messages_read', { p_app: 'bemmp' }).then(() => setMsgs((m) => m.map((x) => ({ ...x, unread: false }))));
  };
  return (
    <div className="qt-bell">
      <button type="button" className="icon-toggle" onClick={toggle} aria-label="Messages">
        <Icon d={I.bell} />{unread > 0 && <span className="qt-bell-n">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && createPortal(
        <div className="qt-bell-scrim" onClick={() => setOpen(false)} role="presentation">
          <div className="qt-bell-list" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Messages">
            <h3>Messages</h3>
            {!msgs.length ? <p className="empty-inline">No messages.</p> : (
              <ul>{msgs.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => { setOpen(false); const q = new URL(m.url ?? '', window.location.origin).searchParams.get('q'); if (q) onOpen(q); }}>
                    <strong>{m.title}</strong><span>{m.body}</span><time>{whenText(m.created_at)}</time>
                  </button>
                </li>
              ))}</ul>
            )}
          </div>
        </div>, document.body)}
    </div>
  );
}

/* ============================================================== cards == */

/** One photo on a card, small, so the spare is known at a glance. */
function CardPhoto({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let on = true; if (path) photoUrl(path).then((u) => { if (on) setUrl(u); }).catch(() => {}); return () => { on = false; }; }, [path]);
  if (!path) return null;
  const retried = useRef(false);
  const retry = (e) => {
    if (retried.current) { e.currentTarget.parentElement.style.display = 'none'; return; }
    retried.current = true; photoUrl(path, true).then(setUrl).catch(() => {});
  };
  return <span className="qt-card-photo">{url && <img src={url} alt="" loading="lazy" onError={retry} />}</span>;
}

function Card({ r, targets, now, onOpen, picked, onPick, children }) {
  const { pools } = useContext(QtCtx);
  return (
    <li className="qt-card" data-tone={stepOf(r.step).tone} data-role={roleOfStep(r.step) ?? undefined} data-picked={picked ? 'true' : undefined}>
      {onPick && (
        <button type="button" className="qt-pick" aria-pressed={Boolean(picked)} onClick={() => onPick(r.id)} aria-label={`Select ${r.no}`}>
          {picked && <Icon d={I.check} size={16} />}
        </button>
      )}
      <button type="button" className="qt-card-body" onClick={() => onOpen(r.id)}>
        <span className="qt-card-top"><span className="qt-no">{r.no}{r.ref_no && <small className="qt-ref">{r.ref_no}</small>}</span><StepBadge r={r} /><PendingChip r={r} now={now} /><Clock r={r} targets={targets} now={now} /></span>
        <span className="qt-card-spare">{r.spare} <b>× {r.approved_qty ?? r.qty}</b></span>
        <span className="qt-card-line"><span className="qt-card-step">{statusOf(r)} · </span>{[r.equipment, r.hospital ?? (r.kind === 'stock' ? 'Stock' : null)].filter(Boolean).join(' · ')}</span>
        {!r.mine && !r.done && (acceptPending(r)
          ? <span className="qt-card-with">Waiting for <b>{orNames(acceptBy(r, pools)) || stepOf(r.step).who}</b> to accept</span>
          : <span className="qt-card-with">With {stepOf(r.step).who} · {r.accepted_by_name ?? 'not accepted yet'}</span>
        )}
        {r.transferred_from_name && !r.done && <span className="qt-card-moved"><Icon d={I.swap} size={12} />Transferred from {r.transferred_from_name}</span>}
        <span className="qt-card-foot">{r.engineer_name}{r.engineer_code ? ` (${r.engineer_code})` : ''} · {dayText(r.created_at)}</span>
        <CardPhoto path={r.photos?.find((x) => !/\.pdf$/i.test(x)) ?? r.equipment_photo} />
      </button>
      {children}
    </li>
  );
}

/* =============================================================== to do == */

function Todo({ me, list, targets, now, onOpen, onDone, sub }) {
  const [sel, setSel] = useState(new Set());
  const [only, setOnly] = useState('');
  const [ask, box] = useAsk();
  const stop = () => setSel(new Set());
  /* Sub-tabs (the user, 11 Nov): To accept | With you, one list at a time; opens on To accept when anything waits. */
  const isWaiting = (r) => !r.accepted_at && !NO_ACCEPT.has(r.step);
  const tab = sub;
  useEffect(() => { setOnly(''); setSel(new Set()); }, [sub]);
  const pool = list;
  const steps = useMemo(() => {
    const m = new Map(); for (const r of pool) m.set(r.step, (m.get(r.step) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [pool]);
  const step = steps.some(([k]) => k === only) ? only : '';
  const sorted = useMemo(() => [...pool].filter((r) => !step || r.step === step).sort((a, b) => {
    const ca = clockOf(a, targets, now); const cb = clockOf(b, targets, now);
    return (cb?.secs ?? 0) - (ca?.secs ?? 0);
  }), [pool, targets, now, step]);
  const waiting = tab === 'accept' ? sorted : [];
  const working = tab === 'mine' ? sorted : [];
  const approvable = working.filter((r) => me.role === 'team_lead' && r.step === 'tl_review');
  const pick = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = sorted.filter((r) => sel.has(r.id));
  const canApprove = chosen.length > 0 && chosen.every((r) => r.step === 'tl_review' && r.accepted_at);
  const canAccept = chosen.length > 0 && chosen.every((r) => !r.accepted_at && !NO_ACCEPT.has(r.step));
  const names = (rs) => `${rs.length} ${rs.length === 1 ? 'request' : 'requests'}: ${rs.slice(0, 6).map((r) => r.no).join(', ')}${rs.length > 6 ? '…' : ''}`;

  const acceptOne = (r) => ask({
    title: `Accept ${r.no}?`, lines: [`${r.spare} × ${r.qty} · ${r.hospital ?? 'Stock'}`, `${stepOf(r.step).label} · ${person(r.engineer_name, r.engineer_code)}`],
    ok: 'Accept', run: () => accept([r.id]), after: () => { onDone(`${r.no} accepted.`); onOpen(r.id); },
  });

  return (
    <div className="qt-todo">
      {!sorted.length && <p className="empty-inline pm-empty">{tab === 'accept' ? 'Nothing to accept.' : 'Nothing with you.'}</p>}
      {steps.length > 1 && (
        <div className="qt-chips" role="tablist" aria-label="Step">
          <button type="button" role="tab" className="qt-step-chip" aria-selected={!step} onClick={() => { setOnly(''); stop(); }}>All <b>{pool.length}</b></button>
          {steps.map(([k, n]) => (
            <button key={k} type="button" role="tab" className="qt-step-chip" data-role={roleOfStep(k) ?? undefined} aria-selected={step === k}
                    onClick={() => { setOnly(k); stop(); }}>{stepOf(k).label} <b>{n}</b></button>
          ))}
        </div>
      )}
      {waiting.length > 0 && (
        <section>
          <ul className="qt-cards">
            {waiting.map((r) => (
              <Card key={r.id} r={r} targets={targets} now={now} onOpen={onOpen} picked={sel.has(r.id)} onPick={waiting.length > 1 ? pick : null}>
                <div className="qt-card-acts"><button type="button" className="mt-go qt-accept" onClick={() => acceptOne(r)}>Accept</button></div>
              </Card>
            ))}
          </ul>
        </section>
      )}
      {working.length > 0 && (
        <section>
          <ul className="qt-cards">
            {working.map((r) => (
              <Card key={r.id} r={r} targets={targets} now={now} onOpen={onOpen}
                    picked={sel.has(r.id)} onPick={approvable.length > 1 && approvable.includes(r) ? pick : null}>
                {r.step === 'tl_review' && me.role === 'team_lead' ? (
                  <div className="qt-card-acts">
                    <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => onOpen(r.id, 'reject')}>Reject</button>
                    <button type="button" className="mt-btn" onClick={() => onOpen(r.id, 'send_back')}>Send back</button>
                    <button type="button" data-role="coordinator" className="mt-go" onClick={() => ask({
                      title: `Approve ${r.no}?`, lines: [`${r.spare} × ${r.qty} · ${r.hospital}`, person(r.engineer_name, r.engineer_code),
                        (r.category ?? '').toUpperCase() === 'CAMC' ? 'CAMC: straight to PR.' : 'It goes to the Coordinator.'], ok: 'Approve',
                      run: () => tlApprove([r.id]), after: () => onDone(`${r.no} approved.`),
                    })}>Approve</button>
                  </div>
                ) : (
                  <div className="qt-card-acts"><button type="button" className="mt-btn qt-next" onClick={() => onOpen(r.id)}>{nextLabel(r)}</button></div>
                )}
              </Card>
            ))}
          </ul>
        </section>
      )}
      {sel.size > 0 && (
        <div className="pm-bar qt-bar">
          <span className="qt-bar-n">{sel.size} selected</span>
          <button type="button" className="mt-btn qt-bar-x" onClick={stop}>Clear</button>
          {canAccept && (
            <button type="button" className="mt-go qt-bar-go" onClick={() => ask({
              title: `Accept ${chosen.length} requests?`, lines: [names(chosen)], ok: `Accept ${chosen.length}`,
              run: () => accept(chosen.map((r) => r.id)), after: (n) => { stop(); onDone(`${n} accepted.`); },
            })}>Accept {chosen.length}</button>
          )}
          {canApprove && (
            <button type="button" className="mt-go qt-bar-go" onClick={() => ask({
              title: `Approve ${chosen.length} requests?`, lines: [names(chosen), 'Each goes to the Coordinator (CAMC straight to PR).'], ok: `Approve ${chosen.length}`,
              run: () => tlApprove(chosen.map((r) => r.id)), after: (n) => { stop(); onDone(`${n} approved.`); },
            })}>Approve {chosen.length}</button>
          )}
          {!canAccept && !canApprove && <span className="qt-bar-note">Pick requests at the same step</span>}
        </div>
      )}
      {box}
    </div>
  );
}

function nextLabel(r) {
  return {
    tl_review: 'Review', eng_fix: 'Correct', tl_clarify: 'Answer', coord_initial: 'Check', purchase_rates: 'Give rates', pv: 'Verify',
    coord_pr: 'PR', on_hold: 'On hold', purchase_dispatch: 'PO and dispatch', coord_decide: 'Decide',
    on_hold_dispatch: 'On hold', receipt: 'Confirm receipt', observation: 'Confirm', purchase_faulty: 'Decide',
    return_dispatch: 'Send back', purchase_replacement: 'Send replacement',
  }[r.step] ?? 'Open';
}

/* ============================================================ requests == */

/** One Requests tab (the user, 11 Nov): To accept · With you · With others · Closed · All. */
function Work({ me, list, mine, targets, now, period, setPeriod, onOpen, onDone, view, setView }) {
  const isWaiting = (r) => !r.accepted_at && !NO_ACCEPT.has(r.step);
  const nWait = mine.filter(isWaiting).length;
  const nWork = mine.length - nWait;
  // A Coordinator or Purchase person sees the role's own apart from everybody else's (the user, 12 Nov).
  const split = me.role === 'coordinator' || me.role === 'purchase';
  const inRole = (r) => split && roleOfReq(r) === me.role;
  const nTeam = list.filter((r) => !r.done && !r.mine && inRole(r)).length;
  const nOthers = list.filter((r) => !r.done && !r.mine && !inRole(r)).length;
  // An observer (or a viewer) never holds a request: Open · Closed · All only (the user, 11 Nov).
  const watcher = me.role === 'observer' || me.role === 'viewer';
  const nOpen = list.filter((r) => !r.done).length;
  const v = view ?? (watcher ? 'open' : nWait ? 'accept' : 'mine'); // To accept when anything waits, else With you (the user, 11 Nov)
  const views = watcher
    ? [['open', 'Open', nOpen], ['done', 'Closed'], ['all', 'All']]
    : [['accept', 'To accept', nWait], ['mine', 'With you', nWork], ...(split ? [['team', me.role === 'coordinator' ? 'With Coordinators' : 'With Purchase', nTeam]] : []), ['others', 'With others', nOthers], ['done', 'Closed'], ['all', 'All']];
  /* Phone: one dropdown, so no view hides past the edge (the user, 12 Nov: option C); beside Sort where there is one. */
  const pick = (
    <Picker value={v} title="Requests" onChange={setView}
            options={views.map(([id, label, n]) => ({ value: id, label: <span className="qt-view-opt" data-view={id}><i aria-hidden="true" />{label}{n != null ? <b> · {n}</b> : null}</span> }))} />
  );
  return (
    <div className="qt-work">
      <PeriodBar period={period} setPeriod={setPeriod} />
      <div className="segmented qt-views" role="tablist" aria-label="Requests">
        {views.map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={v === id} data-view={id} data-hot={n ? 'true' : undefined}
                  onClick={() => setView(id)}><i aria-hidden="true" />{label}{n != null ? <b> {n}</b> : null}</button>
        ))}
      </div>
      {v === 'accept' || v === 'mine'
        ? <><div className="qt-views-pick">{pick}</div>
            <Todo me={me} list={mine.filter((r) => (v === 'accept') === isWaiting(r))} targets={targets} now={now} onOpen={onOpen} onDone={onDone} sub={v} /></>
        : <Requests list={list} targets={targets} now={now} onOpen={onOpen} show={v} viewPick={pick} myRole={split ? me.role : null} />}
    </div>
  );
}

const SORTS = [
  { value: 'new', label: 'Newest first' }, { value: 'old', label: 'Oldest first' }, { value: 'wait', label: 'Waiting longest' },
];

function Requests({ list, targets, now, onOpen, show, viewPick, myRole }) {
  const [q, setQ] = useState('');
  const [step, setStep] = useState('');
  const [sort, setSort] = useState('new');
  const [role, setRole] = useState('');
  // Pending with a role (the user, 11 Nov): open requests by the role they now wait with.
  const roleOf = roleOfReq;
  // The filters count only what this tab shows (the user, 12 Nov: With Purchase listed every role).
  const inView = (r) => show === 'all' || (show === 'done' ? r.done : show === 'open' ? !r.done
    : !r.done && !r.mine && (show === 'team' ? roleOf(r) === myRole : !myRole || roleOf(r) !== myRole));
  const base = useMemo(() => list.filter(inView),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [list, show, myRole]);
  useEffect(() => { setRole(''); setStep(''); }, [show]);
  const roles = useMemo(() => {
    const m = new Map(); for (const r of base) if (!r.done && roleOf(r)) m.set(roleOf(r), (m.get(roleOf(r)) ?? 0) + 1);
    return [{ value: '', label: 'Pending with anyone' }, ...ROLE_ORDER.filter((k) => m.has(k)).map((k) => ({ value: k, label: `${ROLE_NAME[k]} · ${m.get(k)}` }))];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  const steps = useMemo(() => {
    const m = new Map(); for (const r of base) m.set(r.step, (m.get(r.step) ?? 0) + 1);
    return [{ value: '', label: 'Every step' }, ...[...m.entries()].map(([k, n]) => ({ value: k, label: `${stepOf(k).label} · ${n}` }))];
  }, [base]);
  const shown = useMemo(() => {
    const out = base.filter((r) => (!step || r.step === step) && (!role || (!r.done && roleOf(r) === role)) && (!q || matches(r, q)));
    if (sort === 'old') out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    else if (sort === 'wait') out.sort((a, b) => (clockOf(b, targets, now)?.secs ?? -1) - (clockOf(a, targets, now)?.secs ?? -1));
    else out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, step, role, q, sort, targets, now]);
  return (
    <div className="mt-tickets qt-requests">
      {viewPick && <div className="qt-view-sort">{viewPick}<Picker value={sort} options={SORTS} onChange={setSort} title="Sort" /></div>}
      <div className="mt-filters qt-filters">
        <Search value={q} onChange={setQ} placeholder="Request no, hospital, spare, engineer" />
        {roles.length > 2 && <Picker value={role} options={roles} onChange={setRole} title="Pending with" />}
        <Picker value={step} options={steps} onChange={setStep} title="Step" />
        <span className="qt-sort-wide"><Picker value={sort} options={SORTS} onChange={setSort} title="Sort" /></span>
      </div>
      {!shown.length ? <p className="empty-inline pm-empty">No request here.</p> : (
        <ul className="qt-cards">{shown.map((r) => <Card key={r.id} r={r} targets={targets} now={now} onOpen={onOpen} />)}</ul>
      )}
    </div>
  );
}

/* ======================================================= request sheet == */

function RequestSheet({ id, preset, me, targets, now, onClose, onChanged, onFinished }) {
  const [notice, setNotice] = useState(null);
  const [r, setR] = useState(undefined);
  const [big, setBig] = useState(null);
  const load = useCallback(() => loadOne(id).then(setR).catch(() => setR(null)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    const was = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = was; };
  }, [onClose]);
  const changed = (msg) => { onChanged(msg); load(); };
  /** A form done: the result with OK, then back to To do (With you when it is still yours). */
  const finish = async (msg) => {
    const fresh = await loadOne(id).catch(() => null);
    setNotice({ msg, mine: Boolean(fresh?.mine && !fresh?.done) });
  };

  return (
    <div className="mt-scrim" onClick={onClose}>
      <div className="mt-sheet qt-sheet" role="dialog" aria-modal="true" aria-label={r?.no ?? 'Request'} onClick={(e) => e.stopPropagation()}>
        <header className="mt-sheet-head">
          <div className="mt-sheet-title">
            {r && <span className="qt-card-top"><StepBadge r={r} /><PendingChip r={r} withRole />{r.mine && <Clock r={r} targets={targets} now={now} />}</span>}
            <h2>{r?.no ?? ' '}{r?.ref_no && <small className="qt-ref">{r.ref_no}</small>}</h2>
            {r && <p>{r.spare} × {r.approved_qty ?? r.qty}{r.hospital ? ` · ${r.hospital}` : ''}</p>}
            {r?.transferred_from_name && !r.done && <span className="qt-card-moved"><Icon d={I.swap} size={12} />Transferred from {r.transferred_from_name}</span>}
          </div>
          <div className="qt-sheet-acts">
            <button type="button" className="mt-sheet-x" onClick={onClose} aria-label="Close"><Icon d={I.x} size={20} /></button>
            {r && <Transfer r={r} me={me} onDone={changed} />}
          </div>
        </header>
        <div className="mt-sheet-body">
          {r === undefined ? <div className="loader" aria-hidden="true" /> : r === null ? <p>This request is not one you can see.</p> : (
            <div className="qt-sheet-cols" data-acting={r.mine ? 'true' : undefined}>
              <div className="qt-sheet-col">
              {r.mine && <Action r={r} me={me} preset={preset} onDone={changed} onFinish={finish} />}
              {!r.mine && !r.done && (
                <p className="qt-with">{r.accepted_by_name
                  ? `With ${stepOf(r.step).who} · ${r.accepted_by_name} accepted ${whenText(r.accepted_at)}`
                  : `Sent to ${stepOf(r.step).who} ${agoText(r.step_since, now)} · not accepted yet`}</p>
              )}
              {r.done && r.close_note && <p className="qt-closed-note">{r.close_note}</p>}
              <Reopen r={r} me={me} onDone={changed} />
              {!r.mine && <Facts r={r} now={now} />}
              </div>
              <div className="qt-sheet-col">
              {r.mine && <Facts r={r} now={now} />}
              <Quotes r={r} onlyPicked={me.role === 'engineer'} />
              {(r.quote_file || r.quote_signed) && (
                <section className="mt-card-block">
                  <span className="mt-block-label">Quotation{r.quote_date ? ` · ${r.quote_date.split('-').reverse().join('-')}` : ''}{r.quote_ok === true ? ' · approved' : r.quote_ok === false ? ' · not approved' : ''}</span>
                  <Photos paths={[r.quote_file, r.quote_signed].filter(Boolean)} />
                </section>
              )}
              {(r.track_photo || r.return_track_photo) && (
                <section className="mt-card-block">
                  <span className="mt-block-label">Slips</span>
                  <Photos paths={[r.track_photo, r.return_track_photo].filter(Boolean)} name={`${r.no}-slip`} />
                </section>
              )}
              {/* Spare and equipment photos apart, side by side in one block (the user, 11 Nov). */}
              {(r.photos?.length > 0 || r.equipment_photos?.length > 0 || r.equipment_photo) && (
                <section className="mt-card-block">
                  <div className="qt-photo-groups">
                    {r.photos?.length > 0 && <div><span className="mt-block-label">Spare photos</span><Photos paths={r.photos} name={`${r.no}-spare`} /></div>}
                    {(r.equipment_photos?.length > 0 || r.equipment_photo) && (
                      <div><span className="mt-block-label">Equipment photos</span><Photos paths={r.equipment_photos?.length ? r.equipment_photos : [r.equipment_photo]} name={`${r.no}-equipment`} /></div>
                    )}
                  </div>
                </section>
              )}
              <RoleTime r={r} now={now} />
              <Timeline r={r} now={now} onDone={changed} />
              </div>
            </div>
          )}
        </div>
      </div>
      {big && null}
      {notice && <Notice title={notice.msg} onOk={() => onFinished(notice.mine)} />}
    </div>
  );
}

/** "just now", "2 min ago", "3 h ago", "2 days ago". */
function agoText(at, now) {
  const m = Math.floor((now - Date.parse(at)) / 60000);
  if (!Number.isFinite(m) || m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** Raised to closed, or to now while open (the user, 11 Nov). */
const totalTat = (r, now) => spanText(Math.max(0, ((r.closed_at ? Date.parse(r.closed_at) : now) - Date.parse(r.created_at)) / 1000));

function Fact({ label, children, sub }) {
  if (children == null || children === '') return null;
  return (
    <div className="mt-fact"><span className="mt-fact-text"><span className="mt-fact-label">{label}</span><span className="mt-fact-value">{children}</span>{sub && <span className="mt-fact-sub">{sub}</span>}</span></div>
  );
}

function Facts({ r, now }) {
  return (
    <section className="mt-facts qt-facts">
      <Fact label={r.kind === 'stock' ? 'For' : 'Engineer'} sub={r.team_lead_name ? `Team Lead ${r.team_lead_name}` : null}>{person(r.engineer_name, r.engineer_code)}</Fact>
      <Fact label="Hospital" sub={[r.district, r.state, r.category].filter(Boolean).join(' · ')}>{r.hospital ?? (r.kind === 'stock' ? 'Stock' : null)}</Fact>
      <Fact label="Equipment" sub={[r.make, r.model, r.serial && `Serial ${r.serial}`].filter(Boolean).join(' · ')}>{r.equipment}</Fact>
      <Fact label="Spare" sub={[r.part_no && `Part ${r.part_no}`, r.item_code && `Item ${r.item_code}`].filter(Boolean).join(' · ')}>{r.spare} × {r.qty}{r.approved_qty && r.approved_qty !== r.qty ? ` (approved ${r.approved_qty})` : ''}</Fact>
      <Fact label="Raised" sub={r.raised_by_name && r.raised_by_name !== r.engineer_name ? `by ${r.raised_by_name}` : null}>{whenText(r.created_at)}</Fact>
      <Fact label="Delivery address">{r.delivery_address}</Fact>
      <Fact label="PR" sub={dayText(r.pr_date)}>{r.pr_no}</Fact>
      <Fact label="PO" sub={[dayText(r.po_date), r.vendor].filter(Boolean).join(' · ')}>{r.po_no}</Fact>
      <Fact label="Sent" sub={r.dispatched_at ? whenText(r.dispatched_at) : null}>{r.track_no ? `${r.track_mode} · ${r.track_no}` : null}</Fact>
      <Fact label="Received" sub={r.received_on ? dayText(r.received_on) : null}>{r.received_qty ? `${r.received_qty} received · ${r.used_qty} used · ${r.faulty_qty} faulty` : null}</Fact>
      <Fact label="Faulty" sub={r.faulty_note}>{r.faulty_kind ? `${r.faulty_kind}${r.faulty_action ? ` · ${r.faulty_action}` : ''}` : null}</Fact>
      <Fact label="Return" sub={r.return_address}>{r.return_track_no ? `${r.return_track_mode} · ${r.return_track_no}` : null}</Fact>
      <Fact label="Coordinator">{r.coord_name}</Fact>
      <Fact label="Purchase">{r.purchase_name}</Fact>
      <Fact label="PV">{r.pv_name}</Fact>
      <Fact label="Total TAT" sub={r.done ? `Closed ${whenText(r.closed_at)}` : 'Still open'}>{totalTat(r, now ?? Date.now())}</Fact>
    </section>
  );
}

/** Original and compatible side by side, total with tax; the picked one marked (idea 9). */
function QuoteCard({ kind, vendor, rate, tax, photo, picked, onPick, saves }) {
  if (rate == null && !vendor) return null;
  const total = withTax(rate, tax);
  const body = (
    <>
      <span className="qt-quote-kind">{kind}{picked && <span className="qt-quote-mark"><Icon d={I.check} size={13} /> Picked</span>}</span>
      <span className="qt-quote-vendor">{vendor}</span>
      <span className="qt-quote-total">{money(total)}</span>
      <span className="qt-quote-sub">{money(rate)} + {Number(tax ?? 0)}% tax</span>
      {saves && <span className="qt-save">Saves {money(saves.by)} · {saves.pct}%</span>}
      {photo && <Photos paths={[photo]} />}
    </>
  );
  return onPick
    ? <button type="button" className="qt-quote is-pick" data-picked={picked ? 'true' : undefined} onClick={onPick}>{body}</button>
    : <div className="qt-quote" data-picked={picked ? 'true' : undefined}>{body}</div>;
}

function Quotes({ r, onPick, onlyPicked }) {
  if (r.orig_rate == null && r.comp_rate == null) return null;
  /* Engineers see only what was bought, never the other price (the user, 11 Nov). */
  if (onlyPicked) {
    if (!r.picked) return null;
    const o = r.picked === 'original';
    return (
      <section className="mt-card-block">
        <span className="mt-block-label">Bought</span>
        <div className="qt-quotes">
          <QuoteCard kind={o ? 'Original' : 'Compatible'} vendor={o ? r.orig_vendor : r.comp_vendor} rate={o ? r.orig_rate : r.comp_rate}
                     tax={o ? r.orig_tax : r.comp_tax} photo={o ? r.orig_photo : r.comp_photo} />
        </div>
      </section>
    );
  }
  const o = r.orig_rate != null ? withTax(r.orig_rate, r.orig_tax) : null;
  const c = r.comp_rate != null ? withTax(r.comp_rate, r.comp_tax) : null;
  const save = o > 0 && c > 0 && o !== c ? { by: Math.abs(o - c), pct: Math.round((Math.abs(o - c) / Math.max(o, c)) * 100) } : null;
  return (
    <section className="mt-card-block">
      <span className="mt-block-label">{r.sap && r.comp_rate == null ? 'SAP rate' : 'Quotes'}</span>
      <div className="qt-quotes">
        <QuoteCard kind={r.sap ? 'SAP · original' : 'Original'} vendor={r.orig_vendor} rate={r.orig_rate} tax={r.orig_tax} photo={r.orig_photo}
                   picked={r.picked === 'original'} onPick={onPick && (() => onPick('original'))} saves={save && o < c ? save : null} />
        <QuoteCard kind="Compatible" vendor={r.comp_vendor} rate={r.comp_rate} tax={r.comp_tax} photo={r.comp_photo}
                   picked={r.picked === 'compatible'} onPick={onPick && (() => onPick('compatible'))} saves={save && c < o ? save : null} />
      </div>
      {(r.warranty || r.lead_days) && (
        <div className="qt-chips qt-quote-chips">
          {r.lead_days != null && r.lead_days !== '' && <span className="qt-info-chip">Lead time {r.lead_days} {Number(r.lead_days) === 1 ? 'day' : 'days'}</span>}
          {r.warranty && <span className="qt-info-chip">Warranty {r.warranty}</span>}
        </div>
      )}
      {r.purchase_note && <p className="qt-quote-more">{r.purchase_note}</p>}
    </section>
  );
}

/** The time from one step to the next, as Revive Lab writes it on its thread: "<1m", "2h 5m", "3d 4h". */
function gapLabel(ms) {
  const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
  if (!Number.isFinite(ms) || ms < MIN) return '<1m';
  const d = Math.floor(ms / DAY); const h = Math.floor((ms % DAY) / HOUR); const m = Math.floor((ms % HOUR) / MIN);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
function gapWords(ms) {
  const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
  if (!Number.isFinite(ms) || ms < MIN) return 'under a minute';
  const d = Math.floor(ms / DAY); const h = Math.floor((ms % DAY) / HOUR); const m = Math.floor((ms % HOUR) / MIN);
  const part = (n, unit) => (n > 0 ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
  return [part(d, 'day'), part(h, 'hour'), d > 0 ? '' : part(m, 'minute')].filter(Boolean).join(' ');
}

/**
 * Time by role (the user, 11 Nov): how long the request sat with each role, from the moment it was sent to
 * that role until it moved on, and its share of the total. Roles it never reached are left out; observers hold nothing.
 */
const ROLE_ORDER = ['engineer', 'team_lead', 'coordinator', 'purchase', 'pv'];
function roleTimes(r, now) {
  // Before the move from the old tracker only some steps are known, so time by role counts from the move on.
  const cut = (r.events ?? []).find((e) => e.action === 'Moved from the old tracker')?.at;
  const moves = (r.events ?? []).filter((e) => e.to_step && e.to_step !== e.step && (!cut || e.at >= cut));
  const end = r.closed_at ? Date.parse(r.closed_at) : now;
  const out = new Map();
  moves.forEach((e, i) => {
    const step = e.to_step;
    if (!STEPS[step]?.who) return;
    const role = step === 'return_dispatch' && r.kind === 'stock' ? 'coordinator' : roleOfStep(step);
    if (!role) return;
    const from = Date.parse(e.at);
    const to = moves[i + 1] ? Date.parse(moves[i + 1].at) : end;
    out.set(role, (out.get(role) ?? 0) + Math.max(0, to - from));
  });
  const keys = ROLE_ORDER.filter((k) => out.has(k));
  const total = keys.reduce((a, k) => a + out.get(k), 0);
  // Shares that add up: each part rounded so the parts make the whole (the user, 11 Nov: 6 + 2 + 123 + 5 must be the total).
  const fair = (whole, unit) => {
    const raw = keys.map((k) => (out.get(k) / unit)); const base = raw.map(Math.floor);
    let left = Math.round(whole) - base.reduce((a, b) => a + b, 0);
    raw.map((x, i) => [x - base[i], i]).sort((x, y) => y[0] - x[0]).forEach(([, i]) => { if (left > 0) { base[i] += 1; left -= 1; } });
    return base;
  };
  const unit = total >= 86400000 ? 3600000 : 60000; // whole hours past a day, as spanText shows them
  const spans = fair(Math.floor(((r.closed_at ? Date.parse(r.closed_at) : now) - Date.parse(r.created_at)) / unit), unit);
  const pcts = total ? fair(100, total / 100) : keys.map(() => 0);
  return keys.map((k, i) => ({ role: k, secs: spans[i] * unit / 1000, pct: pcts[i] }));
}

function RoleTime({ r, now }) {
  const rows = roleTimes(r, now ?? Date.now());
  if (!rows.length) return null;
  return (
    <section className="mt-card-block">
      <span className="mt-block-label qt-tl-head">Time by role<span className="qt-tl-total">Total {totalTat(r, now ?? Date.now())}</span></span>
      <ul className="qt-roletime">
        {rows.map((x) => (
          <li key={x.role} data-role={x.role}>
            <span className="qt-rt-name">{ROLE_NAME[x.role]}</span>
            <span className="qt-rt-bar"><i style={{ width: `${Math.max(2, x.pct)}%` }} /></span>
            <span className="qt-rt-val">{spanText(x.secs)} · <b>{x.pct}%</b></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every step with who, when and how long (idea 3), and the conversation on it (idea 11). */
function Timeline({ r, now, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, show, clear, at] = useErr();
  const send = async () => {
    if (!note.trim()) { show('Write the note.'); return; }
    setBusy(true); clear();
    try { await addNote(r.id, note.trim()); setNote(''); onDone('Note added.'); } catch (e) { show(e); } finally { setBusy(false); }
  };
  return (
    <section className="mt-card-block">
      <span className="mt-block-label">Timeline</span>
      <ol className="qt-timeline">
        {r.events.map((e, i) => {
          const next = r.events[i + 1];
          const gap = next ? Math.max(0, Date.parse(next.at) - Date.parse(e.at)) : null;
          return (
            <li key={i} data-role={e.by_role ?? undefined} data-next={next ? 'true' : undefined}>
              <span className="qt-tl-dot" />
              {gap !== null && <span className="qt-tl-gap" data-long={gap >= 86400000 ? 'true' : undefined} title={`${gapWords(gap)} to the next step`}>{gapLabel(gap)}</span>}
              <div className="qt-tl-text">
                <span className="qt-tl-what">{ACTIONS[e.action] ?? e.action}{e.action === 'transfer' ? ` · ${e.by_name ?? ''} → ${e.to_name ?? ''}` : e.to_step && e.to_step !== e.step && STEPS[e.to_step] ? ` → ${STEPS[e.to_step].who ?? STEPS[e.to_step].label}` : e.action === 'accept' && STEPS[e.step]?.who ? ` · ${STEPS[e.step].who}` : e.action !== 'raise' && e.action !== 'note' && STEPS[e.step] ? ` · ${STEPS[e.step].label}` : ''}</span>
                <span className="qt-tl-who">{person(e.by_name, e.by_code)} · {whenText(e.at)}</span>
                {e.note && <span className="qt-tl-note">{e.note}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="qt-note-row">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a note" onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button type="button" className="mt-btn" onClick={send} disabled={busy}>Send</button>
      </div>
      <Err text={err} at={at} />
    </section>
  );
}

/** Hand my Coordinator or Purchase step to another of the role (the user, 12 Nov: Namitha on leave transfers to Suhail). */
function Transfer({ r, me, onDone }) {
  const { pools } = useContext(QtCtx);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const role = roleOfStep(r.step);
  const holder = role === 'coordinator' ? r.coord_id : role === 'purchase' ? r.purchase_id : null;
  if (r.done || !holder || holder !== me.id) return null;
  const test = /- *test/i.test(r.engineer_name ?? '');
  const people = (pools?.[role] ?? []).filter((p) => p.id !== me.id && p.test === test);
  if (!people.length) return null;
  const roleName = role === 'coordinator' ? 'Coordinator' : 'Purchase';
  const name = people.find((p) => p.id === to)?.name;
  const close = () => { if (!busy) { setOpen(false); setErr(null); } };
  const go = async () => {
    if (!to) { setErr('Choose who to transfer it to.'); return; }
    setBusy(true); setErr(null);
    try { await transfer(r.id, to, why.trim()); setOpen(false); setTo(''); setWhy(''); onDone(`${r.no} transferred to ${name}.`); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="mt-btn qt-transfer-btn" onClick={() => setOpen(true)}><Icon d={I.swap} size={16} />Transfer</button>
      {open && createPortal(
        <div className="modal-scrim qt-scrim-top" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="modal mt-modal" role="dialog" aria-label={`Transfer ${r.no}?`}>
            <div className="modal-head"><h2>Transfer {r.no}?</h2></div>
            <div className="modal-body qt-transfer-body">
              <div className="qt-transfer-field"><span>To</span>
                <Picker value={to} onChange={(v) => { setTo(v); setErr(null); }} title="To" placeholder={`Choose a ${roleName === 'Purchase' ? 'Purchase person' : 'Coordinator'}`}
                        options={people.map((p) => ({ value: p.id, label: `${p.name} · ${roleName}` }))} />
              </div>
              <label className="qt-transfer-field"><span>Reason</span>
                <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="On leave today" />
              </label>
              {err && <p className="mt-err" role="alert">{err}</p>}
            </div>
            <div className="modal-foot">
              <button type="button" className="mt-btn" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="mt-btn mt-btn-primary" onClick={go} disabled={busy}>{busy ? 'Please wait…' : name ? `Transfer to ${name.split(' ')[0]}` : 'Transfer'}</button>
            </div>
          </div>
        </div>, document.body)}
    </>
  );
}

function Reopen({ r, me, onDone }) {
  const [ask, box] = useAsk();
  const [why, setWhy] = useState('');
  const [err, show, clear, at] = useErr();
  const can = (r.step === 'quotation_only' && me.role === 'coordinator') || (r.step === 'completed' && r.mine === false && r.engineer_id && me.role !== 'coordinator' && r.engineer_code);
  if (!can) return null;
  return (
    <section className="mt-card-block">
      <span className="mt-block-label">Reopen</span>
      <div className="qt-note-row">
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it is reopened" />
        <button type="button" className="mt-btn" onClick={() => {
          if (!why.trim()) { show('Write why it is reopened.'); return; } clear();
          ask({ title: `Reopen ${r.no}?`, lines: [`${r.spare} × ${r.qty}`, r.step === 'quotation_only' ? 'It goes back to PR, with you.' : 'It goes back to receipt.'], ok: 'Reopen',
            run: () => reopen(r.id, why.trim()), after: () => onDone(`${r.no} reopened.`) });
        }}>Reopen</button>
      </div>
      <Err text={err} at={at} />
      {box}
    </section>
  );
}

/* ============================================================ actions == */

/** The step's own form, on the request; Accept first where the step waits for one. */
function Action({ r, me, preset, onDone, onFinish }) {
  const [ask, box] = useAsk();
  if (!r.accepted_at && !NO_ACCEPT.has(r.step)) {
    return (
      <section className="qt-action" data-role={roleOfStep(r.step) ?? undefined}>
        <p className="qt-action-title">{statusOf(r)}</p>
        <p className="qt-action-sub">Waiting since {whenText(r.step_since)}</p>
        <button type="button" className="mt-go" onClick={() => ask({
          title: `Accept ${r.no}?`, lines: [`${r.spare} × ${r.qty} · ${r.hospital ?? 'Stock'}`, person(r.engineer_name, r.engineer_code)], ok: 'Accept',
          run: () => accept([r.id]), after: () => onDone(`${r.no} accepted.`),
        })}>Accept</button>
        {box}
      </section>
    );
  }
  const F = FORMS[r.step];
  return F ? <section className="qt-action" data-role={roleOfStep(r.step) ?? undefined}><p className="qt-action-title">{statusOf(r)}</p><F r={r} me={me} preset={preset} onDone={onFinish ?? onDone} /></section> : null;
}

/** Shared by forms: the decision asked first, sent, the message, the error beside the button. */
function useSend(r, onDone) {
  const [ask, box] = useAsk();
  const [err, show, clear, at] = useErr();
  const go = (title, lines, ok, p, msg, tone) => {
    clear();
    ask({ title, lines: [`${r.no} · ${r.spare} × ${r.approved_qty ?? r.qty}`, r.hospital ?? null, ...lines], ok, tone,
      run: () => act(r.step, r.id, p).catch((e) => {
        if (/^(Write|Choose) the |^The compatible rate must/i.test(e.message ?? '')) { show(e.message); e.toField = true; }
        throw e;
      }), after: () => onDone(msg) });
  };
  /** Every empty box red at once, the first scrolled to; true when nothing is missing. */
  const need = (list) => {
    const miss = list.filter(([x]) => x == null || x === false || String(x).trim() === '').map(([, m]) => m);
    if (!miss.length) return true;
    show(miss.length === 1 ? miss[0] : `Fill the ${miss.length} boxes in red.`, miss);
    return false;
  };
  return { go, box, err, show, at, need };
}

function Choice({ options, value, onChange }) {
  return (
    <div className="qt-choices" role="tablist">
      {options.map(([id, label, tone, role]) => (
        <button key={id} type="button" className="pm-choice" data-tone={tone ?? 'good'} data-role={role} aria-pressed={value === id} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

function RequestEdit({ v, set }) {
  return (
    <div className="qt-grid">
      <Field label="Equipment"><input value={v.equipment ?? ''} onChange={(e) => set('equipment', e.target.value)} /></Field>
      <Field label="Make"><input value={v.make ?? ''} onChange={(e) => set('make', e.target.value)} /></Field>
      <Field label="Model"><input value={v.model ?? ''} onChange={(e) => set('model', e.target.value)} /></Field>
      <Field label="Serial no"><input value={v.serial ?? ''} onChange={(e) => set('serial', e.target.value)} /></Field>
      <Field label="Spare"><input value={v.spare ?? ''} onChange={(e) => set('spare', e.target.value)} /></Field>
      <Field label="Qty"><input type="number" inputMode="numeric" min="1" value={v.qty ?? ''} onChange={(e) => set('qty', e.target.value)} /></Field>
    </div>
  );
}
const editOf = (r) => ({ equipment: r.equipment, make: r.make, model: r.model, serial: r.serial, spare: r.spare, qty: r.qty });

function TlReview({ r, preset, onDone }) {
  const [v, setV] = useState(editOf(r));
  const [note, setNote] = useState('');
  const [ask, box] = useAsk();
  const [err, show, clear, at] = useErr();
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const camc = (r.category ?? '').toUpperCase() === 'CAMC';
  const who = person(r.engineer_name, r.engineer_code);
  const decline = (a) => {
    if (!note.trim()) { show('Write the remarks.'); return; }
    clear();
    ask({
      title: a === 'send_back' ? `Send ${r.no} back to ${r.engineer_name}?` : `Reject ${r.no}?`,
      lines: [`${r.spare} × ${r.qty} · ${r.hospital}`, who, note.trim(), a === 'send_back' ? `${r.engineer_name} corrects it and sends it again.` : 'The request ends here.'],
      ok: a === 'send_back' ? 'Send back' : 'Reject', tone: a === 'reject' ? 'bad' : undefined,
      run: () => tlDecline(r.id, { action: a, note: note.trim() }),
      after: () => onDone(a === 'send_back' ? `${r.no} sent back to ${r.engineer_name}.` : `${r.no} rejected.`),
    });
  };
  /* Three buttons at the bottom, no choice above (the user, 11 Nov); remarks needed to send back or reject. */
  return (
    <>
      <RequestEdit v={v} set={set} />
      <Field label="Remarks" wide>
        <textarea rows={2} value={note} autoFocus={preset === 'send_back' || preset === 'reject'} onChange={(e) => { setNote(e.target.value); clear(); }} />
      </Field>
      <div className="qt-three qt-tl-acts">
        <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => decline('reject')}>Reject</button>
        <button type="button" data-role="engineer" className="mt-btn" onClick={() => decline('send_back')}>Send back</button>
        <button type="button" data-role="coordinator" className="mt-go" onClick={() => { clear(); ask({
          title: `Approve ${r.no}?`, lines: [`${v.spare} × ${v.qty} · ${r.hospital}`, who, camc ? 'CAMC: straight to PR.' : 'It goes to the Coordinator.'], ok: 'Approve',
          run: () => tlApprove([r.id], { ...v, qty: Number(v.qty) }), after: () => onDone(`${r.no} approved.`),
        }); }}>Approve</button>
      </div>
      <Err text={err} at={at} />
      {box}
    </>
  );
}

/** A request the Team Lead sent back: the engineer corrects it and sends it again, or withdraws it. */
function EngFix({ r, onDone }) {
  const why = [...(r.events ?? [])].reverse().find((e) => e.action === 'send_back');
  const [v, setV] = useState({ ...editOf(r), part_no: r.part_no ?? '' });
  const [photos, setPhotos] = useState(r.photos ?? []);
  const [note, setNote] = useState('');
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <>
      {why && <p className="qt-question"><b>{why.by_name}:</b> {why.note}</p>}
      <RequestEdit v={v} set={set} />
      <Field label="Part no"><input value={v.part_no} onChange={(e) => set('part_no', e.target.value)} /></Field>
      <div className="pm-in"><span>Photos</span><PhotoAdd folder={r.id} paths={photos} onChange={setPhotos} /></div>
      <Field label="Remarks" wide><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="qt-two">
        <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => s.go(`Withdraw ${r.no}?`, ['The request ends here.'], 'Withdraw', { action: 'withdraw', note }, `${r.no} withdrawn.`, 'bad')}>Withdraw</button>
        <button type="button" data-role="team_lead" className="mt-go" onClick={() => s.go(`Send ${r.no} again?`, [`${v.spare} × ${v.qty}`, `It goes to ${r.team_lead_name ?? 'your Team Lead'}.`], 'Send again', { ...v, qty: Number(v.qty), photos, action: 'resend', note }, `${r.no} sent again.`)}>Send again</button>
      </div>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function CoordInitial({ r, onDone }) {
  const [a, setA] = useState('to_purchase');
  const [v, setV] = useState({ item_code: r.item_code ?? '', vendor: '', rate: '', tax: '', note: '', pr_no: '', pr_date: '', contract: '' });
  const s = useSend(r, onDone);
  /** A hospital under both contracts says which one at Close; one contract asks nothing (the user, 14 Nov; 0054). */
  const both = /amc.*&.*amc/i.test(r.category ?? '');
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const p = { action: a, note: v.note, item_code: v.item_code, vendor: v.vendor, rate: v.rate === '' ? null : Number(v.rate), tax: v.tax === '' ? null : Number(v.tax), ...(a === 'close' ? { pr_no: v.pr_no, pr_date: v.pr_date, ...(both ? { contract: v.contract } : {}) } : {}) };
  return (
    <>
      <Choice value={a} onChange={setA} options={[['to_purchase', 'Ask Purchase for rates', 'good', 'purchase'], ['sap', 'SAP rate', 'good', 'coordinator'], ['ask_tl', 'Clarify with Team Lead', 'good', 'team_lead'], ['close', 'Close', 'bad']]} />
      {a === 'sap' && (
        <div className="qt-grid qt-sap">
          <Field label="Item code"><input value={v.item_code} onChange={(e) => set('item_code', e.target.value)} /></Field>
          <VendorInput value={v.vendor} onChange={(x) => set('vendor', x)} />
          <Field label="Rate (₹)"><MoneyInput value={v.rate} onChange={(x) => set('rate', x)} placeholder="0" /></Field>
          <TaxChips value={v.tax} onChange={(x) => set('tax', x)} />
          <TotalLine rate={v.rate} tax={v.tax} />
        </div>
      )}
      {/* Close: PR no and date if there is one, never required; the reason is (the user, 14 Nov; 0053). */}
      {a === 'close' && both && (
        <Field label="Contract">
          <select value={v.contract} onChange={(e) => set('contract', e.target.value)}>
            <option value="">Choose</option>
            <option value="AMC">AMC</option>
            <option value="CAMC">CAMC</option>
          </select>
        </Field>
      )}
      {a === 'close' && (
        <div className="qt-date-pair">
          <Field label="PR no"><input value={v.pr_no} onChange={(e) => set('pr_no', e.target.value)} autoComplete="off" /></Field>
          <Field label="PR date"><input type="date" value={v.pr_date} max={todayIst()} onChange={(e) => set('pr_date', e.target.value)} /></Field>
        </div>
      )}
      <Field label={a === 'close' ? 'Reason' : a === 'ask_tl' ? 'Question' : 'Remarks'} wide>
        <textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} />
      </Field>
      {a === 'to_purchase' && <button type="button" data-role="purchase" className="mt-go" onClick={() => s.go(`Send ${r.no} to Purchase?`, ['Purchase gives the rates.'], 'Send', p, `${r.no} sent to Purchase.`)}>Send to Purchase</button>}
      {a === 'ask_tl' && <button type="button" data-role="team_lead" className="mt-go" onClick={() => s.need([[v.note, 'Write the question.']]) && s.go(`Clarify ${r.no} with the Team Lead?`, [r.team_lead_name, v.note], 'Send', p, `Sent to ${r.team_lead_name ?? 'the Team Lead'}.`)}>Clarify with Team Lead</button>}
      {a === 'close' && <button type="button" className="mt-go qt-btn-bad" onClick={() => s.need([...(both ? [[v.contract, 'Choose the contract.']] : []), [v.note, 'Write the reason.']]) && s.go(`Close ${r.no}?`, [person(r.engineer_name, r.engineer_code), [both && v.contract, v.pr_no && `PR ${v.pr_no}`, v.pr_date && dayText(v.pr_date)].filter(Boolean).join(' · ') || null, v.note], 'Close', p, `${r.no} closed.`, 'bad')}>Close the request</button>}
      {a === 'sap' && (
        <div className="qt-two">
          <button type="button" data-role="purchase" className="mt-btn" onClick={() => s.need([[v.item_code, 'Write the item code.'], [v.vendor, 'Write the vendor.'], [Number(v.rate) > 0, 'Write the rate.'], [v.tax, 'Choose the tax.']]) && s.go(`Send the SAP rate to Purchase to confirm?`, [`Item ${v.item_code} · ${v.vendor} · ${money(v.rate)} + ${v.tax || 0}%`], 'Send', { ...p, action: 'sap_confirm' }, `${r.no} sent to Purchase to confirm.`)}>Purchase to confirm</button>
          <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.item_code, 'Write the item code.'], [v.vendor, 'Write the vendor.'], [Number(v.rate) > 0, 'Write the rate.'], [v.tax, 'Choose the tax.']]) && s.go(`Convert to PR on the SAP rate?`, [`Item ${v.item_code} · ${v.vendor} · ${money(v.rate)} + ${v.tax || 0}%`], 'Convert to PR', { ...p, action: 'sap_pr' }, `${r.no} is at PR.`)}>Convert to PR</button>
        </div>
      )}
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function TlClarify({ r, onDone }) {
  const q = [...(r.events ?? [])].reverse().find((e) => e.action === 'ask');
  const [v, setV] = useState({ ...editOf(r), note: '' });
  const [fix, setFix] = useState(false);
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <>
      {q && <p className="qt-question"><b>{q.by_name}:</b> {q.note}</p>}
      <Field label="Answer" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      <button type="button" className="pm-add-remark" onClick={() => setFix((f) => !f)}>{fix ? '− Keep the request as it is' : '+ Correct the request'}</button>
      {fix && <RequestEdit v={v} set={set} />}
      <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.go(`Send the answer on ${r.no}?`, [v.note], 'Send', fix ? { ...v, qty: Number(v.qty) } : { note: v.note }, 'Answer sent to the Coordinator.')}>Send answer</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function TotalLine({ rate, tax }) {
  const n = Number(rate) || 0;
  const t = Number(tax) || 0;
  return (
    <div className="qt-total" data-empty={n ? undefined : 'true'}>
      <span className="qt-total-label">Total with tax
        {n > 0 && <small>{money(n)} + {money(withTax(n, t) - n)} tax{t ? ` (${t}%)` : ''}</small>}
      </span>
      <strong>{money(withTax(n, tax))}</strong>
    </div>
  );
}

function QuoteInputs({ title, folder, v, set, prefix }) {
  const k = (x) => `${prefix}_${x}`;
  return (
    <div className="qt-quote-in">
      <span className="qt-quote-kind">{title}</span>
      <VendorInput value={v[k('vendor')]} onChange={(x) => set(k('vendor'), x)} />
      <Field label="Rate (₹)"><MoneyInput value={v[k('rate')] ?? ''} onChange={(x) => set(k('rate'), x)} placeholder="0" /></Field>
      <TaxChips value={v[k('tax')]} onChange={(x) => set(k('tax'), x)} />
      <TotalLine rate={v[k('rate')]} tax={v[k('tax')]} />
      <PhotoAdd folder={folder} paths={v[k('photo')] ? [v[k('photo')]] : []} onChange={(p) => set(k('photo'), p[p.length - 1] ?? '')} label="Quote" max={1} />
    </div>
  );
}

function PurchaseRates({ r, onDone }) {
  const [v, setV] = useState({
    orig_vendor: r.orig_vendor ?? '', orig_rate: r.orig_rate ?? '', orig_tax: r.orig_tax ?? '', orig_photo: r.orig_photo ?? '',
    comp_vendor: r.comp_vendor ?? '', comp_rate: r.comp_rate ?? '', comp_tax: r.comp_tax ?? '', comp_photo: r.comp_photo ?? '',
    warranty: r.warranty ?? '', lead_days: r.lead_days ?? '', note: '',
  });
  const [a, setA] = useState('rates');
  const stock = r.kind === 'stock';
  const [quotes, setQuotes] = useState(stock ? 'compatible' : 'both');
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const num = (x) => (x === '' || x == null ? null : Number(x));
  const p = { ...v, quotes, orig_rate: num(v.orig_rate), orig_tax: num(v.orig_tax), comp_rate: num(v.comp_rate), comp_tax: num(v.comp_tax), lead_days: num(v.lead_days) };
  const hasO = quotes !== 'compatible'; const hasC = quotes !== 'original';
  const oT = withTax(p.orig_rate, p.orig_tax); const cT = withTax(p.comp_rate, p.comp_tax);
  /** PV only above ₹40,000: the compatible's total when both are quoted, else the one quote's (the user, 11 Nov; 0024). */
  const toPv = !stock && (hasC ? cT : oT) > PV_ABOVE;
  const line = stock ? money(cT) : [hasO && `Original ${money(oT)}`, hasC && `Compatible ${money(cT)}`].filter(Boolean).join(' · ');
  /** Asked first, unless the compatible is not the cheaper one (the user, 11 Nov). */
  const send = (...args) => {
    if (!s.need([
      ...(hasO ? [[v.orig_vendor, 'Write the original vendor.'], [Number(v.orig_rate) > 0, 'Write the original rate.'], [v.orig_tax, 'Choose the original tax.']] : []),
      ...(hasC ? [[v.comp_vendor, 'Write the compatible vendor.'], [Number(v.comp_rate) > 0, 'Write the compatible rate.'], [v.comp_tax, 'Choose the compatible tax.']] : []),
    ])) return;
    if (hasO && hasC && p.orig_rate > 0 && p.comp_rate > 0 && cT >= oT) { s.show('The compatible rate must be lower than the original.'); return; }
    s.go(...args);
  };
  const back = [...(r.events ?? [])].reverse().find((e) => e.action === 'return' && e.step === 'pv');
  return (
    <>
      {back && <p className="qt-question"><b>PV asks to revise:</b> {back.note}</p>}
      {r.sap && <Quotes r={r} />}
      <Choice value={a} onChange={setA} options={[['rates', 'Give rates', 'good', 'purchase'], ...(r.sap ? [['approve_sap', 'Approve SAP rates', 'good', 'coordinator']] : []), ['ask', 'Clarify with Coordinator', 'good', 'coordinator']]} />
      {a === 'rates' && (
        <>
          {!stock && (
            <div className="pm-in"><span>Quotes</span>
              <div className="qt-send-chips" role="radiogroup" aria-label="Quotes">
                {[['both', 'Both'], ['original', 'Original only'], ['compatible', 'Compatible only']].map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={quotes === id} onClick={() => setQuotes(id)}>{label}</button>
                ))}
              </div>
            </div>
          )}
          <div className="qt-quotes">
            {hasO && <QuoteInputs title="Original" folder={r.id} v={v} set={set} prefix="orig" />}
            {hasC && <QuoteInputs title={stock ? 'Price' : 'Compatible'} folder={r.id} v={v} set={set} prefix="comp" />}
          </div>
          <div className="qt-grid is-two">
            <Field label="Warranty"><input value={v.warranty} onChange={(e) => set('warranty', e.target.value)} placeholder="6 months" /></Field>
            <Field label="Lead time (days)"><input type="number" inputMode="numeric" value={v.lead_days} onChange={(e) => set('lead_days', e.target.value)} /></Field>
          </div>
        </>
      )}
      <Field label={a === 'ask' ? 'Question' : 'Remarks'} wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      {a === 'rates' && (stock
        ? <button type="button" data-role="coordinator" className="mt-go" onClick={() => send('Send the price to the Coordinator?', [line], 'Send', { ...p, action: 'rates' }, `${r.no} is at PR.`)}>Send price</button>
        : toPv
          ? <button type="button" data-role="pv" className="mt-go" onClick={() => send('Send the rates to PV?', [line], 'Send', { ...p, action: 'rates' }, `${r.no} sent to PV.`)}>Send to PV</button>
          : <button type="button" data-role="coordinator" className="mt-go" onClick={() => send('Send the rates to the Coordinator?', [line], 'Send', { ...p, action: 'rates_pr' }, `${r.no} sent to the Coordinator.`)}>Send to Coordinator</button>
      )}
      {a === 'approve_sap' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.go('Approve the SAP rates?', [`${r.orig_vendor} · ${money(withTax(r.orig_rate, r.orig_tax))}`], 'Approve', { action: 'approve_sap', note: v.note }, `SAP rates approved. ${r.no} sent to the Coordinator.`)}>Approve SAP rates</button>}
      {a === 'ask' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.note, 'Write the question.']]) && s.go(`Clarify ${r.no} with the Coordinator?`, [v.note], 'Send', { action: 'ask', note: v.note }, 'Sent to the Coordinator.')}>Clarify with Coordinator</button>}
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function Pv({ r, onDone }) {
  const [note, setNote] = useState('');
  const s = useSend(r, onDone);
  const pick = (k) => s.go(`Pick the ${k}?`, [k === 'original' ? `${r.orig_vendor} · ${money(withTax(r.orig_rate, r.orig_tax))}` : `${r.comp_vendor} · ${money(withTax(r.comp_rate, r.comp_tax))}`], 'Pick', { action: k, note }, `${k === 'original' ? 'Original' : 'Compatible'} picked. ${r.no} is at PR.`);
  return (
    <>
      <p className="qt-action-sub">Press the one to buy.</p>
      <Quotes r={r} onPick={pick} />
      <Field label="Remarks" wide><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => s.go('Send the rates back to Purchase?', [note], 'Send back', { action: 'return', note }, `${r.no} sent back to Purchase.`, 'bad')}>Send back to Purchase</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

/** Quotation before PR (the user, 11 Nov): the Coordinator attaches it; the engineer gets the customer's answer. */
function CoordQuote({ r, onDone }) {
  const [a, setA] = useState('quote');
  const [v, setV] = useState({ quote_file: '', quote_date: '', note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const canPick = !r.picked && r.orig_rate != null && r.comp_rate != null;
  const [pick, setPick] = useState(r.picked ?? (r.comp_rate != null ? 'compatible' : 'original'));
  const said = r.quote_ok === false ? [...(r.events ?? [])].reverse().find((e) => e.action === 'quote_no') : null;
  const p = { ...v, action: a, ...(canPick ? { picked: pick } : {}) };
  return (
    <>
      {said && <p className="qt-question"><b>Customer did not approve:</b> {said.note}</p>}
      <Quotes r={{ ...r, picked: pick }} onPick={canPick ? setPick : undefined} />
      <Choice value={a} onChange={setA} options={[['quote', 'Quotation', 'good', 'engineer'], ['hold', 'Hold', 'good', 'coordinator'], ['cancel', 'Cancel', 'bad']]} />
      {a === 'quote' ? (
        <div className="qt-quote-row">
          <div className="pm-in"><span>Quotation</span>
            <PhotoAdd folder={r.id} paths={v.quote_file ? [v.quote_file] : []} onChange={(x) => set('quote_file', x[x.length - 1] ?? '')} label="Attach" max={1} />
          </div>
          <Field label="Quotation date"><input type="date" value={v.quote_date} max={todayIst()} onChange={(e) => set('quote_date', e.target.value)} /></Field>
          <Field label="Remarks"><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
        </div>
      ) : <Field label="Reason" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>}
      {a === 'quote' && <button type="button" data-role="engineer" className="mt-go" onClick={() => s.need([[v.quote_file, 'Attach the quotation.'], [v.quote_date, 'Choose the quotation date.']]) && s.go(`Submit the quotation of ${r.no}?`, [`To ${person(r.engineer_name, r.engineer_code)}`, 'The Team Lead is told too.'], 'Submit', p, `Quotation sent to ${r.engineer_name}.`)}>Submit quotation</button>}
      {a === 'hold' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Put ${r.no} on hold?`, [v.note], 'Hold', p, `${r.no} is on hold.`)}>Put on hold</button>}
      {a === 'cancel' && <button type="button" className="mt-go qt-btn-bad" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Cancel ${r.no}?`, [person(r.engineer_name, r.engineer_code), v.note], 'Cancel request', p, `${r.no} cancelled.`, 'bad')}>Cancel the request</button>}
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

/** The engineer confirms the customer's answer; the signed copy now or at the last receipt. */
function EngQuote({ r, onDone }) {
  const [v, setV] = useState({ approved: '', signed: '', note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <>
      <div className="pm-in"><span>Quotation</span><Photos paths={[r.quote_file].filter(Boolean)} /></div>
      <div className="pm-in"><span>Approved by the customer</span>
        <div className="qt-send-chips" role="radiogroup" aria-label="Approved by the customer">
          {[['yes', 'Yes'], ['no', 'No']].map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={v.approved === id} onClick={() => set('approved', id)}>{label}</button>)}
        </div>
      </div>
      {v.approved === 'yes' && (
        <div className="pm-in"><span>Signed quotation</span>
          <PhotoAdd folder={r.id} paths={v.signed ? [v.signed] : []} onChange={(x) => set('signed', x[x.length - 1] ?? '')} label="Attach" max={1} />
        </div>
      )}
      <Field label={v.approved === 'no' ? 'Reason' : 'Remarks'} wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.approved, 'Choose whether the customer approved it.'], ...(v.approved === 'no' ? [[v.note, 'Write the reason.']] : [])]) && s.go(
        v.approved === 'yes' ? `Customer approved the quotation of ${r.no}?` : `Customer did not approve ${r.no}?`,
        v.approved === 'yes' ? [v.signed ? 'Signed copy attached.' : 'The signed copy is needed when you confirm the receipt.', 'The Coordinator raises the PR.'] : [v.note, 'It goes back to the Coordinator.'],
        'Confirm', v, v.approved === 'yes' ? 'Sent to the Coordinator for PR.' : 'Sent back to the Coordinator.')}>Confirm quotation</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function CoordPr({ r, onDone }) {
  const [a, setA] = useState('pr');
  const [v, setV] = useState({ pr_no: '', pr_date: '', item_code: r.item_code ?? '', approved_qty: r.qty, note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  /** Straight to PR with both quotes: no PV pick, so the Coordinator picks; compatible by default (the user, 11 Nov; 0025). */
  const canPick = !r.picked && r.orig_rate != null && r.comp_rate != null;
  const [pick, setPick] = useState(r.picked ?? (r.comp_rate != null ? 'compatible' : 'original'));
  const price = pick === 'original' ? withTax(r.orig_rate, r.orig_tax) : withTax(r.comp_rate, r.comp_tax);
  const p = { ...v, action: a, quote: 'no', approved_qty: Number(v.approved_qty), ...(canPick ? { picked: pick } : {}) };
  return (
    <>
      <Quotes r={{ ...r, picked: pick }} onPick={canPick ? setPick : undefined} />
      <Choice value={a} onChange={setA} options={[['pr', 'Request PO', 'good', 'purchase'], ['hold', 'Hold', 'good', 'coordinator'], ['cancel', 'Cancel', 'bad']]} />
      {a === 'pr' && (
        <div className="qt-grid">
          <div className="qt-date-pair">
            <Field label="PR no"><input value={v.pr_no} onChange={(e) => set('pr_no', e.target.value)} autoComplete="off" /></Field>
            <Field label="PR date"><input type="date" value={v.pr_date} max={todayIst()} onChange={(e) => set('pr_date', e.target.value)} /></Field>
          </div>
          <Field label="Item code"><input value={v.item_code} onChange={(e) => set('item_code', e.target.value)} /></Field>
          <Field label="Approved qty"><input type="number" inputMode="numeric" min="1" value={v.approved_qty} onChange={(e) => set('approved_qty', e.target.value)} /></Field>
        </div>
      )}
      <Field label={a === 'pr' ? 'Remarks' : 'Reason'} wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      {a === 'pr' && <button type="button" data-role="purchase" className="mt-go" onClick={() => s.need([[v.pr_no, 'Write the PR no.'], [v.pr_date, 'Choose the PR date.'], [Number(v.approved_qty) > 0, 'Write the approved qty.'], [v.item_code, 'Write the item code.']]) && s.go(`Request PO for ${r.no}${v.pr_no ? ` · PR ${v.pr_no}` : ''}?`, [`${pick === 'original' ? 'Original' : 'Compatible'} · ${(pick === 'original' ? r.orig_vendor : r.comp_vendor) ?? ''}`, `${v.approved_qty} × ${money(price)} = ${money(price * Number(v.approved_qty || 0))}`, 'It goes to Purchase for PO and dispatch.'], 'Request PO', p, `PO requested for ${r.no}.`)}>Request PO</button>}
      {a === 'hold' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Put ${r.no} on hold?`, [v.note], 'Hold', p, `${r.no} is on hold.`)}>Put on hold</button>}
      {a === 'cancel' && <button type="button" className="mt-go qt-btn-bad" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Cancel ${r.no}?`, [person(r.engineer_name, r.engineer_code), v.note], 'Cancel request', p, `${r.no} cancelled.`, 'bad')}>Cancel the request</button>}
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function OnHold({ r, onDone }) {
  const [ask, box] = useAsk();
  const why = [...(r.events ?? [])].reverse().find((e) => e.action === 'hold');
  return (
    <>
      {why?.note && <p className="qt-question"><b>On hold:</b> {why.note}</p>}
      <button type="button" data-role="coordinator" className="mt-go" onClick={() => ask({ title: `Take ${r.no} off hold?`, lines: [`${r.spare} × ${r.qty}`], ok: 'Take off hold', run: () => resume(r.id), after: () => onDone(`${r.no} is back.`) })}>Take off hold</button>
      {box}
    </>
  );
}

/** By hand: whom it was handed to, found by name or employee code (the user, 11 Nov; 0034). */
function HandedTo({ value, onChange }) {
  const [q, setQ] = useState(value);
  const [found, setFound] = useState([]);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setFound([]); return undefined; }
    let on = true;
    const t = setTimeout(() => findPerson(q).then((x) => { if (on) setFound(x ?? []); }).catch(() => {}), 250);
    return () => { on = false; clearTimeout(t); };
  }, [q, open]);
  useEffect(() => {
    const out = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, []);
  return (
    <div className="qt-hand" ref={box}>
      <Field label="Handed to"><input value={q} placeholder="Name or employee code" autoComplete="off"
        onChange={(e) => { setQ(e.target.value); onChange(''); setOpen(true); }} onFocus={() => setOpen(true)} /></Field>
      {open && found.length > 0 && (
        <ul className="qt-hand-list" role="listbox">
          {found.map((p) => (
            <li key={p.ecode}><button type="button" onClick={() => { const t = `${p.name} (${p.ecode})`; setQ(t); onChange(t); setOpen(false); }}>
              {p.name} <span>{p.ecode}</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How it went, the tracking number and a photo of the slip. */
function SendBy({ v, set, folder }) {
  return (
    <>
      <div className="pm-in"><span>Sent by</span>
        <div className="qt-send-chips" role="radiogroup" aria-label="Sent by">
          {SEND_BY.map((x) => <button key={x} type="button" role="radio" aria-checked={v.track_mode === x} onClick={() => set('track_mode', x)}>{x}</button>)}
        </div>
      </div>
      {v.track_mode === 'By hand' ? <HandedTo value={v.track_no} onChange={(x) => set('track_no', x)} /> : (
        <div className="qt-track-row">
          <Field label="Tracking no"><input value={v.track_no} onChange={(e) => set('track_no', e.target.value)} autoComplete="off" /></Field>
          <div className="pm-in"><span>Receipt</span>
            <PhotoAdd folder={folder} paths={v.photo ? [v.photo] : []} onChange={(p) => set('photo', p[p.length - 1] ?? '')} label="" max={1} />
          </div>
        </div>
      )}
    </>
  );
}

function PurchaseDispatch({ r, onDone }) {
  const [a, setA] = useState('dispatch');
  const [v, setV] = useState({ po_no: r.po_no ?? '', po_date: r.po_date ?? '', vendor: r.vendor ?? (r.picked === 'original' ? r.orig_vendor : r.comp_vendor) ?? '', item_code: r.item_code ?? '', track_mode: '', track_no: '', photo: '', note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const p = { ...v, action: a };
  return (
    <>
      <Choice value={a} onChange={setA} options={[['dispatch', 'PO and dispatch', 'good', 'engineer'], ['ask_hold', 'Ask to hold', 'good', 'coordinator'], ['ask_cancel', 'Ask to cancel', 'bad']]} />
      {a === 'dispatch' && (
        <>
          <div className="qt-grid">
            <div className="qt-date-pair">
              <Field label="PO no"><input value={v.po_no} onChange={(e) => set('po_no', e.target.value)} autoComplete="off" /></Field>
              <Field label="PO date"><input type="date" value={v.po_date} max={todayIst()} onChange={(e) => set('po_date', e.target.value)} /></Field>
            </div>
            <div className="qt-date-pair">
              <VendorInput value={v.vendor} onChange={(x) => set('vendor', x)} />
              <Field label="Item code"><input value={v.item_code} onChange={(e) => set('item_code', e.target.value)} /></Field>
            </div>
          </div>
          <SendBy v={v} set={set} folder={r.id} />
        </>
      )}
      <Field label={a === 'dispatch' ? 'Remarks' : 'Reason'} wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      {a === 'dispatch' && (
        <div className="qt-two">
          <button type="button" data-role="purchase" className="mt-btn" onClick={() => s.need([[v.po_no, 'Write the PO no.']]) && s.go(`Save the PO on ${r.no}?`, [`PO ${v.po_no}`, 'It stays with you until dispatched.'], 'Save', { ...p, action: 'save' }, 'PO saved.')}>Save PO</button>
          <button type="button" data-role="engineer" className="mt-go" onClick={() => s.need([[v.po_no, 'Write the PO no.'], [v.po_date, 'Choose the PO date.'], [v.vendor, 'Write the vendor.'], [v.track_mode, 'Choose how it is sent.'], [v.track_no, v.track_mode === 'By hand' ? 'Write who it was handed to.' : 'Write the tracking no.']]) && s.go(`Dispatch ${r.no}?`, [`PO ${v.po_no} · ${v.track_mode} ${v.track_no}`, `To ${r.engineer_name}`], 'Dispatch', p, `${r.no} dispatched.`)}>Dispatch</button>
        </div>
      )}
      {a !== 'dispatch' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(a === 'ask_hold' ? `Ask to hold ${r.no}?` : `Ask to cancel ${r.no}?`, [v.note, 'The Coordinator decides.'], 'Ask', p, 'Sent to the Coordinator.')}>Send to the Coordinator</button>}
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function CoordDecide({ r, onDone }) {
  const asked = [...(r.events ?? [])].reverse().find((e) => e.action === 'ask_hold' || e.action === 'ask_cancel');
  const [note, setNote] = useState('');
  const s = useSend(r, onDone);
  return (
    <>
      {asked && <p className="qt-question"><b>{asked.by_name} asks to {asked.action === 'ask_hold' ? 'hold' : 'cancel'}:</b> {asked.note}</p>}
      <Field label="Remarks" wide><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="qt-three">
        <button type="button" data-role="purchase" className="mt-btn" onClick={() => s.go('Tell Purchase to go ahead?', [note], 'Go ahead', { action: 'deny', note }, 'Purchase goes ahead.')}>Go ahead</button>
        <button type="button" data-role="coordinator" className="mt-btn" onClick={() => s.go(`Hold ${r.no}?`, [note], 'Hold', { action: 'hold', note }, `${r.no} is on hold.`)}>Hold</button>
        <button type="button" className="mt-go qt-btn-bad" onClick={() => s.go(`Cancel ${r.no}?`, [note], 'Cancel request', { action: 'cancel', note }, `${r.no} cancelled.`, 'bad')}>Cancel</button>
      </div>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

/** A plain number box, no − / + (the user, 11 Nov); never below 0 or above max. */
function Stepper({ label, value, onChange, max }) {
  return (
    <Field label={label}>
      <input type="number" inputMode="numeric" min="0" max={max ?? undefined} value={value}
             onChange={(e) => onChange(e.target.value === '' ? '' : Math.max(0, Math.min(max ?? Infinity, Math.floor(Number(e.target.value)))))} />
    </Field>
  );
}

/** Receipt on one screen (idea 8): received, used, faulty; used and faulty never more than received. */
function Receipt({ r, onDone }) {
  const repl = r.step === 'receipt' && r.faulty_qty > 0;
  const obs = r.step === 'observation';
  const expect = repl ? r.faulty_qty : (r.approved_qty ?? r.qty);
  const left = obs ? r.received_qty - r.used_qty - r.faulty_qty : 0;
  const [v, setV] = useState({ received: obs ? 0 : expect, used: obs ? left : 0, faulty: 0, faulty_kind: 'Faulty', date: todayIst(), note: '', observe: false, signed: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const room = Number(v.received || 0) + (obs ? r.received_qty - r.used_qty - r.faulty_qty : 0);
  const over = Number(v.used || 0) + Number(v.faulty || 0) > room;
  const p = { ...v, received: Number(v.received || 0), used: Number(v.used || 0), faulty: Number(v.faulty || 0) };
  // Completing it needs the signed quotation if it was not attached before (the user, 11 Nov; 0033).
  const needSigned = r.kind === 'request' && r.quote_file && !r.quote_signed && !Number(v.faulty) && !v.observe;
  return (
    <>
      {repl && <p className="qt-question">Replacement for {r.faulty_qty} faulty.</p>}
      {obs && <p className="qt-question">{r.received_qty - r.used_qty - r.faulty_qty} under observation.</p>}
      <div className="qt-grid is-three">
        {!obs && <Stepper label="Received" value={v.received} max={expect} onChange={(x) => setV((o) => {
          const got = Number(x || 0); const used = Math.min(Number(o.used || 0), got);
          return { ...o, received: x, used, faulty: Math.min(Number(o.faulty || 0), got - used) };
        })} />}
        {!v.observe && <Stepper label="Used" value={v.used} max={Math.max(0, room - Number(v.faulty || 0))} onChange={(x) => set('used', x)} />}
        <Stepper label="Faulty" value={v.faulty} max={Math.max(0, room - Number(v.used || 0))} onChange={(x) => set('faulty', x)} />
      </div>
      {Number(v.faulty) > 0 && <Choice value={v.faulty_kind} onChange={(x) => set('faulty_kind', x)} options={[['Faulty', 'Faulty', 'bad'], ['Mismatch', 'Mismatch', 'bad']]} />}
      {!obs && <Field label="Received on"><input type="date" value={v.date} max={todayIst()} onChange={(e) => set('date', e.target.value)} /></Field>}
      <Field label="Remarks" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      {!Number(v.faulty) && !obs && (
        <label className="qt-check"><input type="checkbox" checked={v.observe} onChange={(e) => setV((o) => ({ ...o, observe: e.target.checked, used: e.target.checked ? 0 : o.used }))} /> Keep under observation</label>
      )}
      {needSigned && (
        <div className="pm-in"><span>Signed quotation</span>
          <PhotoAdd folder={r.id} paths={v.signed ? [v.signed] : []} onChange={(x) => set('signed', x[x.length - 1] ?? '')} label="Attach" max={1} />
        </div>
      )}
      {over && <p className="mt-err qt-err">Used and faulty together cannot be more than {room}.</p>}
      <button type="button" data-role={Number(v.faulty) ? 'purchase' : 'engineer'} className="mt-go" disabled={over} onClick={() => s.need(needSigned ? [[v.signed, 'Attach the signed quotation.']] : []) && s.go(`Confirm receipt of ${r.no}?`,
        [`${p.received} received · ${p.used} used · ${p.faulty} ${p.faulty ? v.faulty_kind.toLowerCase() : 'faulty'}`, p.faulty ? 'Purchase is told about the faulty one.' : v.observe ? 'It stays under observation.' : 'The request is completed.'],
        'Confirm', p, p.faulty ? `${v.faulty_kind} reported to Purchase.` : `Receipt of ${r.no} confirmed.`)}>Confirm receipt</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function PurchaseFaulty({ r, onDone }) {
  const [a, setA] = useState('return');
  const [v, setV] = useState({ address: '', note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <>
      <p className="qt-question"><b>{r.faulty_qty} {String(r.faulty_kind ?? 'faulty').toLowerCase()}:</b> {r.faulty_note ?? ''}</p>
      <Choice value={a} onChange={setA} options={[['return', 'Return for replacement', 'good', 'engineer'], ['stock', 'Move to stock', 'good', 'coordinator'], ['cancel', 'Cancel PO', 'bad']]} />
      {a === 'return' && <Field label="Return address" wide><textarea rows={2} value={v.address} onChange={(e) => set('address', e.target.value)} /></Field>}
      <Field label="Remarks" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      <button type="button" data-role={a === 'return' ? 'engineer' : a === 'stock' ? 'coordinator' : undefined} className={`mt-go${a === 'cancel' ? ' qt-btn-bad' : ''}`} onClick={() => s.go(
        a === 'return' ? `Ask ${r.engineer_name} to send it back?` : a === 'stock' ? `Move ${r.no} to stock?` : `Cancel the PO of ${r.no}?`,
        [a === 'return' ? v.address : v.note], a === 'return' ? 'Send' : a === 'stock' ? 'Move to stock' : 'Cancel PO', { ...v, action: a },
        a === 'return' ? 'Return address sent.' : a === 'stock' ? 'Moved to stock.' : 'PO cancelled.', a === 'cancel' ? 'bad' : undefined)}>
        {a === 'return' ? 'Send the return address' : a === 'stock' ? 'Move to stock' : 'Cancel PO'}
      </button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function TrackForm({ r, onDone, title, done, intro, to }) {
  const [v, setV] = useState({ track_mode: '', track_no: '', photo: '', note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <>
      {intro}
      <SendBy v={v} set={set} folder={r.id} />
      <Field label="Remarks" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      <button type="button" data-role={to} className="mt-go" onClick={() => s.need([[v.track_mode, 'Choose how it is sent.'], [v.track_no, v.track_mode === 'By hand' ? 'Write who it was handed to.' : 'Write the tracking no.']]) && s.go(`${title}?`, [`${v.track_mode} · ${v.track_no}`], 'Send', v, done)}>{title}</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

const FORMS = {
  tl_review: TlReview,
  eng_fix: EngFix,
  coord_initial: CoordInitial,
  tl_clarify: TlClarify,
  purchase_rates: PurchaseRates,
  pv: Pv,
  coord_quote: CoordQuote,
  eng_quote: EngQuote,
  coord_pr: CoordPr,
  on_hold: OnHold,
  on_hold_dispatch: OnHold,
  purchase_dispatch: PurchaseDispatch,
  coord_decide: CoordDecide,
  receipt: Receipt,
  observation: Receipt,
  purchase_faulty: PurchaseFaulty,
  return_dispatch: ({ r, onDone }) => <TrackForm r={r} onDone={onDone} title="Send the faulty spare back" to="purchase" done="Return sent to Purchase."
    intro={r.return_address && <p className="qt-question"><b>Send to:</b> {r.return_address}</p>} />,
  purchase_replacement: ({ r, onDone }) => <TrackForm r={r} onDone={onDone} title="Dispatch the replacement" to="engineer" done="Replacement dispatched."
    intro={r.return_track_no && <p className="qt-question"><b>Faulty one sent back:</b> {r.return_track_mode} · {r.return_track_no}</p>} />,
};

/* ============================================================== raising == */

const blankSpare = () => ({ id: uuid(), spare: '', part_no: '', qty: 1, photos: [] });

function HospitalPick({ facilities, value, onChange, bad }) {
  const { recent } = useContext(QtCtx);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  /* Esc or a press outside closes the list (the user, 11 Nov). */
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const f = facilities.find((x) => x.id === value);
  const mineFirst = useMemo(() => {
    const at = new Map(recent.map((id, i) => [id, i]));
    const top = facilities.filter((x) => at.has(x.id)).sort((a, b) => at.get(a.id) - at.get(b.id));
    return { top, rest: facilities.filter((x) => !at.has(x.id)) };
  }, [recent, facilities]);
  const shown = useMemo(() => (q ? facilities.filter((x) => `${x.name} ${x.district} ${x.state}`.toLowerCase().includes(q.toLowerCase())) : mineFirst.rest).slice(0, 60), [q, facilities, mineFirst]);
  const row = (x) => (
    <li key={x.id}><button type="button" onClick={() => { onChange(x.id); setOpen(false); setQ(''); }}>
      <strong>{x.name}</strong><span>{[x.district, x.state, x.category].filter(Boolean).join(' · ')}</span>
    </button></li>
  );
  return (
    <div className="pm-in qt-hosp" ref={box}><span>Hospital</span>
      {f && !open ? (
        <button type="button" className="qt-hosp-picked" onClick={() => setOpen(true)}>
          <strong>{f.name}</strong><span>{[f.district, f.state, f.category].filter(Boolean).join(' · ')}</span>
        </button>
      ) : (
        <>
          <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search the hospital" className={bad ? 'is-bad' : ''} />
          {open && (
            <ul className="qt-hosp-list">
              {!q && mineFirst.top.length > 0 && (
                <>
                  <li className="qt-hosp-head">Your recent hospitals</li>
                  {mineFirst.top.map(row)}
                  <li className="qt-hosp-head">All hospitals</li>
                </>
              )}
              {shown.map(row)}
              {!shown.length && <li className="qt-hosp-none">Not in the list. Ask a Coordinator to add it.</li>}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Raise in two steps (idea 6): hospital and equipment, then the spares, one request number each. */
const BLANK_RAISE = { facility_id: '', equipment: '', make: '', model: '', serial: '', note: '' };
function RaiseForm({ me, onDone }) {
  const { code } = useContext(QtCtx);
  const key = `qt-raise-draft:${code}`;
  const [draft] = useState(() => store.get(key));
  const [facilities, setFacilities] = useState([]);
  const [step, setStep] = useState(draft?.step ?? 1);
  const [v, setV] = useState({ ...BLANK_RAISE, ...(draft?.v ?? {}) });
  const [eqPhotos, setEqPhotos] = useState(draft?.eqPhotos ?? []);
  const [spares, setSpares] = useState(draft?.spares?.length ? draft.spares : [blankSpare()]);
  const [before, setBefore] = useState([]);
  const [token, setToken] = useState(() => draft?.token ?? uuid());
  const [ask, box] = useAsk();
  const [err, show, clear, at] = useErr();
  const filled = Boolean(v.facility_id || v.equipment || v.make || v.model || v.serial || v.note || eqPhotos.length
    || spares.some((s) => s.spare || s.part_no || s.photos.length || Number(s.qty) !== 1));
  const sent = useRef(false);
  useEffect(() => { if (!sent.current) store.set(key, filled ? { v, eqPhotos, spares, step, token } : null); }, [key, filled, v, eqPhotos, spares, step, token]);
  const startAgain = () => ask({ title: 'Clear this form?', lines: [], ok: 'Clear', tone: 'bad', run: async () => {
    setV(BLANK_RAISE); setEqPhotos([]); setSpares([blankSpare()]); setStep(1); setToken(uuid()); clear(); store.set(key, null);
  } });
  useEffect(() => { loadFacilities().then((f) => setFacilities(f ?? [])).catch(() => {}); }, []);
  useEffect(() => { if (v.facility_id) loadEquipmentAt(v.facility_id).then((x) => setBefore(x ?? [])).catch(() => setBefore([])); }, [v.facility_id]);
  const set = (k, x) => { setV((o) => ({ ...o, [k]: x })); clear(); };
  const setSpare = (i, k, x) => { setSpares((s) => s.map((o, j) => (j === i ? { ...o, [k]: x } : o))); clear(); };
  const f = facilities.find((x) => x.id === v.facility_id);

  const next = () => {
    if (!v.facility_id) { show('Choose the hospital.'); return; }
    if (!v.equipment.trim()) { show('Write the equipment name.'); return; }
    clear(); setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const send = () => {
    const bad = spares.findIndex((s) => !s.spare.trim() || !(Number(s.qty) >= 1));
    if (bad >= 0) { show(`Write the spare name and quantity of spare ${bad + 1}.`); return; }
    ask({
      title: spares.length === 1 ? 'Send this request?' : `Send ${spares.length} requests?`,
      lines: [`${f?.name}`, `${v.equipment}${v.make ? ` · ${v.make}` : ''}`, ...spares.map((s) => `${s.spare} × ${s.qty}`),
        me.role === 'team_lead' ? 'It goes to the Coordinator.' : `It goes to ${me.team_lead_name ?? 'your Team Lead'}.`],
      ok: 'Send',
      run: () => raise({ ...v, equipment_photo: eqPhotos[0] ?? null, equipment_photos: eqPhotos, client_token: token, spares: spares.map((s) => ({ ...s, qty: Number(s.qty), photos: s.photos })) }),
      after: (nos) => {
        sent.current = true; store.set(key, null);
        store.set(`qt-recent-hosp:${code}`, [v.facility_id, ...(store.get(`qt-recent-hosp:${code}`) ?? []).filter((x) => x !== v.facility_id)].slice(0, 5));
        onDone(`${(nos ?? []).join(', ')} raised.`);
      },
    });
  };

  return (
    <div className="pm-form qt-raise">
      <div className="qt-steps"><span data-on={step === 1}>1 · Hospital and equipment</span><span data-on={step === 2}>2 · Spares</span>
        {filled && <button type="button" className="pm-clear qt-start-again" onClick={startAgain}>Clear</button>}
      </div>
      {step === 1 ? (
        <section className="pm-card pm-details">
          <HospitalPick facilities={facilities} value={v.facility_id} onChange={(x) => set('facility_id', x)} />
          {before.length > 0 && (
            <div className="qt-before">
              <span className="qt-before-label">Raised here before</span>
              <div className="qt-before-row">
                {before.map((b, i) => (
                  <button key={i} type="button" className="qt-chip" onClick={() => setV((o) => ({ ...o, equipment: b.equipment ?? '', make: b.make ?? '', model: b.model ?? '', serial: b.serial ?? '' }))}>
                    {[b.equipment, b.make, b.model, b.serial].filter(Boolean).join(' · ')}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Field label="Equipment"><input value={v.equipment} onChange={(e) => set('equipment', e.target.value)} placeholder="Defibrillator" /></Field>
          <div className="pm-in-row">
            <Field label="Make"><input value={v.make} onChange={(e) => set('make', e.target.value)} /></Field>
            <Field label="Model"><input value={v.model} onChange={(e) => set('model', e.target.value)} /></Field>
          </div>
          <Field label="Serial no"><input value={v.serial} onChange={(e) => set('serial', e.target.value)} /></Field>
          <div className="pm-in"><span>Equipment photos</span>
            <PhotoAdd folder={spares[0].id} paths={eqPhotos} onChange={setEqPhotos} />
          </div>
          <Field label="Remarks" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
          <button type="button" className="mt-go" onClick={next}>Next: spares</button>
          <Err text={err} at={at} />
        </section>
      ) : (
        <>
          <section className="pm-card qt-summary-card">
            <button type="button" className="pm-back" onClick={() => setStep(1)} aria-label="Back to hospital and equipment"><Icon d={I.back} size={20} /></button>
            <div><strong>{f?.name}</strong><span>{[v.equipment, v.make, v.model].filter(Boolean).join(' · ')}</span></div>
          </section>
          {spares.map((s, i) => (
            <section key={s.id} className="pm-card pm-details qt-spare-card">
              <div className="pm-sec-head"><h3>Spare {i + 1}</h3>
                {spares.length > 1 && <button type="button" className="pm-clear" onClick={() => setSpares((x) => x.filter((_, j) => j !== i))}>Remove</button>}
              </div>
              <Field label="Spare name"><input value={s.spare} onChange={(e) => setSpare(i, 'spare', e.target.value)} placeholder="Battery" /></Field>
              <div className="pm-in-row">
                <Field label="Part no"><input value={s.part_no} onChange={(e) => setSpare(i, 'part_no', e.target.value)} /></Field>
                <Stepper label="Qty" value={s.qty} onChange={(x) => setSpare(i, 'qty', x)} />
              </div>
              <div className="pm-in"><span>Photos</span><PhotoAdd folder={s.id} paths={s.photos} onChange={(p) => setSpare(i, 'photos', p)} /></div>
            </section>
          ))}
          <button type="button" className="mt-btn qt-another" onClick={() => setSpares((x) => [...x, blankSpare()])}><Icon d={I.plus} /> Another spare</button>
          <div className="pm-bar">
            <span className="qt-bar-n">{spares.length} {spares.length === 1 ? 'spare' : 'spares'}</span>
            <button type="button" data-role={me.role === 'team_lead' ? 'coordinator' : 'team_lead'} className="mt-go pm-submit" onClick={send}>Send</button>
            <Err text={err} at={at} />
          </div>
        </>
      )}
      {box}
    </div>
  );
}

/** A Coordinator's stock request (STK): straight to Purchase dispatch. */
function StockForm({ onDone }) {
  const [people, setPeople] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [v, setV] = useState({ stakeholder_id: '', facility_id: '', address: '', pr_no: '', pr_date: '' });
  const [spares, setSpares] = useState([{ ...blankSpare(), item_code: '' }]);
  const [token] = useState(uuid);
  const [ask, box] = useAsk();
  const [err, show, clear, at] = useErr();
  useEffect(() => {
    loadPeople().then((p) => setPeople((p ?? []).filter((x) => x.active && (x.role === 'engineer' || x.role === 'team_lead' || x.role === 'coordinator')))).catch(() => {});
    loadFacilities().then((f) => setFacilities(f ?? [])).catch(() => {});
  }, []);
  const set = (k, x) => { setV((o) => ({ ...o, [k]: x })); clear(); };
  const setSpare = (i, k, x) => { setSpares((s) => s.map((o, j) => (j === i ? { ...o, [k]: x } : o))); clear(); };
  const who = people.find((p) => p.employee_id === v.stakeholder_id);
  const send = () => {
    if (!v.stakeholder_id) { show('Choose who receives it.'); return; }
    if (!v.address.trim() || !v.pr_no.trim()) { show('Write the delivery address and the PR number.'); return; }
    const bad = spares.findIndex((s) => !s.spare.trim() || !(Number(s.qty) >= 1));
    if (bad >= 0) { show(`Write the spare name and quantity of spare ${bad + 1}.`); return; }
    ask({ title: `Send ${spares.length === 1 ? 'this stock request' : `${spares.length} stock requests`}?`,
      lines: [`For ${person(who?.name, who?.ecode)}`, `PR ${v.pr_no}`, ...spares.map((s) => `${s.spare} × ${s.qty}`), 'It goes to Purchase for dispatch.'], ok: 'Send',
      run: () => raiseStock({ ...v, client_token: token, spares: spares.map((s) => ({ ...s, qty: Number(s.qty) })) }),
      after: (nos) => onDone(`${(nos ?? []).join(', ')} raised.`) });
  };
  return (
    <div className="pm-form qt-raise">
      <section className="pm-card pm-details">
        <div className="pm-in"><span>For</span>
          <Picker value={v.stakeholder_id} onChange={(x) => set('stakeholder_id', x)} title="For"
                  options={[{ value: '', label: 'Choose the person' }, ...people.map((p) => ({ value: p.employee_id, label: `${p.name} (${p.ecode})` }))]} />
        </div>
        <HospitalPick facilities={facilities} value={v.facility_id} onChange={(x) => set('facility_id', x)} />
        <Field label="Delivery address" wide><textarea rows={2} value={v.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <div className="pm-in-row">
          <Field label="PR no"><input value={v.pr_no} onChange={(e) => set('pr_no', e.target.value)} /></Field>
          <Field label="PR date"><input type="date" value={v.pr_date} max={todayIst()} onChange={(e) => set('pr_date', e.target.value)} /></Field>
        </div>
      </section>
      {spares.map((s, i) => (
        <section key={s.id} className="pm-card pm-details">
          <div className="pm-sec-head"><h3>Spare {i + 1}</h3>
            {spares.length > 1 && <button type="button" className="pm-clear" onClick={() => setSpares((x) => x.filter((_, j) => j !== i))}>Remove</button>}
          </div>
          <Field label="Spare name"><input value={s.spare} onChange={(e) => setSpare(i, 'spare', e.target.value)} /></Field>
          <div className="pm-in-row">
            <Field label="Item code"><input value={s.item_code} onChange={(e) => setSpare(i, 'item_code', e.target.value)} /></Field>
            <Field label="Part no"><input value={s.part_no} onChange={(e) => setSpare(i, 'part_no', e.target.value)} /></Field>
          </div>
          <Stepper label="Qty" value={s.qty} onChange={(x) => setSpare(i, 'qty', x)} />
          <div className="pm-in"><span>Photos</span><PhotoAdd folder={s.id} paths={s.photos} onChange={(p) => setSpare(i, 'photos', p)} /></div>
        </section>
      ))}
      <button type="button" className="mt-btn qt-another" onClick={() => setSpares((x) => [...x, { ...blankSpare(), item_code: '' }])}><Icon d={I.plus} /> Another spare</button>
      <div className="pm-bar">
        <span className="qt-bar-n">{spares.length} {spares.length === 1 ? 'spare' : 'spares'}</span>
        <button type="button" data-role="purchase" className="mt-go pm-submit" onClick={send}>Send</button>
        <Err text={err} at={at} />
      </div>
      {box}
    </div>
  );
}

/* ============================================================= stock == */

function StockRegister({ me, list, onOpen, onDone }) {
  const [q, setQ] = useState('');
  const [use, setUse] = useState(null);
  const rows = useMemo(() => list
    .filter((r) => (r.step === 'completed' || r.step === 'observation') && r.received_qty - r.used_qty - r.faulty_qty > 0)
    .filter((r) => !q || matches(r, q))
    .sort((a, b) => (a.engineer_name ?? '').localeCompare(b.engineer_name ?? '') || a.spare.localeCompare(b.spare)), [list, q]);
  const total = rows.reduce((n, r) => n + r.received_qty - r.used_qty - r.faulty_qty, 0);
  return (
    <div className="mt-tickets">
      <div className="mt-filters qt-filters">
        <Search value={q} onChange={setQ} placeholder="Spare, engineer, hospital" />
        <span className="qt-total">{total} in hand</span>
      </div>
      {!rows.length ? <p className="empty-inline pm-empty">Nothing in hand.</p> : (
        <ul className="qt-cards">
          {rows.map((r) => {
            const left = r.received_qty - r.used_qty - r.faulty_qty;
            const own = r.engineer_code && me.role !== 'coordinator' && r.mine !== undefined && r.engineer_id && (me.role === 'engineer' || me.role === 'team_lead');
            return (
              <li key={r.id} className="qt-card" data-tone="green">
                <button type="button" className="qt-card-body" onClick={() => onOpen(r.id)}>
                  <span className="qt-card-top"><span className="qt-no">{r.no}{r.ref_no && <small className="qt-ref">{r.ref_no}</small>}</span><span className="qt-left">{left} in hand</span></span>
                  <span className="qt-card-spare">{r.spare}</span>
                  <span className="qt-card-line">{r.received_qty} received · {r.used_qty} used{r.faulty_qty ? ` · ${r.faulty_qty} faulty` : ''}</span>
                  <span className="qt-card-foot">{person(r.engineer_name, r.engineer_code)}{r.hospital ? ` · ${r.hospital}` : ''}</span>
                </button>
                {own && <button type="button" className="mt-btn qt-next" onClick={() => setUse(r)}>Use</button>}
              </li>
            );
          })}
        </ul>
      )}
      {use && <UseStock r={use} onClose={() => setUse(null)} onDone={(m) => { setUse(null); onDone(m); }} />}
    </div>
  );
}

function UseStock({ r, onClose, onDone }) {
  const left = r.received_qty - r.used_qty - r.faulty_qty;
  const [n, setN] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await consume(r.id, Number(n), note.trim()); onDone(`${n} ${r.spare} used.`); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="modal-scrim qt-scrim-top" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal mt-modal" role="dialog" aria-label="Use from stock">
        <div className="modal-head"><h2>Use {r.spare}</h2></div>
        <div className="modal-body qt-modal-body">
          <p className="pm-confirm-line">{r.no} · {left} in hand</p>
          <Stepper label="How many" value={n} onChange={setN} max={left} />
          <Field label="Where it was used" wide><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Hospital, equipment" /></Field>
          {err && <p className="mt-err" role="alert">{err}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="mt-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="mt-btn mt-btn-primary" onClick={go} disabled={busy}>{busy ? 'Please wait…' : 'Use'}</button>
        </div>
      </div>
    </div>, document.body);
}

/* =============================================================== TAT == */

/**
 * Dashboard (the user, 11 Nov): one look at how a person, or a team, performs. How many requests were handled,
 * how many steps finished at their end, what is pending now by status, the share done, and the TAT at each stage
 * against its target, as a graph. Leads see everybody; an observer sees the team of the role observed
 * (Purchase's observer: the Purchase people and Purchase's stages only), with a member filter.
 */
const HOLDER = { engineer: 'engineer_id', team_lead: 'team_lead_id', coordinator: 'coord_id', purchase: 'purchase_id', pv: 'pv_id' };
function perfOf(ids, events, list, targets, opts = {}) {
  const evs = events.filter((e) => ids.has(e.by) && e.action !== 'note');
  const handled = new Set(evs.map((e) => e.request_id)).size;
  const moves = evs.filter((e) => e.to_step && e.to_step !== e.step);
  // Pending: accepted by them, or still waiting for Accept with the person named for that step (or, unnamed, with their role).
  // My own view: exactly what To accept + With you hold, so the Dashboard and the Requests tab agree (the user, 11 Nov).
  const pending = list.filter((r) => {
    if (r.done) return false;
    if (opts.me) return Boolean(r.mine);
    if (r.accepted_by) return ids.has(r.accepted_by);
    const role = r.step === 'return_dispatch' && r.kind === 'stock' ? 'coordinator' : roleOfStep(r.step);
    const named = role && r[HOLDER[role]];
    if (named) return ids.has(named);
    return (opts.me && r.mine) || (opts.role ? role === opts.role : !!opts.roles?.has(role));
  });
  const stages = new Map();
  const st = (k) => stages.get(k) ?? stages.set(k, { step: k, done: 0, acc: 0, accN: 0, accOk: 0, pro: 0, proN: 0, proOk: 0 }).get(k);
  for (const e of evs) {
    if (!TAT_STEPS.includes(e.step)) continue;
    if (opts.role && roleOfStep(e.step) !== opts.role) continue;
    const t = targets?.[e.step];
    if (e.action === 'accept' && e.accept_s != null) {
      const s = st(e.step); s.acc += e.accept_s; s.accN += 1; if (!t || e.accept_s <= Number(t.accept_h) * 3600) s.accOk += 1;
    } else if (e.to_step && e.to_step !== e.step) {
      const s = st(e.step); s.done += 1;
      if (e.process_s != null) { s.pro += e.process_s; s.proN += 1; if (!t || e.process_s <= Number(t.process_h) * 3600) s.proOk += 1; }
    }
  }
  const rows = TAT_STEPS.filter((k) => stages.has(k)).map((k) => stages.get(k));
  const n = rows.reduce((a, s) => a + s.accN + s.proN, 0);
  const ok = rows.reduce((a, s) => a + s.accOk + s.proOk, 0);
  const byStatus = new Map(); for (const r of pending) { const k = statusOf(r); byStatus.set(k, { n: (byStatus.get(k)?.n ?? 0) + 1, tone: stepOf(r.step).tone }); }
  const passedIds = new Set(moves.map((e) => e.request_id)); const passed = passedIds.size; // requests their part is done on
  const totalIds = new Set([...evs.map((e) => e.request_id), ...pending.map((r) => r.id)]);
  return {
    handled, done: passed, pending: pending.length,
    total: totalIds.size, // every request they worked on or hold
    ids: { total: totalIds, closed: passedIds, open: new Set(pending.map((r) => r.id)) },
    donePct: passed + pending.length ? Math.round((passed / (passed + pending.length)) * 100) : null,
    onTime: n ? Math.round((ok / n) * 100) : null, ok, n, rows,
    byStatus: [...byStatus.entries()].sort((a, b) => b[1].n - a[1].n),
  };
}

const pctTone = (p) => (p == null ? undefined : p >= 90 ? 'good' : p >= 70 ? 'warn' : 'bad');

/** Average accept and process at each stage against the target: one bar each, the target a line across. */
function TatGraph({ rows, targets }) {
  const items = rows.map((s) => {
    const t = targets[s.step] ?? {};
    const acc = s.accN ? s.acc / s.accN : null; const pro = s.proN ? s.pro / s.proN : null;
    const ta = Number(t.accept_h) * 3600 || null; const tp = Number(t.process_h) * 3600 || null;
    return { s, acc, pro, ta, tp, max: Math.max(acc ?? 0, pro ?? 0, ta ?? 0, tp ?? 0) * 1.1 || 1 };
  });
  const Bar = ({ v, t, max, label }) => (
    <span className="qt-graph-bar" data-late={v != null && t && v > t ? 'true' : undefined}>
      <span className="qt-graph-k">{label}</span>
      <span className="qt-graph-track">
        {v != null && <i style={{ width: `${Math.max(1.5, (v / max) * 100)}%` }} />}
        {t && <em style={{ left: `${(t / max) * 100}%` }} title={`Target ${spanText(t)}`} />}
      </span>
      <span className="qt-graph-v">{v == null ? '—' : spanText(v)}</span>
    </span>
  );
  return (
    <div className="qt-graph">
      {items.map(({ s, acc, pro, ta, tp, max }) => (
        <div key={s.step} className="qt-graph-row" data-tone={STEPS[s.step].tone}>
          <span className="qt-graph-name">{workOf(s.step)}<small>{s.done} done · target {spanText(ta)} · {spanText(tp)}</small></span>
          <Bar v={acc} t={ta} max={max} label="Accept" />
          <Bar v={pro} t={tp} max={max} label="Process" />
        </div>
      ))}
      <p className="qt-graph-key"><i /> on time <i data-late="true" /> past target <em /> target</p>
    </div>
  );
}

function Dashboard({ me, list, targets, period, setPeriod, onToast, onGo }) {
  const [events, setEvents] = useState(null);
  const [staff, setStaff] = useState([]);
  // A team only for those who look after one (the user, 11 Nov): an observer, the team observed; a Team Lead, their engineers. Everybody else sees themselves.
  const teamView = me.role === 'observer' || me.role === 'team_lead';
  const [who, setWho] = useState(teamView && me.role === 'observer' ? 'all' : me.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { const [f, t] = periodRange(period); setEvents(null); loadEvents(f, t).then(setEvents).catch(() => setEvents([])); }, [period]);
  useEffect(() => { if (teamView) loadPeople().then((x) => setStaff(x ?? [])).catch(() => {}); }, [teamView]);
  const label = period.id === 'month' ? todayIst().slice(0, 7) : period.id === 'all' ? 'all-time' : `${period.from || 'start'}-to-${period.to || 'today'}`;
  const excel = async () => {
    setBusy(true); setErr(null);
    try { const all = await loadEvents(null, null); await exportAll(list, all, targets, label); onToast('Excel downloaded.'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // The team: everybody for a lead; for an observer, the people of the role observed (all roles when none is set).
  const team = useMemo(() => (!teamView ? [] : staff
    .filter((x) => x.role !== 'observer' && x.active !== false && (me.role === 'team_lead'
      ? x.role === 'engineer' && x.team_lead_id === me.id
      : !me.observes || x.role === me.observes))
    .map((x) => ({ id: x.employee_id, name: x.name, code: x.ecode, role: x.role }))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.name ?? '').localeCompare(b.name ?? ''))), [staff, teamView, me]);
  const role = me.role === 'observer' ? me.observes ?? null : null;
  // Localhost only, for testing (the user, 11 Nov): the test coordinator E7777 sees Namitha K V's figures as its own.
  const asId = (w) => (import.meta.env.DEV && w === me.id && me.id === '99f48e76-ec4c-4f63-bd23-b248fcdf3c26' ? '2bcbb69c-bd77-4ff7-8345-6282f6464534' : w);
  const idsOf = (w) => (w === 'all' ? new Set(team.map((x) => x.id)) : new Set([asId(w)]));
  const pid = who;
  const p = useMemo(() => (events ? perfOf(idsOf(pid), events, list, targets, { me: pid === me.id, role: pid === 'all' ? role : null, roles: pid === 'all' ? new Set(team.map((x) => x.role)) : null }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, pid, list, targets, me.id, team, role]);
  const rows = useMemo(() => (events && teamView ? team.map((x) => ({ ...x, ...perfOf(new Set([x.id]), events, list, targets, { me: x.id === me.id }) })).filter((x) => x.handled || x.pending) : []), [events, team, list, targets, me.id, teamView]);
  const sel = pid === 'all' ? null : team.find((x) => x.id === pid) ?? (pid === me.id ? { name: me.name, role: me.role } : null);
  const whose = pid === me.id ? 'my' : pid === 'all' ? 'the team\'s' : `${sel?.name?.split(' ')[0] ?? 'their'}'s`;
  const avg = (s, n) => (n ? spanText(s / n) : '—');
  // A tile opens the Requests tab on its view (the user, 11 Nov).
  const watcher = me.role === 'observer' || me.role === 'viewer';
  const VIEW = { total: 'all', closed: 'done', open: watcher ? 'open' : pid === me.id ? null : 'others' };
  const Tile = ({ k, id, label, n, sub }) => (
    <button type="button" className="qt-tile" data-k={k} onClick={() => onGo(VIEW[id])}>
      <span>{label}</span><b><CountUp n={n} /></b><small>{sub}</small>
    </button>
  );
  // Your work now (the user, 12 Nov: the old tracker was easier; say what waits for me first): to accept, and accepted to finish.
  const work = useMemo(() => {
    const mine = list.filter((r) => r.mine && !r.done);
    const wait = mine.filter((r) => !r.accepted_at && !NO_ACCEPT.has(r.step));
    return { accept: wait.length, doing: mine.length - wait.length };
  }, [list]);
  const tot = useMemo(() => {
    const closed = list.filter((r) => r.done).length; const all = list.length;
    return { all, closed, open: all - closed, pct: all ? Math.round((closed / all) * 100) : null };
  }, [list]);
  const options = [
    ...(teamView ? [{ value: 'all', label: role ? `All ${ROLE_NAME[role]} · ${team.length}` : `Everybody · ${team.length}` }] : []),
    ...(me.role !== 'observer' && me.role !== 'viewer' ? [{ value: me.id, label: `Me · ${me.name ?? ''}` }] : []),
    ...team.filter((x) => x.id !== me.id).map((x) => ({ value: x.id, label: `${x.name}${role ? '' : ` · ${ROLE_NAME[x.role] ?? ''}`}` })),
  ];
  return (
    <div className="mt-dash qt-dash">
      <PeriodBar period={period} setPeriod={setPeriod}>
        {teamView && options.length > 1 && <Picker value={pid ?? ''} onChange={setWho} title="Team member" options={options} />}
        <button type="button" className="mt-btn mt-btn-primary pm-excel" onClick={excel} disabled={busy}><Icon d={I.down} size={17} /> {busy ? 'Preparing…' : 'Excel'}</button>
        {err && <span className="mt-err pm-excel-err" role="alert">{err}</span>}
      </PeriodBar>
      {!watcher && (
        <section className="panel mt-panel qt-work-now">
          <h3 className="qt-panel-h">Your work now</h3>
          <div className="qt-work-tiles">
            <button type="button" className="qt-work-tile" data-k="accept" data-on={work.accept ? 'true' : undefined} onClick={() => onGo('accept')}>
              <span className="qt-work-l"><Icon d={I.hourglass} size={14} />To accept</span>
              <b><CountUp n={work.accept} /></b>
            </button>
            <button type="button" className="qt-work-tile" data-k="mine" data-on={work.doing ? 'true' : undefined} onClick={() => onGo('mine')}>
              <span className="qt-work-l"><Icon d={I.check} size={14} />With you</span>
              <b><CountUp n={work.doing} /></b>
            </button>
          </div>
        </section>
      )}
      {!p ? <div className="loader" aria-hidden="true" /> : (
        <>
          {pid !== me.id && <p className="qt-dash-who" data-role={sel?.role ?? role ?? undefined}>{pid === 'all' ? (role ? `${ROLE_NAME[role]} team` : 'Everybody') : `${sel?.name ?? ''} · ${ROLE_NAME[sel?.role] ?? ''}`}</p>}
          {/* Everybody: the requests themselves; one person: their part (the user, 11 Nov). */}
          {pid === 'all' ? (
            <div className="qt-dash-tiles">
              <Tile k="handled" id="total" label="Total" n={tot.all} sub="requests" />
              <Tile k="done" id="closed" label="Closed" n={tot.closed} sub="requests" />
              <Tile k="pending" id="open" label="Open" n={tot.open} sub="requests" />
              <div className="qt-tile" data-k="pct" data-tone={pctTone(tot.pct)}><span>Completed</span><b>{tot.pct == null ? '—' : <><CountUp n={tot.pct} />%</>}</b><small>{tot.closed} of {tot.all}</small></div>
            </div>
          ) : (
            <div className="qt-dash-tiles">
              <Tile k="handled" id="total" label="Total" n={p.total} sub="requests" />
              <Tile k="done" id="closed" label="Closed" n={p.done} sub={pid === me.id ? 'my part done' : 'their part done'} />
              <Tile k="pending" id="open" label="Open" n={p.pending} sub={pid === me.id ? 'pending with me' : 'pending with them'} />
              <div className="qt-tile" data-k="pct" data-tone={pctTone(p.donePct)}><span>Completed</span><b>{p.donePct == null ? '—' : `${p.donePct}%`}</b><small>{p.done} of {p.done + p.pending}</small></div>
            </div>
          )}
          {p.byStatus.length > 0 && (
            <section className="panel mt-panel">
              <h3 className="qt-panel-h">Pending by status</h3>
              <div className="qt-dash-chips">
                {p.byStatus.map(([k, v]) => <span key={k} className="qt-dash-chip" data-tone={v.tone}>{k}<b>{v.n}</b></span>)}
                {pid === me.id && work.accept > 0 && (
                  <button type="button" className="qt-pending-chip qt-dash-accept" onClick={() => onGo('accept')}><Icon d={I.hourglass} size={13} />{work.accept} to accept</button>
                )}
              </div>
            </section>
          )}

          <section className="panel mt-panel">
            <h3 className="qt-panel-h">TAT at each stage{p.onTime != null && <span className="qt-panel-sub" data-tone={pctTone(p.onTime)}> · {p.onTime}% on time</span>}</h3>
            {!p.rows.length ? <p className="empty-inline">Nothing in this period.</p> : (
              <>
                <TatGraph rows={p.rows} targets={targets} />
                <div className="qt-dash-stages">
                  {p.rows.map((s) => {
                    const n = s.accN + s.proN; const ok = s.accOk + s.proOk; const pc = n ? Math.round((ok / n) * 100) : null;
                    return (
                      <div key={s.step} className="qt-dash-stage" data-tone={STEPS[s.step].tone}>
                        <span className="qt-dash-stage-name">{workOf(s.step)}</span>
                        <span className="qt-dash-kv"><span>Accept</span><b>{avg(s.acc, s.accN)}</b></span>
                        <span className="qt-dash-kv"><span>Process</span><b>{avg(s.pro, s.proN)}</b></span>
                        <span className="qt-dash-ontime" data-tone={pctTone(pc)}>
                          <span className="qt-rt-bar"><i style={{ width: `${pc ?? 0}%` }} /></span>
                          <span>{pc == null ? '—' : `${ok} of ${n} · ${pc}% on time`}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          {teamView && rows.length > 0 && (
            <section className="panel mt-panel">
              <h3 className="qt-panel-h">Team</h3>
              <div className="qt-dash-team">
                <div className="qt-dash-team-row is-head"><span>Person</span><span>Closed</span><span>Open</span><span>Completed</span><span>On time</span></div>
                {rows.map((x) => (
                  <button key={x.id} type="button" className="qt-dash-team-row" data-role={x.role ?? undefined} aria-pressed={x.id === pid} onClick={() => setWho(x.id)}>
                    <span className="qt-dash-team-name">{x.name}<small>{ROLE_NAME[x.role] ?? ''}</small></span>
                    <span>{x.done}</span><span>{x.pending}</span>
                    <span data-tone={pctTone(x.donePct)}>{x.donePct == null ? '—' : `${x.donePct}%`}</span>
                    <span data-tone={pctTone(x.onTime)}>{x.onTime == null ? '—' : `${x.onTime}%`}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ========================================================== hospitals == */

function Hospitals() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [edit, setEdit] = useState(null);
  const load = () => loadFacilities().then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const states = useMemo(() => [{ value: '', label: 'Every state' }, ...[...new Set((rows ?? []).map((r) => r.state))].sort().map((s) => ({ value: s, label: s }))], [rows]);
  const shown = (rows ?? []).filter((r) => (!state || r.state === state) && (!q || `${r.name} ${r.district} ${r.state}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="mt-tickets">
      <div className="mt-filters qt-filters">
        <Search value={q} onChange={setQ} placeholder="Hospital, district" />
        <Picker value={state} options={states} onChange={setState} title="State" />
        <button type="button" className="mt-btn mt-btn-primary" onClick={() => setEdit({ state: '', district: '', name: '', category: 'AMC' })}><Icon d={I.plus} size={16} /> Hospital</button>
      </div>
      {!rows ? <div className="loader" aria-hidden="true" /> : (
        <ul className="qt-rows">
          {shown.map((r) => (
            <li key={r.id}><button type="button" onClick={() => setEdit(r)}>
              <strong>{r.name}</strong><span>{[r.district, r.state].filter(Boolean).join(', ')}</span><span className="qt-badge" data-tone={r.category === 'AMC' ? 'blue' : 'violet'}>{r.category}</span>
              {r.updated_by ? <small>Changed by {r.updated_by} · {dayText(r.updated_at)}</small> : r.created_by ? <small>Added by {r.created_by} · {dayText(r.created_at)}</small> : null}
            </button></li>
          ))}
        </ul>
      )}
      {edit && <HospitalEdit f={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function HospitalEdit({ f, onClose, onDone }) {
  const [v, setV] = useState(f);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const go = async () => { setBusy(true); setErr(null); try { await saveFacility(v); onDone(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return createPortal(
    <div className="modal-scrim qt-scrim-top" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal mt-modal" role="dialog" aria-label="Hospital">
        <div className="modal-head"><h2>{f.id ? 'Change hospital' : 'Add hospital'}</h2></div>
        <div className="modal-body qt-modal-body">
          <Field label="Hospital name"><input value={v.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <div className="pm-in-row">
            <Field label="State"><input value={v.state} onChange={(e) => set('state', e.target.value)} /></Field>
            <Field label="District"><input value={v.district} onChange={(e) => set('district', e.target.value)} /></Field>
          </div>
          <Choice value={v.category} onChange={(x) => set('category', x)} options={[['AMC', 'AMC'], ['CAMC', 'CAMC'], ['CAMC & AMC', 'Both']]} />
          {err && <p className="mt-err" role="alert">{err}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="mt-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="mt-btn mt-btn-primary" onClick={go} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>, document.body);
}

/* ============================================================ settings == */

function Settings({ targets, onDone }) {
  const [t, setT] = useState(() => Object.fromEntries(TAT_STEPS.map((k) => [k, { accept_h: targets[k]?.accept_h ?? 4, process_h: targets[k]?.process_h ?? 24 }])));
  const [ask, box] = useAsk();
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [add, setAdd] = useState(null);
  const loadP = () => loadPeople().then(setPeople).catch(() => setPeople([]));
  useEffect(() => { loadP(); }, []);
  const tls = (people ?? []).filter((p) => p.role === 'team_lead');
  const shown = (people ?? []).filter((p) => !q || `${p.name} ${p.ecode} ${ROLE_NAME[p.role]}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="qt-settings">
      <section className="panel mt-panel">
        <h3 className="qt-panel-h">Targets (hours)</h3>
        <div className="qt-targets">
          <span /><span className="qt-target-h">Accept</span><span className="qt-target-h">Process</span>
          {TAT_STEPS.map((k) => (
            <div key={k} className="qt-target-row">
              <span>{STEPS[k].label}</span>
              <input type="number" inputMode="decimal" min="0.5" step="0.5" value={t[k].accept_h} onChange={(e) => setT((o) => ({ ...o, [k]: { ...o[k], accept_h: e.target.value } }))} aria-label={`${STEPS[k].label} accept hours`} />
              <input type="number" inputMode="decimal" min="0.5" step="0.5" value={t[k].process_h} onChange={(e) => setT((o) => ({ ...o, [k]: { ...o[k], process_h: e.target.value } }))} aria-label={`${STEPS[k].label} process hours`} />
            </div>
          ))}
        </div>
        <button type="button" className="mt-go" onClick={() => ask({ title: 'Save the targets?', lines: ['The clocks and the TAT use them from now.'], ok: 'Save', run: () => saveTargets(t), after: () => onDone('Targets saved.') })}>Save targets</button>
      </section>
      <section className="panel mt-panel">
        <h3 className="qt-panel-h">People</h3>
        <div className="mt-filters qt-filters">
          <Search value={q} onChange={setQ} placeholder="Name, E-code, role" />
          <button type="button" className="mt-btn mt-btn-primary" onClick={() => setAdd({ ecode: '', role: 'engineer', lead: false, team_lead_ecode: '' })}><Icon d={I.plus} size={16} /> Person</button>
        </div>
        {!people ? <div className="loader" aria-hidden="true" /> : (
          <ul className="qt-rows">
            {shown.map((p) => (
              <li key={p.employee_id}><button type="button" onClick={() => setAdd({ ecode: p.ecode, role: p.role, lead: p.lead, team_lead_ecode: tls.find((x) => x.employee_id === p.team_lead_id)?.ecode ?? '', employee_id: p.employee_id, name: p.name })}>
                <strong>{person(p.name, p.ecode)}</strong><span>{ROLE_NAME[p.role]}{p.lead ? ' · lead' : ''}{p.team_lead_name ? ` · Team Lead ${p.team_lead_name}` : ''}</span>
                {!p.active && <span className="qt-badge" data-tone="grey">Left</span>}
              </button></li>
            ))}
          </ul>
        )}
      </section>
      {add && <PersonEdit p={add} tls={tls} onClose={() => setAdd(null)} onDone={(m) => { setAdd(null); loadP(); onDone(m); }} />}
      {box}
    </div>
  );
}

function PersonEdit({ p, tls, onClose, onDone }) {
  const [v, setV] = useState(p);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sure, setSure] = useState(false);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const go = async (fn, msg) => { setBusy(true); setErr(null); try { await fn(); onDone(msg); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return createPortal(
    <div className="modal-scrim qt-scrim-top" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal mt-modal" role="dialog" aria-label="Person">
        <div className="modal-head"><h2>{p.employee_id ? p.name : 'Add person'}</h2></div>
        <div className="modal-body qt-modal-body">
          {!p.employee_id && <Field label="E-code"><input value={v.ecode} onChange={(e) => set('ecode', e.target.value.toUpperCase())} placeholder="E1234" /></Field>}
          <Choice value={v.role} onChange={(x) => set('role', x)} options={['engineer', 'team_lead', 'coordinator', 'purchase', 'pv', 'observer'].map((r) => [r, ROLE_NAME[r]])} />
          {v.role === 'engineer' && (
            <div className="pm-in"><span>Team Lead</span>
              <Picker value={v.team_lead_ecode} onChange={(x) => set('team_lead_ecode', x)} title="Team Lead"
                      options={[{ value: '', label: 'Reporting manager' }, ...tls.map((t) => ({ value: t.ecode, label: `${t.name} (${t.ecode})` }))]} />
            </div>
          )}
          {v.role === 'observer' && (
            <div className="pm-in"><span>Observes</span>
              <Picker value={v.observes ?? ''} onChange={(x) => set('observes', x || null)} title="Observes"
                      options={[{ value: '', label: 'Every team' }, ...['engineer', 'team_lead', 'coordinator', 'purchase', 'pv'].map((r) => ({ value: r, label: ROLE_NAME[r] }))]} />
            </div>
          )}
          {(v.role === 'coordinator' || v.role === 'purchase') && (
            <label className="qt-check"><input type="checkbox" checked={v.lead} onChange={(e) => set('lead', e.target.checked)} /> Lead (sees settings and people)</label>
          )}
          {err && <p className="mt-err" role="alert">{err}</p>}
        </div>
        <div className="modal-foot">
          {p.employee_id && (sure
            ? <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => go(() => removePerson(p.employee_id), `${p.name} removed.`)} disabled={busy}>Remove {p.name}?</button>
            : <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => setSure(true)} disabled={busy}>Remove</button>)}
          <button type="button" className="mt-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="mt-btn mt-btn-primary" onClick={() => go(() => savePerson(v), 'Saved.')} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>, document.body);
}
