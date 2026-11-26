import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SideNav from './SideNav.jsx';
import Picker from './Picker.jsx';
import { ProjectMasthead } from './ProjectHome.jsx';
import { CHECKLISTS, CHECKLIST, checkRows } from '../data/pmChecklists.js';
import {
  loadPmList, loadFacilities, submitPm, loadReport, exportReports, periodRange, todayIst, nowTime, timeText,
  readDraft, saveDraft, dropDraft, duration, isBad,
} from '../data/pm.js';
import '../medtronic.css';
import '../pm.css';

/**
 * PM checklist: an engineer picks the equipment, fills its checklist at the
 * site and submits it; everyone else on the project reads the reports, the
 * summary, and an Excel per equipment (the user, 31 Oct). Phone first, and
 * for people who do not use phones much: one press per row, numbers on the
 * number pad, the half-filled sheet kept, nothing hidden behind gestures.
 */

const ENGINEER_TABS = [
  { id: 'checklist', label: 'Checklists', short: 'Checklists' },
  { id: 'calls', label: 'My PMs', short: 'My PMs' },
];
const VIEWER_TABS = [
  { id: 'dashboard', label: 'Summary', short: 'Summary' },
  { id: 'calls', label: 'Reports', short: 'Reports' },
];
const PERIODS = [['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (d) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
const hm = (t) => (t ? t.slice(0, 5) : '');
const TINTS = ['#0d9488', '#2563eb', '#7c3aed', '#d97706', '#db2777', '#059669', '#0891b2', '#4f46e5', '#ea580c', '#65a30d', '#9333ea'];

/* Each machine drawn, so the engineer finds it by its shape (the user: "ventilator then icon should be ventilator"). */
const MACHINE = {
  ANU: <><rect x="7" y="2.5" width="10" height="6" rx="1.2" /><path d="M12 8.5V10" /><rect x="5" y="10" width="14" height="9" rx="1.5" /><circle cx="9.5" cy="14.5" r="2" /><path d="M14 13h2.5M14 16h2.5" /><circle cx="7.5" cy="21" r="1" /><circle cx="16.5" cy="21" r="1" /></>,
  CRS: <><path d="M8 13V5.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V13" /><rect x="3" y="10" width="18" height="9" rx="2" /><path d="M6 13h12M6.5 16h3" /></>,
  DLM: <><rect x="4" y="3" width="11" height="18" rx="2" /><rect x="6.5" y="5.5" width="6" height="4" rx="0.8" /><circle cx="9.5" cy="15" r="2.3" /><rect x="18" y="6" width="3" height="10" rx="1.5" /><path d="M15 8h3M15 14h3" /></>,
  FLP: <><path d="M7 8V3h10v5" /><rect x="3" y="8" width="18" height="8" rx="2" /><path d="M7 16v5h10v-5M16.5 11.5H18" /></>,
  GNE: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M6 10h3l1.5-3 2.5 6 1.5-3H18M9 20h6M12 16v4" /></>,
  HMA: <><path d="M5 3h7M6 3v14a2.5 2.5 0 0 0 5 0V3M6 11h5" /><path d="M17 9c-2 2.6-3 4.3-3 5.7a3 3 0 0 0 6 0c0-1.4-1-3.1-3-5.7z" /></>,
  SAA: <><rect x="3" y="9" width="18" height="11" rx="2" /><rect x="6" y="12" width="7" height="4.5" rx="0.8" /><path d="M14 3.5h3M17 3.5V9M15.5 12h3v4.5a1.5 1.5 0 0 1-3 0z" /></>,
  ULS: <><rect x="10" y="2.5" width="4" height="5.5" rx="1" /><path d="M8 8h8v2.5a4 4 0 0 1-8 0z" /><path d="M7 17.5a7 2.6 0 0 0 10 0M5 21a10 3 0 0 0 14 0" /></>,
  VNT: <><path d="M12 3v9M12 12c-.5 1-1.2 1.5-2 1.5M12 12c.5 1 1.2 1.5 2 1.5" /><path d="M9.5 8C6.5 6.5 4 10 4 15v3a2.5 2.5 0 0 0 3.2 2.4L9 19.8a1.5 1.5 0 0 0 1-1.4V9a1 1 0 0 0-.5-1z" /><path d="M14.5 8c3-1.5 5.5 2 5.5 7v3a2.5 2.5 0 0 1-3.2 2.4L15 19.8a1.5 1.5 0 0 1-1-1.4V9a1 1 0 0 1 .5-1z" /></>,
  XRDR: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 6v12M12 8c-2 0-3.5.6-4.5 1.6M12 8c2 0 3.5.6 4.5 1.6M12 11c-2 0-3.5.6-4.5 1.6M12 11c2 0 3.5.6 4.5 1.6M12 14c-1.8 0-3 .5-4 1.4M12 14c1.8 0 3 .5 4 1.4" /></>,
  XRM: <><path d="M4 21V3M4 5h8M3 21h4M7 17h14" /><rect x="11" y="3.5" width="7" height="4" rx="1" /><path d="M12.5 10l-1 4M14.5 10v4M16.5 10l1 4" /></>,
};
const MachineIcon = ({ code }) => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {MACHINE[code]}
  </svg>
);
const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M8 11l4 4 4-4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

export default function PmApp({ me, profile, narrow, switcher, onSignOut }) {
  const viewer = me?.role === 'viewer';
  const [tab, setTab] = useState(viewer ? 'dashboard' : 'checklist');
  const [period, setPeriod] = useState({ id: 'month', from: '', to: '' });
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(null);
  const [filling, setFilling] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [equipFilter, setEquipFilter] = useState('');
  const [toast, setToast] = useState(null);

  const reload = useCallback(() => {
    const [from, to] = periodRange(period);
    return loadPmList(from, to).then((d) => { setList(d ?? []); setFailed(null); }).catch((e) => setFailed(e.message));
  }, [period]);

  useEffect(() => {
    reload();
    const check = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [reload]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const tabs = viewer ? VIEWER_TABS : ENGINEER_TABS;
  const sub = `PM checklist${list ? ` · ${list.length.toLocaleString('en-IN')} ${list.length === 1 ? 'PM' : 'PMs'} ${period.id === 'month' ? 'this month' : period.id === 'all' ? 'in all' : 'in the period'}` : ''}`;

  return (
    <div className="app">
      <ProjectMasthead profile={profile} narrow={narrow} sub={sub} right={switcher} onSignOut={onSignOut} />
      <div className="shell">
        <SideNav
          tabs={tabs}
          active={filling ? 'checklist' : tab}
          onSelect={(id) => { setFilling(null); setTab(id); }}
          onSignOut={onSignOut}
          signedIn={Boolean(profile)}
          profile={profile}
          showAccountControls={!narrow}
        />
        <div className="work">
          {toast && <div className="mt-toast" role="status">{toast}</div>}
          {filling ? (
            <PmForm
              key={filling}
              def={CHECKLIST[filling]}
              profile={profile}
              onBack={() => setFilling(null)}
              onDone={(msg) => { setFilling(null); setTab('calls'); setToast(msg); reload(); }}
            />
          ) : failed ? (
            <div className="status-msg">
              <p>PM checklist could not load just now.</p>
              <p className="status-detail">{failed}</p>
              <button type="button" className="mt-btn" onClick={reload}>Try again</button>
            </div>
          ) : !list ? (
            <div className="status-msg"><div className="loader" aria-hidden="true" /></div>
          ) : (
            <div className="tabview" key={tab}>
              {tab === 'checklist' && <EquipmentGrid list={list} onPick={setFilling} />}
              {tab === 'dashboard' && (
                <Summary
                  list={list}
                  period={period}
                  setPeriod={setPeriod}
                  onEquipment={(code) => { setEquipFilter(code); setTab('calls'); }}
                  onToast={setToast}
                />
              )}
              {tab === 'calls' && (
                <Reports
                  list={list}
                  viewer={viewer}
                  narrow={narrow}
                  period={period}
                  setPeriod={setPeriod}
                  equipment={equipFilter}
                  setEquipment={setEquipFilter}
                  onOpen={setOpenId}
                  onToast={setToast}
                />
              )}
            </div>
          )}
        </div>
      </div>
      {openId && <ReportSheet id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function PeriodBar({ period, setPeriod, children }) {
  return (
    <div className="mt-period">
      <div className="segmented" role="tablist" aria-label="Period">
        {PERIODS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={period.id === id}
                  onClick={() => setPeriod((p) => ({ ...p, id }))}>{label}</button>
        ))}
      </div>
      {period.id === 'custom' && (
        <div className="mt-range">
          <label className="mt-field"><span>From</span>
            <input type="date" value={period.from} max={period.to || undefined}
                   onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} />
          </label>
          <label className="mt-field"><span>To</span>
            <input type="date" value={period.to} min={period.from || undefined}
                   onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} />
          </label>
        </div>
      )}
      {children}
    </div>
  );
}

/* ======================================================= the engineer's == */

function EquipmentGrid({ list, onPick }) {
  const mine = useMemo(() => {
    const m = new Map();
    for (const r of list) m.set(r.equipment, (m.get(r.equipment) ?? 0) + 1);
    return m;
  }, [list]);
  return (
    <div className="pm-home">
      <h2 className="pm-home-title">Choose the equipment</h2>
      <ul className="pm-grid">
        {CHECKLISTS.map((c, i) => {
          const draft = readDraft(c.code);
          return (
            <li key={c.code}>
              <button type="button" className="pm-tile" style={{ '--tint': TINTS[i % TINTS.length], '--i': i }} onClick={() => onPick(c.code)}>
                <span className="pm-tile-icon"><MachineIcon code={c.code} /></span>
                <span className="pm-tile-name">{c.name}</span>
                {draft ? <span className="pm-tile-draft">Not finished</span>
                  : mine.get(c.code) ? <span className="pm-tile-sub">{mine.get(c.code)} this month</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const blankReport = () => ({
  equipment_name: '', barcode: '', pm_wo: '', facility: '',
  pm_date: todayIst(), start_time: nowTime(), end_time: '',
  answers: {}, notes: '', handed_over: null, customer_name: '',
});

function PmForm({ def, profile, onBack, onDone }) {
  const [r, setR] = useState(() => readDraft(def.code) ?? blankReport());
  const [facilities, setFacilities] = useState([]);
  const [missing, setMissing] = useState(null);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const errRef = useRef(null);
  const rows = useMemo(() => checkRows(def), [def]);

  useEffect(() => { loadFacilities().then((f) => setFacilities(f ?? [])).catch(() => {}); }, []);
  // Every change is kept on the phone until it is submitted.
  useEffect(() => { saveDraft(def.code, r); }, [def.code, r]);

  const set = (k, v) => { setR((x) => ({ ...x, [k]: v })); setErr(null); };
  const answer = (id, patch) => { setR((x) => ({ ...x, answers: { ...x.answers, [id]: { ...x.answers[id], ...patch } } })); setErr(null); };
  const done = rows.filter((it) => r.answers[it.id]?.s).length;

  const allOk = (s) => setR((x) => {
    const a = { ...x.answers };
    for (const it of s.items) {
      if (it.kind !== 'check' || a[it.id]?.s || it.options[0] === 'Yes') continue;
      a[it.id] = { ...a[it.id], s: it.options[0] };
    }
    return { ...x, answers: a };
  });

  const check = () => {
    const miss = new Set(rows.filter((it) => !r.answers[it.id]?.s).map((it) => it.id));
    const need = [];
    if (!r.equipment_name.trim()) need.push('equipment name');
    if (!r.facility.trim()) need.push('hospital');
    if (!r.pm_date) need.push('date');
    if (r.handed_over == null) miss.add('handed_over');
    setMissing(miss);
    if (need.length || miss.size) {
      const parts = [];
      if (need.length) parts.push(`Write the ${need.join(', ')}`);
      const n = [...miss].filter((m) => m !== 'handed_over').length;
      if (n) parts.push(`${n} ${n === 1 ? 'row is' : 'rows are'} not answered`);
      if (miss.has('handed_over')) parts.push('choose whether the machine was handed over in good condition');
      setErr(`${parts.join('; ')}.`);
      const first = need.length ? document.querySelector('.pm-details') : document.querySelector('.pm-row.is-missing, .pm-summary.is-missing');
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setConfirm(true);
  };

  const submit = async () => {
    setBusy(true);
    try {
      await submitPm({ ...r, equipment: def.code, end_time: r.end_time || nowTime() });
      dropDraft(def.code);
      onDone(`${def.name} PM submitted for ${r.facility.trim()}.`);
    } catch (e) {
      setConfirm(false);
      setErr(e.message);
      setTimeout(() => errRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    } finally {
      setBusy(false);
    }
  };

  const clear = () => { dropDraft(def.code); setR(blankReport()); setMissing(null); setErr(null); };
  const bad = rows.filter((it) => isBad(r.answers[it.id])).length;

  return (
    <div className="pm-form">
      <div className="pm-form-head">
        <button type="button" className="pm-back" onClick={onBack} aria-label="Back to the checklists">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div className="pm-form-title">
          <h2>{def.name}</h2>
          <span>{def.form}</span>
        </div>
        {(done > 0 || r.equipment_name) && <button type="button" className="pm-clear" onClick={clear}>Start again</button>}
      </div>

      <section className="pm-card pm-details">
        <label className="pm-in"><span>Equipment name</span>
          <input value={r.equipment_name} onChange={(e) => set('equipment_name', e.target.value)} placeholder="Make and model" />
        </label>
        <label className="pm-in"><span>Hospital</span>
          <input value={r.facility} onChange={(e) => set('facility', e.target.value)} list="pm-facilities" placeholder="Hospital name" />
          <datalist id="pm-facilities">{facilities.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <div className="pm-in-row">
          <label className="pm-in"><span>Barcode</span>
            <input value={r.barcode} onChange={(e) => set('barcode', e.target.value)} />
          </label>
          <label className="pm-in"><span>PM WO</span>
            <input value={r.pm_wo} onChange={(e) => set('pm_wo', e.target.value)} />
          </label>
        </div>
        <div className="pm-in-row is-three">
          <label className="pm-in"><span>Date</span>
            <input type="date" value={r.pm_date} max={todayIst()} onChange={(e) => set('pm_date', e.target.value)} />
          </label>
          <label className="pm-in"><span>Start time</span>
            <input type="time" value={r.start_time} onChange={(e) => set('start_time', e.target.value)} />
          </label>
          <label className="pm-in"><span>End time</span>
            <input type="time" value={r.end_time} onChange={(e) => set('end_time', e.target.value)} />
          </label>
        </div>
      </section>

      {def.sections.map((s, si) => {
        const left = s.items.filter((it) => it.kind === 'check' && !r.answers[it.id]?.s && it.options[0] !== 'Yes').length;
        return (
          <section key={si} className="pm-card">
            {s.part && <div className="pm-part">{s.part}</div>}
            {(s.title || left > 0) && (
              <div className="pm-sec-head">
                <h3>{s.title ?? ''}</h3>
                {left > 0 && <button type="button" className="pm-allok" onClick={() => allOk(s)}>All {s.items.find((it) => it.kind === 'check')?.options[0]}</button>}
              </div>
            )}
            {s.items.map((it) => (
              <Row key={it.id} it={it} a={r.answers[it.id]} missing={missing?.has(it.id)} onChange={(p) => answer(it.id, p)} />
            ))}
          </section>
        );
      })}

      <section className={`pm-card pm-summary${missing?.has('handed_over') && r.handed_over == null ? ' is-missing' : ''}`}>
        <h3>Summary</h3>
        <label className="pm-in"><span>Notes / overall observation</span>
          <textarea rows={3} value={r.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
        <div className="pm-in"><span>Handed over the machine in good condition</span>
          <div className="pm-choices is-two">
            {[[true, 'Yes'], [false, 'No']].map(([v, l]) => (
              <button key={l} type="button" className="pm-choice" data-tone={v ? 'good' : 'bad'}
                      aria-pressed={r.handed_over === v} onClick={() => set('handed_over', v)}>{l}</button>
            ))}
          </div>
        </div>
        <label className="pm-in"><span>Customer name</span>
          <input value={r.customer_name} onChange={(e) => set('customer_name', e.target.value)} />
        </label>
        <div className="pm-signed">Engineer · {profile?.full_name ?? ''}{r.start_time && r.end_time ? ` · ${duration(r.start_time, r.end_time)}` : ''}</div>
      </section>

      <div className="pm-bar">
        <div className="pm-progress">
          <span className="pm-progress-n">{done} of {rows.length}</span>
          <span className="pm-progress-track"><span style={{ width: `${rows.length ? (done / rows.length) * 100 : 0}%` }} /></span>
        </div>
        <button type="button" className="mt-go pm-submit" onClick={check} disabled={busy}>Submit</button>
        {err && <p className="mt-err pm-bar-err" ref={errRef} role="alert">{err}</p>}
      </div>

      {confirm && (
        <div className="modal-scrim" role="presentation">
          <div className="modal mt-modal" role="dialog" aria-label="Submit PM">
            <div className="modal-head"><h2>Submit this PM?</h2></div>
            <div className="modal-body">
              <p className="pm-confirm-line"><b>{def.name}</b> · {r.equipment_name.trim()}</p>
              <p className="pm-confirm-line">{r.facility.trim()} · {dayOf(r.pm_date)}</p>
              <p className="pm-confirm-line">{bad ? `${bad} ${bad === 1 ? 'row' : 'rows'} not OK` : 'Every row OK'}</p>
              <p className="pm-confirm-note">A submitted PM cannot be changed.</p>
            </div>
            <div className="modal-foot">
              <button type="button" className="mt-btn" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
              <button type="button" className="mt-btn mt-btn-primary" onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ it, a, missing, onChange }) {
  const [remark, setRemark] = useState(Boolean(a?.r));
  if (it.kind === 'text') {
    return (
      <label className="pm-row pm-in"><span>{it.label}</span>
        <textarea rows={2} value={a?.r ?? ''} onChange={(e) => onChange({ r: e.target.value })} />
      </label>
    );
  }
  if (it.kind === 'params') {
    const rows = a?.rows ?? Array.from({ length: it.params }, () => ({}));
    const put = (i, k, v) => onChange({ rows: rows.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
    return (
      <div className="pm-row pm-params">
        {rows.map((x, i) => (
          <div key={i} className="pm-param">
            <input value={x.p ?? ''} onChange={(e) => put(i, 'p', e.target.value)} placeholder="Parameter" aria-label={`Parameter ${i + 1}`} />
            <input value={x.set ?? ''} onChange={(e) => put(i, 'set', e.target.value)} placeholder="Set value" inputMode="decimal" aria-label={`Set value ${i + 1}`} />
            <input value={x.meas ?? ''} onChange={(e) => put(i, 'meas', e.target.value)} placeholder="Measured" inputMode="decimal" aria-label={`Measured value ${i + 1}`} />
            <input value={x.r ?? ''} onChange={(e) => put(i, 'r', e.target.value)} placeholder="Remarks" aria-label={`Remarks ${i + 1}`} />
          </div>
        ))}
      </div>
    );
  }
  const showRemark = it.measure || remark || isBad(a);
  return (
    <div className={`pm-row${missing && !a?.s ? ' is-missing' : ''}`}>
      <div className="pm-row-label">
        {it.label}
        {it.expect && <span className="pm-expect">Expected: {it.expect}</span>}
      </div>
      {it.fields && (
        <div className="pm-fields">
          {it.fields.map((f) => (
            <label key={f.k} className="pm-field">
              {f.label && <span className="pm-field-label">{f.label}</span>}
              <input inputMode="decimal" value={a?.v?.[f.k] ?? ''} onChange={(e) => onChange({ v: { ...a?.v, [f.k]: e.target.value } })}
                     aria-label={`${it.label} ${f.label ?? ''}`} />
              {f.unit && <span className="pm-field-unit">{f.unit}</span>}
            </label>
          ))}
        </div>
      )}
      <div className={`pm-choices${it.options.length === 2 ? ' is-two' : ''}`}>
        {it.options.map((o) => (
          <button key={o} type="button" className="pm-choice" data-tone={isBad({ s: o }) ? 'bad' : o === 'N/A' || o === 'Not involved' ? 'none' : 'good'}
                  aria-pressed={a?.s === o} onClick={() => onChange({ s: o })}>{o}</button>
        ))}
      </div>
      {showRemark ? (
        <input className="pm-remark" value={a?.r ?? ''} onChange={(e) => onChange({ r: e.target.value })}
               placeholder={it.measure ? 'Measured value / remarks' : 'Remark'} aria-label={`${it.label} remark`} />
      ) : (
        <button type="button" className="pm-add-remark" onClick={() => setRemark(true)}>+ Remark</button>
      )}
    </div>
  );
}

/* ======================================================== the readers' == */

function Bars({ rows, onPick }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="empty-inline">None</p>;
  return (
    <ul className="mt-bars">
      {rows.map((r) => (
        <li key={r.key ?? r.label} className="mt-bar">
          {onPick ? <button type="button" className="mt-bar-label pm-bar-pick" onClick={() => onPick(r.key)} title={r.label}>{r.label}</button>
            : <span className="mt-bar-label" title={r.label}>{r.label}</span>}
          <span className="mt-bar-track"><span className="mt-bar-fill" style={{ width: `${(r.n / max) * 100}%`, background: r.tint }} /></span>
          <span className="mt-bar-n">{r.n}</span>
        </li>
      ))}
    </ul>
  );
}

function countBy(list, fn) {
  const m = new Map();
  for (const r of list) { const k = fn(r) || '—'; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

function periodLabel(p) {
  if (p.id === 'month') return todayIst().slice(0, 7);
  if (p.id === 'all') return 'all';
  return `${p.from || 'start'}-to-${p.to || todayIst()}`;
}

/** One workbook of what is on screen, each equipment on its own sheet. The refusal shows beside it. */
function ExcelButton({ period, ids, onToast }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => setErr(null), [period, ids]);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const [from, to] = periodRange(period);
      const { reports } = await exportReports({ from, to, ids, label: periodLabel(period) });
      onToast(`Excel downloaded · ${reports} ${reports === 1 ? 'PM' : 'PMs'}.`);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="mt-btn mt-btn-primary pm-excel" onClick={go} disabled={busy}>
        <DownloadIcon /> {busy ? 'Preparing…' : 'Excel'}
      </button>
      {err && <span className="mt-err pm-excel-err" role="alert">{err}</span>}
    </>
  );
}

function Summary({ list, period, setPeriod, onEquipment, onToast }) {
  const f = useMemo(() => {
    const byEq = new Map(CHECKLISTS.map((c) => [c.code, 0]));
    for (const r of list) byEq.set(r.equipment, (byEq.get(r.equipment) ?? 0) + 1);
    return {
      engineers: new Set(list.map((r) => r.engineer_code)).size,
      hospitals: new Set(list.map((r) => r.facility.trim().toLowerCase())).size,
      withIssues: list.filter((r) => r.issues > 0).length,
      equipment: CHECKLISTS.map((c, i) => ({ key: c.code, label: c.name, n: byEq.get(c.code) ?? 0, tint: TINTS[i % TINTS.length] })),
      bemmp: countBy(list, (r) => r.cost_centre).map((x) => ({ ...x, tint: 'var(--series-1)' })),
    };
  }, [list]);

  return (
    <div className="mt-dash">
      <PeriodBar period={period} setPeriod={setPeriod} />
      <div className="mt-tiles">
        {[
          ['PMs done', list.length, 'var(--series-1)'],
          ['Engineers', f.engineers, 'var(--series-4)'],
          ['Hospitals', f.hospitals, 'var(--series-3)'],
          ['With rows not OK', f.withIssues, 'var(--status-critical)'],
        ].map(([label, value, tint], i) => (
          <div key={label} className="kpi" style={{ '--k-tint': tint, '--i': i }}>
            <div className="k-top"><span className="k-label">{label}</span></div>
            <div className="k-main"><span className="k-value">{value.toLocaleString('en-IN')}</span></div>
          </div>
        ))}
      </div>
      <div className="mt-panels">
        <section className="panel mt-panel mt-panel-wide" style={{ '--i': 1 }}>
          <h2>By equipment</h2>
          <Bars rows={f.equipment} onPick={onEquipment} />
        </section>
        <section className="panel mt-panel" style={{ '--i': 2 }}>
          <h2>By BEMMP</h2>
          <Bars rows={f.bemmp} />
        </section>
      </div>
    </div>
  );
}

const SORTS = [['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['issues-desc', 'Most not OK']];

function Reports({ list, viewer, narrow, period, setPeriod, equipment, setEquipment, onOpen, onToast }) {
  const [q, setQ] = useState('');
  const [bemmp, setBemmp] = useState('');
  const [eng, setEng] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [limit, setLimit] = useState(150);

  const opts = useMemo(() => {
    const count = (fn) => { const m = new Map(); for (const r of list) { const k = fn(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); } return m; };
    const eq = count((r) => r.equipment);
    const cc = count((r) => r.cost_centre);
    const people = new Map();
    for (const r of list) { const p = people.get(r.engineer_code) ?? { name: r.engineer_name, n: 0 }; p.n += 1; people.set(r.engineer_code, p); }
    return {
      equipment: [{ value: '', label: 'All equipment', count: list.length }, ...CHECKLISTS.filter((c) => eq.get(c.code)).map((c) => ({ value: c.code, label: c.name, count: eq.get(c.code) }))],
      bemmp: [{ value: '', label: 'All BEMMP', count: list.length }, ...[...cc].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ value: k, label: k, count: n }))],
      people: [{ value: '', label: 'All engineers', count: list.length }, ...[...people].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([k, p]) => ({ value: k, label: p.name, count: p.n }))],
    };
  }, [list]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = list.filter((r) => (!equipment || r.equipment === equipment)
      && (!bemmp || r.cost_centre === bemmp)
      && (!eng || r.engineer_code === eng)
      && (!s || [r.facility, r.engineer_name, r.engineer_code, r.barcode, r.pm_wo, r.equipment_name, CHECKLIST[r.equipment]?.name]
        .some((x) => String(x ?? '').toLowerCase().includes(s))));
    const [k, d] = sort.split('-');
    const dir = d === 'asc' ? 1 : -1;
    const val = (r) => (k === 'issues' ? r.issues : k === 'hospital' ? r.facility.toLowerCase() : k === 'engineer' ? (r.engineer_name ?? '')
      : k === 'equipment' ? (CHECKLIST[r.equipment]?.name ?? '') : `${r.pm_date} ${r.submitted_at}`);
    return out.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : 0));
  }, [list, q, equipment, bemmp, eng, sort]);

  const th = (key, label) => {
    const [k, d] = sort.split('-');
    return (
      <th><button type="button" className="th-sort" onClick={() => setSort(k === key && d === 'desc' ? `${key}-asc` : `${key}-desc`)}>
        {label}{k === key && <span className="sort-mark">{d === 'asc' ? '▲' : '▼'}</span>}
      </button></th>
    );
  };

  const ids = useMemo(() => shown.map((r) => r.id), [shown]);

  return (
    <div className="mt-tickets">
      <PeriodBar period={period} setPeriod={setPeriod} />
      <div className="mt-filters">
        {/* Excel shares the search row: on a phone a row of its own was wasted space (the user, 31 Oct). */}
        <div className="pm-search-row">
          <div className="field-search mt-search">
            <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(150); }}
                   placeholder="Search hospital, barcode" aria-label="Search" />
          </div>
          {viewer && <ExcelButton period={period} ids={ids} onToast={onToast} />}
        </div>
        <Picker title="Equipment" value={equipment} onChange={setEquipment} options={opts.equipment} />
        {viewer && <Picker title="BEMMP" value={bemmp} onChange={setBemmp} options={opts.bemmp} />}
        {viewer && <Picker title="Engineer" value={eng} onChange={setEng} options={opts.people} />}
        {narrow && <Picker title="Sort" value={sort} onChange={setSort} options={SORTS.map(([value, label]) => ({ value, label }))} />}
      </div>

      {!shown.length ? <p className="empty-inline pm-empty">No PM in this period.</p> : narrow ? (
        <ul className="mt-cards">
          {shown.slice(0, limit).map((r) => (
            <li key={r.id} className="mt-card pm-card-item" data-state={r.issues ? 'unassigned' : 'closed'}>
              <button type="button" className="mt-card-body" onClick={() => onOpen(r.id)}>
                <span className="mt-card-top">
                  <span className="mt-wo">{CHECKLIST[r.equipment]?.name ?? r.equipment}</span>
                  <span className={`mt-badge ${r.issues ? 'is-unassigned' : 'is-closed'}`}>{r.issues ? `${r.issues} not OK` : 'All OK'}</span>
                </span>
                <span className="mt-card-line mt-strong">{r.facility}</span>
                <span className="mt-card-line">{[r.equipment_name, r.barcode].filter(Boolean).join(' · ')}</span>
                <span className="mt-card-foot">
                  <span className="mt-card-meta">{dayOf(r.pm_date)}{r.pm_wo ? ` · ${r.pm_wo}` : ''}</span>
                  {viewer && <span className="mt-card-right"><span className="mt-strong">{r.engineer_name}</span></span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="panel mt-table-wrap">
          <table className="mt-table">
            <thead>
              <tr>
                {th('date', 'Date')}
                {th('equipment', 'Equipment')}
                {th('hospital', 'Hospital')}
                <th>Equipment name</th>
                <th>Barcode</th>
                <th>PM WO</th>
                {viewer && th('engineer', 'Engineer')}
                {viewer && <th>BEMMP</th>}
                {th('issues', 'Not OK')}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((r) => (
                <tr key={r.id} data-state={r.issues ? 'unassigned' : 'closed'} onClick={() => onOpen(r.id)}>
                  <td className="mt-nowrap">{dayOf(r.pm_date)}</td>
                  <td>{CHECKLIST[r.equipment]?.name ?? r.equipment}</td>
                  <td className="mt-strong">{r.facility}</td>
                  <td>{r.equipment_name}</td>
                  <td>{r.barcode ?? '—'}</td>
                  <td>{r.pm_wo ?? '—'}</td>
                  {viewer && <td>{r.engineer_name} <span className="mt-muted">{r.engineer_code}</span></td>}
                  {viewer && <td>{r.cost_centre ?? '—'}</td>}
                  <td className="mt-num">{r.issues ? <span className="mt-badge is-unassigned">{r.issues}</span> : <span className="mt-badge is-closed">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown.length > limit && (
        <button type="button" className="mt-more" onClick={() => setLimit((l) => l + 150)}>Show more ({shown.length - limit} left)</button>
      )}
    </div>
  );
}

function ReportSheet({ id, onClose }) {
  const [r, setR] = useState(undefined);
  useEffect(() => { loadReport(id).then(setR).catch(() => setR(null)); }, [id]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = prev; };
  }, [onClose]);
  const def = r ? CHECKLIST[r.equipment] : null;

  return (
    <div className="mt-scrim" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mt-sheet" role="dialog" aria-label="PM report">
        <span className="mt-sheet-grab" aria-hidden="true" />
        <div className="mt-sheet-head">
          <div className="mt-sheet-title">
            {r && <span className={`mt-badge ${r.issues ? 'is-unassigned' : 'is-closed'}`}>{r.issues ? `${r.issues} not OK` : 'All OK'}</span>}
            <h2>{def?.name ?? 'PM report'}</h2>
            {r && <p>{r.facility} · {dayOf(r.pm_date)}</p>}
          </div>
          <button type="button" className="mt-sheet-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="mt-sheet-body">
          {r === undefined && <div className="loader" aria-hidden="true" />}
          {r === null && <p className="empty-inline">This report could not load.</p>}
          {r && def && (
            <>
              <dl className="pm-facts">
                <div><dt>Engineer</dt><dd>{r.engineer_name} ({r.engineer_code})</dd></div>
                <div><dt>BEMMP</dt><dd>{r.cost_centre ?? '—'}</dd></div>
                <div><dt>Equipment name</dt><dd>{r.equipment_name}</dd></div>
                <div><dt>Barcode</dt><dd>{r.barcode ?? '—'}</dd></div>
                <div><dt>PM WO</dt><dd>{r.pm_wo ?? '—'}</dd></div>
                <div><dt>Time</dt><dd>{timeText(hm(r.start_time)) || '—'}{r.end_time ? ` – ${timeText(hm(r.end_time))}` : ''}{duration(hm(r.start_time), hm(r.end_time)) ? ` · ${duration(hm(r.start_time), hm(r.end_time))}` : ''}</dd></div>
                <div><dt>Handed over in good condition</dt><dd>{r.handed_over == null ? '—' : r.handed_over ? 'Yes' : 'No'}</dd></div>
                <div><dt>Customer</dt><dd>{r.customer_name ?? '—'}</dd></div>
              </dl>
              {def.sections.map((s, si) => (
                <section key={si} className="pm-read">
                  {s.part && <div className="pm-part">{s.part}</div>}
                  {s.title && <h3>{s.title}</h3>}
                  <ul>
                    {s.items.map((it) => <ReadRow key={it.id} it={it} a={r.answers?.[it.id]} />)}
                  </ul>
                </section>
              ))}
              {r.notes && (
                <section className="pm-read"><h3>Notes / overall observation</h3><p className="pm-read-note">{r.notes}</p></section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReadRow({ it, a }) {
  if (it.kind === 'text') return <li className="pm-read-row"><span className="pm-read-label">{it.label}</span><span className="pm-read-val">{a?.r || '—'}</span></li>;
  if (it.kind === 'params') {
    const rows = (a?.rows ?? []).filter((x) => x.p || x.set || x.meas || x.r);
    return (
      <li className="pm-read-row is-block">
        {!rows.length ? <span className="pm-read-val">—</span> : rows.map((x, i) => (
          <span key={i} className="pm-read-val">{[x.p, x.set && `Set ${x.set}`, x.meas && `Measured ${x.meas}`, x.r].filter(Boolean).join(' · ')}</span>
        ))}
      </li>
    );
  }
  const vals = (it.fields ?? []).filter((f) => a?.v?.[f.k]).map((f) => `${f.label ? `${f.label} ` : ''}${a.v[f.k]}${f.unit ? ` ${f.unit}` : ''}`);
  const tone = !a?.s ? 'none' : isBad(a) ? 'bad' : a.s === 'N/A' || a.s === 'Not involved' ? 'none' : 'good';
  return (
    <li className="pm-read-row">
      <span className="pm-read-label">{it.label}{it.expect && <span className="pm-expect">Expected: {it.expect}</span>}</span>
      <span className="pm-read-val">
        {a?.s && <span className="pm-read-chip" data-tone={tone}>{a.s}</span>}
        {vals.length > 0 && <span>{vals.join(', ')}</span>}
        {a?.r && <span className="pm-read-remark">{a.r}</span>}
      </span>
    </li>
  );
}
