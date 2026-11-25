import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SideNav from './SideNav.jsx';
import Picker from './Picker.jsx';
import { ProjectMasthead } from './ProjectHome.jsx';
import { supabase } from '../data/supabase.js';
import {
  loadList, loadOne, loadFacilities, loadEquipmentAt, loadPeople, loadTargets, loadEvents,
  raise, raiseStock, accept, tlApprove, tlDecline, editOwn, reopen, addNote, pingNote, transfer, consume, resume, act,
  saveFacility, savePerson, removePerson, saveTargets, uploadPhoto, photoUrl, exportAll, tatOf, statusOf, findPerson, workOf,
  STEPS, stepOf, isCamc, roleOfStep, ACTIONS, TAT_STEPS, NO_ACCEPT, clockOf, spanText, dayText, whenText, todayIst,
  periodRange, money, withTax, person, nextQtn, releaseQtn, loadQuotes, saveQuote, deleteQuote, loadMyReportees, loadTemplates, deleteTemplate, templateBlob, saveTemplate, templateName, templateArt,
  loadBarcodeCounts, loadBarcodeHistory,
} from '../data/quotation.js';
import { nameBoxes } from '../data/quoteAi.js';
import { markYellow, readYellow, readTerms, fillYellow, startValue, clientFrom, totalsOf, itemsOf, fromRequest, rolesOf, oneBoxPerCell } from '../data/yellowDoc.js';
import { readLayout, makeLayoutPdf, layoutTotals, qtyCol, upgradeLayout } from '../data/quoteLayout.js';
import { readQuoteFile, qtnKey, loadPdf } from '../data/quoteRead.js';
import { makeQuotePdf, quoteTotals, inWords, quoteFileName, DEFAULT_TERMS, DEFAULT_SUBJECT } from '../data/quoteMake.js';
import { readGrid } from '../data/readSheet.js';
import { fillWord } from '../data/quoteWord.js';
import { readBlanks, fillBlanks, cleanYellow } from '../data/quoteBlanks.js';
import { writeBook, saveBlob } from '../data/xlsx.js';
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

const PERIODS = [['all', 'All time'], ['month', 'This month'], ['custom', 'Custom']];
const SEND_BY = ['Courier', 'Transport', 'Post', 'By hand'];
const TAXES = [0, 5, 18]; // 12 and 28 not used (the user, 12 Nov)
const PV_ABOVE = 40000;
/** What every form may want from the app: past vendors, recent hospitals, who is signed in. */
const QtCtx = createContext({ vendors: [], recent: [], code: '', lead: false, pools: {}, repeats: {}, openReq: null, role: '' });
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* the draft is only lost on reload */ } },
};
const ROLE_NAME = { engineer: 'Engineer', team_lead: 'Team Lead', coordinator: 'Coordinator', purchase: 'Purchase', pv: 'PV', observer: 'Observer', maker: 'Quotation maker', viewer: 'Viewer' };

/*
  The quotation creator (Create quotation, Quotations, Quotation templates) for test accounts only while it is rebuilt
  (the user, 19 Nov: "remove quotation creator for all, except test"). Attaching a quotation file is for everybody.
*/
export const canMakeQuotes = (profile) => /^E(6666|7777|8888|9999)$/i.test(profile?.code ?? '') || /-\s*test\b/i.test(profile?.full_name ?? '');

function tabsFor(me) {
  const r = me.role;
  if (r === 'maker') return [{ id: 'quotations', label: 'Quotations', short: 'Quotations' }, { id: 'templates', label: 'Quotation templates', short: 'Templates' }]; const t = [{ id: 'dashboard', label: 'Dashboard', short: 'Dashboard' }, { id: 'requests', label: 'Requests', short: 'Requests' }];
  if (r === 'engineer' || r === 'team_lead') t.push({ id: 'new', label: 'New request', short: 'New' });
  if (r === 'coordinator') t.push({ id: 'new', label: 'Stock request', short: 'Stock req' });
  t.push({ id: 'stock', label: 'Stock register', short: 'Stock' });
  if (r === 'coordinator' || me.lead) t.push({ id: 'hospitals', label: 'Hospitals', short: 'Hospitals' });
  if ((r === 'coordinator' || me.lead) && me.make) t.push({ id: 'quotations', label: 'Quotations', short: 'Quotations' }, { id: 'templates', label: 'Quotation templates', short: 'Templates' });
  // Settings (the targets): SW Admin only (0066; the user, 18 Nov: "not needed for pur, tl, pv, only sw admin").
  if (me.admin) t.push({ id: 'settings', label: 'Settings', short: 'Settings' });
  return t;
}

export default function QuotationApp({ me: meIn, profile, narrow, switcher, onSignOut }) {
  // Every coordinator makes quotations again (the user, 23 Nov: "ok every coordinator"); makers and leads stay test-only.
  // Everybody with a quotation role (the user, 24 Nov: "all changes in quotation should be for all"): makers, coordinators, leads.
  const me = useMemo(() => ({ ...meIn, make: canMakeQuotes(profile) || ['coordinator', 'maker'].includes(meIn?.role) || Boolean(meIn?.lead) }), [meIn, profile]);
  // The open tab rides in the address (?tab=), so a reload stays on it (the user, 19 Nov).
  const [tab, setTabRaw] = useState(() => {
    const t = new URL(window.location.href).searchParams.get('tab');
    return t && tabsFor(me).some((x) => x.id === t) ? t : (me.role === 'maker' ? 'quotations' : 'dashboard');
  });
  const setTab = (t) => {
    setTabRaw(t);
    const u = new URL(window.location.href); u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  const [period, setPeriod] = useState({ id: 'all', from: '', to: '' });
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
  /** Received spares per barcode (BEMMP 0071), fresh with the list. */
  const [repeats, setRepeats] = useState({});
  useEffect(() => { loadBarcodeCounts().then((x) => setRepeats(x ?? {})).catch(() => {}); }, [list]);
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
    return { vendors, recent: [...new Set(seen)].slice(0, 5), code, lead: Boolean(me.lead), pools, repeats, openReq: open, role: me.role, make: me.make };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, code, me.role, me.lead, me.make, pools, repeats]);
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
              {tab === 'quotations' && <Quotations me={me} onToast={setToast} />}
              {tab === 'templates' && <Templates me={me} onToast={setToast} />}
              {tab === 'settings' && <Settings me={me} targets={targets} onDone={done} />}
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
  pen: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  box: <><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9" /></>,
  doc: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  revise: <><path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3" /><rect x="3" y="8" width="13" height="13" rx="2" /><path d="M9.5 11.5v6M6.5 14.5h6" /></>,
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
    <button type="button" className="qt-thumb" onClick={() => url && onOpen()} aria-label="See the photo">
      {pdf ? <span className="qt-thumb-pdf">PDF</span> : url ? <img src={url} alt="" onError={() => { if (!retried.current) { retried.current = true; photoUrl(path, true).then(setUrl).catch(() => {}); } }} /> : <span className="qt-thumb-wait" />}
    </button>
  );
}

/** One group's photos (spare, equipment, slips); a press opens the viewer on that group only (the user, 14 Nov). */
function Photos({ paths, name }) {
  const [at, setAt] = useState(null);
  const [pdf, setPdf] = useState(null);
  if (!paths?.length) return null;
  const pics = paths.filter((p) => !/\.pdf$/i.test(p));
  return (
    <>
      <div className="qt-thumbs">{paths.map((p) => <Thumb key={p} path={p} onOpen={() => (/\.pdf$/i.test(p) ? setPdf(p) : setAt(pics.indexOf(p)))} />)}</div>
      {at != null && at >= 0 && <Viewer paths={pics} start={at} name={name} onClose={() => setAt(null)} />}
      {pdf && <PdfViewer path={pdf} name={name ?? 'file'} onClose={() => setPdf(null)} />}
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

/* ===================================================== quotations (0055) == */

const isPdf = (p) => /\.pdf$/i.test(p ?? '');
const isDocx = (p) => /\.docx$/i.test(p ?? '');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SomeViewer = ({ word, ...p }) => (word ? <DocxViewer {...p} /> : <PdfViewer {...p} />);
/*
  The PDF beside the Word file, drawn here in the browser from the filled Word itself (its page, letterhead pictures, fonts,
  sizes, tables and wording): close to Word, not a copy of it (the user, 19 Nov: on save "drew its own in browser and save
  both word n pdf"). No server. When it cannot be drawn, the Word file is shown and kept alone.
*/
const drawnPdf = async (docx) => makeLayoutPdf({ items: [] }, (await readLayout(docx, { asIs: true })).layout, templateArt);
const wordShown = async (blob) => { try { return { blob: await drawnPdf(blob) }; } catch { return { blob, word: true }; } };

/*
  A Word quotation shown as Word lays it out (docx-preview), with Download; the customer's file itself is what is kept
  and downloaded (the user, 19 Nov: "if anything changes customer will make problem").
*/
function DocxViewer({ path, blob, name, onClose, actions }) {
  const box = useRef(null);
  const [file, setFile] = useState(blob ?? null);
  const [fail, setFail] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const b = blob ?? await (await fetch(await photoUrl(path))).blob(); if (!on) return; setFile(b);
        const { renderAsync } = await import('docx-preview');
        if (box.current) {
          box.current.innerHTML = '';
          await renderAsync(b, box.current, null, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true });
          // A letterhead drawn as one page-sized picture (Sub AMC): laid on each page from its corner, behind the text.
          for (const page of box.current.querySelectorAll('section.docx')) {
            const pw = page.getBoundingClientRect().width;
            for (const img of page.querySelectorAll('header img, footer img')) {
              if (img.getBoundingClientRect().width < pw * 0.8) continue;
              // The preview does not always break pages where Word does: the picture repeats every A4 page.
              const ph = pw * (297 / 210);
              Object.assign(page.style, { backgroundImage: `url("${img.src}")`, backgroundSize: `100% ${ph}px`, backgroundRepeat: 'repeat-y', backgroundPosition: '0 0' });
              (img.closest('div[style*="position"]') ?? img).remove();
            }
          }
        }
      } catch { if (on) setFail(true); }
    })();
    return () => { on = false; };
  }, [path, blob]);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    const was = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = was; };
  }, [onClose]);
  const download = async () => {
    if (!file) return; setBusy(true);
    const href = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = href; a.download = `${fileName(name)}.docx`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000); setBusy(false);
  };
  return createPortal(
    <div className="qt-lightbox qt-pdfbox qt-docxbox" role="dialog" aria-label="Quotation">
      <div className="qt-lb-bar">
        <button type="button" className="mt-sheet-x qt-lb-btn" disabled={!file || busy} onClick={download} aria-label="Download" title="Download"><Icon d={I.down} size={19} /></button>
        <button type="button" className="mt-sheet-x qt-lb-btn" onClick={onClose} aria-label="Close" title="Close"><Icon d={I.x} size={20} /></button>
      </div>
      <div className="qt-pdf-pages qt-docx-pages">
        {fail ? <p className="qt-pdf-msg">This Word file could not be opened.</p> : <div ref={box} className="qt-docx-doc"><span className="qt-thumb-wait" /></div>}
      </div>
      {actions && <div className="qt-pdf-acts">{actions}</div>}
    </div>, document.body);
}
const fileName = (s) => String(s || 'file').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

/** Save what a link points at under our own name (a cross-origin link would only open). */
async function saveAs(url, name) {
  try {
    const blob = await (await fetch(url)).blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
  } catch { window.open(url, '_blank', 'noopener'); }
}

/**
  A PDF in the app's own pop-up, never a new tab on the storage link (the user, 14 Nov: "why no pop up?"): every page
  down the screen, − / + or Ctrl + wheel or a pinch to zoom, download, close or Esc.
*/
function PdfViewer({ path, blob, name, onClose, actions }) {
  const [doc, setDoc] = useState(null);
  const [url, setUrl] = useState(null);
  const [fail, setFail] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const pinch = useRef(null);
  const zoomRef = useRef(1); zoomRef.current = zoom;
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const u = blob ? URL.createObjectURL(blob) : await photoUrl(path); if (!on) return; setUrl(u);
        const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
        const d = await loadPdf(buf); if (on) setDoc(d);
      } catch { if (on) setFail(true); }
    })();
    return () => { on = false; };
  }, [path, blob]);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    const was = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = was; };
  }, [onClose]);
  useEffect(() => {
    const el = box.current; if (!el) return undefined;
    const clamp = (z) => Math.min(4, Math.max(0.5, z));
    const wheel = (e) => { if (!e.ctrlKey) return; e.preventDefault(); setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); };
    const ts = (e) => { if (e.touches.length === 2) { const [a, b] = e.touches; pinch.current = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoomRef.current }; } };
    const tm = (e) => {
      if (!pinch.current || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      setZoom(clamp(pinch.current.z * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.current.d)));
    };
    const te = () => { pinch.current = null; };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('touchstart', ts, { passive: true });
    el.addEventListener('touchmove', tm, { passive: false });
    el.addEventListener('touchend', te);
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('touchstart', ts); el.removeEventListener('touchmove', tm); el.removeEventListener('touchend', te); };
  }, []);
  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [];
  return createPortal(
    <div className="qt-lightbox qt-pdfbox" role="dialog" aria-label="Quotation">
      <div className="qt-lb-bar">
        {doc && <span className="qt-lb-count">{doc.numPages} {doc.numPages === 1 ? 'page' : 'pages'}</span>}
        <button type="button" className="mt-sheet-x qt-lb-btn" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} aria-label="Smaller" title="Smaller"><Icon d={<path d="M6 12h12" />} size={19} /></button>
        <button type="button" className="mt-sheet-x qt-lb-btn" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} aria-label="Bigger" title="Bigger"><Icon d={I.plus} size={19} /></button>
        <button type="button" className="mt-sheet-x qt-lb-btn" disabled={!url || busy} onClick={async () => { setBusy(true); await saveAs(url, `${fileName(name)}.pdf`); setBusy(false); }} aria-label="Download" title="Download"><Icon d={I.down} size={19} /></button>
        <button type="button" className="mt-sheet-x qt-lb-btn" onClick={onClose} aria-label="Close" title="Close"><Icon d={I.x} size={20} /></button>
      </div>
      <div ref={box} className="qt-pdf-pages">
        {fail ? <p className="qt-pdf-msg">This PDF could not be opened.</p>
          : !doc ? <span className="qt-thumb-wait" />
            : pages.map((n) => <PdfPage key={n} doc={doc} n={n} zoom={zoom} />)}
      </div>
      {actions && <div className="qt-pdf-acts">{actions}</div>}
    </div>, document.body);
}

function PdfPage({ doc, n, zoom }) {
  const ref = useRef(null);
  const [w, setW] = useState(() => Math.min(900, window.innerWidth - 24));
  useEffect(() => { const f = () => setW(Math.min(900, window.innerWidth - 24)); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  useEffect(() => {
    let task; let on = true;
    (async () => {
      const page = await doc.getPage(n); if (!on) return;
      const css = w * zoom; const dpr = Math.min(3, window.devicePixelRatio || 1);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (css * dpr) / v1.width });
      const c = ref.current; if (!c) return;
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      c.style.width = `${css}px`; c.style.height = `${(css * vp.height) / vp.width}px`;
      task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
      try { await task.promise; } catch { /* a newer zoom replaced it */ }
    })();
    return () => { on = false; task?.cancel?.(); };
  }, [doc, n, zoom, w]);
  return <canvas ref={ref} className="qt-pdf-page" />;
}

/** Whatever a file is: a PDF in the PDF pop-up, a Word file in the Word pop-up, a photo in the photo viewer. */
function FileView({ path, name, onClose }) {
  if (isDocx(path)) return <DocxViewer path={path} name={name} onClose={onClose} />;
  return isPdf(path) ? <PdfViewer path={path} name={name} onClose={onClose} /> : <Viewer paths={[path]} start={0} name={name} onClose={onClose} />;
}

/**
  Quotations or signed copies to attach, as many as there are (the user, 14 Nov: "dont keep quotation upload limit").
  Each is read as it is added (QTN number, To, total; a signed copy only its number) and uploaded beside it.
*/
function QuoteAdd({ folder, files, onChange, signed = false, label = 'Attach', createLabel = 'Create', onCreate, onEdit, onRemove, drafts = [], onDraft, onDropDraft }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const latest = useRef(files); latest.current = files;
  const add = async (list) => {
    setErr(null);
    const picked = [...list];
    if (input.current) input.current.value = '';
    setBusy((b) => b + picked.length);
    await Promise.all(picked.map(async (f) => {
      try {
        const [read, path] = await Promise.all([readQuoteFile(f, { signed }), uploadPhoto(folder, f)]);
        latest.current = [...latest.current, { path, ...read }];
        onChange(latest.current);
      } catch (e) { setErr(e.message); } finally { setBusy((b) => b - 1); }
    }));
  };
  return (
    <div className="qt-qadd">
      {files.map((f) => (
        <div key={f.path} className="qt-qadd-row">
          <button type="button" className="qt-qfile-ico" onClick={() => setOpen(f.path)} aria-label="See it">{isPdf(f.path) ? 'PDF' : isDocx(f.path) ? 'W' : <Icon d={I.camera} size={16} />}</button>
          <button type="button" className="qt-qadd-text" onClick={() => setOpen(f.path)}>
            <b>{f.qtn_no ?? (signed ? 'Signed copy' : 'Quotation')}</b>
            <span>{[!signed && f.qtn_to, !signed && f.total != null && money(f.total), !f.qtn_no && 'QTN number not read'].filter(Boolean).join(' · ')}</span>
          </button>
          {f.doc && onEdit && <button type="button" className="qt-qadd-x" onClick={() => onEdit(f)} aria-label="Edit" title="Edit"><Icon d={I.pen} size={14} /></button>}
          <button type="button" className="qt-qadd-x" onClick={() => (onRemove ? onRemove(f) : onChange(files.filter((x) => x.path !== f.path)))} aria-label="Remove"><Icon d={I.x} size={14} /></button>
        </div>
      ))}
      {drafts.map((x) => <DraftRow key={x.id} d={x.d} onOpen={() => onDraft(x)} onDrop={() => onDropDraft(x)} />)}
      {/* Create in the app, or attach one made elsewhere (the user, 16 Nov: "attach or prepare/create, something logical"). */}
      <div className={onCreate ? 'qt-qadd-two' : 'qt-qadd-one'}>
        {onCreate && (
          <button type="button" className="qt-camera qt-qadd-btn qt-qadd-make" onClick={onCreate} disabled={busy > 0}>
            <Icon d={createLabel === 'Create' ? I.doc : I.revise} size={18} /><span>{createLabel}</span>
          </button>
        )}
        <button type="button" className="qt-camera qt-qadd-btn" onClick={() => input.current?.click()} disabled={busy > 0}>
          <Icon d={I.plus} size={18} /><span>{busy > 0 ? `Reading ${busy}…` : files.length && !onCreate ? 'Add more' : label}</span>
        </button>
      </div>
      <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => e.target.files?.length && add(e.target.files)} />
      {err && <p className="mt-err qt-err" role="alert">{err}</p>}
      {open && <FileView path={open} name={files.find((x) => x.path === open)?.qtn_no ?? 'quotation'} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The spare as the quotation names it: "US probe for BPL CTG machine". */
const spareLine = (r) => `${r.spare ?? ''}${r.part_no ? ` (${r.part_no})` : ''}${[r.make, r.model, r.equipment].some(Boolean) ? ` for ${[r.make, r.model, r.equipment].filter(Boolean).join(' ')}` : ''}`.trim();

/** A quotation being made, kept on this device until it is saved or deleted (the user, 16 Nov: "if by mistake back, need draft"). */
const draftKey = (id) => `qt-quote-draft:${id}`;
const quoteDraft = {
  get: (id) => store.get(draftKey(id)),
  set: (id, d) => store.set(draftKey(id), d),
  drop: (id) => store.set(draftKey(id), null),
  /** One draft per template (the user, 19 Nov: "other templates draft shouldnt affect this"): "<base>~<template file>". */
  idFor: (base, tpl) => (tpl?.path ? `${base}~${tpl.path}` : base),
  /** Every draft kept under base; a draft from before (one per base) moves to its template's own place. */
  all(base) {
    const out = [];
    try {
      const old = store.get(draftKey(base));
      if (old?.tplPath) {
        const to = draftKey(`${base}~${old.tplPath}`);
        if (!store.get(to)) store.set(to, old);
        store.set(draftKey(base), null);
      }
      const pre = draftKey('');
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith(pre)) continue;
        const id = k.slice(pre.length);
        if (id !== base && !id.startsWith(`${base}~`)) continue;
        const d = store.get(k); if (d) out.push({ id, d });
      }
    } catch { /* no storage: no drafts */ }
    return out;
  },
};

/** Whether anything was typed or picked in a box while the form is open (the user, 19 Nov: opening and closing is no
    draft; a single character entered is). A draft continued is one already. */
function useTyped(already) {
  const t = useRef(Boolean(already));
  useEffect(() => {
    const on = () => { t.current = true; };
    document.addEventListener('input', on, true); document.addEventListener('change', on, true);
    return () => { document.removeEventListener('input', on, true); document.removeEventListener('change', on, true); };
  }, []);
  return t;
}

/** A draft waiting: continue (pen or its words) or delete (x). */
function DraftRow({ d, onOpen, onDrop, className = '' }) {
  return (
    <div className={`qt-qadd-row qt-qadd-draft ${className}`.trim()}>
      <button type="button" className="qt-qfile-ico" onClick={onOpen} aria-label="Continue the draft"><Icon d={I.pen} size={16} /></button>
      <button type="button" className="qt-qadd-text" onClick={onOpen}>
        <b>{['Draft', d.tpl, d.qtn_no].filter(Boolean).join(' · ')}</b>
        <span>{[d.to, `${d.items?.length ?? 0} ${d.items?.length === 1 ? 'item' : 'items'}`, money(docGrand(d))].filter(Boolean).join(' · ')}</span>
      </button>
      <button type="button" className="qt-qadd-x" onClick={onDrop} aria-label="Delete the draft" title="Delete the draft"><Icon d={I.x} size={14} /></button>
    </div>
  );
}

/**
  The quotation made in the app (the user, 16 Nov): the company letter with the items as their Excel had them, edited and
  added to before the PDF is made. Saving gives the next QTN number (kept when the same quotation is edited again before it
  is submitted; an earlier, submitted one comes back as a revision, R1, R2…) and attaches the PDF like an uploaded one.
  Every change is kept as a draft, so closing it by mistake loses nothing. On a computer the items are rows of a table and
  the totals stay beside them.
*/
/**
  A request's quotation shows its QTN number from the start, the next of the series, and it can be changed (the user,
  18 Nov: "for suhail show the quot number he can edit"). A number held and not used goes back to the series.
*/
function useHeldQtn(r, q, set) {
  const held = useRef(null);
  useEffect(() => {
    if (r.free || q.qtn_no) return undefined;
    let on = true;
    nextQtn().then((n) => {
      if (!on) { releaseQtn(n).catch(() => {}); return; }
      held.current = n; set('qtn_no', n);
    }).catch(() => {});
    return () => { on = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (used) => { if (held.current && held.current !== used) releaseQtn(held.current).catch(() => {}); held.current = null; };
}

/** A Word template's quotation in its own layout; otherwise Spares Quotation. */
function QuoteMaker(props) {
  const s = props.start;
  if (s?.tpl?.layout?.v === 2 || s?.doc?.v === 2 || s?.draft?.v === 2) return <YellowMaker {...props} />;
  return s?.tpl?.layout || s?.doc?.layout || s?.draft?.layout ? <LayoutMaker {...props} /> : <SparesMaker {...props} />;
}

function SparesMaker({ r, pick, start, onClose, onMade }) {
  const cost = pick === 'original' ? r.orig_rate : r.comp_rate ?? r.orig_rate;
  const tax = pick === 'original' ? r.orig_tax : r.comp_tax ?? r.orig_tax;
  const [q, setQ] = useState(() => {
    const d = start?.draft ?? null;
    const approved = cost != null ? String(Number(cost)) : '';
    if (d) return { ...d, items: d.items.map((it, n) => ({ ...it, cost: it.cost ?? (n === 0 ? approved : ''), margin: it.margin && it.margin !== '0' ? it.margin : '', price: n === 0 && !it.price ? approved : it.price })) };
    const s = start?.doc;
    return s ? {
      qtn_no: s.qtn_no ?? null, date: s.date ?? todayIst(), to: s.to ?? '', place: s.place ?? '', subject: s.subject ?? DEFAULT_SUBJECT,
      terms: (s.terms ?? DEFAULT_TERMS).join('\n'), path: start.path ?? null,
      items: (s.items ?? []).map((it) => ({ key: Math.random(), desc: it.desc ?? '', cost: it.cost != null ? String(it.cost) : '', margin: it.margin ? String(it.margin) : '',
        price: String(it.price ?? ''), qty: String(it.qty ?? 1), gst: String(it.gst ?? ''), whole: Boolean(it.whole) })),
    } : {
      qtn_no: null, path: null, date: todayIst(), to: r.hospital ?? '', place: r.district ?? '', subject: start?.tpl?.doc.subject ?? DEFAULT_SUBJECT, tpl: start?.tpl?.name ?? null,
      items: [{ key: Math.random(), desc: spareLine(r), cost: approved, margin: '', price: approved, qty: String(r.approved_qty ?? r.qty ?? 1), gst: tax != null ? String(Number(tax)) : '' }],
      terms: (start?.tpl?.doc.terms ?? DEFAULT_TERMS).join('\n'),
    };
  });
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [err, show, clear, at] = useErr();
  const typed = useTyped(start?.draft);
  useEffect(() => { if (typed.current) quoteDraft.set(r.id, q); }, [r.id, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setQ((o) => ({ ...o, [k]: v }));
  const settle = useHeldQtn(r, q, set);
  const setItem = (i, k, v) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, [k]: v } : it)) }));
  const totals = quoteTotals(q.items);
  // Margin and unit price follow each other: a margin gives the price from the cost, a price shows its margin.
  const r2 = (n) => String(Math.round(n * 100) / 100);
  const priceOf = (c, m) => r2(Number(c) * (1 + (Number(m) || 0) / 100));
  const marginOf = (c, p) => {
    if (!(Number(c) > 0) || p === '') return '';
    const m = Math.round((Number(p) / Number(c) - 1) * 1000) / 10;
    return m ? String(m) : '';
  };
  const setMargin = (i, m) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, margin: m, price: Number(it.cost) > 0 ? priceOf(it.cost, m) : it.price } : it)) }));
  const setCost = (i, c) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, cost: c, price: Number(c) > 0 ? priceOf(c, it.margin) : it.price } : it)) }));
  const setPrice = (i, p) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, price: p, margin: marginOf(it.cost, p) } : it)) }));
  const [marginAll, setMarginAll] = useState('');
  /*
    Items from Excel (the user, 19 Nov: "where is excel upload option for equipments?"): Description, Qty, Unit price or
    Total price, GST %, Cost. A Total price column makes those rows total-priced. Excel format gives the headings.
  */
  const xlsIn = useRef(null);
  const SHEET = ['Description', 'Qty', 'Unit price', 'Total price', 'GST %', 'Cost'];
  const format = async () => saveBlob(await writeBook([{ name: 'Items', columns: SHEET.map((h, k) => ({ header: h, key: String(k), numeric: k > 0 })), rows: [] }]), 'Quotation items.xlsx');
  const fromExcel = async (f) => {
    clear();
    if (!f) return;
    try {
      const grid = await readGrid(f);
      const n = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');
      const find = (heads, re) => heads.findIndex((h) => re.test(h));
      let hi = -1; let at = null;
      for (let i = 0; i < Math.min(grid.length, 15); i++) {
        const h = grid[i].map(n);
        const m = { desc: find(h, /desc|item|equipment|particular|spare|name/), qty: find(h, /^(qty|quantity|nos|no?ofunits)/), unit: find(h, /unit|rate|^price$/),
          whole: find(h, /total|amount|value/), gst: find(h, /gst|tax/), cost: find(h, /cost/) };
        if (m.desc >= 0 && (m.unit >= 0 || m.whole >= 0)) { hi = i; at = m; break; }
      }
      if (hi < 0) { show('Headings not found. Use the Excel format: Description, Qty, Unit price or Total price, GST %.'); return; }
      const v = (g, k) => (k >= 0 ? String(g[k] ?? '').trim() : '');
      const num = (x) => x.replace(/[^0-9.]/g, '');
      const last = q.items[q.items.length - 1]?.gst ?? '';
      const rows = grid.slice(hi + 1).filter((g) => v(g, at.desc)).map((g) => {
        const whole = !num(v(g, at.unit)) && !!num(v(g, at.whole));
        const price = num(whole ? v(g, at.whole) : v(g, at.unit));
        const gst = num(v(g, at.gst).replace(/^0?\.(\d+)$/, (m0, d) => String(Number(`0.${d}`) * 100)));
        const c0 = num(v(g, at.cost));
        return { key: Math.random(), desc: v(g, at.desc), cost: c0, margin: c0 && price ? marginOf(c0, price) : '', price, qty: num(v(g, at.qty)) || '1', gst: gst || last, whole };
      });
      if (!rows.length) { show('No items under the headings.'); return; }
      const blank = (it) => !it.desc.trim() && !it.price;
      setQ((o) => ({ ...o, items: [...o.items.filter((it) => !blank(it)), ...rows] }));
    } catch (e) { show(e.message || 'This file could not be read.'); }
  };
  const applyAll = () => setQ((o) => ({ ...o, items: o.items.map((it) => (Number(it.cost) > 0 ? { ...it, margin: marginAll, price: priceOf(it.cost, marginAll) } : it)) }));
  const costed = q.items.filter((it) => Number(it.cost) > 0);
  const per = (it) => (it.whole ? 1 : Number(it.qty) || 0);
  const costSum = costed.reduce((t, it) => t + Number(it.cost) * per(it), 0);
  const marginSum = costed.reduce((t, it) => t + (Number(it.price || 0) - Number(it.cost)) * per(it), 0);
  const doc = (qtn) => ({
    qtn_no: qtn, date: q.date, to: q.to.trim(), place: q.place.trim(), subject: q.subject.trim() || DEFAULT_SUBJECT,
    // Cost and margin are kept with the quotation for the record; the PDF shows only the price.
    items: q.items.map(({ desc, cost, margin, price, qty, gst, whole }) => ({ desc: desc.trim(), price: Number(price), qty: Number(qty), gst: Number(gst), ...(whole ? { whole: true } : {}),
      ...(Number(cost) > 0 ? { cost: Number(cost), margin: Number(margin) || 0 } : {}) })),
    terms: q.terms.split('\n').map((t) => t.trim()).filter(Boolean),
  });
  const check = () => {
    if (r.free && !(q.qtn_no ?? '').trim()) return 'Write the QTN number.';
    if (!q.to.trim()) return 'Write the hospital the quotation is to.';
    if (!q.date) return 'Choose the quotation date.';
    if (!q.items.length) return 'Add an item.';
    for (const [n, it] of q.items.entries()) {
      const name = q.items.length > 1 ? ` of item ${n + 1}` : '';
      if (!it.desc.trim()) return `Write the description${name}.`;
      if (!(Number(it.price) > 0)) return `Write the ${it.whole ? 'total' : 'unit'} price${name}.`;
      if (!(Number(it.qty) >= 1)) return `Write the quantity${name}.`;
      if (it.gst === '' || it.gst == null) return `Choose the GST %${name}.`;
    }
    return null;
  };
  // Escape closes the preview first, then this (the draft stays); never the request behind it.
  useEffect(() => {
    const esc = (e) => { if (e.key !== 'Escape') return; e.stopImmediatePropagation(); if (preview) setPreview(null); else if (termsOpen) setTermsOpen(false); else if (!busy) onClose(); };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [preview, termsOpen, busy, onClose]);
  const run = async (save) => {
    clear();
    const bad = check(); if (bad) { show(bad); return; }
    setBusy(save ? 'save' : 'look');
    try {
      let qtn = q.qtn_no;
      if (r.free) qtn = (qtn ?? '').trim() || null;
      else if (save) { qtn = (qtn ?? '').trim() || await nextQtn(); set('qtn_no', qtn); }
      const d = doc(save ? qtn : (q.qtn_no ?? 'QTN number on saving'));
      const blob = await makeQuotePdf(d);
      // Save shows it first: Edit goes back to the form, Save keeps it (the user, 19 Nov).
      if (!save) { setPreview(blob); return; }
      const changes = docChanges(start?.base, d);
      if (changes && !changes.length) { show('Nothing is changed yet. Change the quotation to revise it.'); return; }
      setConfirm({ blob, d, qtn, total: totals.with, changes });
    } catch (e) { show(e.message || 'The quotation could not be made.'); } finally { setBusy(null); }
  };
  const [confirm, setConfirm] = useState(null);
  const keep = async () => {
    const { blob, d, qtn, total } = confirm;
    setBusy('save');
    try {
      const file = new File([blob], `${quoteFileName(d)}.pdf`, { type: 'application/pdf' });
      const path = await uploadPhoto(r.folder ?? r.id, file);
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      settle(qtn); setConfirm(null);
      onMade({ path, sha256: sha, qtn_no: qtn, qtn_to: d.to, total, date: d.date, doc: d }, q.path);
    } catch (e) { setConfirm(null); show(e.message || 'The quotation could not be saved.'); } finally { setBusy(null); }
  };
  const termList = q.terms.split('\n').map((t) => t.trim()).filter(Boolean);
  const terms = q.terms === '' ? [] : q.terms.split('\n');
  const setTerms = (list) => set('terms', list.join('\n'));
  // The description box as tall as its text.
  const fit = (el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; } };
  return createPortal(
    <div className={`mt-scrim qt-maker-scrim qt-app${r.free ? ' qt-maker-free' : ''}`}>
      <div className="mt-sheet qt-maker" role="dialog" aria-modal="true" aria-label="Create quotation">
        <header className="mt-sheet-head">
          <div className="mt-sheet-title">
            <h2>{(r.free ? r.editing : q.qtn_no) ? 'Edit quotation' : 'Create quotation'}</h2>
            <p>{[r.free ? (q.qtn_no || 'New quotation') : q.qtn_no ?? `${r.no} · ${r.spare}`, q.tpl].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="mt-sheet-x" onClick={onClose} disabled={!!busy} aria-label="Close"><Icon d={I.x} size={20} /></button>
        </header>
        <div className="mt-sheet-body qt-maker-body">
          <div className="qt-maker-main">
            <div className="qt-maker-to">
              {<Field label="QTN number"><input value={q.qtn_no ?? ''} onChange={(e) => set('qtn_no', e.target.value)} placeholder="QTN405/CHC/PVMP/2026-27" /></Field>}
              <Field label="To"><input value={q.to} onChange={(e) => set('to', e.target.value)} placeholder="Hospital" /></Field>
              <Field label="Place"><input value={q.place} onChange={(e) => set('place', e.target.value)} placeholder="Place" /></Field>
              <Field label="Date"><input type="date" value={q.date} max={todayIst()} onChange={(e) => set('date', e.target.value)} /></Field>
              <Field label="Subject"><input value={q.subject} onChange={(e) => set('subject', e.target.value)} placeholder={DEFAULT_SUBJECT} /></Field>
            </div>
            <div className="qt-maker-items">
              <div className="qt-maker-head" aria-hidden="true">
                <span>Sl No</span><span>Description</span><span>Cost</span><span>Margin %</span><span>Price</span><span>Qty</span><span>GST %</span><span>With GST</span><span />
              </div>
              {q.items.map((it, i) => (
                <section key={it.key} className="qt-maker-item">
                  <b className="qt-mi-n">{i + 1}<span className="qt-mi-word"> · Item</span></b>
                  <button type="button" className="qt-qadd-x qt-mi-x" onClick={() => set('items', q.items.filter((_, n) => n !== i))} aria-label={`Remove item ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>
                  <label className="pm-in qt-mi-desc"><span>Description</span>
                    <textarea ref={fit} rows={1} value={it.desc} onChange={(e) => { setItem(i, 'desc', e.target.value); fit(e.target); }} placeholder="Spare, accessory, labour…" />
                  </label>
                  {/* Without a request the maker types the cost (the user, 16 Nov: "where is margin?"). */}
                  {r.free ? (
                    <label className="pm-in qt-mi-cost qt-mi-cost-in"><span>{it.whole ? 'Total cost' : 'Unit cost'}</span>
                      <input inputMode="decimal" value={it.cost ?? ''} onChange={(e) => setCost(i, e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" />
                    </label>
                  ) : <p className="qt-mi-cost"><span>{it.whole ? 'Total cost' : 'Unit cost'}</span><b>{Number(it.cost) > 0 ? money(Number(it.cost)) : '—'}</b></p>}
                  {Number(it.cost) > 0 || r.free ? (
                    <label className="pm-in qt-mi-margin"><span>Margin %</span>
                      <input inputMode="decimal" value={it.margin ?? ''} onChange={(e) => setMargin(i, e.target.value.replace(/[^0-9.-]/g, ''))} placeholder="0" />
                    </label>
                  ) : <p className="qt-mi-margin qt-mi-none"><span>Margin %</span><b>—</b></p>}
                  <div className="qt-mi-whole"><Choice value={it.whole ? 'whole' : 'unit'} onChange={(x) => setItem(i, 'whole', x === 'whole')} options={[['unit', 'Unit price', 'good'], ['whole', 'Total price', 'good']]} /></div>
                  <label className="pm-in qt-mi-price"><span>{it.whole ? 'Total price' : 'Unit price'}</span>
                    <input inputMode="decimal" value={it.price} onChange={(e) => setPrice(i, e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" />
                  </label>
                  <label className="pm-in qt-mi-qty"><span>Qty</span>
                    <input inputMode="numeric" value={it.qty} onChange={(e) => setItem(i, 'qty', e.target.value.replace(/[^0-9]/g, ''))} placeholder="1" />
                  </label>
                  <div className="qt-mi-tax"><TaxChips value={it.gst} onChange={(v) => setItem(i, 'gst', v)} /></div>
                  <p className="qt-mi-tot"><span>Total with GST</span><b>{money(totals.lines[i].with) || '₹0'}</b></p>
                </section>
              ))}
              <button type="button" className="qt-camera qt-qadd-btn qt-maker-add" onClick={() => set('items', [...q.items, { key: Math.random(), desc: '', cost: '', margin: '', price: '', qty: '1', gst: q.items[q.items.length - 1]?.gst ?? '' }])}>
                <Icon d={I.plus} size={18} /><span>Add item</span>
              </button>
              <div className="qt-lm-excel">
                <button type="button" className="mt-btn" onClick={() => xlsIn.current?.click()}><Icon d={I.doc} size={16} />Upload Excel</button>
                <button type="button" className="mt-btn" onClick={format}><Icon d={I.down} size={16} />Excel format</button>
                <input ref={xlsIn} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { fromExcel(e.target.files?.[0]); e.target.value = ''; }} />
              </div>
            </div>
            {/* Terms on one line; pressed, a small pop-up to edit them (the user, 16 Nov: "dont show term fully, on click a small sub popup"). */}
            <button type="button" className="qt-maker-terms" onClick={() => setTermsOpen(true)}>
              <span>Terms and conditions</span><b>{termList.length} {termList.length === 1 ? 'term' : 'terms'}</b><Icon d={I.pen} size={15} />
            </button>
          </div>
          <aside className="qt-maker-side">
            <div className="qt-maker-sum">
              <p><span>Items</span><b>{q.items.length}</b></p>
              {costed.length > 0 && <>
                <p><span>Cost</span><b>{money(costSum) || '₹0'}</b></p>
                <p><span>Margin</span><b>{money(marginSum) || '₹0'} · {costSum ? Math.round((marginSum / costSum) * 1000) / 10 : 0}%</b></p>
              </>}
              <p><span>Total</span><b>{money(totals.total) || '₹0'}</b></p>
              <p><span>GST</span><b>{money(totals.tax) || '₹0'}</b></p>
              <p className="qt-maker-grand"><span>Grand total</span><b>{money(totals.with) || '₹0'}</b></p>
              <small>{inWords(totals.with)}</small>
            </div>
            {costed.length > 1 && (
              <div className="qt-maker-all">
                <label className="pm-in"><span>Margin on all, %</span>
                  <input inputMode="decimal" value={marginAll} onChange={(e) => setMarginAll(e.target.value.replace(/[^0-9.-]/g, ''))} placeholder="0" />
                </label>
                <button type="button" className="mt-btn" onClick={applyAll}>Apply</button>
              </div>
            )}
            <Err text={err} at={at} />
            <div className="qt-maker-go" data-role="engineer">
              <button type="button" className="mt-btn mt-btn-lg" onClick={() => run(false)} disabled={!!busy}>{busy === 'look' ? 'Making…' : 'Preview'}</button>
              <button type="button" className="mt-go" onClick={() => run(true)} disabled={!!busy}>{busy === 'save' ? 'Saving…' : r.free ? 'Save quotation' : q.qtn_no ? 'Save quotation' : 'Save and attach'}</button>
            </div>
          </aside>
        </div>
      </div>
      {termsOpen && (
        <div className="mt-scrim qt-terms-scrim" onClick={() => setTermsOpen(false)}>
          <div className="qt-terms-pop" role="dialog" aria-label="Terms and conditions" onClick={(e) => e.stopPropagation()}>
            <div className="qt-terms-head"><b>Terms and conditions</b>
              <button type="button" className="qt-qadd-x" onClick={() => setTermsOpen(false)} aria-label="Close"><Icon d={I.x} size={14} /></button>
            </div>
            {/* Numbered, one box a term, as in the letter (the user, 16 Nov: "can we make it as in series also?"). Enter starts the next term. */}
            <ol className="qt-terms-list">
              {terms.map((t, i) => (
                <li key={i}>
                  <span className="qt-terms-no">{i + 1}.</span>
                  <textarea ref={fit} rows={1} value={t} autoFocus={i === 0}
                    onChange={(e) => { setTerms(terms.map((x, n) => (n === i ? e.target.value.replace(/\s*\n\s*/g, ' ') : x))); fit(e.target); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); setTerms([...terms.slice(0, i + 1), '', ...terms.slice(i + 1)]); setTimeout(() => e.target.closest('ol')?.querySelectorAll('textarea')[i + 1]?.focus(), 0); }
                    }} placeholder="Term" />
                  <button type="button" className="qt-qadd-x" onClick={() => setTerms(terms.filter((_, n) => n !== i))} aria-label={`Remove term ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>
                </li>
              ))}
            </ol>
            <button type="button" className="qt-camera qt-qadd-btn qt-terms-add" onClick={() => setTerms([...terms, ''])}><Icon d={I.plus} size={16} /><span>Add term</span></button>
            <div className="qt-terms-go">
              <button type="button" className="mt-btn" onClick={() => set('terms', DEFAULT_TERMS.join('\n'))}>Reset</button>
              <button type="button" className="mt-btn mt-btn-primary" onClick={() => setTermsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
      {preview && <PdfViewer blob={preview} name={quoteFileName(doc(q.qtn_no ?? 'Preview'))} onClose={() => setPreview(null)} />}
      {confirm && <SaveLook confirm={confirm} busy={busy} onEdit={() => setConfirm(null)} onSave={keep} free={r.free} />}
    </div>, document.body);
}

/** The PDF before it is kept: Edit back to the form, Save keeps it (the user, 19 Nov: "on saving, just show a pop up preview"). */
/** What a revision changed from the quotation it revises (the user, 25 Nov: changes seen; none, no save). */
function docChanges(a, b) {
  if (!a || !b) return null;
  const out = [];
  const j = (x) => JSON.stringify(x ?? null);
  if ((a.to ?? '') !== (b.to ?? '')) out.push(`To: ${b.to || '—'}`);
  const ia = a.items ?? [], ib = b.items ?? [];
  const name = (x) => x?.desc ?? Object.values(x ?? {}).find((y) => typeof y === 'string') ?? 'Item';
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    if (!ib[i]) out.push(`Removed: ${name(ia[i])}`);
    else if (!ia[i]) out.push(`Added: ${name(ib[i])}`);
    else if (j(ia[i]) !== j(ib[i])) out.push(String(ia[i].price ?? '') !== String(ib[i].price ?? '') ? `${name(ib[i])}: price ${ia[i].price ?? '—'} → ${ib[i].price ?? '—'}` : `Changed: ${name(ib[i])}`);
  }
  if (j(a.rows) !== j(b.rows)) out.push('Rows changed');
  if ((a.gst ?? null) !== (b.gst ?? null)) out.push(`GST ${a.gst ?? '—'}% → ${b.gst ?? '—'}%`);
  if (Boolean(a.lump) !== Boolean(b.lump)) out.push(b.lump ? 'Lump sum' : 'Item-wise prices');
  if (j(a.terms) !== j(b.terms)) out.push('Terms changed');
  const fa = a.f ?? {}, fb = b.f ?? {};
  const skip = (k) => /^(date|text):/.test(k) && /date|qtn|ref/i.test(k);
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) if (!skip(k) && k !== 'block:to' && j(fa[k]) !== j(fb[k])) out.push(`${k.split(':').pop().trim() || 'Field'} changed`);
  if ((a.total ?? null) !== (b.total ?? null)) out.push(`Total ${money(a.total)} → ${money(b.total)}`);
  return out;
}

function SaveLook({ confirm, busy, onEdit, onSave, free }) {
  return (
    <SomeViewer word={confirm.word} blob={confirm.blob} name={quoteFileName(confirm.d)} onClose={() => !busy && onEdit()} actions={<>
      {confirm.changes?.length > 0 && <div className="qt-changes"><b>Changed</b>{confirm.changes.map((c) => <span key={c}>{c}</span>)}</div>}
      <button type="button" className="mt-btn mt-btn-lg" onClick={onEdit} disabled={!!busy}><Icon d={I.pen} size={16} />Edit</button>
      <button type="button" className="mt-go" onClick={onSave} disabled={!!busy}>{busy ? 'Saving…' : free ? 'Save quotation' : 'Save and attach'}</button>
    </>} />
  );
}

/**
  Quotations made without a request (0060; the user, 16 Nov: "other coordinators, they just create quotations",
  Sandhya K Nair E2146). A Quotation maker sees only this: their quotations, made, edited, revised (R1, R2…) and
  downloaded; the QTN number is typed by them for now. Leads see everybody's, with who made it.
*/
const FREE_NEW = 'free-new';
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
const QUOTE_COLS = [['qtn_no', 'QTN number'], ['date', 'Date'], ['to', 'To'], ['total', 'Grand total'], ['by_name', 'Made by']];

function Quotations({ me, onToast }) {
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(null);
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [sort, setSort] = useState({ key: 'date', dir: -1 });
  const [making, setMaking] = useState(null);
  const [view, setView] = useState(null);
  const [drafts, setDrafts] = useState(() => quoteDraft.all(FREE_NEW));
  const reDrafts = () => setDrafts(quoteDraft.all(FREE_NEW));
  const [ask, askBox] = useAsk();
  const load = useCallback(() => loadQuotes().then(setList).catch((e) => setFailed(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const everyone = me.lead || (list ?? []).some((x) => !x.mine);
  const people = useMemo(() => {
    const m = new Map(); for (const x of list ?? []) m.set(x.made_by, `${x.by_name} (${x.by_code})`);
    return [{ value: '', label: 'Everyone' }, ...[...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
  }, [list]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const out = (list ?? []).filter((x) => (!who || x.made_by === who)
      && (!t || [x.qtn_no, x.to, x.by_name, x.by_code, ...(x.doc?.items ?? []).map((i) => i.desc)].some((v) => String(v ?? '').toLowerCase().includes(t))));
    const val = (x) => (sort.key === 'date' ? `${x.date ?? ''}${x.created_at}` : sort.key === 'total' ? Number(x.total ?? 0) : String(x[sort.key] ?? '').toLowerCase());
    return out.sort((a, b) => { const A = val(a), B = val(b); return (A < B ? -1 : A > B ? 1 : 0) * sort.dir; });
  }, [list, q, who, sort]);
  const by = (key) => setSort((o) => ({ key, dir: o.key === key ? -o.dir : key === 'date' || key === 'total' ? -1 : 1 }));
  // New: the draft again, or a fresh one. Edit keeps the number; Revise gives the next R.
  // New from a template: that template's own draft again, else a fresh one; other templates' drafts stay as they are.
  const create = (tpl) => {
    const id = quoteDraft.idFor(FREE_NEW, tpl); const d = quoteDraft.get(id);
    setMaking({ r: { free: true, id, folder: newId() }, start: d ? { draft: d } : tpl ? { tpl } : null });
  };
  const openDraft = (x) => setMaking({ r: { free: true, id: x.id, folder: newId() }, start: { draft: x.d } });
  const [pickTpl, tplBox] = useTemplatePick(create);
  const edit = (x) => setMaking({ r: { free: true, id: `free-${x.id}`, folder: x.id, editing: true }, start: { doc: x.doc, path: x.path } });
  const revise = (x) => {
    // QTN-1, QTN-2… from the first number (the user, 25 Nov); "2026-27" in a number is not a revision.
    const nos = (list ?? []).map((y) => y.qtn_no ?? '');
    const isRev = (a, b) => a.startsWith(`${b}-`) && /^\d+$/.test(a.slice(b.length + 1)) && nos.includes(b);
    const base = nos.find((b) => b && isRev(x.qtn_no ?? '', b)) ?? x.qtn_no;
    const next = Math.max(0, ...nos.filter((y) => isRev(y, base)).map((y) => Number(y.slice(base.length + 1)))) + 1;
    setMaking({ r: { free: true, id: `free-rev-${x.id}`, folder: newId() }, start: { doc: { ...x.doc, qtn_no: `${base}-${next}`, date: todayIst() } } });
  };
  const close = () => { setMaking(null); reDrafts(); };
  const made = async (f) => {
    const r = making.r;
    await saveQuote({ id: r.folder, qtn_no: f.qtn_no, to: f.qtn_to, total: f.total, date: f.date, doc: f.doc, path: f.path, sha256: f.sha256 });
    quoteDraft.drop(r.id); setMaking(null); reDrafts();
    onToast?.(`${f.qtn_no} saved.`); load();
  };
  const remove = (x) => ask({ title: `Delete quotation ${x.qtn_no}?`, lines: [x.to, money(x.total)].filter(Boolean), ok: 'Delete', tone: 'bad',
    run: async () => { await deleteQuote(x.id); load(); } });
  const dropDraft = ({ id, d }) => ask({ title: 'Delete the draft quotation?', lines: [d.tpl, d.qtn_no, d.to, money(docGrand(d))].filter(Boolean), ok: 'Delete', tone: 'bad',
    run: async () => { quoteDraft.drop(id); reDrafts(); } });
  const cols = QUOTE_COLS.filter(([k]) => k !== 'by_name' || everyone);
  return (
    <div className="qt-qbook">
      <div className="qt-qbook-bar">
        <Search value={q} onChange={setQ} placeholder="QTN number, hospital, item" />
        {everyone && people.length > 2 && <Picker value={who} options={people} onChange={setWho} title="Made by" />}
        <button type="button" className="mt-go qt-qbook-new" data-role="engineer" onClick={pickTpl}><Icon d={I.doc} size={18} /><span>Create quotation</span></button>
      </div>
      {drafts.map((x) => <DraftRow key={x.id} d={x.d} className="qt-qbook-draft" onOpen={() => openDraft(x)} onDrop={() => dropDraft(x)} />)}
      {failed ? <p className="mt-err" role="alert">The quotations could not be loaded.</p>
        : list === null ? <div className="loader" aria-hidden="true" />
        : !shown.length ? <p className="empty-inline pm-empty">{list.length ? 'No quotation matches.' : 'No quotation yet.'}</p> : (
        <div className="qt-qbook-table" data-everyone={everyone ? 'true' : undefined}>
          <div className="qt-qbook-head" role="row">
            {cols.map(([k, label]) => (
              <button key={k} type="button" className="qt-qbook-th" data-col={k} aria-sort={sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined} onClick={() => by(k)}>
                {label}{sort.key === k && <span aria-hidden="true">{sort.dir > 0 ? ' ↑' : ' ↓'}</span>}
              </button>
            ))}
            <span />
          </div>
          {shown.map((x) => (
            <div key={x.id} className="qt-qbook-row" role="row">
              <button type="button" className="qt-qbook-no" data-col="qtn_no" onClick={() => setView(x)}><b>{x.qtn_no}</b></button>
              <span data-col="date">{dayText(x.date)}</span>
              <span data-col="to">{x.to}</span>
              <b data-col="total">{money(x.total)}</b>
              {everyone && <span data-col="by_name">{x.by_name} ({x.by_code})</span>}
              <span className="qt-qbook-acts">
                <button type="button" className="mt-btn qt-act" onClick={() => setView(x)} aria-label={`View ${x.qtn_no}`} title="View"><Icon d={I.eye} size={17} /><span>View</span></button>
                {(x.mine || me.lead) && <button type="button" className="mt-btn qt-act" onClick={() => edit(x)} aria-label={`Edit ${x.qtn_no}`} title="Edit"><Icon d={I.pen} size={16} /><span>Edit</span></button>}
                <button type="button" className="mt-btn qt-act" onClick={() => revise(x)} aria-label={`Revise ${x.qtn_no}`} title="Revise"><Icon d={I.revise} size={17} /><span>Revise</span></button>
                {(x.mine || me.lead) && <button type="button" className="qt-qadd-x" onClick={() => remove(x)} aria-label={`Delete ${x.qtn_no}`} title="Delete"><Icon d={I.x} size={14} /></button>}
              </span>
            </div>
          ))}
        </div>
      )}
      {making && <QuoteMaker r={making.r} pick={null} start={making.start} onClose={close} onMade={(f) => made(f)} />}
      {view && <FileView path={view.path} name={quoteFileName(view.doc ?? { qtn_no: view.qtn_no, to: view.to })} onClose={() => setView(null)} />}
      {tplBox}
      {askBox}
    </div>
  );
}

/** Each quotation with its signed copy: same file, the same QTN number, another number, or none yet. */
/*
  Revised quotations: only the latest is shown (the user, 25 Nov) — QTN-27, QTN-27-1, QTN-27-2 shows QTN-27-2 alone.
*/
function latestOnly(cards) {
  const no = (c) => (c.q?.qtn_no ?? '').trim();
  const nos = cards.map(no).filter(Boolean);
  const bases = nos.filter((b) => nos.some((x) => x.startsWith(b + '-') && /^\d+$/.test(x.slice(b.length + 1))));
  return cards.filter((c) => {
    const n = no(c); if (!n) return true;
    if (bases.includes(n)) return false;
    const b = bases.find((x) => n.startsWith(x + '-') && /^\d+$/.test(n.slice(x.length + 1)));
    if (!b) return true;
    const rev = (x) => Number(x.slice(b.length + 1));
    return !nos.some((x) => x.startsWith(b + '-') && /^\d+$/.test(x.slice(b.length + 1)) && rev(x) > rev(n));
  });
}
function matchQuotes(r) {
  const files = r.files?.length ? r.files
    : [r.quote_file && { kind: 'quote', path: r.quote_file }, r.quote_signed && { kind: 'signed', path: r.quote_signed }].filter(Boolean);
  const quotes = files.filter((f) => f.kind === 'quote');
  const signed = files.filter((f) => f.kind === 'signed');
  const used = new Set();
  const cards = quotes.map((q) => {
    const same = q.sha256 && signed.find((s) => s.sha256 === q.sha256);
    if (same) { used.add(same.path); return { q, s: same, state: 'same' }; }
    const k = qtnKey(q.qtn_no);
    const hit = k && signed.find((s) => !used.has(s.path) && qtnKey(s.qtn_no) === k);
    if (hit) { used.add(hit.path); return { q, s: hit, state: 'signed' }; }
    return { q, s: null, state: null };
  });
  const left = signed.filter((s) => !used.has(s.path));
  const open = cards.filter((c) => !c.state);
  for (const c of open) {
    // One quotation left and copies left: they belong together even when the numbers do not agree.
    const s = open.length === 1 ? left.shift() : null;
    if (s) {
      c.s = s; c.state = !s.qtn_no || !c.q.qtn_no ? 'unread' : 'differs';
      // The other unread copies are more pages of the same signed copy (QR-185: two photos; the user, 17 Nov).
      if (!s.qtn_no) { c.more = left.filter((x) => !x.qtn_no); left.splice(0, left.length, ...left.filter((x) => x.qtn_no)); }
    } else c.state = signed.length || r.done ? 'none' : 'waiting';
  }
  return { cards, extra: left };
}
const STATE = {
  signed: ['ok', 'Signed'], same: ['bad', 'Same file, not signed'], differs: ['bad', 'QTN differs'],
  unread: ['warn', 'Check signed copy'], none: ['bad', 'Not signed'], waiting: ['wait', 'Not signed yet'],
};

/**
  The quotations side by side, one row of them and See more for the rest (the user, 14 Nov). Each shows its QTN
  number, To, total, date and whether the signed copy matches; the Coordinator and PV also see the margin: the total
  against our picked rate with tax × qty, on our cost.
*/
function QuoteBlock({ r, me }) {
  const { cards, extra } = useMemo(() => { const m = matchQuotes(r); return { ...m, cards: latestOnly(m.cards) }; }, [r]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(null);
  const grid = useRef(null);
  const [per, setPer] = useState(3);
  const any = cards.length + extra.length > 0;
  useEffect(() => {
    const el = grid.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setPer(Math.max(1, Math.floor((el.clientWidth + 10) / 220))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [any]);
  if (!any) return null;
  const pick = r.picked ?? (r.orig_rate != null ? 'original' : r.comp_rate != null ? 'compatible' : null);
  const unit = pick === 'original' ? withTax(r.orig_rate, r.orig_tax) : pick === 'compatible' ? withTax(r.comp_rate, r.comp_tax) : null;
  const cost = unit != null ? unit * Number(r.approved_qty ?? r.qty ?? 1) : null;
  const seesMargin = (me.role === 'coordinator' || me.role === 'pv') && cost > 0;
  const priced = cards.filter((c) => c.q.total != null);
  const sum = priced.reduce((t, c) => t + Number(c.q.total), 0);
  const pct = (g, base) => `${g < 0 ? '−' : ''}${money(Math.round(Math.abs(g)))} · ${((g / base) * 100).toFixed(1)}%`;
  const tiles = [...cards.map((c) => ({ key: c.q.path, c })), ...extra.map((s) => ({ key: s.path, s }))];
  const shown = all ? tiles : tiles.slice(0, per);
  const date = r.quote_date ? r.quote_date.split('-').reverse().join('-') : '';
  const headG = sum - (cost ?? 0) * priced.length;
  return (
    <section className="mt-card-block">
      <div className="qt-qhead">
        <span className="mt-block-label">
          {cards.length > 1 ? `Quotations · ${cards.length}` : 'Quotation'}
          {cards.length > 1 && priced.length > 0 ? ` · ${money(Math.round(sum))}` : ''}
          {r.quote_ok === true ? ' · approved' : r.quote_ok === false ? ' · not approved' : ''}
        </span>
        {seesMargin && priced.length > 1 && <span className="qt-qhead-m" data-down={headG < 0 || undefined}>Margin {pct(headG, cost * priced.length)}</span>}
      </div>
      <div ref={grid} className="qt-qgrid">
        {shown.map(({ key, c, s }) => (c ? (
          <div key={key} className="qt-qcard">
            <button type="button" className="qt-qcard-open" onClick={() => setOpen({ path: c.q.path, name: c.q.qtn_no ?? `${r.no} quotation` })} aria-label="See the quotation" />
            <div className="qt-qcard-top">
              <span className="qt-qfile-ico">{isPdf(c.q.path) ? 'PDF' : isDocx(c.q.path) ? 'W' : <Icon d={I.camera} size={15} />}</span>
              <span className="qt-qstate" data-tone={STATE[c.state][0]}>{c.state === 'signed' && <Icon d={I.check} size={13} />}{STATE[c.state][1]}</span>
            </div>
            <p className="qt-qno">{c.q.qtn_no ?? 'Quotation'}</p>
            {c.q.qtn_to && <p className="qt-qto">{c.q.qtn_to}</p>}
            <div className="qt-qfoot"><b>{c.q.total != null ? money(c.q.total) : ''}</b><span>{date}</span></div>
            {c.state === 'differs' && <p className="qt-qnote">Signed copy says {c.s.qtn_no}</p>}
            {seesMargin && c.q.total != null && (
              <span className="qt-qmargin" data-down={Number(c.q.total) < cost || undefined}><span>Margin</span><b>{pct(Number(c.q.total) - cost, cost)}</b></span>
            )}
            {/* Two files in one card, each its own button (the user, 17 Nov: "tough for user to understand there are 2 quo"). */}
            {c.s && (
              <div className="qt-qfiles">
                <button type="button" data-role="coordinator" onClick={() => setOpen({ path: c.q.path, name: c.q.qtn_no ?? `${r.no} quotation` })}><Icon d={I.doc} size={14} />Quotation</button>
                {[c.s, ...(c.more ?? [])].map((x, i, a) => (
                  <button key={x.path} type="button" data-role="engineer" onClick={() => setOpen({ path: x.path, name: `${c.q.qtn_no ?? r.no} signed${a.length > 1 ? ` ${i + 1}` : ''}` })}>
                    <Icon d={I.pen} size={14} />{a.length > 1 ? `Signed ${i + 1}` : 'Signed copy'}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div key={key} className="qt-qcard">
            <button type="button" className="qt-qcard-open" onClick={() => setOpen({ path: s.path, name: `${s.qtn_no ?? r.no} signed` })} aria-label="See the signed copy" />
            <div className="qt-qcard-top">
              <span className="qt-qfile-ico">{isPdf(s.path) ? 'PDF' : isDocx(s.path) ? 'W' : <Icon d={I.camera} size={15} />}</span>
              <span className="qt-qstate" data-tone="warn">No quotation</span>
            </div>
            <p className="qt-qno">{s.qtn_no ?? 'Signed copy'}</p>
            <p className="qt-qto">Signed copy</p>
          </div>
        )))}
      </div>
      {tiles.length > per && (
        <button type="button" className="mt-btn qt-qmore" onClick={() => setAll((x) => !x)}>{all ? 'See less' : `See more · ${tiles.length - per}`}</button>
      )}
      {open && <FileView path={open.path} name={open.name} onClose={() => setOpen(null)} />}
    </section>
  );
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
  r.pr_no, r.itr_no, r.po_no, r.track_no, r.item_code, r.ref_no, statusOf(r)].filter(Boolean).join(' ').toLowerCase();
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

/** "3rd time": spares already received for this barcode, not counting this one (BEMMP 0071; the user, 19 Nov). */
const nth = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
function RepeatTag({ r }) {
  const { repeats } = useContext(QtCtx);
  const b = r.barcode?.trim().toUpperCase();
  if (!b || r.step === 'cancelled') return null;
  const before = (repeats[b] ?? 0) - (r.received_on ? 1 : 0);
  if (before < 1) return null;
  return <span className="qt-repeat">{nth(before + 1)} time</span>;
}

/*
  Spares received before for the same barcode, inside a request (BEMMP 0071; the user, 19 Nov). Many come as totals,
  counts per spare and the latest three; Show all opens the rest with a search ("what if more than 10 comes?").
*/
function BarcodeHistory({ r }) {
  const { role, openReq } = useContext(QtCtx);
  const [rows, setRows] = useState(null);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const sees = ['coordinator', 'team_lead', 'pv', 'purchase'].includes(role);
  useEffect(() => {
    if (!sees || !r.barcode) return;
    loadBarcodeHistory(r.barcode, r.id).then((x) => setRows(x ?? [])).catch(() => setRows([]));
  }, [sees, r.barcode, r.id]);
  if (!sees || !rows?.length) return null;
  const total = rows.reduce((t, x) => t + (Number(x.amount) || 0), 0);
  const bySpare = new Map();
  for (const x of rows) { const k = (x.spare ?? '').trim(); bySpare.set(k, (bySpare.get(k) ?? 0) + (Number(x.qty) || 0)); }
  const chips = [...bySpare.entries()].sort((a, b) => b[1] - a[1]);
  const shownChips = chips.slice(0, 4);
  const list = all ? rows.filter((x) => !q.trim() || `${x.no} ${x.spare}`.toLowerCase().includes(q.trim().toLowerCase())) : rows.slice(0, 3);
  return (
    <section className="qt-history">
      <p className="qt-history-head"><Icon d={I.clock} size={15} />Spares received before for this barcode · {rows.length}{total > 0 ? ` · ₹${total.toLocaleString('en-IN')}` : ''}</p>
      {rows.length > 3 && (
        <div className="qt-history-chips">
          {shownChips.map(([k, n]) => <span key={k}>{k} <b>× {n}</b></span>)}
          {chips.length > 4 && <span>+{chips.length - 4} more</span>}
        </div>
      )}
      {all && <input className="qt-history-find" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Spare or request number" />}
      <ul className="qt-history-list">
        {list.map((x) => (
          <li key={x.id}><button type="button" onClick={() => openReq?.(x.id)}>
            <b>{x.no}</b><span>{x.spare} × {x.qty}</span><small>received {x.received_on ? new Date(x.received_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : ''}</small>
            {Number(x.amount) > 0 && <em>₹{Number(x.amount).toLocaleString('en-IN')}</em>}
            <Icon d={I.chevron} size={14} />
          </button></li>
        ))}
      </ul>
      {rows.length > 3 && <button type="button" className="qt-history-more" onClick={() => { setAll((v) => !v); setQ(''); }}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </section>
  );
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
        <span className="qt-card-top"><span className="qt-no">{r.no}{r.ref_no && <small className="qt-ref">{r.ref_no}</small>}</span><StepBadge r={r} /><RepeatTag r={r} /><PendingChip r={r} now={now} /><Clock r={r} targets={targets} now={now} /></span>
        <span className="qt-card-spare">{r.spare} <b>× {r.approved_qty ?? r.qty}</b></span>
        <span className="qt-card-line"><span className="qt-card-step">{statusOf(r)} · </span>{[r.equipment, r.for_stock ? `Stock · ${r.hospital ?? ''}` : r.hospital ?? (r.kind === 'stock' ? 'Stock' : null)].filter(Boolean).join(' · ')}</span>
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
                      title: `Approve ${r.no}?`, lines: [`${r.spare} × ${r.qty} · ${r.hospital ?? 'Stock'}`, person(r.engineer_name, r.engineer_code),
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
  // Search on To accept and With you too (the user, 20 Nov: "we need search option in with you tab also").
  const [q, setQ] = useState('');
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
      {/* The tabs, then the period at the end of the same row (the user, 20 Nov: "date filter come at end of sub tab"). */}
      <div className="qt-views-row">
        <div className="segmented qt-views" role="tablist" aria-label="Requests">
          {views.map(([id, label, n]) => (
            <button key={id} type="button" role="tab" aria-selected={v === id} data-view={id} data-hot={n ? 'true' : undefined}
                    onClick={() => setView(id)}><i aria-hidden="true" />{label}{n != null ? <b> {n}</b> : null}</button>
          ))}
        </div>
        <PeriodBar period={period} setPeriod={setPeriod} />
      </div>
      {v === 'accept' || v === 'mine'
        ? <><div className="qt-views-pick">{pick}</div>
            <div className="mt-filters qt-filters"><Search value={q} onChange={setQ} placeholder="Request no, hospital, spare, engineer" /></div>
            <Todo me={me} list={mine.filter((r) => (v === 'accept') === isWaiting(r) && (!q || matches(r, q)))} targets={targets} now={now} onOpen={onOpen} onDone={onDone} sub={v} /></>
        : <Requests list={list} targets={targets} now={now} onOpen={onOpen} show={v} viewPick={pick} myRole={split ? me.role : null} allTime={period.id === 'all'} />}
    </div>
  );
}

// Recent changes: the requests this person acted on first, their latest first, then the rest newest first; nothing is
// hidden (0059; the user, 16 Nov). A choice in the tabs between With you and Closed, where a request just passed on goes;
// they open on it (the user, 16 Nov: "default should be recent changes").
const RECENT = { value: 'recent', label: 'Recent changes' };
const SORTS = [
  { value: 'new', label: 'Newest first' }, { value: 'old', label: 'Oldest first' }, { value: 'wait', label: 'Waiting longest' },
];

function Requests({ list, targets, now, onOpen, show, viewPick, myRole, allTime }) {
  const [q, setQ] = useState('');
  const [wide, setWide] = useState(null);
  const [step, setStep] = useState('');
  const between = show === 'team' || show === 'others';
  const [sort, setSort] = useState(between ? 'recent' : 'new');
  const sorts = between ? [RECENT, ...SORTS] : SORTS;
  const [role, setRole] = useState('');
  // Pending with a role (the user, 11 Nov): open requests by the role they now wait with.
  const roleOf = roleOfReq;
  // The filters count only what this tab shows (the user, 12 Nov: With Purchase listed every role).
  const inView = (r) => show === 'all' || (show === 'done' ? r.done : show === 'open' ? !r.done
    : !r.done && !r.mine && (show === 'team' ? roleOf(r) === myRole : !myRole || roleOf(r) !== myRole));
  const base = useMemo(() => list.filter(inView),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [list, show, myRole]);
  useEffect(() => { setRole(''); setStep(''); setSort(show === 'team' || show === 'others' ? 'recent' : 'new'); }, [show]);
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
    const out = base.filter((r) => (!step || r.step === step) && (!role || (!r.done && roleOf(r) === role)) && (!q || matches(r, q))
    );
    if (sort === 'recent') out.sort((a, b) => (b.my_last_at ?? '').localeCompare(a.my_last_at ?? '') || b.created_at.localeCompare(a.created_at));
    else if (sort === 'old') out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    else if (sort === 'wait') out.sort((a, b) => (clockOf(b, targets, now)?.secs ?? -1) - (clockOf(a, targets, now)?.secs ?? -1));
    else out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, step, role, q, sort, targets, now]);
  // Nothing found in the period: the search looks through all time, every tab (the user, 17 Nov: REQ-133 not found in This month).
  const look = q.trim() && !shown.length && !allTime;
  useEffect(() => { if (look && wide === null) { setWide([]); loadList(null, null).then((l) => setWide(l ?? [])).catch(() => setWide([])); } }, [look, wide]);
  const older = look ? (wide ?? []).filter((r) => matches(r, q)).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
  return (
    <div className="mt-tickets qt-requests">
      {viewPick && <div className="qt-view-sort">{viewPick}<Picker value={sort} options={sorts} onChange={setSort} title="Sort" /></div>}
      <div className="mt-filters qt-filters">
        <Search value={q} onChange={setQ} placeholder="Request no, hospital, spare, engineer" />
        {roles.length > 2 && <Picker value={role} options={roles} onChange={setRole} title="Pending with" />}
        <Picker value={step} options={steps} onChange={setStep} title="Step" />
        <span className="qt-sort-wide"><Picker value={sort} options={sorts} onChange={setSort} title="Sort" /></span>
      </div>
      {!shown.length && older.length ? <ul className="qt-cards">{older.map((r) => <Card key={r.id} r={r} targets={targets} now={now} onOpen={onOpen} />)}</ul>
        : !shown.length ? <p className="empty-inline pm-empty">No request here.</p> : (
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
              {r.step === 'eng_quote' && me?.role === 'coordinator' && <Requote r={r} onDone={changed} />}
              {!r.mine && !r.done && (
                <p className="qt-with">{r.accepted_by_name
                  ? `With ${stepOf(r.step).who} · ${r.accepted_by_name} accepted ${whenText(r.accepted_at)}`
                  : `Sent to ${stepOf(r.step).who} ${agoText(r.step_since, now)} · not accepted yet`}</p>
              )}
              {r.done && r.close_note && <p className="qt-closed-note">{r.close_note}</p>}
              <Reopen r={r} me={me} onDone={changed} />
              {/* Under the work to do, where the Coordinator sees it (the user, 18 Nov: "show that visual in current window"). */}
              <Flow r={r} />
              {!r.mine && <Facts r={r} now={now} />}
              </div>
              <div className="qt-sheet-col">
              {r.mine && <Facts r={r} now={now} />}
              <Quotes r={r} onlyPicked={me.role === 'engineer'} />
              <QuoteBlock r={r} me={me} />
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
              <Timeline r={r} now={now} me={me} onDone={changed} />
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
      <Fact label="Hospital" sub={[r.district, r.state, r.category].filter(Boolean).join(' · ')}>{r.for_stock ? `Stock · ${r.hospital ?? ''}` : r.hospital ?? (r.kind === 'stock' ? 'Stock' : null)}</Fact>
      <Fact label="Equipment" sub={[r.make, r.model, r.serial && `Serial ${r.serial}`, r.barcode && `Barcode ${r.barcode}`, r.ticket_id && `Ticket ${r.ticket_id}`].filter(Boolean).join(' · ')}>{r.equipment}</Fact>
      <BarcodeHistory r={r} />
      <Fact label="Spare" sub={[r.part_no && `Part ${r.part_no}`, r.item_code && `Item ${r.item_code}`].filter(Boolean).join(' · ')}>{r.spare} × {r.qty}{r.approved_qty && r.approved_qty !== r.qty ? ` (approved ${r.approved_qty})` : ''}</Fact>
      <Fact label="Raised" sub={r.raised_by_name && r.raised_by_name !== r.engineer_name ? `by ${r.raised_by_name}` : null}>{whenText(r.created_at)}</Fact>
      <Fact label="Delivery address">{r.delivery_address}</Fact>
      <Fact label="PR" sub={dayText(r.pr_date)}>{r.pr_no}</Fact>
      <Fact label="ITR" sub={dayText(r.itr_date)}>{r.itr_no}</Fact>
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

/*
  The request's way through, at a glance (the user, 18 Nov: for CAMC "quotation flow is skipped … show visual"): each
  stage done, the one it is at, those ahead. A CAMC request's flow has no pricing, quotation or customer approval at
  all, nothing said about them ("dont show this anywhere").
*/
const FLOW = [
  ['Team Lead', ['tl_review', 'eng_fix', 'tl_clarify']],
  ['Pricing', ['coord_initial', 'purchase_rates', 'pv'], true],
  ['Quotation', ['coord_quote'], true],
  ['Customer approval', ['eng_quote'], true],
  ['PR', ['coord_pr']],
  ['PO & dispatch', ['purchase_dispatch', 'coord_decide', 'on_hold', 'on_hold_dispatch']],
  ['Receipt', ['receipt', 'observation', 'purchase_faulty', 'return_dispatch', 'purchase_replacement']],
];
function Flow({ r }) {
  if (r.kind !== 'request' || r.cancelled || r.step === 'cancelled') return null;
  // Completed from stock on an ITR: no PO, dispatch or receipt, the ITR in their place (0062).
  const path = r.itr_no ? [...FLOW.slice(0, 5), ['From stock (ITR)', ['completed']]] : FLOW;
  const stages = isCamc(r) ? path.filter(([, , priced]) => !priced) : path;
  const been = new Set((r.events ?? []).flatMap((e) => [e.step, e.to_step]).filter(Boolean));
  const at = stages.findIndex(([, steps]) => steps.includes(r.step));
  return (
    <section className="mt-card-block">
      <span className="mt-block-label qt-tl-head">Flow</span>
      <ol className="qt-flow" style={{ '--n': stages.length }}>
        {stages.map(([name, steps], i) => {
          const state = r.done || i < at || (at < 0 && steps.some((s) => been.has(s))) ? 'done' : i === at ? 'now' : 'ahead';
          return (
            <li key={name} data-state={state}>
              <i aria-hidden="true">{state === 'done' ? '✓' : ''}</i>
              <span>{name}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
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
// Who a note notifies (the user, 25 Nov): ticked at first by the writer's role; PV no one.
const NOTE_ROLES = [['engineer', 'Engineer'], ['team_lead', 'Team Lead'], ['coordinator', 'Coordinator'], ['purchase', 'Purchase'], ['pv', 'PV']];
const NOTE_DEFAULT = { engineer: ['team_lead', 'coordinator'], team_lead: ['engineer', 'coordinator'], coordinator: ['engineer', 'team_lead'], purchase: ['coordinator'], pv: [] };

function Timeline({ r, now, me, onDone }) {
  const [note, setNote] = useState('');
  const mine = me?.role ?? null;
  const [tell, setTell] = useState(() => NOTE_DEFAULT[mine] ?? []);
  const flip = (k) => setTell((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
  // The bell beside a note notifies again (0088, the user, 25 Nov).
  const [ping, setPing] = useState(null);
  const [pingTell, setPingTell] = useState([]);
  const [pingBusy, setPingBusy] = useState(false);
  const openPing = (id) => { setPing(ping === id ? null : id); setPingTell(NOTE_DEFAULT[mine] ?? []); };
  const sendPing = async () => {
    if (!pingTell.length) { show('Choose whom to notify.'); return; }
    setPingBusy(true); clear();
    try { await pingNote(ping, pingTell); setPing(null); onDone('Notified again.'); } catch (e) { show(e); } finally { setPingBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const [err, show, clear, at] = useErr();
  const send = async () => {
    if (!note.trim()) { show('Write the note.'); return; }
    setBusy(true); clear();
    try { await addNote(r.id, note.trim(), tell); setNote(''); onDone('Note added.'); } catch (e) { show(e); } finally { setBusy(false); }
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
                {e.note && (e.action === 'note' && e.id ? (
                  <span className="qt-tl-note qt-tl-note-bell">
                    <span>{e.note}</span>
                    <button type="button" className="qt-bell" data-on={ping === e.id ? 'true' : undefined} aria-label="Notify again" title="Notify again" onClick={() => openPing(e.id)}><Icon d={I.bell} size={16} /></button>
                  </span>
                ) : <span className="qt-tl-note">{e.note}</span>)}
                {ping === e.id && (
                  <div className="qt-note-box qt-ping" data-role={mine ?? undefined}>
                    <div className="qt-notify" role="group" aria-label="Notify again">
                      <span className="qt-notify-label">Notify again</span>
                      {NOTE_ROLES.filter(([k]) => k !== mine).map(([k, label]) => (
                        <button key={k} type="button" data-role={k} aria-pressed={pingTell.includes(k)} onClick={() => setPingTell((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]))}>
                          {pingTell.includes(k) && <Icon d={I.check} size={14} />}{label}
                        </button>
                      ))}
                    </div>
                    <button type="button" className="qt-note-send" onClick={sendPing} disabled={pingBusy}>{`Notify ${pingTell.length}`}</button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="qt-note-box" data-role={mine ?? undefined}>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a note" />
        <div className="qt-notify" role="group" aria-label="Notify">
          <span className="qt-notify-label">Notify</span>
          {NOTE_ROLES.filter(([k]) => k !== mine).map(([k, label]) => (
            <button key={k} type="button" data-role={k} aria-pressed={tell.includes(k)} onClick={() => flip(k)}>
              {tell.includes(k) && <Icon d={I.check} size={14} />}{label}
            </button>
          ))}
        </div>
        <button type="button" className="qt-note-send" onClick={send} disabled={busy}>{tell.length ? `Send · notify ${tell.length}` : 'Send'}</button>
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

/** While the customer decides, the Coordinator revises the quotation and sends it again (0087). */
function Requote({ r, onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="qt-action" data-role="coordinator">
      {open ? (
        <>
          <p className="qt-action-title">Revise and send again</p>
          <CoordQuote r={{ ...r, step: 'coord_quote' }} again onDone={(m) => { setOpen(false); onDone(m); }} />
          <button type="button" className="mt-btn" onClick={() => setOpen(false)}>Close</button>
        </>
      ) : (
        <button type="button" className="mt-go" onClick={() => setOpen(true)}><Icon d={I.revise} size={17} /> Revise and send again</button>
      )}
    </section>
  );
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
  // The Team Lead may remove, replace or add photos (0075; the user, 20 Nov).
  const [photos, setPhotos] = useState(r.photos ?? []);
  const [eqPhotos, setEqPhotos] = useState(r.equipment_photos?.length ? r.equipment_photos : r.equipment_photo ? [r.equipment_photo] : []);
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
      lines: [`${r.spare} × ${r.qty} · ${r.hospital ?? 'Stock'}`, who, note.trim(), a === 'send_back' ? `${r.engineer_name} corrects it and sends it again.` : 'The request ends here.'],
      ok: a === 'send_back' ? 'Send back' : 'Reject', tone: a === 'reject' ? 'bad' : undefined,
      run: () => tlDecline(r.id, { action: a, note: note.trim() }),
      after: () => onDone(a === 'send_back' ? `${r.no} sent back to ${r.engineer_name}.` : `${r.no} rejected.`),
    });
  };
  /* Three buttons at the bottom, no choice above (the user, 11 Nov); remarks needed to send back or reject. */
  return (
    <>
      <RequestEdit v={v} set={set} />
      <div className="pm-in"><span>Equipment photos</span><PhotoAdd folder={r.id} paths={eqPhotos} onChange={setEqPhotos} /></div>
      <div className="pm-in"><span>Spare photos</span><PhotoAdd folder={r.id} paths={photos} onChange={setPhotos} /></div>
      <Field label="Remarks" wide>
        <textarea rows={2} value={note} autoFocus={preset === 'send_back' || preset === 'reject'} onChange={(e) => { setNote(e.target.value); clear(); }} />
      </Field>
      <div className="qt-three qt-tl-acts">
        <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => decline('reject')}>Reject</button>
        <button type="button" data-role="engineer" className="mt-btn" onClick={() => decline('send_back')}>Send back</button>
        <button type="button" data-role="coordinator" className="mt-go" onClick={() => { clear(); ask({
          title: `Approve ${r.no}?`, lines: [`${v.spare} × ${v.qty} · ${r.hospital ?? 'Stock'}`, who, camc ? 'CAMC: straight to PR.' : 'It goes to the Coordinator.'], ok: 'Approve',
          run: () => tlApprove([r.id], { ...v, qty: Number(v.qty), photos, equipment_photos: eqPhotos }), after: () => onDone(`${r.no} approved.`),
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
  /*
    A hospital under both contracts: the Coordinator picks AMC or CAMC first and the flow follows it (the user, 19 Nov;
    0073). CAMC has no pricing: Send to PR, Clarify or Close. One contract asks nothing.
  */
  const both = /amc.*&.*amc/i.test(r.category ?? '');
  const camc = both ? v.contract === 'CAMC' : isCamc(r);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const pick = (c) => { set('contract', c); setA(c === 'CAMC' ? 'camc_pr' : (x) => (x === 'camc_pr' ? 'to_purchase' : x)); };
  const p = { action: a, note: v.note, item_code: v.item_code, vendor: v.vendor, rate: v.rate === '' ? null : Number(v.rate), tax: v.tax === '' ? null : Number(v.tax), ...(both ? { contract: v.contract } : {}), ...(a === 'close' ? { pr_no: v.pr_no, pr_date: v.pr_date } : {}) };
  // Remarks on every action (the user, 19 Nov; 0074).
  const needContract = () => s.need([[!both || v.contract, 'Choose the contract.'], [a === 'to_purchase' || v.note, 'Write the remarks.']]); // Send to Purchase: remarks optional (the user, 25 Nov; 0089).
  return (
    <>
      {both && (
        <Field label="Contract" wide>
          <Choice value={v.contract} onChange={pick} options={[['AMC', 'AMC', 'good'], ['CAMC', 'CAMC', 'good']]} />
        </Field>
      )}
      <div className={both && !v.contract ? 'qt-faded' : undefined}>
      <Choice value={a} onChange={setA} options={camc
        ? [['camc_pr', 'Send to PR', 'good', 'coordinator'], ['hold', 'Hold', 'good', 'coordinator'], ['ask_tl', 'Clarify with Team Lead', 'good', 'team_lead'], ['close', 'Close', 'bad']]
        : [['to_purchase', 'Ask Purchase for rates', 'good', 'purchase'], ['sap', 'SAP rate', 'good', 'coordinator'], ['hold', 'Hold', 'good', 'coordinator'], ['ask_tl', 'Clarify with Team Lead', 'good', 'team_lead'], ['close', 'Close', 'bad']]} />
      </div>
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
      {a === 'close' && (
        <div className="qt-date-pair">
          <Field label="PR no"><input value={v.pr_no} onChange={(e) => set('pr_no', e.target.value)} autoComplete="off" /></Field>
          <Field label="PR date"><input type="date" value={v.pr_date} max={todayIst()} onChange={(e) => set('pr_date', e.target.value)} /></Field>
        </div>
      )}
      <Field label={a === 'close' ? 'Reason' : a === 'ask_tl' ? 'Question' : a === 'hold' ? 'Reason for the hold' : 'Remarks'} wide>
        <textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} />
      </Field>
      {a === 'hold' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => needContract() && s.go(`Put ${r.no} on hold?`, [v.note], 'Hold', p, `${r.no} is on hold.`)}>Hold</button>}
      {a === 'camc_pr' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => needContract() && s.go(`Send ${r.no} to PR?`, ['CAMC: no pricing, straight to PR.'], 'Send to PR', p, `${r.no} is at PR.`)}>Send to PR</button>}
      {a === 'to_purchase' && <button type="button" data-role="purchase" className="mt-go" onClick={() => needContract() && s.go(`Send ${r.no} to Purchase?`, ['Purchase gives the rates.'], 'Send', p, `${r.no} sent to Purchase.`)}>Send to Purchase</button>}
      {a === 'ask_tl' && <button type="button" data-role="team_lead" className="mt-go" onClick={() => s.need([[!both || v.contract, 'Choose the contract.'], [v.note, 'Write the question.']]) && s.go(`Clarify ${r.no} with the Team Lead?`, [r.team_lead_name, v.note], 'Send', p, `Sent to ${r.team_lead_name ?? 'the Team Lead'}.`)}>Clarify with Team Lead</button>}
      {a === 'close' && <button type="button" className="mt-go qt-btn-bad" onClick={() => s.need([...(both ? [[v.contract, 'Choose the contract.']] : []), [v.note, 'Write the reason.']]) && s.go(`Close ${r.no}?`, [person(r.engineer_name, r.engineer_code), [both && v.contract, v.pr_no && `PR ${v.pr_no}`, v.pr_date && dayText(v.pr_date)].filter(Boolean).join(' · ') || null, v.note], 'Close', p, `${r.no} closed.`, 'bad')}>Close the request</button>}
      {a === 'sap' && (
        <div className="qt-two">
          <button type="button" data-role="purchase" className="mt-btn" onClick={() => s.need([[!both || v.contract, 'Choose the contract.'], [v.note, 'Write the remarks.'], [v.item_code, 'Write the item code.'], [v.vendor, 'Write the vendor.'], [Number(v.rate) > 0, 'Write the rate.'], [v.tax, 'Choose the tax.']]) && s.go(`Send the SAP rate to Purchase to confirm?`, [`Item ${v.item_code} · ${v.vendor} · ${money(v.rate)} + ${v.tax || 0}%`], 'Send', { ...p, action: 'sap_confirm' }, `${r.no} sent to Purchase to confirm.`)}>Purchase to confirm</button>
          <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[!both || v.contract, 'Choose the contract.'], [v.note, 'Write the remarks.'], [v.item_code, 'Write the item code.'], [v.vendor, 'Write the vendor.'], [Number(v.rate) > 0, 'Write the rate.'], [v.tax, 'Choose the tax.']]) && s.go(`Convert to PR on the SAP rate?`, [`Item ${v.item_code} · ${v.vendor} · ${money(v.rate)} + ${v.tax || 0}%`], 'Convert to PR', { ...p, action: 'sap_pr' }, `${r.no} is at PR.`)}>Convert to PR</button>
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
  // The photos can be changed while answering too (0076; the user, 21 Nov: QR-209 asked for images).
  const [photos, setPhotos] = useState(r.photos ?? []);
  const [eqPhotos, setEqPhotos] = useState(r.equipment_photos?.length ? r.equipment_photos : r.equipment_photo ? [r.equipment_photo] : []);
  const [hadSpare] = useState(() => !!r.photos?.length);
  const [hadEq] = useState(() => !!(r.equipment_photos?.length || r.equipment_photo));
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  return (
    <>
      {q && <p className="qt-question"><b>{q.by_name}:</b> {q.note}</p>}
      <Field label="Answer" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      {/* Only a group the request has no photo of (the user, 21 Nov). */}
      {!hadEq && <div className="pm-in"><span>Equipment photos</span><PhotoAdd folder={r.id} paths={eqPhotos} onChange={setEqPhotos} /></div>}
      {!hadSpare && <div className="pm-in"><span>Spare photos</span><PhotoAdd folder={r.id} paths={photos} onChange={setPhotos} /></div>}
      <button type="button" className="pm-add-remark" onClick={() => setFix((f) => !f)}>{fix ? '− Keep the request as it is' : '+ Correct the request'}</button>
      {fix && <RequestEdit v={v} set={set} />}
      <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.go(`Send the answer on ${r.no}?`, [v.note], 'Send', { ...(fix ? { ...v, qty: Number(v.qty) } : { note: v.note }), photos, equipment_photos: eqPhotos }, 'Answer sent to the Coordinator.')}>Send answer</button>
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
  // One quote: already chosen. Two: none until one is pressed; then Approve (the user, 17 Nov: QR-175).
  const has = [r.orig_rate != null && 'original', r.comp_rate != null && 'compatible'].filter(Boolean);
  const [sel, setSel] = useState(has.length === 1 ? has[0] : null);
  const pick = (k) => s.go(`Approve the ${k}?`, [k === 'original' ? `${r.orig_vendor} · ${money(withTax(r.orig_rate, r.orig_tax))}` : `${r.comp_vendor} · ${money(withTax(r.comp_rate, r.comp_tax))}`, 'It goes to the Coordinator.', note].filter(Boolean), 'Approve', { action: k, note }, `${k === 'original' ? 'Original' : 'Compatible'} approved. ${r.no} is with the Coordinator.`);
  return (
    <>
      <Quotes r={{ ...r, picked: sel }} onPick={has.length > 1 ? setSel : undefined} />
      <Field label="Remarks" wide><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {sel && <button type="button" data-role="coordinator" className="mt-go" onClick={() => pick(sel)}>Approve</button>}
      <button type="button" className="mt-btn qt-btn-line-bad" onClick={() => s.go('Send the rates back to Purchase?', [note], 'Send back', { action: 'return', note }, `${r.no} sent back to Purchase.`, 'bad')}>Send back to Purchase</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

/** Quotation before PR (the user, 11 Nov): the Coordinator attaches it; the engineer gets the customer's answer. */
function CoordQuote({ r, onDone, again = false }) {
  const [a, setA] = useState('quote');
  // Sending again: the date comes from the revised quotation, else today (the user, 25 Nov).
  const [v, setV] = useState({ files: [], quote_date: again ? todayIst() : '', note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const canPick = !r.picked && r.orig_rate != null && r.comp_rate != null;
  const [pick, setPick] = useState(r.picked ?? (r.comp_rate != null ? 'compatible' : 'original'));
  const said = r.quote_ok === false ? [...(r.events ?? [])].reverse().find((e) => e.action === 'quote_no') : null;
  const p = { ...v, files: v.files.map(({ date, ...f }) => f), action: a, ...(canPick ? { picked: pick } : {}) };
  const setFiles = (files) => setV((o) => ({ ...o, files, quote_date: o.quote_date || files.find((f) => f.date && f.date <= todayIst())?.date || '' }));
  // Create: the draft again, a fresh quotation, or the last one made for this request as its next revision (R1, R2…).
  const [making, setMaking] = useState(null);
  const [drafts, setDrafts] = useState(() => quoteDraft.all(r.id));
  const reDrafts = useCallback(() => setDrafts(quoteDraft.all(r.id)), [r.id]);
  const [ask, askBox] = useAsk();
  // Each send again is the first number with -1, -2… (the user, 25 Nov: "quo-123A, then quo-123A-1").
  const lastMade = () => {
    const made = (r.files ?? []).filter((f) => f.kind === 'quote' && f.doc);
    const prev = made[made.length - 1];
    if (!prev) return null;
    const base = made[0].doc.qtn_no ?? made[0].qtn_no;
    return { base: prev.doc, doc: { ...prev.doc, qtn_no: base ? `${base}-${made.length}` : null, date: todayIst() } };
  };
  // Editing a made one starts a new draft of its template: that template's unsaved draft is not replaced without asking.
  const askDraft = (id, go) => (quoteDraft.get(id)
    ? ask({ title: 'Replace the draft?', lines: ['The draft quotation not saved yet is deleted.'], ok: 'Replace', tone: 'bad', run: async () => { go(); } })
    : go());
  const closeMaker = useCallback(() => { setMaking(null); reDrafts(); }, [reDrafts]);
  // A template: its own draft again, else the last one made from it as the next revision, else fresh; other templates' drafts stay.
  const [pickTpl, tplBox] = useTemplatePick((tpl) => {
    const id = quoteDraft.idFor(r.id, tpl); const d = quoteDraft.get(id);
    const last = lastMade();
    setMaking({ id, start: d ? { draft: d } : last && (!tpl || !last.doc.tplPath || last.doc.tplPath === tpl.path) ? last : tpl ? { tpl } : null });
  });
  const { make } = useContext(QtCtx);
  const made = (f, path) => {
    setFiles(path ? v.files.map((x) => (x.path === path ? f : x)) : [...v.files, f]);
    if (path || !v.quote_date) set('quote_date', f.date);
    quoteDraft.drop(making?.id ?? r.id); reDrafts();
    setMaking(null);
  };
  return (
    <>
      {making && <QuoteMaker r={{ ...r, folder: r.folder ?? r.id, id: making.id ?? r.id }} pick={pick} start={making.start} onClose={closeMaker} onMade={made} />}
      {askBox}{tplBox}
      {said && <p className="qt-question"><b>Customer did not approve:</b> {said.note}</p>}
      {!again && <Quotes r={{ ...r, picked: pick }} onPick={canPick ? setPick : undefined} />}
      {!again && <Choice value={a} onChange={setA} options={[['quote', 'Quotation', 'good', 'engineer'], ['hold', 'Hold', 'good', 'coordinator'], ['cancel', 'Cancel', 'bad']]} />}
      {a === 'quote' ? (
        <div className="qt-quote-row">
          <div className="pm-in qt-wide"><span>Quotation</span>
            <QuoteAdd folder={r.id} files={v.files} onChange={setFiles}
              createLabel={again && lastMade() ? `Revise ${(r.files ?? []).filter((f) => f.kind === 'quote' && f.doc).pop()?.qtn_no ?? ''}`.trim() : 'Create'}
              onCreate={make ? (again && lastMade() ? () => { const last = lastMade(); const id = quoteDraft.idFor(r.id, { path: last.doc.tplPath }); askDraft(id, () => setMaking({ id, start: last })); } : pickTpl) : undefined}
              onEdit={make ? (f) => { const id = quoteDraft.idFor(r.id, { path: f.doc?.tplPath }); askDraft(id, () => setMaking({ id, start: { doc: f.doc, path: f.path } })); } : undefined}
              drafts={make ? drafts : []} onDraft={(x) => setMaking({ id: x.id, start: { draft: x.d } })}
              onDropDraft={(x) => ask({ title: 'Delete the draft quotation?', lines: [`${r.no} · ${r.spare}`, x.d.tpl, x.d.to, money(docGrand(x.d))].filter(Boolean), ok: 'Delete', tone: 'bad',
                run: async () => { await releaseQtn(x.d.qtn_no).catch(() => false); quoteDraft.drop(x.id); reDrafts(); } })}
              onRemove={(f) => (f.doc
                // A made one: asked first, and its number goes back to the series (the user, 16 Nov: "we need that number back").
                ? ask({ title: `Delete quotation ${f.qtn_no ?? ''}?`.replace(' ?', '?'), lines: [f.qtn_to, f.total != null && money(f.total)].filter(Boolean), ok: 'Delete', tone: 'bad',
                    run: async () => { await releaseQtn(f.qtn_no); setV((o) => ({ ...o, files: o.files.filter((x) => x.path !== f.path) })); } })
                : setFiles(v.files.filter((x) => x.path !== f.path)))} />
          </div>
          {!again && <Field label="Quotation date"><input type="date" value={v.quote_date} max={todayIst()} onChange={(e) => set('quote_date', e.target.value)} /></Field>}
          <Field label="Remarks" wide={again}><input value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
        </div>
      ) : <Field label="Reason" wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>}
      {a === 'quote' && <button type="button" data-role="engineer" className="mt-go" onClick={() => s.need([[v.files.length > 0, 'Attach the quotation.'], [v.quote_date, 'Choose the quotation date.'], ...(again ? [[v.note, 'Write the remarks.']] : [])]) && s.go(`Submit the quotation of ${r.no}?`, [...v.files.map((f) => [f.qtn_no ?? 'Quotation', f.total != null && money(f.total)].filter(Boolean).join(' · ')), `To ${person(r.engineer_name, r.engineer_code)}`, 'The Team Lead is told too.'], again ? 'Send again' : 'Submit', p, `Quotation sent to ${r.engineer_name}.`)}>{again ? 'Send again' : 'Submit quotation'}</button>}
      {a === 'hold' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Put ${r.no} on hold?`, [v.note], 'Hold', p, `${r.no} is on hold.`)}>Put on hold</button>}
      {a === 'cancel' && <button type="button" className="mt-go qt-btn-bad" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Cancel ${r.no}?`, [person(r.engineer_name, r.engineer_code), v.note], 'Cancel request', p, `${r.no} cancelled.`, 'bad')}>Cancel the request</button>}
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

/** The engineer confirms the customer's answer; the signed copy now or at the last receipt. */
function EngQuote({ r, onDone }) {
  const [v, setV] = useState({ approved: '', signed: [], note: '' });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const back = [...(r.events ?? [])].reverse().find((e) => e.to_step === 'eng_quote' || e.action === 'clarify');
  return (
    <>
      {back?.action === 'clarify' && back.note && <p className="qt-question"><b>Clarify quote:</b> {back.note}</p>}
      <div className="pm-in"><span>Approved by the customer</span>
        <div className="qt-send-chips" role="radiogroup" aria-label="Approved by the customer">
          {[['yes', 'Yes'], ['no', 'No']].map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={v.approved === id} onClick={() => set('approved', id)}>{label}</button>)}
        </div>
      </div>
      {v.approved === 'yes' && (
        <div className="pm-in qt-wide"><span>Signed quotation</span>
          <QuoteAdd folder={r.id} files={v.signed} onChange={(x) => set('signed', x)} signed />
        </div>
      )}
      <Field label={v.approved === 'no' ? 'Reason' : 'Remarks'} wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.approved, 'Choose whether the customer approved it.'], ...(v.approved === 'no' ? [[v.note, 'Write the reason.']] : [])]) && s.go(
        v.approved === 'yes' ? `Customer approved the quotation of ${r.no}?` : `Customer did not approve ${r.no}?`,
        v.approved === 'yes' ? [v.signed.length ? `${v.signed.length === 1 ? 'Signed copy' : `${v.signed.length} signed copies`} attached.` : 'The signed copy is needed when you confirm the receipt.', 'The Coordinator raises the PR.'] : [v.note, 'It goes back to the Coordinator.'],
        'Confirm', { approved: v.approved, note: v.note, signed_files: v.approved === 'yes' ? v.signed.map(({ date, ...f }) => f) : [] }, v.approved === 'yes' ? 'Sent to the Coordinator for PR.' : 'Sent back to the Coordinator.')}>Confirm quotation</button>
      <Err text={s.err} at={s.at} />
      {s.box}
    </>
  );
}

function CoordPr({ r, onDone }) {
  const [a, setA] = useState('pr');
  const [v, setV] = useState({ pr_no: '', pr_date: '', itr_no: '', itr_date: '', item_code: r.item_code ?? '', approved_qty: r.qty, note: '' });
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
      <Choice value={a} onChange={setA} options={[['pr', 'Request PO', 'good', 'purchase'], ['itr', 'From stock - ITR', 'good', 'coordinator'], ['clarify', 'Clarify quote', 'good', 'engineer'], ['hold', 'Hold', 'good', 'coordinator'], ['cancel', 'Cancel', 'bad']]} />
      {a === 'itr' && (
        <div className="qt-grid">
          <div className="qt-date-pair">
            <Field label="ITR no"><input value={v.itr_no} onChange={(e) => set('itr_no', e.target.value)} autoComplete="off" /></Field>
            <Field label="ITR date"><input type="date" value={v.itr_date} max={todayIst()} onChange={(e) => set('itr_date', e.target.value)} /></Field>
          </div>
          <Field label="Item code"><input value={v.item_code} onChange={(e) => set('item_code', e.target.value)} /></Field>
          <Field label="Approved qty"><input type="number" inputMode="numeric" min="1" value={v.approved_qty} onChange={(e) => set('approved_qty', e.target.value)} /></Field>
        </div>
      )}
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
      <Field label={a === 'pr' || a === 'itr' ? 'Remarks' : 'Reason'} wide><textarea rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} /></Field>
      {a === 'itr' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.itr_no, 'Write the ITR no.'], [v.itr_date, 'Choose the ITR date.'], [v.item_code, 'Write the item code.'], [Number(v.approved_qty) > 0, 'Write the approved qty.']]) && s.go(`Complete ${r.no} from stock?`, [`ITR ${v.itr_no} · ${dayText(v.itr_date)}`, `Item ${v.item_code} × ${v.approved_qty}`, v.note], 'Complete', p, `${r.no} completed from stock.`)}>Complete from stock</button>}
      {a === 'clarify' && <button type="button" data-role="engineer" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Send ${r.no} back to ${r.engineer_name}?`, [person(r.engineer_name, r.engineer_code), v.note], 'Send back', p, `${r.no} sent back to ${r.engineer_name}.`)}>Send back to {r.engineer_name}</button>}
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
      <button type="button" data-role={r.step === 'on_hold_dispatch' ? 'purchase' : 'coordinator'} className="mt-go" onClick={() => ask({ title: `Take ${r.no} off hold?`, lines: [`${r.spare} × ${r.qty}`], ok: 'Take off hold', run: () => resume(r.id), after: () => onDone(`${r.no} is back.`) })}>Take off hold</button>
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
      <Choice value={a} onChange={setA} options={[['dispatch', 'PO and dispatch', 'good', 'engineer'], ['hold', 'Put on hold', 'good', 'purchase'], ['ask_cancel', 'Ask to cancel', 'bad']]} />
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
      {/* Purchase holds it itself and it stays with Purchase (the user, 23 Nov; 0083). Cancelling is still the Coordinator's call. */}
      {a === 'hold' && <button type="button" data-role="purchase" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Put ${r.no} on hold?`, [v.note, 'It stays with you until you take it off hold.'], 'Put on hold', p, `${r.no} is on hold.`)}>Put on hold</button>}
      {a === 'ask_cancel' && <button type="button" data-role="coordinator" className="mt-go" onClick={() => s.need([[v.note, 'Write the reason.']]) && s.go(`Ask to cancel ${r.no}?`, [v.note, 'The Coordinator decides.'], 'Ask', p, 'Sent to the Coordinator.')}>Send to the Coordinator</button>}
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
  const [v, setV] = useState({ received: obs ? 0 : expect, used: obs ? left : 0, faulty: 0, faulty_kind: 'Faulty', date: todayIst(), note: '', observe: false, signed: [] });
  const s = useSend(r, onDone);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const room = Number(v.received || 0) + (obs ? r.received_qty - r.used_qty - r.faulty_qty : 0);
  const over = Number(v.used || 0) + Number(v.faulty || 0) > room;
  const p = { ...v, signed: undefined, signed_files: v.signed.map(({ date, ...f }) => f), received: Number(v.received || 0), used: Number(v.used || 0), faulty: Number(v.faulty || 0) };
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
        <div className="pm-in qt-wide"><span>Signed quotation</span>
          <QuoteAdd folder={r.id} files={v.signed} onChange={(x) => set('signed', x)} signed />
        </div>
      )}
      {over && <p className="mt-err qt-err">Used and faulty together cannot be more than {room}.</p>}
      <button type="button" data-role={Number(v.faulty) ? 'purchase' : 'engineer'} className="mt-go" disabled={over} onClick={() => s.need(needSigned ? [[v.signed.length > 0, 'Attach the signed quotation.']] : []) && s.go(`Confirm receipt of ${r.no}?`,
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
const BLANK_RAISE = { ticket: '', barcode: '', facility_id: '', equipment: '', make: '', model: '', serial: '', note: '', for_stock: false };

/*
  A Care 360 ticket ID fills the hospital and the equipment (BEMMP 0068; the user, 19 Nov: "when ticket id is entered
  automatically all available data should fill", "ya care360 needed"). Everything stays changeable.
*/
const squash = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function TicketFind({ value, onChange, facilities, onFound }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const find = async () => {
    // Only the number is enough: 23 is PMPT_000023 (the user, 19 Nov).
    const raw = value.trim().toUpperCase().replace(/\s+/g, '');
    const n = raw.match(/^(?:PMPT[_-]?)?(\d+)$/);
    const id = n ? `PMPT_${n[1].padStart(6, '0')}` : raw;
    if (!id) return;
    if (id !== value) onChange(id);
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.functions.invoke('bemp-ticket', { body: { ticket: id, from: 'quotation' } });
    setBusy(false);
    if (error || !data?.ticket) {
      let text = 'The ticket could not be looked up';
      try { text = (await error?.context?.json())?.error ?? text; } catch { /* keep the plain one */ }
      setMsg({ bad: true, text }); return;
    }
    const t = data.ticket;
    const h = squash(t.hospital);
    const fac = h ? (facilities.find((x) => squash(x.name) === h) ?? facilities.find((x) => squash(x.name).includes(h) || h.includes(squash(x.name)))) : null;
    onFound({ facility_id: fac?.id, barcode: t.barcode, equipment: t.equipment, make: t.make, model: t.model, serial: t.serial });
    setMsg(fac ? { bad: false, text: 'Filled from the ticket' } : { bad: true, text: `${t.hospital ?? 'The hospital'} is not in the list. Choose it below.` });
  };
  return (
    <div className="pm-in"><span>Ticket ID</span>
      <div className="qt-ticket-row">
        <input value={value} onChange={(e) => { onChange(e.target.value); setMsg(null); }} placeholder="PMPT_000023"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } }} onBlur={() => { if (value.trim() && !msg && !busy) void find(); }} />
        <button type="button" className="qt-ticket-go" disabled={busy || !value.trim()} onClick={() => void find()}>{busy ? 'Finding…' : 'Fill'}</button>
      </div>
      {msg && <p className={msg.bad ? 'qt-ticket-bad' : 'qt-ticket-ok'} role={msg.bad ? 'alert' : undefined}>{msg.text}</p>}
    </div>
  );
}
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
  const filled = Boolean(v.ticket || v.barcode || v.facility_id || v.equipment || v.make || v.model || v.serial || v.note || eqPhotos.length
    || spares.some((s) => s.spare || s.part_no || s.photos.length || Number(s.qty) !== 1));
  const sent = useRef(false);
  useEffect(() => { if (!sent.current) store.set(key, filled ? { v, eqPhotos, spares, step, token } : null); }, [key, filled, v, eqPhotos, spares, step, token]);
  const startAgain = () => ask({ title: 'Clear this form?', lines: [], ok: 'Clear', tone: 'bad', run: async () => {
    setV(BLANK_RAISE); setEqPhotos([]); setSpares([blankSpare()]); setStep(1); setToken(uuid()); clear(); store.set(key, null);
  } });
  useEffect(() => { loadFacilities().then((f) => setFacilities(f ?? [])).catch(() => {}); }, []);
  useEffect(() => { if (!v.facility_id) { setBefore([]); return; } loadEquipmentAt(v.facility_id).then((x) => setBefore(x ?? [])).catch(() => setBefore([])); }, [v.facility_id]);
  const set = (k, x) => { setV((o) => ({ ...o, [k]: x })); clear(); };
  const setSpare = (i, k, x) => { setSpares((s) => s.map((o, j) => (j === i ? { ...o, [k]: x } : o))); clear(); };
  const f = facilities.find((x) => x.id === v.facility_id);
  // For my stock (0085; the user, 24 Nov: "same fields as in tickets, just a category"): everything the same, no ticket ID.
  const stock = Boolean(v.for_stock);

  const next = () => {
    // Required (the user, 19 Nov: "ticket id mandatory").
    if (!stock && !(v.ticket ?? '').trim()) { show('Type the ticket ID.'); return; }
    if (!v.facility_id) { show('Choose the hospital.'); return; }
    if (!v.equipment.trim()) { show('Write the equipment name.'); return; }
    // One equipment photo and two of each spare (the user, 20 Nov).
    if (!eqPhotos.length) { show('Add a photo of the equipment.'); return; }
    clear(); setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const send = () => {
    const bad = spares.findIndex((s) => !s.spare.trim() || !(Number(s.qty) >= 1));
    if (bad >= 0) { show(`Write the spare name and quantity of spare ${bad + 1}.`); return; }
    const few = spares.findIndex((s) => s.photos.length < 2);
    if (few >= 0) { show(`Add 2 photos of spare ${few + 1}.`); return; }
    ask({
      title: spares.length === 1 ? 'Send this request?' : `Send ${spares.length} requests?`,
      lines: [...(stock ? ['For my stock'] : []), `${f?.name}`, `${v.equipment}${v.make ? ` · ${v.make}` : ''}`, ...spares.map((s) => `${s.spare} × ${s.qty}`),
        me.role === 'team_lead' ? 'It goes to the Coordinator.' : `It goes to ${me.team_lead_name ?? 'your Team Lead'}.`],
      ok: 'Send',
      run: () => raise({ ...v, ticket: stock ? '' : v.ticket, for_stock: stock, equipment_photo: eqPhotos[0] ?? null, equipment_photos: eqPhotos, client_token: token, spares: spares.map((s) => ({ ...s, qty: Number(s.qty), photos: s.photos })) }),
      after: (nos) => {
        sent.current = true; store.set(key, null);
        store.set(`qt-recent-hosp:${code}`, [v.facility_id, ...(store.get(`qt-recent-hosp:${code}`) ?? []).filter((x) => x !== v.facility_id)].slice(0, 5));
        onDone(`${(nos ?? []).join(', ')} raised.`);
      },
    });
  };

  return (
    <div className="pm-form qt-raise">
      <div className="qt-for" role="group" aria-label="Request for">
        <button type="button" data-on={!stock} aria-pressed={!stock} onClick={() => set('for_stock', false)}><Icon d={I.doc} size={16} />For a ticket</button>
        <button type="button" data-on={stock} aria-pressed={stock} onClick={() => set('for_stock', true)}><Icon d={I.box} size={16} />For my stock</button>
      </div>
      <div className="qt-steps"><span data-on={step === 1}>1 · Hospital and equipment</span><span data-on={step === 2}>2 · Spares</span>
        {filled && <button type="button" className="pm-clear qt-start-again" onClick={startAgain}>Clear</button>}
      </div>
      {step === 1 ? (
        <section className="pm-card pm-details">
          {!stock && <TicketFind value={v.ticket ?? ''} onChange={(x) => set('ticket', x)} facilities={facilities}
            onFound={(t) => setV((o) => ({ ...o, facility_id: t.facility_id ?? o.facility_id, barcode: t.barcode ?? o.barcode, equipment: t.equipment ?? o.equipment, make: t.make ?? o.make, model: t.model ?? o.model, serial: t.serial ?? o.serial }))} />}
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
          {/* Barcode and Equipment side by side (the user, 19 Nov). */}
          <div className="pm-in-row">
            <Field label="Barcode"><input value={v.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} /></Field>
            <Field label="Equipment"><input value={v.equipment} onChange={(e) => set('equipment', e.target.value)} placeholder="Defibrillator" /></Field>
          </div>
          <div className="pm-in-row">
            <Field label="Make"><input value={v.make} onChange={(e) => set('make', e.target.value)} /></Field>
            <Field label="Model"><input value={v.model} onChange={(e) => set('model', e.target.value)} /></Field>
          </div>
          <Field label="Serial no"><input value={v.serial} onChange={(e) => set('serial', e.target.value)} /></Field>
          <div className="pm-in"><span>Equipment photos · 1 needed</span>
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
            <div><strong>{stock ? `Stock · ${f?.name}` : f?.name}</strong><span>{[v.equipment, v.make, v.model].filter(Boolean).join(' · ')}</span></div>
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
              <div className="pm-in"><span>Photos · 2 needed</span><PhotoAdd folder={s.id} paths={s.photos} onChange={(p) => setSpare(i, 'photos', p)} /></div>
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

function Settings({ me, targets, onDone }) {
  const [t, setT] = useState(() => Object.fromEntries(TAT_STEPS.map((k) => [k, { accept_h: targets[k]?.accept_h ?? 4, process_h: targets[k]?.process_h ?? 24 }])));
  const [ask, box] = useAsk();
  return (
    <div className="qt-settings">
      {me.admin && (
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
      )}
      {me.role === 'team_lead' && <MyEngineers ask={ask} onDone={onDone} />}
      {box}
    </div>
  );
}

/**
  A Team Lead's own reportees (0061; the user, 16 Nov: "only lead can add new engineer under him, ie only his reportees
  newly joined"): the ones not in the tracker yet are added as Engineers under them with one press; the rest is SW Admin's.
*/
function MyEngineers({ ask, onDone }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => loadMyReportees().then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  const fresh = (list ?? []).filter((x) => !x.in);
  const added = (list ?? []).filter((x) => x.in);
  return (
    <section className="panel mt-panel">
      <h3 className="qt-panel-h">My engineers</h3>
      {list === null ? <div className="loader" aria-hidden="true" /> : !list.length ? <p className="empty-inline pm-empty">No reportee.</p> : (
        <ul className="qt-rows qt-team-rows">
          {fresh.map((x) => (
            <li key={x.ecode} className="qt-team-row">
              <span><strong>{person(x.name, x.ecode)}</strong><span>{x.designation || 'Not in the tracker'}</span></span>
              <button type="button" className="mt-btn mt-btn-primary" onClick={() => ask({
                title: `Add ${x.name} as Engineer?`, lines: [`${x.name} (${x.ecode})`, 'Under you as Team Lead'], ok: 'Add',
                run: () => savePerson({ ecode: x.ecode, role: 'engineer' }), after: () => { load(); onDone(`${x.name} added as Engineer.`); },
              })}><Icon d={I.plus} size={16} /> Add</button>
            </li>
          ))}
          {added.map((x) => (
            <li key={x.ecode} className="qt-team-row">
              <span><strong>{person(x.name, x.ecode)}</strong><span>{ROLE_NAME[x.role] ?? x.role}{x.role === 'engineer' && !x.mine ? ' · under another Team Lead' : ''}</span></span>
              <span className="qt-badge" data-tone="grey">Added</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


/* ======================================================== templates == */

/**
  Quotation templates (0063–0065; the user, 18 Nov). A Word file is read into the app's own quotation: its letterhead,
  letter, machine-table columns, totals and terms are kept (the user: "for each upload, we need to save that quot
  letterhead, layouts etc"), edited here, and Create quotation fills them in the app as Spares Quotation does. Named from
  the subject's first two words. Coordinators also keep the in-app Spares Quotation with its own subject and terms.
*/
const tplSubject = (t) => t?.doc?.subject || DEFAULT_SUBJECT;
const tplTerms = (t) => (t?.doc?.terms?.length ? t.doc.terms : DEFAULT_TERMS);
/** What Create quotation starts from: an in-app template's name, subject and terms; a Word one's layout. */
const tplStart = (t) => (!t ? null : t.kind === 'word' ? { name: t.name, layout: t.doc?.layout?.v === 2 ? t.doc.layout : upgradeLayout(t.doc?.layout), path: t.path } : { name: t.name, doc: { subject: tplSubject(t), terms: tplTerms(t) } });

/** A quotation's grand total, whichever kind it is. */
const docGrand = (d) => (d?.v === 2 ? totalsOf(d.Y, itemsOf(d.Y, d.items, d.rows), d.gst, d.lump).with
  : d?.layout ? layoutTotals(d.items, d.layout, d.gst, d.lump).with : quoteTotals(d?.items ?? []).with);

/** "06.12.2026" → "2026-12-06". */
const isoOf = (s) => { const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(s ?? '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };

/** The layout of a Word template: kept with it, or read from its file (older ones). */
async function layoutOf(t) {
  if (t.doc?.layout) return t.doc.layout.v === 2 ? t.doc.layout : upgradeLayout(t.doc.layout);
  return (await readLayout(await templateBlob(t.path))).layout;
}

/** A template's look: the quotation it was made from, refilled. */
const layoutSample = (lay) => ({
  qtn_no: lay.sample?.ref || 'Sample', date: todayIst(), to: lay.sample?.to || 'Hospital name', place: lay.sample?.place || 'Place',
  subject: lay.subject, from: isoOf(lay.sample?.from), upto: isoOf(lay.sample?.upto), gst: lay.items?.gst ?? 18,
  items: lay.items?.sample?.length ? lay.items.sample : [{ cells: (lay.items?.cols ?? []).map(() => ''), price: 1000 }],
});
const sampleDoc = (t) => ({
  qtn_no: 'Sample', date: todayIst(), to: 'Hospital name', place: 'Place', subject: tplSubject(t),
  items: [{ desc: 'Spare or service', price: 1000, qty: 1, gst: 18 }], terms: tplTerms(t),
});

/** Terms numbered as the PDF numbers them, one box a term (the user, 18 Nov: "if terms having serial number, keep the same"). */
function TermsList({ terms, onChange }) {
  const fit = (el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; } };
  return (
    <>
      <ol className="qt-terms-list">
        {terms.map((t, i) => (
          <li key={i}>
            <span className="qt-terms-no">{i + 1}.</span>
            <textarea ref={fit} rows={1} value={t}
              onChange={(e) => { onChange(terms.map((x, n) => (n === i ? e.target.value.replace(/\s*\n\s*/g, ' ') : x))); fit(e.target); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onChange([...terms.slice(0, i + 1), '', ...terms.slice(i + 1)]); setTimeout(() => e.target.closest('ol')?.querySelectorAll('textarea')[i + 1]?.focus(), 0); }
              }} placeholder="Term" />
            <button type="button" className="qt-qadd-x" onClick={() => onChange(terms.filter((_, n) => n !== i))} aria-label={`Remove term ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>
          </li>
        ))}
      </ol>
      <button type="button" className="qt-camera qt-qadd-btn qt-terms-add" onClick={() => onChange([...terms, ''])}><Icon d={I.plus} size={16} /><span>Add term</span></button>
    </>
  );
}

/** A picture of the layout, small. */
function ArtThumb({ a }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { let on = true; templateArt(a).then((u) => on && setSrc(u)).catch(() => {}); return () => { on = false; }; }, [a]);
  return src ? <img className="qt-blk-img" src={src} alt="" /> : <span className="qt-thumb-wait" />;
}

/**
  The letter and terms of a layout, one box a paragraph, tables as cells, pictures removable. {to}, {place}, {date}, {ref},
  {subject}, {from}, {upto}, {total}, {gst}, {grand} are filled by each quotation.
*/
function BlocksPop({ blocks, onChange, onClose, onReset }) {
  const fit = (el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; } };
  const set = (i, b) => onChange(blocks.map((x, n) => (n === i ? b : x)));
  const drop = (i) => onChange(blocks.filter((_, n) => n !== i));
  return createPortal(
    <div className="mt-scrim qt-terms-scrim qt-app" onClick={onClose}>
      <div className="qt-terms-pop qt-blk-pop" role="dialog" aria-label="Letter and terms" onClick={(e) => e.stopPropagation()}>
        <div className="qt-terms-head"><b>Letter and terms</b>
          <button type="button" className="qt-qadd-x" onClick={onClose} aria-label="Close"><Icon d={I.x} size={14} /></button>
        </div>
        <ol className="qt-blk-list">
          {blocks.map((b, i) => {
            if (b.k === 'p') return b.t.trim() ? (
              <li key={i} className={`${b.br ? 'qt-blk-br' : ''}${b.n ? ' qt-blk-num' : ''}`.trim() || undefined}>
                {b.n && <span className="qt-terms-no">{b.n}</span>}
                <textarea ref={fit} rows={1} value={b.t} className={b.b ? 'qt-blk-bold' : undefined}
                  onChange={(e) => { set(i, { ...b, t: e.target.value }); fit(e.target); }} />
                <button type="button" className="qt-qadd-x" onClick={() => drop(i)} aria-label="Remove" title="Remove"><Icon d={I.x} size={14} /></button>
              </li>
            ) : null;
            if (b.k === 'items') return <li key={i} className="qt-blk-fixed"><b>Machine table</b></li>;
            if (b.k === 'img') return (
              <li key={i} className="qt-blk-fixed"><ArtThumb a={b} /><span>Picture</span>
                <button type="button" className="qt-qadd-x" onClick={() => drop(i)} aria-label="Remove picture" title="Remove"><Icon d={I.x} size={14} /></button>
              </li>
            );
            if (b.k === 'grid') return (
              <li key={i} className="qt-blk-grid">
                <div>{b.rows.map((row, ri) => (
                  <div key={ri} className="qt-blk-row">
                    {row.map((c, ci) => (
                      <textarea key={ci} ref={fit} rows={1} value={c.t} style={{ flex: c.span ?? 1 }}
                        onChange={(e) => { set(i, { ...b, rows: b.rows.map((r2, x) => (x !== ri ? r2 : r2.map((c2, y) => (y === ci ? { ...c2, t: e.target.value } : c2)))) }); fit(e.target); }} />
                    ))}
                  </div>
                ))}</div>
                <button type="button" className="qt-qadd-x" onClick={() => drop(i)} aria-label="Remove table" title="Remove"><Icon d={I.x} size={14} /></button>
              </li>
            );
            return null;
          })}
        </ol>
        <div className="qt-terms-go">
          {onReset && <button type="button" className="mt-btn" onClick={onReset}>Reset</button>}
          <button type="button" className="mt-btn mt-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>, document.body);
}

/** The machine table's columns: renamed, removed, added; the amount column's name; the GST. */
function ColumnsEdit({ lay, onChange }) {
  const it = lay.items;
  const set = (items) => onChange({ ...lay, items: { ...it, ...items } });
  // Widths: each column keeps its share; a new one takes an even share.
  const cols = (cols, cw, sample) => set({ cols, cw, sample });
  const idx = it.idx ? 1 : 0;
  return (
    <div className="qt-lm-colsbox">
      <span className="qt-lm-label">Table columns</span>
      <div className="qt-lm-cols">
        {it.cols.map((c, k) => (
          <label key={k} className="pm-in qt-lm-col">
            <input value={c} onChange={(e) => set({ cols: it.cols.map((x, n) => (n === k ? e.target.value : x)) })} placeholder="Column" />
            <button type="button" className="qt-qadd-x" aria-label={`Remove ${c}`} title="Remove"
              onClick={() => cols(it.cols.filter((_, n) => n !== k), it.cw.filter((_, n) => n !== k + idx), it.sample.map((s) => ({ ...s, cells: s.cells.filter((_, n) => n !== k) })))}>
              <Icon d={I.x} size={12} />
            </button>
          </label>
        ))}
        <button type="button" className="mt-btn qt-lm-coladd" onClick={() => {
          const share = 1 / (it.cw.length + 1); const at = idx + it.cols.length;
          const cw = [...it.cw.slice(0, at).map((w) => w * (1 - share)), share, ...it.cw.slice(at).map((w) => w * (1 - share))];
          cols([...it.cols, ''], cw, it.sample.map((s) => ({ ...s, cells: [...s.cells, ''] })));
        }}><Icon d={I.plus} size={15} />Column</button>
      </div>
      <div className="qt-lm-pair">
        <Field label="Amount column"><input value={it.price} onChange={(e) => set({ price: e.target.value })} placeholder="Amount (In Rs.)" /></Field>
        <div className="qt-lm-gst"><TaxChips value={String(it.gst)} onChange={(v) => set({ gst: Number(v) })} /></div>
      </div>
    </div>
  );
}

/** Add or edit one. A Word file: chosen, then read into the app's own form. In-app (Coordinators): name, subject, terms. */
function TemplateEdit({ t, app, onClose, onSaved }) {
  const [kind, setKind] = useState(t?.kind ?? 'word');
  const [name, setName] = useState(t?.name ?? (kind === 'app' ? 'Spares Quotation' : ''));
  const [subject, setSubject] = useState(tplSubject(t));
  const [terms, setTerms] = useState(tplTerms(t).join('\n'));
  const [file, setFile] = useState(null);
  const [lay, setLay] = useState(null);
  const [reading, setReading] = useState(t?.kind === 'word');
  const [pop, setPop] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const input = useRef(null);
  const id = useRef(t?.id ?? newId());
  useEffect(() => {
    if (t?.kind !== 'word') return;
    layoutOf(t).then(setLay).catch(() => setErr('The Word file could not be read.')).finally(() => setReading(false));
  }, [t]);
  const pick = async (f) => {
    if (!f) return;
    if (!/\.docx$/i.test(f.name)) { setErr('Choose a Word file (.docx).'); return; }
    setErr(null); setReading(true);
    try {
      // Only what is in yellow changes (the user, 19 Nov): the boxes, the price table's item row, the Annexure heading.
      const [Y0, n] = await Promise.all([readYellow(f), t ? Promise.resolve(null) : templateName(f)]);
      // Gemini names the boxes (api/quote-boxes.js); the rules' names stand if it cannot.
      const { Y: G } = await nameBoxes(Y0);
      // What changes but is not yellow (the Ref and Date by rule, Gemini's finds) is coloured in a copy and read again
      // (the user, 25 Nov); Gemini's names and its "kept as in the file" carry over by key.
      const missed = G.missed ?? [];
      const { file: f2, added } = await markYellow(f, missed.map((m) => m.text)).catch(() => ({ file: f, added: [] }));
      let Y = G;
      if (added.length) {
        const Y1 = await readYellow(f2);
        const by = new Map(G.fields.map((x) => [x.key, x]));
        const fields = Y1.fields.map((x) => {
          const g = by.get(x.key); if (g) return { ...x, label: g.label, kind: g.kind === 'fixed' ? 'fixed' : x.kind, common: g.common, size: g.size };
          const m = missed.find((mm) => mm.text && x.sample.includes(mm.text));
          return { ...x, label: m?.label || x.label, added: true, ...(m ? { common: m.common, size: m.size } : {}) };
        });
        const { plain, ...rest } = Y1;
        Y = { ...rest, fields: rolesOf(fields, Y1.list), missed: missed.filter((m) => !added.includes(m.text)), ai: G.ai };
      }
      if (!Y.fields.length && !Y.price && !Y.list) { setErr('No yellow found. In Word, mark in yellow what changes in each quotation.'); return; }
      setFile(f2); setLay({ v: 2, yellow: Y }); if (n) setName(n);
    } catch { setErr('This Word file could not be read.'); } finally { setReading(false); }
  };
  const look = async () => {
    setBusy('look'); setErr(null);
    try {
      setPreview(lay.v === 2 ? await wordShown(file ?? await templateBlob(t.path)) : { blob: await makeLayoutPdf(layoutSample(lay), lay, templateArt) });
    } catch { setErr('The preview could not be made.'); } finally { setBusy(null); }
  };
  const save = async () => {
    if (!name.trim()) { setErr('Write the template name.'); return; }
    if (kind === 'word' && !lay) { setErr('Choose the Word file.'); return; }
    if (kind === 'word' && lay.items && lay.items.cols.some((c) => !c.trim())) { setErr('Write each column name.'); return; }
    setBusy('save'); setErr(null);
    try {
      await saveTemplate(kind === 'app'
        ? { id: id.current, kind, name: name.trim(), doc: { subject: subject.trim() || DEFAULT_SUBJECT, terms: terms.split('\n').map((x) => x.trim()).filter(Boolean) } }
        : { id: id.current, kind, name: name.trim(), file, doc: { layout: lay } });
      onSaved(name.trim());
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  const lines = lay?.blocks ? lay.blocks.filter((b) => b.k === 'p' && b.t.trim()).length : 0;
  const full = kind === 'word' && (lay || reading);
  return createPortal(
    <div className={`mt-scrim qt-app${full ? ' qt-tpl-fullwrap' : ''}`} role="presentation">
      <div className={`mt-sheet qt-tpl-sheet${full ? ' qt-tpl-full' : ''}`} role="dialog" aria-modal="true" aria-label={t ? 'Edit template' : 'Add template'}>
        <div className="mt-sheet-head">
          <div className="mt-sheet-title"><h2>{t ? 'Edit template' : 'Add template'}</h2>{lay && <p>{name}</p>}</div>
          <button type="button" className="mt-sheet-x" onClick={onClose} aria-label="Close"><Icon d={I.x} size={20} /></button>
        </div>
        <div className="mt-sheet-body">
        {!t && app && !lay && !reading && (
          <div className="segmented qt-tpl-kind" role="tablist">
            {[['word', 'Word file'], ['app', 'Made in the app']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k}
                onClick={() => { setKind(k); setErr(null); if (k === 'app' && !name) setName('Spares Quotation'); }}>{l}</button>
            ))}
          </div>
        )}
        {kind === 'app' ? (
          <div className="qt-tpl-form">
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spares Quotation" /></Field>
            <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={DEFAULT_SUBJECT} /></Field>
            <div className="pm-in qt-wide"><span>Terms</span><TermsList terms={terms === '' ? [] : terms.split('\n')} onChange={(l) => setTerms(l.join('\n'))} /></div>
          </div>
        ) : reading ? <div className="loader" aria-hidden="true" /> : !lay ? (
          <button type="button" className="qt-tpl-drop" onClick={() => input.current?.click()}><Icon d={I.doc} size={22} /><span>Choose Word file</span></button>
        ) : lay.v === 2 ? (
          <div className="qt-tpl-form qt-lm-form">
            <div className="qt-tpl-bar">
              <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="AMC Proposal" /></Field>
              <button type="button" className="mt-btn" onClick={() => input.current?.click()}><Icon d={I.doc} size={16} />Replace file</button>
            </div>
            <YellowCheck lay={lay} onChange={setLay} />
          </div>
        ) : (
          <div className="qt-tpl-form qt-lm-form">
            <div className="qt-tpl-bar">
              <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="AMC Proposal" /></Field>
              <button type="button" className="mt-btn" onClick={() => input.current?.click()}><Icon d={I.doc} size={16} />Replace file</button>
            </div>
            <Field label="Subject"><input value={lay.subject} onChange={(e) => setLay({ ...lay, subject: e.target.value })} placeholder="Annual Maintenance Contract" /></Field>
            {lay.items && <ColumnsEdit lay={lay} onChange={setLay} />}
            <button type="button" className="qt-maker-terms" onClick={() => setPop(true)}>
              <span>Letter and terms</span><b>{lines} {lines === 1 ? 'line' : 'lines'}</b><Icon d={I.pen} size={15} />
            </button>
          </div>
        )}
        <input ref={input} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        <div className="qt-tpl-foot">
          <Err text={err} />
          {(kind === 'app' || lay) && (
            <div className="qt-lm-go">
              {lay && <button type="button" className="mt-btn mt-btn-lg" disabled={!!busy} onClick={look}>{busy === 'look' ? 'Making…' : 'Preview'}</button>}
              <button type="button" className="mt-go" data-role="coordinator" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </div>
        </div>
      </div>
      {pop && lay && <BlocksPop blocks={lay.blocks} onChange={(blocks) => setLay((o) => ({ ...o, blocks }))} onClose={() => setPop(false)} />}
      {preview && <SomeViewer word={preview.word} blob={preview.blob} name={name || 'Template'} onClose={() => setPreview(null)} />}
    </div>, document.body);
}

/** A template as the quotation it makes: the sample, refilled, as a PDF. */
function TemplateView({ t, onClose }) {
  const [shown, setShown] = useState(null);
  const [fail, setFail] = useState(false);
  useEffect(() => {
    (async () => {
      if (t.kind === 'app') return { blob: await makeQuotePdf(sampleDoc(t)) };
      const lay = await layoutOf(t);
      if (lay.v === 2) return wordShown(await templateBlob(t.path));
      return { blob: await makeLayoutPdf(layoutSample(lay), lay, templateArt) };
    })().then(setShown).catch(() => setFail(true));
  }, [t]);
  if (shown) return <SomeViewer word={shown.word} blob={shown.blob} name={t.name} onClose={onClose} />;
  return createPortal(
    <div className="qt-lightbox qt-pdfbox" onClick={fail ? onClose : undefined}>
      {fail ? <p className="qt-pdf-msg">This template could not be shown.</p> : <span className="qt-thumb-wait" />}
    </div>, document.body);
}

function Templates({ me, onToast }) {
  const app = me.role === 'coordinator' || me.lead;
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const [view, setView] = useState(null);
  const [ask, askBox] = useAsk();
  const load = useCallback(() => loadTemplates().then((l) => setList((l ?? []).filter((x) => x.mine))).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  const everyone = false;
  return (
    <div className="qt-qbook">
      <div className="qt-qbook-bar qt-tpl-top">
        <button type="button" className="mt-go qt-qbook-new" data-role="coordinator" onClick={() => setEdit({})}><Icon d={I.plus} size={18} /><span>Add template</span></button>
      </div>
      <ul className="qt-tpl-list">
        {list === null ? <li><div className="loader" aria-hidden="true" /></li> : !list.length ? <li className="empty-inline pm-empty">No template yet.</li> : list.map((x) => (
          <li key={x.id} className="qt-tpl-row">
            <button type="button" className={`qt-qfile-ico${x.kind === 'word' ? ' qt-tpl-word' : ''}`} onClick={() => setView(x)} aria-label={`See ${x.name}`}>{x.kind === 'word' ? 'W' : 'PDF'}</button>
            <button type="button" className="qt-tpl-text" onClick={() => setView(x)}>
              <b>{x.name}</b>
              <span>{[x.kind === 'word' ? x.file_name : 'Made in the app', whenText(x.updated_at), everyone && `${x.by_name} (${x.by_code})`].filter(Boolean).join(' · ')}</span>
            </button>
            <span className="qt-quotes-acts">
              <button type="button" className="mt-btn qt-act" onClick={() => setView(x)} aria-label={`View ${x.name}`} title="View"><Icon d={I.eye} size={17} /><span>View</span></button>
              <button type="button" className="mt-btn qt-act" onClick={() => setEdit({ t: x })} aria-label={`Edit ${x.name}`} title="Edit"><Icon d={I.pen} size={16} /><span>Edit</span></button>
              <button type="button" className="qt-qadd-x" aria-label={`Delete ${x.name}`} title="Delete"
                onClick={() => ask({ title: `Delete template ${x.name}?`, lines: [x.kind === 'word' ? x.file_name : 'Made in the app'].filter(Boolean), ok: 'Delete', tone: 'bad', run: async () => { await deleteTemplate(x.id); load(); } })}>
                <Icon d={I.x} size={14} />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {edit && <TemplateEdit t={edit.t} app={app} onClose={() => setEdit(null)} onSaved={(n) => { setEdit(null); load(); onToast?.(`${n} saved.`); }} />}
      {view && <TemplateView t={view} onClose={() => setView(null)} />}
      {askBox}
    </div>
  );
}

/**
  Create quotation: with one template it starts straight away; with more, which one. Each opens the quotation maker in
  its own layout (the user, 18 Nov: "clicking choose template why it is not loading as field?"). A Word template not read
  yet is read and kept first. None at all: the maker as it always was.
*/
function useTemplatePick(onApp) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { loadTemplates().then((l) => setList((l ?? []).filter((x) => x.mine && x.kind === 'word'))).catch(() => setList([])); }, [open]);
  const choose = async (x) => {
    // Uploaded before the yellow blanks and S.No lists were read (19 Nov): read from its file now.
    if (x.kind === 'word' && x.doc?.layout && x.doc.layout.v !== 2 && !x.doc.layout.blanksRead && x.path) {
      setBusy(x.id); setErr(null);
      try {
        const bl = await readBlanks(await templateBlob(x.path));
        const layout = { ...x.doc.layout, blanksRead: true, ...(bl.fields.length || bl.ticks.length || bl.list ? { blanks: bl } : {}) };
        setOpen(false); onApp(tplStart({ ...x, doc: { ...x.doc, layout } }));
      } catch { setErr(`${x.name} could not be opened.`); setOpen(true); } finally { setBusy(null); }
      return;
    }
    if (x.kind === 'app' || x.doc?.layout) { setOpen(false); onApp(tplStart(x)); return; }
    setBusy(x.id); setErr(null);
    try {
      const layout = await layoutOf(x);
      await saveTemplate({ id: x.id, kind: 'word', name: x.name, doc: { layout } });
      const kept = (await loadTemplates()).find((y) => y.id === x.id) ?? { ...x, doc: { layout } };
      setOpen(false); onApp(tplStart(kept));
    } catch { setErr(`${x.name} could not be opened.`); setOpen(true); } finally { setBusy(null); }
  };
  // Word templates only: the rows follow that Word table (the user, 19 Nov: "we need only from word, some quotation may not have qty").
  const start = () => (list?.length === 1 ? choose(list[0]) : setOpen(true));
  const box = open && createPortal(
    <div className="mt-scrim qt-app" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="mt-sheet qt-tpl-pick" role="dialog" aria-modal="true" aria-label="Choose template">
        <div className="mt-sheet-head">
          <div className="mt-sheet-title"><h2>Choose template</h2></div>
          <button type="button" className="mt-sheet-x" onClick={() => setOpen(false)} aria-label="Close"><Icon d={I.x} size={20} /></button>
        </div>
        <div className="mt-sheet-body">
        {list && !list.length && <p className="qt-tpl-none">No Word template yet. Upload one under Templates.</p>}
        <ul className="qt-tpl-list">
          {(list ?? []).map((x) => (
            <li key={x.id}><button type="button" className="qt-tpl-row qt-tpl-choice" disabled={!!busy} onClick={() => choose(x)}>
              <span className={`qt-qfile-ico${x.kind === 'word' ? ' qt-tpl-word' : ''}`}>{x.kind === 'word' ? 'W' : 'PDF'}</span>
              <span className="qt-tpl-text"><b>{x.name}</b><span>{busy === x.id ? 'Opening…' : x.kind === 'word' ? x.file_name : 'Made in the app'}</span></span>
            </button></li>
          ))}
        </ul>
        <Err text={err} />
        </div>
      </div>
    </div>, document.body);
  return [start, box];
}

/* ------------------------------------------------------------- layout maker -- */

/** A request's machine in the template's columns: model, make, serial, equipment, the spare, the quantity. */
function cellsFor(cols, r) {
  return cols.map((c) => {
    if (!r || r.free) return '';
    if (/model/i.test(c)) return r.model ?? '';
    if (/make|brand/i.test(c)) return r.make ?? '';
    if (/s\s*\/\s*n|serial/i.test(c)) return r.serial ?? '';
    if (/modality|equipment/i.test(c)) return r.equipment ?? '';
    if (/desc|item|particular|spare/i.test(c)) return spareLine(r);
    if (/^\s*(qty|quantity)/i.test(c)) return String(r.approved_qty ?? r.qty ?? 1);
    return '';
  });
}

/**
  Create quotation in a Word template's layout: the same form as Spares Quotation (the user, 18 Nov: "LIKE THIS"), with
  that template's columns and contract period; the PDF in its letterhead and layout. Kept as a draft as it is typed.
*/
function LayoutMaker({ r, start, onClose, onMade }) {
  const cost = r.comp_rate ?? r.orig_rate;
  const [q, setQ] = useState(() => {
    const d = start?.draft ?? start?.doc;
    if (d?.layout) {
      // A draft from before its table was found: found now in its own wording.
      const up = upgradeLayout({ ...d.layout, blocks: d.blocks ?? d.layout.blocks });
      const layout = { ...up, blocks: [] };
      const its = (d.items ?? []).length ? d.items : [{ cells: [], price: '' }];
      return { ...d, layout, path: start.path ?? d.path ?? null, gst: String(d.gst ?? layout.items?.gst ?? 18), blocks: up.blocks,
        items: its.map((it) => ({ key: it.key ?? Math.random(), cells: [...(it.cells ?? [])], price: String(it.price ?? '') })) };
    }
    const lay = start.tpl.layout; const cols = lay.items?.cols ?? [];
    // Yellow blanks (quoteBlanks): a box per name, its sample kept where nothing is to be typed; ticks all on.
    const bl = lay.blanks;
    const fields = {};
    for (const f of bl?.fields ?? []) {
      if (f.kind === 'date' || f.kind === 'period') continue;
      fields[f.key] = /customer|hospital/.test(f.key) ? (r.hospital ?? '') : f.key === 'place' ? (r.district ?? '') : f.kind === 'qtn' ? ''
        : f.blank ? (/\d/.test(f.sample) ? f.sample : '') : f.sample;
    }
    return {
      ...(bl ? { fields, ticks: {}, rows: [] } : {}),
      tpl: start.tpl.name, tplPath: start.tpl.path ?? null, layout: { ...lay, blocks: [] }, blocks: lay.blocks, qtn_no: null, path: null, date: todayIst(),
      to: r.hospital ?? '', place: r.district ?? '', subject: lay.subject ?? '', from: '', upto: '', gst: String(lay.items?.gst ?? 18), lump: Boolean(lay.items?.lump),
      items: [{ key: Math.random(), cells: cellsFor(cols, r), price: !r.free && cost != null ? String(Number(cost)) : '' }],
    };
  });
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);
  const [pop, setPop] = useState(false);
  const [err, show, clear, at] = useErr();
  const typed = useTyped(start?.draft);
  useEffect(() => { if (typed.current) quoteDraft.set(r.id, q); }, [r.id, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const lay = q.layout; const cols = lay.items?.cols ?? [];
  const set = (k, v) => setQ((o) => ({ ...o, [k]: v }));
  const settle = useHeldQtn(r, q, set);
  const setCell = (i, k, v) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, cells: cols.map((_, c) => (c === k ? v : it.cells[c] ?? '')) } : it)) }));
  const setPrice = (i, v) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, price: v } : it)) }));
  const totals = layoutTotals(q.items, lay, q.gst, q.lump);
  const qi = qtyCol(lay);
  const [confirm, setConfirm] = useState(null);
  const xlsIn = useRef(null);
  /*
    Rows from Excel (the user, 19 Nov: "1 quotation with 100 equipments"): the heading row is the one naming the
    template's columns; each row under it becomes a row here. Format gives an empty sheet with those headings.
  */
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const priceName = lay.items?.price ?? 'Rate';
  const format = async () => saveBlob(await writeBook([{ name: 'Rows', columns: [...cols, priceName].map((h, k) => ({ header: h, key: String(k), numeric: k === cols.length })), rows: [] }]), `${q.tpl || 'Quotation'} rows.xlsx`);
  const fromExcel = async (f) => {
    clear();
    if (!f) return;
    try {
      const grid = await readGrid(f);
      const want = [...cols, priceName].map(norm);
      const match = (h, w, k) => h && (h === w || (k === cols.length ? /rate|price|amount|value/.test(h) : h.includes(w) || w.includes(h)));
      let hi = -1; let at = [];
      for (let i = 0; i < Math.min(grid.length, 15); i++) {
        const heads = grid[i].map(norm);
        const m = want.map((w, k) => heads.findIndex((h) => match(h, w, k)));
        if (m.filter((x) => x >= 0).length > at.filter((x) => x >= 0).length) { hi = i; at = m; }
      }
      if (hi < 0 || at.filter((x) => x >= 0).length < 2) { show(`Headings not found. Use the Excel format: ${[...cols, priceName].join(', ')}.`); return; }
      const rows = grid.slice(hi + 1).map((g) => ({ key: Math.random(), cells: cols.map((_, k) => (at[k] >= 0 ? g[at[k]] ?? '' : '')),
        price: at[cols.length] >= 0 ? String(g[at[cols.length]] ?? '').replace(/[^0-9.]/g, '') : '' }))
        .filter((x) => x.cells.some((v) => v) || x.price);
      if (!rows.length) { show('No rows under the headings.'); return; }
      const blank = (it) => !it.cells.some((v) => String(v ?? '').trim()) && !it.price;
      setQ((o) => ({ ...o, items: [...o.items.filter((it) => !blank(it)), ...rows] }));
    } catch (e) { show(e.message || 'This file could not be read.'); }
  };
  // The yellow form (quoteBlanks): fields, ticks and the Annexure list rows.
  const bl = lay.blanks;
  // Yellow boxes in place of To / Ref / Subject only when the template has them; a list alone keeps the usual header.
  const yb = bl && (bl.fields.length || bl.ticks.length) ? bl : null;
  const setField = (k, v) => setQ((o) => {
    const fields = { ...o.fields, [k]: v };
    const who = bl?.fields.find((f) => /customer|hospital/.test(f.key));
    return { ...o, fields, ...(who && who.key === k ? { to: v } : {}), ...(k === 'place' ? { place: v } : {}) };
  });
  const numbered = /^(s[il]?\.?\s*no|sr\.?\s*no|no)\.?$/i.test(bl?.list?.cols[0] ?? '');
  const listCols = (bl?.list?.cols ?? []).map((c, k) => ({ c, k })).filter(({ k }) => !(numbered && k === 0));
  const setRow = (i, k, v) => setQ((o) => ({ ...o, rows: o.rows.map((row, n) => (n === i ? bl.list.cols.map((_, j) => (j === k ? v : row[j] ?? '')) : row)) }));
  const listIn = useRef(null);
  const listFormat = async () => saveBlob(await writeBook([{ name: 'Equipment', columns: listCols.map(({ c }, j) => ({ header: c, key: String(j), numeric: /qty|quantity|nos/i.test(c) })), rows: [] }]), `${q.tpl || 'Quotation'} equipment.xlsx`);
  const listExcel = async (f) => {
    clear();
    if (!f) return;
    try {
      const grid = await readGrid(f);
      const want = listCols.map(({ c }) => norm(c));
      let hi = -1; let at = [];
      for (let i = 0; i < Math.min(grid.length, 15); i++) {
        const heads = grid[i].map(norm);
        const m = want.map((w) => heads.findIndex((h) => h && (h === w || h.includes(w) || w.includes(h) || (/qty|quantity/.test(w) && /qty|quantity|nos/.test(h)))));
        if (m.filter((x) => x >= 0).length > at.filter((x) => x >= 0).length) { hi = i; at = m; }
      }
      if (hi < 0 || at.filter((x) => x >= 0).length < Math.min(2, want.length)) { show(`Headings not found. Use the Excel format: ${listCols.map(({ c }) => c).join(', ')}.`); return; }
      const rows = grid.slice(hi + 1).map((g) => {
        const row = bl.list.cols.map(() => '');
        listCols.forEach(({ k }, j) => { if (at[j] >= 0) row[k] = String(g[at[j]] ?? '').trim(); });
        return row;
      }).filter((row) => row.some((v) => v));
      if (!rows.length) { show('No rows under the headings.'); return; }
      setQ((o) => ({ ...o, rows: [...(o.rows ?? []).filter((row) => row.some((v) => String(v ?? '').trim())), ...rows] }));
    } catch (e) { show(e.message || 'This file could not be read.'); }
  };
  const doc = (qtn) => ({
    tpl: q.tpl, qtn_no: qtn, date: q.date, to: q.to.trim(), place: q.place.trim(), ...(q.tplPath && q.address != null ? { address: q.address } : {}), subject: q.subject.trim(), from: q.from, upto: q.upto, gst: Number(q.gst), lump: Boolean(q.lump),
    items: q.items.map((it) => ({ cells: it.cells.map((c) => String(c ?? '').trim()), price: Number(it.price), desc: it.cells.filter(Boolean).join(' ') })),
    blocks: q.blocks, layout: lay, tplPath: q.tplPath ?? null,
    ...(bl ? { fields: q.fields ?? {}, ticks: q.ticks ?? {}, rows: q.rows ?? [] } : {}),
  });
  const check = () => {
    if (yb) {
      for (const f of yb.fields) if ((f.blank || f.kind === 'qtn') && f.kind !== 'date' && f.kind !== 'period' && !String(q.fields?.[f.key] ?? '').trim()) return `Write the ${f.label}.`;
    } else {
      if (r.free && !(q.qtn_no ?? '').trim()) return 'Write the Ref number.';
      if (!q.to.trim()) return 'Write the hospital the quotation is to.';
    }
    if (!q.date) return 'Choose the quotation date.';
    if ((lay.period || bl?.period) && (!q.from || !q.upto)) return 'Choose the contract period.';
    if (lay.period && q.upto < q.from) return 'The contract ends before it starts.';
    if (!q.items.length) return 'Add a row.';
    for (const [n, it] of q.items.entries()) {
      const name = q.items.length > 1 ? ` of row ${n + 1}` : '';
      if (cols.length && !String(it.cells[0] ?? '').trim()) return `Write the ${cols[0]}${name}.`;
      if (!(Number(it.price) > 0)) return `Write the ${lay.items?.price ?? 'amount'}${name}.`;
    }
    return null;
  };
  useEffect(() => {
    const esc = (e) => { if (e.key !== 'Escape') return; e.stopImmediatePropagation(); if (preview) setPreview(null); else if (pop) setPop(false); else if (!busy) onClose(); };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [preview, pop, busy, onClose]);
  const run = async (save) => {
    clear();
    const bad = check(); if (bad) { show(bad); return; }
    setBusy(save ? 'save' : 'look');
    try {
      let qtn = q.qtn_no;
      // The QTN typed into the template's own number (QTN0001/CHC/2026-27): the whole number is the quotation's.
      const qf = bl?.fields.find((f) => f.kind === 'qtn');
      if (qf) {
        const w = qf.at[0].line.split(/\s+/).find((x) => x.includes(qf.sample)) ?? qf.sample;
        qtn = w.replace(qf.sample, String(q.fields?.[qf.key] ?? '').trim()).replace(/[–-]$/, '');
        if (save) set('qtn_no', qtn);
      } else if (r.free) qtn = (qtn ?? '').trim() || null;
      else if (save) { qtn = (qtn ?? '').trim() || await nextQtn(); set('qtn_no', qtn); }
      const d = doc(save ? qtn : (q.qtn_no ?? 'Ref on saving'));
      // The customer's own Word filled in (the user, 19 Nov: "edit on same word"); a layout without its file is drawn.
      const word = Boolean(q.tplPath);
      let blob;
      if (word && bl) blob = await cleanYellow(await fillWord(await fillBlanks(await templateBlob(q.tplPath), bl, d), lay, d));
      else blob = word ? await fillWord(await templateBlob(q.tplPath), lay, d) : await makeLayoutPdf(d, lay, templateArt);
      if (!save) { setPreview({ blob, word }); return; }
      const changes = docChanges(start?.base, d);
      if (changes && !changes.length) { show('Nothing is changed yet. Change the quotation to revise it.'); return; }
      setConfirm({ blob, d, qtn, total: totals.with, word, changes });
    } catch (e) { show(e.message || 'The quotation could not be made.'); } finally { setBusy(null); }
  };
  const keep = async () => {
    const { blob, d, qtn, total, word } = confirm;
    setBusy('save');
    try {
      const file = word ? new File([blob], `${quoteFileName(d)}.docx`, { type: DOCX })
        : new File([blob], `${quoteFileName(d)}.pdf`, { type: 'application/pdf' });
      const path = await uploadPhoto(r.folder ?? r.id, file);
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      settle(qtn); setConfirm(null);
      onMade({ path, sha256: sha, qtn_no: qtn, qtn_to: d.to, total, date: d.date, doc: d }, q.path);
    } catch (e) { setConfirm(null); show(e.message || 'The quotation could not be saved.'); } finally { setBusy(null); }
  };
  const lines = q.blocks.filter((b) => b.k === 'p' && b.t.trim()).length;
  return createPortal(
    <div className={`mt-scrim qt-maker-scrim qt-app${r.free ? ' qt-maker-free' : ''}`}>
      <div className="mt-sheet qt-maker" role="dialog" aria-modal="true" aria-label="Create quotation">
        <header className="mt-sheet-head">
          <div className="mt-sheet-title">
            <h2>{(r.free ? r.editing : q.qtn_no) ? 'Edit quotation' : 'Create quotation'}</h2>
            <p>{[r.free ? (q.qtn_no || 'New quotation') : q.qtn_no ?? `${r.no} · ${r.spare}`, q.tpl].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="mt-sheet-x" onClick={onClose} disabled={!!busy} aria-label="Close"><Icon d={I.x} size={20} /></button>
        </header>
        <div className="mt-sheet-body qt-maker-body">
          <div className="qt-maker-main">
            {yb && (
              <div className="qt-maker-to qt-lm-to">
                {bl.fields.filter((f) => f.kind !== 'period').map((f) => (
                  f.kind === 'date' ? <Field key={f.key} label="Date"><input type="date" value={q.date} max={todayIst()} onChange={(e) => set('date', e.target.value)} /></Field>
                  : f.kind === 'pick' ? (
                    <Field key={f.key} label={f.label} wide>
                      <select value={q.fields?.[f.key] ?? f.sample} onChange={(e) => setField(f.key, e.target.value)}>
                        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </Field>
                  ) : /address/.test(f.key) ? (
                    <Field key={f.key} label={f.label} wide>
                      <textarea rows={3} value={q.fields?.[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.label} />
                    </Field>
                  ) : (
                    <Field key={f.key} label={f.label} wide={f.sample.length > 18}>
                      <input value={q.fields?.[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} placeholder={f.blank ? f.label : f.sample}
                        inputMode={f.kind === 'qtn' || /contact|phone|mobile/.test(f.key) ? 'numeric' : undefined} />
                    </Field>
                  )
                ))}
                {(lay.period || bl.period) && <>
                  <Field label="Contract from"><input type="date" value={q.from} onChange={(e) => set('from', e.target.value)} /></Field>
                  <Field label="Contract to"><input type="date" value={q.upto} min={q.from || undefined} onChange={(e) => set('upto', e.target.value)} /></Field>
                </>}
              </div>
            )}
            {bl?.ticks.length > 0 && (
              <div className="qt-bl-ticks">
                {bl.ticks.map((t) => (
                  <label key={t.id} className="qt-bl-tick">
                    <input type="checkbox" checked={q.ticks?.[t.id] !== false} onChange={(e) => setQ((o) => ({ ...o, ticks: { ...o.ticks, [t.id]: e.target.checked } }))} />
                    <span>{t.text}</span>
                  </label>
                ))}
              </div>
            )}
            {!yb && <div className="qt-maker-to qt-lm-to">
              {q.tplPath ? (
                <Field label="To" wide>
                  <textarea rows={Math.max(3, Math.min(7, (q.address ?? '').split('\n').length))} value={q.address ?? [q.to, q.place].filter(Boolean).join('\n')}
                    onChange={(e) => setQ((o) => ({ ...o, address: e.target.value, to: e.target.value.split('\n')[0]?.trim() ?? '', place: '' }))}
                    placeholder={[lay.sample?.to, lay.sample?.place].filter(Boolean).join('\n') || 'Hospital'} />
                </Field>
              ) : <>
                <Field label="To" wide><input value={q.to} onChange={(e) => set('to', e.target.value)} placeholder="Hospital" /></Field>
                <Field label="Place"><input value={q.place} onChange={(e) => set('place', e.target.value)} placeholder="Place" /></Field>
              </>}
              <Field label="Date"><input type="date" value={q.date} max={todayIst()} onChange={(e) => set('date', e.target.value)} /></Field>
              {<Field label="Ref" wide><input value={q.qtn_no ?? ''} onChange={(e) => set('qtn_no', e.target.value)} placeholder={lay.sample?.ref || 'AMC 136/2026-27'} /></Field>}
              <Field label="Subject" wide><input value={q.subject} onChange={(e) => set('subject', e.target.value)} placeholder={lay.subject || 'Subject'} /></Field>
              {lay.period && <>
                <Field label="Contract from"><input type="date" value={q.from} onChange={(e) => set('from', e.target.value)} /></Field>
                <Field label="Contract to"><input type="date" value={q.upto} min={q.from || undefined} onChange={(e) => set('upto', e.target.value)} /></Field>
              </>}
            </div>}
            {lay.items && qi >= 0 && (
              <Field label={priceName} wide>
                <Choice value={q.lump ? 'lump' : 'unit'} onChange={(x) => set('lump', x === 'lump')} options={[['unit', 'For one (× Qty)', 'good'], ['lump', 'For the whole row', 'good']]} />
              </Field>
            )}
            {lay.items && (
              <div className="qt-maker-items">
                {q.items.map((it, i) => (
                  <section key={it.key} className="qt-lm-item">
                    <div className="qt-lm-item-head"><b>{i + 1}</b>
                      <button type="button" className="qt-qadd-x" onClick={() => set('items', q.items.filter((_, n) => n !== i))} aria-label={`Remove row ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>
                    </div>
                    <div className="qt-lm-cells">
                      {cols.map((c, k) => (
                        <label key={k} className="pm-in"><span>{c}</span>
                          {/* Several lines where the Word cell has them ("AMC CONTRACT" then its description; 19 Nov). */}
                          {k === qi ? (
                            <input value={it.cells[k] ?? ''} inputMode={!q.lump ? 'numeric' : undefined}
                              onChange={(e) => setCell(i, k, !q.lump ? e.target.value.replace(/[^0-9]/g, '') : e.target.value)} placeholder={lay.items.sample?.[0]?.cells?.[k] || c} />
                          ) : (
                            <textarea rows={Math.min(6, Math.max(1, String(it.cells[k] ?? lay.items.sample?.[0]?.cells?.[k] ?? '').split('\n').length))} value={it.cells[k] ?? ''}
                              onChange={(e) => setCell(i, k, e.target.value)} placeholder={lay.items.sample?.[0]?.cells?.[k] || c} />
                          )}
                        </label>
                      ))}
                      <label className="pm-in"><span>{lay.items.price}</span>
                        <input inputMode="decimal" value={it.price} onChange={(e) => setPrice(i, e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" />
                      </label>
                      {qi >= 0 && !q.lump && <p className="qt-mi-tot"><span>Amount</span><b>{money(totals.lines[i]) || '₹0'}</b></p>}
                    </div>
                  </section>
                ))}
                <button type="button" className="qt-camera qt-qadd-btn qt-maker-add" onClick={() => set('items', [...q.items, { key: Math.random(), cells: cols.map(() => ''), price: '' }])}>
                  <Icon d={I.plus} size={18} /><span>Add row</span>
                </button>
                <div className="qt-lm-excel">
                  <button type="button" className="mt-btn" onClick={() => xlsIn.current?.click()}><Icon d={I.doc} size={16} />Upload Excel</button>
                  <button type="button" className="mt-btn" onClick={format}><Icon d={I.down} size={16} />Excel format</button>
                  <input ref={xlsIn} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { fromExcel(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
              </div>
            )}
            <div className="qt-lm-gst"><TaxChips value={q.gst} onChange={(v) => set('gst', v)} /></div>
            {bl?.list && (
              <div className="qt-maker-items qt-bl-list">
                <h3 className="qt-bl-h">{bl.list.title || bl.fields.find((f) => /annexure/i.test(f.sample))?.sample || 'Annexure'}</h3>
                {(q.rows ?? []).map((row, i) => (
                  <section key={i} className="qt-lm-item">
                    <div className="qt-lm-item-head"><b>{i + 1}</b>
                      <button type="button" className="qt-qadd-x" onClick={() => set('rows', q.rows.filter((_, n) => n !== i))} aria-label={`Remove row ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>
                    </div>
                    <div className="qt-lm-cells">
                      {listCols.map(({ c, k }) => (
                        <label key={k} className="pm-in"><span>{c}</span>
                          <input value={row[k] ?? ''} onChange={(e) => setRow(i, k, e.target.value)} placeholder={c} inputMode={/qty|quantity|nos/i.test(c) ? 'numeric' : undefined} />
                        </label>
                      ))}
                    </div>
                  </section>
                ))}
                <button type="button" className="qt-camera qt-qadd-btn qt-maker-add" onClick={() => set('rows', [...(q.rows ?? []), bl.list.cols.map(() => '')])}>
                  <Icon d={I.plus} size={18} /><span>Add row</span>
                </button>
                <div className="qt-lm-excel">
                  <button type="button" className="mt-btn" onClick={() => listIn.current?.click()}><Icon d={I.doc} size={16} />Upload Excel</button>
                  <button type="button" className="mt-btn" onClick={listFormat}><Icon d={I.down} size={16} />Excel format</button>
                  <input ref={listIn} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { listExcel(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
              </div>
            )}
            <button type="button" className="qt-maker-terms" onClick={() => setPop(true)}>
              <span>Letter and terms</span><b>{lines} {lines === 1 ? 'line' : 'lines'}</b><Icon d={I.pen} size={15} />
            </button>
          </div>
          <aside className="qt-maker-side">
            <div className="qt-maker-sum">
              <p><span>Rows</span><b>{q.items.length}</b></p>
              <p><span>Total</span><b>{money(totals.total) || '₹0'}</b></p>
              <p><span>GST {Number(q.gst) || 0}%</span><b>{money(totals.tax) || '₹0'}</b></p>
              <p className="qt-maker-grand"><span>Grand total</span><b>{money(totals.with) || '₹0'}</b></p>
              <small>{inWords(totals.with)}</small>
            </div>
            <Err text={err} at={at} />
            <div className="qt-maker-go" data-role="engineer">
              <button type="button" className="mt-btn mt-btn-lg" onClick={() => run(false)} disabled={!!busy}>{busy === 'look' ? 'Making…' : 'Preview'}</button>
              <button type="button" className="mt-go" onClick={() => run(true)} disabled={!!busy}>{busy === 'save' ? 'Saving…' : r.free ? 'Save quotation' : q.qtn_no ? 'Save quotation' : 'Save and attach'}</button>
            </div>
          </aside>
        </div>
      </div>
      {pop && <BlocksPop blocks={q.blocks} onChange={(blocks) => set('blocks', blocks)} onClose={() => setPop(false)}
        onReset={start?.tpl?.layout ? () => set('blocks', start.tpl.layout.blocks) : undefined} />}
      {preview && (preview.word ? <DocxViewer blob={preview.blob} name={quoteFileName(doc(q.qtn_no ?? 'Preview'))} onClose={() => setPreview(null)} />
        : <PdfViewer blob={preview.blob} name={quoteFileName(doc(q.qtn_no ?? 'Preview'))} onClose={() => setPreview(null)} />)}
      {confirm && <SaveLook confirm={confirm} busy={busy} onEdit={() => setConfirm(null)} onSave={keep} free={r.free} />}
    </div>, document.body);
}


/*
  A quotation from a template marked in yellow (yellowDoc; the user, 19 Nov: "whatever user shows in yellow is a field,
  rest everything should keep exactly"): a box for each yellow thing, in the order the letter has them; the price
  table's items; the Annexure rows, typed or from Excel. Customer details start empty (the date today, the signer the
  signed-in person, CLIENT from To without the person's line); the usual terms as uploaded. Preview and Save make the
  Word file itself and, on our server, its PDF; both are kept, the PDF is what is attached.
*/
const PERSON_LINE = /^(dr|mr|mrs|ms|miss|prof)\b\.?/i;
const titleLike = (sample, text) => {
  const t = String(text ?? '');
  if (/[a-z]/.test(sample) && t === t.toUpperCase()) return t.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  return t;
};

function YellowMaker({ r, start, onClose, onMade }) {
  const [q, setQ] = useState(() => {
    const d = start?.draft ?? start?.doc;
    if (d?.v === 2) {
      const ref = d.Y.fields.find((x) => x.role === 'ref'); const day = d.Y.fields.find((x) => x.role === 'date');
      // A revision (R1, R2…) comes with its number and today: they go into the Ref and Date boxes.
      const f = { ...d.f, ...(ref && d.qtn_no ? { [ref.key]: d.qtn_no } : {}), ...(day && d.date ? { [day.key]: d.date } : {}) };
      return { ...d, f, items: (d.items ?? []).map((it) => ({ key: Math.random(), ...it })), rows: d.rows ?? [], path: start.path ?? d.path ?? null };
    }
    // The roles again by today's rules (a template saved before keeps working without being uploaded again).
    const Y0 = start.tpl.layout.yellow;
    const Y = { ...Y0, fields: rolesOf(Y0.fields.map((x) => ({ ...x })), Y0.list), price: oneBoxPerCell(Y0.price) };
    const f = {};
    // From the request, into this template's own boxes only (fromRequest); a free quotation starts empty.
    const fr = r.free ? { to: '', item: {}, row: null } : fromRequest(Y, r);
    for (const x of Y.fields) f[x.key] = startValue(x, { today: todayIst(), hospital: fr.to, signer: '' });
    const cl = Y.fields.find((x) => x.role === 'client');
    if (cl && f[cl.key]) f[cl.key] = titleLike(cl.sample, f[cl.key]);
    const own = (Y.price?.fields ?? []).filter((x) => !x.link);
    return {
      v: 2, tpl: start.tpl.name, tplPath: start.tpl.path, Y, f, gst: String(Y.price?.gst ?? 18), lump: Boolean(Y.price?.lump),
      items: [{ key: Math.random(), price: '', ...Object.fromEntries(own.map((x) => [x.key, ''])), ...fr.item }],
      rows: fr.row ? [fr.row] : [], path: null, clientOwn: false, qtn_no: null,
    };
  });
  const Y = q.Y;
  const own = (Y.price?.fields ?? []).filter((x) => !x.link);
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [err, show, clear, at] = useErr();
  const roleOf = (role) => Y.fields.find((x) => x.role === role);
  const toOf = (f) => {
    const to = roleOf('to'); const cl = roleOf('client');
    const lines = String((to && f[to.key]) || (cl && f[cl.key]) || r.hospital || '').split('\n').map((x) => x.trim()).filter(Boolean);
    return (lines.find((x) => !PERSON_LINE.test(x)) ?? lines[0] ?? '').replace(/[\s,;:–—-]+$/, '');
  };
  const typed = useTyped(start?.draft);
  useEffect(() => { if (typed.current) quoteDraft.set(r.id, { ...q, to: toOf(q.f) }); }, [r.id, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setQ((o) => ({ ...o, [k]: v }));
  // The signer is the field staff member the quotation is made for, never the person typing it (the user, 19 Nov:
  // "we are doing for field staff not our name"): written in the box.
  const setF = (k, v) => setQ((o) => {
    const f = { ...o.f, [k]: v };
    const to = roleOf('to'); const cl = roleOf('client');
    // CLIENT follows To (without the person's line) until it is written itself (the user, 19 Nov).
    if (to && cl && k === to.key && !o.clientOwn) f[cl.key] = titleLike(cl.sample, clientFrom(v));
    return { ...o, f, ...(cl && k === cl.key ? { clientOwn: true } : {}) };
  });
  const setItem = (i, k, v) => setQ((o) => ({ ...o, items: o.items.map((it, n) => (n === i ? { ...it, [k]: v } : it)) }));
  // The template's terms, one box each, whether yellow or not (the user, 24 Nov: "earlier we had terms and conditions also,
  // which was editable"); read from the Word when the form opens, kept with the quotation once saved.
  useEffect(() => {
    if (q.terms !== undefined || !q.tplPath) return undefined;
    let live = true;
    templateBlob(q.tplPath).then(readTerms).catch(() => null)
      .then((list) => { if (live) setQ((o) => (o.terms !== undefined ? o : { ...o, terms: list ?? null, termsOrig: list ?? null })); });
    return () => { live = false; };
  }, [q.tplPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = totalsOf(Y, itemsOf(Y, q.items, q.rows), q.gst, q.lump);

  // The Annexure: its columns (S.No. counted), rows typed or from Excel.
  const nrm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const numbered = /^(s[il]?\.?\s*no\.?|sr\.?\s*no\.?|no\.?|#)$/i.test(Y.list?.cols[0] ?? '');
  const listCols = (Y.list?.cols ?? []).map((c, k) => ({ c, k })).filter(({ k }) => !(numbered && k === 0));
  const setRow = (i, k, v) => setQ((o) => ({ ...o, rows: o.rows.map((row, n) => (n === i ? Y.list.cols.map((_, j) => (j === k ? v : row[j] ?? '')) : row)) }));
  const listIn = useRef(null);
  const listFormat = async () => saveBlob(await writeBook([{ name: 'Rows', columns: listCols.map(({ c }, j) => ({ header: c, key: String(j) })), rows: [] }]), `${Y.list?.title || q.tpl || 'Annexure'}.xlsx`);
  const listExcel = async (file) => {
    clear();
    if (!file) return;
    try {
      const grid = await readGrid(file);
      const want = listCols.map(({ c }) => nrm(c));
      let hi = -1; let found = [];
      for (let i = 0; i < Math.min(grid.length, 15); i++) {
        const heads = grid[i].map(nrm);
        const m = want.map((w) => heads.findIndex((h) => h && (h === w || h.includes(w) || w.includes(h))));
        if (m.filter((x) => x >= 0).length > found.filter((x) => x >= 0).length) { hi = i; found = m; }
      }
      if (hi < 0 || found.filter((x) => x >= 0).length < Math.min(2, want.length)) { show(`Headings not found. Use the Excel format: ${listCols.map(({ c }) => c).join(', ')}.`); return; }
      const rows = grid.slice(hi + 1).map((g) => {
        const row = Y.list.cols.map(() => '');
        listCols.forEach(({ k }, j) => { if (found[j] >= 0) row[k] = String(g[found[j]] ?? '').trim(); });
        return row;
      }).filter((row) => row.some((v) => v));
      if (!rows.length) { show('No rows under the headings.'); return; }
      setQ((o) => ({ ...o, rows: [...o.rows.filter((row) => row.some((v) => String(v ?? '').trim())), ...rows] }));
    } catch (e) { show(e.message || 'This file could not be read.'); }
  };

  const doc = (forSave) => {
    const ref = roleOf('ref'); const date = roleOf('date');
    return {
      v: 2, tpl: q.tpl, tplPath: q.tplPath, Y, f: q.f, rows: q.rows, gst: Number(q.gst), lump: q.lump, clientOwn: q.clientOwn,
      ...(Array.isArray(q.terms) ? { terms: q.terms.map((t) => t.trim()).filter(Boolean), termsOrig: q.termsOrig } : {}),
      // Each item's words kept as one line too, for the search of Quotations.
      items: q.items.map(({ key, ...it }) => ({ ...it, desc: own.map((x) => String(it[x.key] ?? '').trim()).filter(Boolean).join(' ') })),
      qtn_no: (ref && String(q.f[ref.key] ?? '').trim()) || q.qtn_no || (forSave ? null : 'Preview'), date: (date && q.f[date.key]) || todayIst(),
      to: toOf(q.f), total: totals.with,
    };
  };
  const check = () => {
    if (r.free && !roleOf('ref')) return 'The Ref number is not in yellow in this template.';
    for (const x of Y.fields) {
      if (x.kind === 'words' || x.kind === 'fixed') continue;
      const v = q.f[x.key];
      if (x.kind === 'period') { if (!v?.from || !v?.upto) return `Choose the ${x.label}.`; if (v.upto < v.from) return `${x.label} ends before it starts.`; continue; }
      if (!String(v ?? '').trim()) return x.kind === 'date' ? `Choose the ${x.label}.` : `Write the ${x.label}.`;
    }
    if (Y.price) {
      for (const [i, it] of q.items.entries()) {
        const n = q.items.length > 1 ? ` of item ${i + 1}` : '';
        for (const x of own) if (!String(it[x.key] ?? '').trim() && !(x.qty && Y.list && q.rows.length)) return `Write the ${x.label}${n}.`;
        if (!(Number(it.price) > 0)) return `Write the ${Y.price.priceHead}${n}.`;
      }
    }
    return null;
  };
  useEffect(() => {
    const esc = (e) => { if (e.key !== 'Escape') return; e.stopImmediatePropagation(); if (preview) setPreview(null); else if (confirm) setConfirm(null); else if (!busy) onClose(); };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [preview, confirm, busy, onClose]);
  const run = async (save) => {
    clear();
    const bad = check(); if (bad) { show(bad); return; }
    setBusy(save ? 'save' : 'look');
    try {
      // Two frames for the page-writing to start before the drawing keeps the phone busy.
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const d = doc(save);
      const docx = await fillYellow(await templateBlob(q.tplPath), Y, d);
      // The PDF from our server; when it cannot be made now the Word file is shown and kept alone.
      const shown = await wordShown(docx); const pdf = shown.word ? null : shown.blob;
      if (!save) { setPreview({ ...shown, name: quoteFileName(d) }); return; }
      const changes = docChanges(start?.base, d);
      if (changes && !changes.length) { show('Nothing is changed yet. Change the quotation to revise it.'); return; }
      setConfirm({ blob: pdf ?? docx, word: !pdf, docx, pdf, d, total: totals.with, changes });
    } catch (e) { show(e.message || 'The quotation could not be made.'); } finally { setBusy(null); }
  };
  const keep = async () => {
    const { docx, pdf, d, total } = confirm;
    setBusy('save');
    try {
      const base = quoteFileName(d);
      const wpath = await uploadPhoto(r.folder ?? r.id, new File([docx], `${base}.docx`, { type: DOCX }));
      const ppath = pdf ? await uploadPhoto(r.folder ?? r.id, new File([pdf], `${base}.pdf`, { type: 'application/pdf' })) : null;
      const main = pdf ?? docx;
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await main.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      setConfirm(null);
      onMade({ path: ppath ?? wpath, sha256: sha, qtn_no: d.qtn_no, qtn_to: d.to, total, date: d.date, doc: { ...d, word: wpath } }, q.path);
    } catch (e) { setConfirm(null); show(e.message || 'The quotation could not be saved.'); } finally { setBusy(null); }
  };

  const box = (x) => {
    const v = q.f[x.key];
    if (x.kind === 'date') return <Field key={x.key} label={x.label}><input type="date" value={v ?? ''} onChange={(e) => setF(x.key, e.target.value)} /></Field>;
    if (x.kind === 'period') return [
      <Field key={`${x.key}-a`} label={`${x.label} from`}><input type="date" value={v?.from ?? ''} onChange={(e) => setF(x.key, { ...v, from: e.target.value })} /></Field>,
      <Field key={`${x.key}-b`} label={`${x.label} to`}><input type="date" value={v?.upto ?? ''} min={v?.from || undefined} onChange={(e) => setF(x.key, { ...v, upto: e.target.value })} /></Field>,
    ];
    if (x.kind === 'num') return <Field key={x.key} label={x.label}><input inputMode="numeric" value={v ?? ''} onChange={(e) => setF(x.key, e.target.value.replace(/[^0-9]/g, '').slice(0, 2))} placeholder="0" /></Field>;
    if (x.kind === 'lines' || x.kind === 'signer') {
      const n = Math.max(2, Math.min(8, Math.max(String(v ?? '').split('\n').length, x.sample.split('\n').length)));
      return <Field key={x.key} label={x.label} wide><textarea rows={n} value={v ?? ''} onChange={(e) => setF(x.key, e.target.value)} placeholder={hintOf(x)} /></Field>;
    }
    // Gemini's size (the user, 25 Nov: "you know what all field needed more space"): a long one full width with room to
    // wrap, a short one half; without it, the sample's length decides as before.
    if (x.size === 'long') return <Field key={x.key} label={x.label} wide><textarea rows={2} value={v ?? ''} onChange={(e) => setF(x.key, e.target.value)} placeholder={hintOf(x)} /></Field>;
    const wide = x.size ? false : x.role !== 'ref' && x.sample.length > 18;
    return <Field key={x.key} label={x.label} wide={wide}><input value={v ?? ''} onChange={(e) => setF(x.key, e.target.value)} placeholder={hintOf(x)} /></Field>;
  };
  const qtyName = (x) => (Y.list && q.rows.length ? `${q.rows.length}${/\s*nos?\.?\s*$/i.exec(x.sample)?.[0] ?? ''}` : '1');
  // Our own hint for a box, never the uploaded file's customer.
  const hintOf = (x) => (x.role === 'to' ? 'Hospital name\nAddress\nPlace' : x.role === 'client' ? 'Hospital name\nPlace'
    : x.kind === 'signer' ? 'Name\nDesignation\nPhone' : x.role === 'ref' ? 'QTN number' : '');

  return createPortal(
    <div className={`mt-scrim qt-maker-scrim qt-app${r.free ? ' qt-maker-free' : ''}`}>
      <div className="mt-sheet qt-maker" role="dialog" aria-modal="true" aria-label="Create quotation">
        <header className="mt-sheet-head">
          <div className="mt-sheet-title">
            <h2>{start?.doc ? 'Edit quotation' : 'Create quotation'}</h2>
            <p>{[r.free ? null : `${r.no} · ${r.spare}`, q.tpl].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="mt-sheet-x" onClick={onClose} disabled={!!busy} aria-label="Close"><Icon d={I.x} size={20} /></button>
        </header>
        <div className="mt-sheet-body qt-maker-body">
          <div className="qt-maker-main">
            <div className="qt-maker-to qt-lm-to">{Y.fields.filter((x) => x.kind !== 'words' && x.kind !== 'fixed').flatMap((x) => [box(x)].flat())}</div>
            {Y.price && (
              <div className="qt-maker-items">
                {q.items.map((it, i) => (
                  <section key={it.key} className="qt-lm-item">
                    <div className="qt-lm-item-head"><b>{i + 1}</b>
                      {q.items.length > 1 && <button type="button" className="qt-qadd-x" onClick={() => set('items', q.items.filter((_, n) => n !== i))} aria-label={`Remove item ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>}
                    </div>
                    <div className="qt-lm-cells">
                      {own.map((x, k) => (
                        <label key={x.key} className={`pm-in${k === own.findIndex((y) => !y.qty) ? ' qt-lm-desc' : ''}`}><span>{x.label}</span>
                          {x.lines > 1 || x.sample.length > 40
                            ? <textarea rows={Math.max(2, Math.min(6, Math.max(x.lines ?? 2, String(it[x.key] ?? '').split('\n').length)))} value={it[x.key] ?? ''} onChange={(e) => setItem(i, x.key, e.target.value)} />
                            : <input value={it[x.key] ?? ''} onChange={(e) => setItem(i, x.key, e.target.value)} placeholder={x.qty ? qtyName(x) : undefined} />}
                        </label>
                      ))}
                      <label className="pm-in"><span>{Y.price.priceHead}</span>
                        <input inputMode="decimal" value={it.price ?? ''} onChange={(e) => setItem(i, 'price', e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" />
                      </label>
                      {!q.lump && Y.price.qty != null && <p className="qt-mi-tot"><span>Amount</span><b>{money(totals.lines[i]) || '₹0'}</b></p>}
                    </div>
                  </section>
                ))}
                <button type="button" className="qt-camera qt-qadd-btn qt-maker-add" onClick={() => set('items', [...q.items, { key: Math.random(), price: '', ...Object.fromEntries(own.map((x) => [x.key, ''])) }])}>
                  <Icon d={I.plus} size={18} /><span>Add item</span>
                </button>
              </div>
            )}
            {Y.price && <div className="qt-lm-gst"><TaxChips value={q.gst} onChange={(v) => set('gst', v)} /></div>}
            {Y.list && (
              <div className="qt-maker-items qt-bl-list">
                <h3 className="qt-bl-h">{Y.list.title || 'Annexure'}{q.rows.length ? ` · ${q.rows.length}` : ''}</h3>
                {q.rows.map((row, i) => (
                  <section key={i} className="qt-lm-item">
                    <div className="qt-lm-item-head"><b>{i + 1}</b>
                      <button type="button" className="qt-qadd-x" onClick={() => set('rows', q.rows.filter((_, n) => n !== i))} aria-label={`Remove row ${i + 1}`} title="Remove"><Icon d={I.x} size={14} /></button>
                    </div>
                    <div className="qt-lm-cells">
                      {listCols.map(({ c, k }) => (
                        <label key={k} className="pm-in"><span>{c}</span><input value={row[k] ?? ''} onChange={(e) => setRow(i, k, e.target.value)} placeholder={c} /></label>
                      ))}
                    </div>
                  </section>
                ))}
                <button type="button" className="qt-camera qt-qadd-btn qt-maker-add" onClick={() => set('rows', [...q.rows, Y.list.cols.map(() => '')])}>
                  <Icon d={I.plus} size={18} /><span>Add row</span>
                </button>
                <div className="qt-lm-excel">
                  <button type="button" className="mt-btn" onClick={() => listIn.current?.click()}><Icon d={I.doc} size={16} />Upload Excel</button>
                  <button type="button" className="mt-btn" onClick={listFormat}><Icon d={I.down} size={16} />Excel format</button>
                  <input ref={listIn} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => { listExcel(e.target.files?.[0]); e.target.value = ''; }} />
                </div>
              </div>
            )}
            {Array.isArray(q.terms) && (
              // Folded until needed (the user, 24 Nov: "collapse, when needed they will expand").
              <div className={`qt-maker-items qt-yl-terms${termsOpen ? ' is-open' : ''}`}>
                <button type="button" className="qt-yl-terms-head" aria-expanded={termsOpen} onClick={() => setTermsOpen(!termsOpen)}>
                  <span>Terms and conditions</span><small>{q.terms.filter((t) => t.trim()).length}</small><Icon d={I.chevron} size={16} />
                </button>
                {termsOpen && <TermsList terms={q.terms} onChange={(t) => set('terms', t)} />}
              </div>
            )}
          </div>
          <aside className="qt-maker-side">
            {Y.price && (
              <div className="qt-maker-sum">
                <p><span>Total</span><b>{money(totals.total) || '₹0'}</b></p>
                <p><span>GST {Number(q.gst) || 0}%</span><b>{money(totals.tax) || '₹0'}</b></p>
                <p className="qt-maker-grand"><span>Grand total</span><b>{money(totals.with) || '₹0'}</b></p>
                <small>{inWords(totals.with)}</small>
              </div>
            )}
            <Err text={err} at={at} />
            <div className="qt-maker-go" data-role="engineer">
              <button type="button" className="mt-btn mt-btn-lg" onClick={() => run(false)} disabled={!!busy}>{busy === 'look' ? 'Making…' : 'Preview'}</button>
              <button type="button" className="mt-go" onClick={() => run(true)} disabled={!!busy}>{busy === 'save' ? 'Making…' : r.free ? 'Save quotation' : 'Save and attach'}</button>
            </div>
          </aside>
        </div>
      </div>
      {busy && !confirm && !preview && <PageWriting />}
      {preview && <SomeViewer word={preview.word} blob={preview.blob} name={preview.name} onClose={() => setPreview(null)} />}
      {confirm && <SaveLook confirm={confirm} busy={busy} onEdit={() => setConfirm(null)} onSave={keep} free={r.free} />}
    </div>, document.body);
}

/*
  While the PDF is made: a page writes itself, as the app draws it from the Word file: the letterhead, the To lines,
  the letter, the price rows one by one, the total last (the user, 19 Nov: "the first one"). Still when the phone asks
  for less motion.
*/
function PageWriting() {
  const lines = [55, 40, 85, 75];
  return (
    <div className="qt-write" role="status" aria-live="polite">
      <div className="qt-write-sheet" aria-hidden="true">
        <i className="qt-write-logo" />
        {lines.map((w, k) => <i key={k} className="qt-write-ln" style={{ width: `${w}%`, animationDelay: `${0.2 + k * 0.22}s` }} />)}
        <span className="qt-write-gap" />
        {[0, 1, 2].map((r2) => (
          <span key={r2} className="qt-write-row">
            {[0, 1, 2].map((c) => <i key={c} style={{ animationDelay: `${1.2 + r2 * 0.3 + c * 0.1}s` }} />)}
          </span>
        ))}
        <i className="qt-write-tot" />
      </div>
      <p>Making the PDF</p>
    </div>
  );
}

/** What a yellow template asks, shown when it is uploaded, so a missed or wrong yellow is seen at once. */
function YellowCheck({ lay, onChange }) {
  const Y = lay.yellow;
  const own = (Y.price?.fields ?? []).filter((x) => !x.link);
  const role = (k) => {
    if (k === Y.price.price) return 'Price';
    if (k === Y.price.qty) return 'Qty';
    if (own.some((x) => x.key.startsWith(`c${k}g`))) return 'Typed';
    if (/^(s[il]?\.?\s*no\.?|sr\.?\s*no\.?|no\.?|#)$/i.test(Y.price.cols[k] ?? '')) return 'Counted';
    return 'As in the file';
  };
  return (
    <div className="qt-yc">
      <section className="qt-yc-sec">
        <h3>Boxes · {Y.fields.filter((x) => x.kind !== 'words' && x.kind !== 'fixed').length}</h3>
        <ul className="qt-yc-list">
          {Y.fields.map((x) => (
            <li key={x.key}><b>{x.label}</b><span>{x.kind === 'words' ? 'Worked out' : x.kind === 'fixed' ? 'Kept as in the file' : x.sample.split('\n').join(' · ')}</span>{x.kind === 'period' && <em>From – To</em>}{x.kind === 'date' && <em>Date</em>}{x.places > 1 && <em>×{x.places}</em>}</li>
          ))}
        </ul>
        {Y.missed?.length > 0 && (
          <div className="qt-yc-missed">
            <b>Not in yellow · may change</b>
            <ul className="qt-yc-list">{Y.missed.map((m) => <li key={m.text}><b>{m.label}</b><span>{m.text}</span></li>)}</ul>
          </div>
        )}
      </section>
      {Y.price && (
        <section className="qt-yc-sec">
          <h3>Price table</h3>
          <ul className="qt-yc-list">
            {Y.price.cols.map((c, k) => <li key={k}><b>{c || '—'}</b><span>{role(k)}</span></li>)}
            <li><b>Total · GST · Grand total</b><span>Worked out</span></li>
          </ul>
          {Y.price.qty != null && !Y.price.lumpSure && (
            <Field label={`${Y.price.priceHead} is for`} wide>
              <Choice value={Y.price.lump ? 'row' : 'unit'} onChange={(x) => onChange({ ...lay, yellow: { ...Y, price: { ...Y.price, lump: x === 'row' } } })}
                options={[['unit', 'One (× Qty)', 'good'], ['row', 'The whole row', 'good']]} />
            </Field>
          )}
        </section>
      )}
      {Y.list && (
        <section className="qt-yc-sec">
          <h3>{Y.list.title || 'List'}</h3>
          <ul className="qt-yc-list">{Y.list.cols.map((c, k) => <li key={k}><b>{c}</b><span>{k === 0 && /^(s[il]?\.?\s*no\.?|sr\.?\s*no\.?|no\.?|#)$/i.test(c) ? 'Counted' : 'Typed or Excel'}</span></li>)}</ul>
        </section>
      )}
    </div>
  );
}
