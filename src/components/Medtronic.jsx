import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SideNav from './SideNav.jsx';
import Picker from './Picker.jsx';
import { ProjectMasthead } from './ProjectHome.jsx';
import {
  roleOf, loadMtData, readTm, uploadTm, assignTickets, closeCall, proofUrl, todayIst, ageDays, AGE_BANDS,
  acceptTickets, startTicket, setWorkStatus, WORK, WORK_DETAIL, workLabel, stageOf, STAGE_LABEL, tatOf, fmtDur, loadEvents,
} from '../data/medtronic.js';
import '../medtronic.css';

/**
 * Medtronic: the manager uploads the ticket master and assigns the work orders
 * to his team; each engineer closes theirs with whether the CSAT was taken,
 * and its proof when it was; the manager's own manager watches (the user,
 * 31 Oct). Phone first — most of the people closing calls do it from a phone.
 */

const TABS = [
  { id: 'dashboard', label: 'Dashboard', short: 'Dashboard' },
  { id: 'calls', label: 'Tickets', short: 'Tickets' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const istDay = (iso) => (!iso ? null : iso.length === 10 ? iso
  : new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().slice(0, 10));
function dayOf(iso) {
  const s = istDay(iso);
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/**
 * A date the TM gives as text ("07/11/2026, 11:30 am", "01 Sept 2026, 12:00 pm"),
 * written the app's way: "7 Nov 2026, 11:30 am".
 */
function tmWhen(v) {
  if (!v) return null;
  const s = String(v).trim();
  const time = (rest) => {
    const t = rest.match(/^[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m\.?/i);
    return t ? `, ${Number(t[1])}:${t[2]} ${t[3].toLowerCase()}m` : '';
  };
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return `${Number(m[1])} ${MONTHS[Number(m[2]) - 1]} ${m[3]}${time(s.slice(m[0].length))}`;
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/);
  const mon = m && MONTHS.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase());
  if (m && mon >= 0) return `${Number(m[1])} ${MONTHS[mon]} ${m[3]}${time(s.slice(m[0].length))}`;
  return s;
}
/**
 * The number people use: the SAP notification (the user, 23 Nov: "this is the sap number they need"),
 * then the SAP service order, then the work order ("wo is not imp").
 */
const refOf = (t) => t.sap_notification || t.sap_order || t.wo;
const sameCode = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

/** Where a work order stands on our side, in the words on its badge (0077). */
function stateOf(t) {
  const id = stageOf(t);
  // Pending says only its status ("Started", not "Pending" and "Started": the user, 23 Nov).
  if (id === 'pending' && t.work_status) return { id, label: workLabel(t.work_status), work: t.work_status };
  return { id, label: STAGE_LABEL[id] };
}

/** Medtronic's own state, separate from ours: closed there shows as a tag (the user, 23 Nov). */
function MtTag({ t, full }) {
  if (t.mt_closed_on) return <span className="mt-tag is-mt-closed">Closed in Medtronic · {dayOf(t.mt_closed_on)}</span>;
  if (full && t.closed_by) return <span className="mt-tag">Open in Medtronic</span>;
  return null;
}

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15V4M8 8l4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

export default function MedtronicApp({ me, profile, narrow, switcher, onSignOut }) {
  const role = roleOf(me);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [view, setView] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [toast, setToast] = useState(null);

  const reload = useCallback(() => loadMtData()
    .then((d) => { setData(d); setFailed(null); })
    .catch((e) => setFailed(e.message)), []);

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

  const tickets = data?.tickets ?? [];
  // A lead (an engineer with people below him, 0082) works his own tickets as before
  // and has My team for theirs (the user, 23 Nov: "he can also assign to reassign to his resp reportees").
  const lead = role === 'engineer' && Boolean(me?.lead);
  const own = lead ? tickets.filter((t) => sameCode(t.engineer_code, profile?.code)) : tickets;
  const teamTickets = lead ? tickets.filter((t) => !sameCode(t.engineer_code, profile?.code)) : [];
  const last = data?.uploads?.[0];
  const opened = tickets.find((t) => t.id === openId);
  const done = (text) => { setToast(text); return reload(); };
  const toList = (v) => { setView(v); setTab('calls'); };
  // A phone has the masthead's upload icon instead.
  const uploadBtn = role === 'manager' && (
    <button type="button" className="mt-btn mt-btn-primary mt-head-action" onClick={() => setShowUpload(true)}>
      <UploadIcon /> Upload TM
    </button>
  );

  const sub = data
    ? `Medtronic · ${tickets.length.toLocaleString('en-IN')} tickets${last ? ` · TM of ${dayOf(last.uploaded_at)}, ${timeOf(last.uploaded_at)}` : ''}`
    : 'Medtronic';

  return (
    <div className="app">
      <ProjectMasthead
        profile={profile}
        narrow={narrow}
        sub={sub}
        right={switcher}
        onSignOut={onSignOut}
        extra={role === 'manager' && (
          <button type="button" className="icon-toggle" onClick={() => setShowUpload(true)} title="Upload TM" aria-label="Upload TM">
            <UploadIcon />
          </button>
        )}
      />

      <div className="shell">
        <SideNav
          tabs={TABS}
          active={tab}
          onSelect={(id) => { setTab(id); if (id === 'calls') setView(null); }}
          onUpload={role === 'manager' ? () => setShowUpload(true) : undefined}
          onSignOut={onSignOut}
          signedIn={Boolean(profile)}
          profile={profile}
          showAccountControls={!narrow}
        />
        <div className="work">
          {toast && <div className="mt-toast" role="status">{toast}</div>}

          {failed && (
            <div className="status-msg">
              <p>Medtronic could not load just now.</p>
              <p className="status-detail">{failed}</p>
              <button type="button" className="mt-btn" onClick={reload}>Try again</button>
            </div>
          )}
          {!data && !failed && (
            <div className="status-msg"><div className="loader" aria-hidden="true" /></div>
          )}

          {data && (
            <div className="tabview" key={tab}>
              {tab === 'dashboard'
                ? <Dashboard tickets={own} tatTickets={tickets} lead={lead} role={role} team={data.team} onList={toList} action={uploadBtn} />
                : (
                  <Tickets
                    key={view ?? 'list'}
                    tickets={own}
                    teamTickets={teamTickets}
                    lead={lead}
                    role={role}
                    team={data.team}
                    startView={view}
                    narrow={narrow}
                    onOpen={setOpenId}
                    onAssigned={done}
                    action={uploadBtn}
                  />
                )}
            </div>
          )}
        </div>
      </div>

      {showUpload && (
        <UploadSheet
          tickets={tickets}
          team={data?.team ?? []}
          profile={profile}
          onClose={() => setShowUpload(false)}
          onDone={reload}
        />
      )}
      {opened && (
        <TicketSheet
          t={opened}
          role={role}
          lead={lead}
          team={data.team}
          profile={profile}
          onClose={() => setOpenId(null)}
          onChanged={done}
        />
      )}
    </div>
  );
}

/* ============================================================ dashboard == */

const PERIODS = [['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];

function inPeriod(day, p) {
  if (p.id === 'all') return true;
  if (!day) return false;
  if (p.id === 'month') return day.slice(0, 7) === todayIst().slice(0, 7);
  return (!p.from || day >= p.from) && (!p.to || day <= p.to);
}

function Tile({ label, value, note, tint, i, onClick, icon }) {
  return (
    <button type="button" className="kpi clickable" style={{ '--k-tint': tint, '--i': i }} onClick={onClick}>
      <div className="k-top">
        <span className="k-label">{label}</span>
        <span className="k-icon">{icon}</span>
      </div>
      <div className="k-main"><span className="k-value">{value}</span></div>
      {note && <div className="k-note">{note}</div>}
    </button>
  );
}

const Ico = ({ d }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

function Bars({ rows, tint }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="empty-inline">None</p>;
  return (
    <ul className="mt-bars">
      {rows.map((r) => (
        <li key={r.label} className="mt-bar">
          <span className="mt-bar-label" title={r.label}>{r.label}</span>
          <span className="mt-bar-track">
            <span className="mt-bar-fill" style={{ width: `${(r.n / max) * 100}%`, background: r.tint ?? tint }} />
          </span>
          <span className="mt-bar-n">{r.n}</span>
        </li>
      ))}
    </ul>
  );
}

function countBy(list, key) {
  const m = new Map();
  for (const t of list) {
    const k = t[key] || '—';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

function Dashboard({ tickets, tatTickets, lead, role, team, onList, action }) {
  const [period, setPeriod] = useState({ id: 'month', from: '', to: '' });
  const today = todayIst();

  const f = useMemo(() => {
    const stage = (id) => tickets.filter((t) => stageOf(t) === id);
    const open = tickets.filter((t) => !t.closed_by && t.status === 'open');
    const completed = tickets.filter((t) => t.closed_by && inPeriod(t.closed_on, period));

    const ages = AGE_BANDS.map((b) => ({ label: b.label, n: 0, tint: null }));
    for (const t of open) {
      const a = ageDays(t, today);
      if (a == null) continue;
      ages[AGE_BANDS.findIndex((b) => a <= b.max)].n += 1;
    }
    ages.forEach((a, i) => { a.tint = ['var(--series-3)', 'var(--series-1)', 'var(--status-warning)', 'var(--series-2)', 'var(--status-critical)'][i]; });

    return {
      unassigned: stage('unassigned'), toAccept: stage('to_accept'), toStart: stage('to_start'),
      pending: stage('pending'), completed,
      purpose: countBy(open, 'purpose'),
      status: countBy(open, 'order_status'),
      ages,
      // Against Medtronic's close-by day (the user, 23 Nov: "that ticket should be in alert").
      ...(() => {
        const cbs = open.map((t) => [t, closeBy(t, today)]);
        return {
          late: cbs.filter(([, c]) => c.late).sort((a, b) => b[1].late - a[1].late),
          soon: cbs.filter(([, c]) => c.soon).sort((a, b) => a[1].left - b[1].left),
          ours: cbs.filter(([, c]) => c.oursLater),
        };
      })(),
    };
  }, [tickets, period, today]);

  const manages = role !== 'engineer';
  const spare = f.pending.filter((t) => t.work_status === 'waiting_spare').length;
  // Completion TAT: assigned → completed, averaged over the period's completions (the user, 23 Nov).
  const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const totalTat = mean(f.completed.map((t) => tatOf(t).total).filter((v) => v != null));
  const jobTat = mean(f.completed.map((t) => tatOf(t).job).filter((v) => v != null));

  return (
    <div className="mt-dash">
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
        {action}
      </div>

      <div className="mt-tiles is-stages">
        {manages && (
          <Tile i={0} label="Not assigned" value={f.unassigned.length} tint="var(--status-warning)"
                onClick={() => onList('unassigned')}
                icon={<Ico d={<><circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /><path d="M18 4l4 4M22 4l-4 4" /></>} />} />
        )}
        <Tile i={1} label="To accept" value={f.toAccept.length} tint="var(--series-2)"
              onClick={() => onList('to_accept')}
              icon={<Ico d={<><path d="M4 12.5l4.5 4.5L20 6.5" /></>} />} />
        <Tile i={2} label="To start" value={f.toStart.length} tint="var(--series-1)"
              onClick={() => onList('to_start')}
              icon={<Ico d={<><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5v7l6-3.5z" /></>} />} />
        <Tile i={3} label="Pending" value={f.pending.length} tint="var(--series-4)"
              note={spare ? `${spare} waiting for spare` : null}
              onClick={() => onList('pending')}
              icon={<Ico d={<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>} />} />
        <Tile i={4} label="Completed" value={f.completed.length} tint="var(--status-good)"
              onClick={() => onList('completed')}
              icon={<Ico d={<><circle cx="12" cy="12" r="8.5" /><path d="M8 12.5l2.7 2.7L16.5 9.5" /></>} />} />
        <Tile i={5} label="Completion TAT" value={fmtDur(totalTat)} tint="var(--series-5)"
              note={jobTat != null ? `Job ${fmtDur(jobTat)}` : null}
              onClick={() => onList('completed')}
              icon={<Ico d={<><path d="M6 3.5h12M6 20.5h12" /><path d="M7.5 3.5c0 4 9 5 9 8.5s-9 4.5-9 8.5M16.5 3.5c0 4-9 5-9 8.5s9 4.5 9 8.5" /></>} />} />
      </div>

      {/* Counts only; a press opens Tickets with that filter (the user, 23 Nov: "what if 100 past date is there"). */}
      {(f.late.length + f.soon.length + f.ours.length > 0) && (
        <div className="mt-alert-tabs">
          {[['late', 'Past Medtronic date'], ['soon', 'Medtronic date in 2 days'], ['ours', "Our date after Medtronic's"]].map(([id, label]) => (
            <button key={id} type="button" className={`mt-alert-tab is-${id}`} onClick={() => onList(`all|${id}`)}>
              <span>{label}</span><b>{f[id].length}</b>
            </button>
          ))}
        </div>
      )}

      <div className="mt-panels">
        <EngineerTat tickets={tatTickets ?? tickets} team={team} period={period} manages={manages || lead} lead={lead} />
        <section className="panel mt-panel" style={{ '--i': 2 }}>
          <h2>Open by purpose of visit</h2>
          <Bars rows={f.purpose} tint="var(--series-1)" />
        </section>
        <section className="panel mt-panel" style={{ '--i': 3 }}>
          <h2>Open by age</h2>
          <Bars rows={f.ages} />
        </section>
        <section className="panel mt-panel" style={{ '--i': 4 }}>
          <h2>Open by order status</h2>
          <Bars rows={f.status} tint="var(--series-4)" />
        </section>
      </div>
    </div>
  );
}

/*
 * Each engineer's TAT for the period, for scoring their KPI (the user, 23 Nov:
 * "make them easy for analysis"). A step counts in the period it was done in:
 * accept TAT by the accept day, start TAT by the start day, job TAT, spare and
 * CSAT by the completion day. The last four columns are as they stand now.
 */
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const TAT_COLS = [
  ['name', 'Engineer'], ['assigned', 'Assigned'], ['completed', 'Completed'], ['accept', 'Accept TAT'],
  ['start', 'Start TAT'], ['job', 'Job TAT'], ['spare', 'Waiting for spare'],
  ['lateDone', 'After Medtronic date'], ['toAccept', 'To accept'], ['toStart', 'To start'], ['pending', 'Pending'], ['mtClosed', 'Closed in Medtronic'],
];
const istDayOf = (iso) => (iso ? new Date(Date.parse(iso) + 5.5 * 3600000).toISOString().slice(0, 10) : null);

function EngineerTat({ tickets, team, period, manages, lead }) {
  const [sort, setSort] = useState(['name', 'asc']);
  const rows = useMemo(() => {
    const m = new Map();
    const row = (code, name) => m.get(code) ?? m.set(code, {
      code, name, assigned: 0, completed: 0, a: [], s: [], j: [], sp: [], yes: 0,
      lateDone: 0, toAccept: 0, toStart: 0, pending: 0, mtClosed: 0,
    }).get(code);
    for (const p of team) row(p.ecode, p.name);
    for (const t of tickets) {
      if (!t.engineer_code) continue;
      const r = row(t.engineer_code, t.engineer_name);
      const tat = tatOf(t);
      const st = stageOf(t);
      if (inPeriod(istDayOf(t.assigned_at), period)) r.assigned += 1;
      if (tat.accept != null && inPeriod(istDayOf(t.accepted_at), period)) r.a.push(tat.accept);
      if (tat.start != null && inPeriod(istDayOf(t.started_at), period)) r.s.push(tat.start);
      if (t.closed_by && inPeriod(t.closed_on, period)) {
        r.completed += 1;
        if (tat.job != null) r.j.push(tat.job);
        r.sp.push(tat.spare);
        if (t.csat) r.yes += 1;
        if (closeBy(t, t.closed_on).closedLate) r.lateDone += 1;
      }
      if (st === 'to_accept') r.toAccept += 1;
      if (st === 'to_start') r.toStart += 1;
      if (st === 'pending') r.pending += 1;
      if (t.mt_closed_on && !t.closed_by) r.mtClosed += 1;
    }
    return [...m.values()].map((r) => ({
      ...r, accept: avg(r.a), start: avg(r.s), job: avg(r.j), spare: avg(r.sp),
      csat: r.completed ? Math.round((r.yes * 100) / r.completed) : null,
    }));
  }, [tickets, team, period]);

  const [key, dir] = sort;
  const shown = [...rows].sort((a, b) => {
    const x = a[key]; const y = b[key];
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return (dir === 'asc' ? c : -c) || a.name.localeCompare(b.name);
  });
  const by = (k) => setSort(([k0, d]) => [k, k0 === k && d === 'asc' ? 'desc' : 'asc']);
  const cell = (r, k) => {
    if (['accept', 'start', 'job', 'spare'].includes(k)) return fmtDur(r[k]);
    if (k === 'csat') return r.csat == null ? '—' : `${r.csat}%`;
    return r[k];
  };
  const cols = TAT_COLS.filter(([k]) => manages || k !== 'name');
  if (!rows.length) return null;

  return (
    <section className="panel mt-panel mt-panel-wide" style={{ '--i': 1 }}>
      <h2>{lead ? 'TAT · you and your team' : manages ? 'TAT by engineer' : 'Your TAT'}</h2>
      {/* A phone gets a card per engineer; the table scrolls sideways there (the user, 23 Nov: "phone based module"). */}
      <ul className="mt-tat-cards">
        {shown.map((r) => (
          <li key={r.code} className="mt-tat-card">
            {manages && <span className="mt-tat-card-name">{r.name} <span className="mt-muted">({r.code})</span></span>}
            <dl>
              {cols.filter(([k]) => k !== 'name').map(([k, label]) => (
                <div key={k}><dt>{label}</dt><dd>{cell(r, k)}</dd></div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="mt-table-wrap mt-tat-wrap">
        <table className="mt-table mt-tat">
          <thead>
            <tr>
              {cols.map(([k, label]) => (
                <th key={k} className={k === 'name' ? '' : 'mt-num'}>
                  <button type="button" className="th-sort" onClick={() => by(k)}>
                    {label}{key === k && <span className="sort-mark">{dir === 'asc' ? '▲' : '▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.code} className="mt-tat-row">
                {cols.map(([k]) => (
                  <td key={k} className={k === 'name' ? 'mt-strong' : 'mt-num'}>
                    {k === 'name' ? <>{r.name} <span className="mt-muted">({r.code})</span></> : cell(r, k)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ============================================================== tickets == */

const SORTS = [
  ['created-desc', 'Newest first'],
  ['created-asc', 'Oldest first'],
  ['closed-desc', 'Closed, newest first'],
  ['age-desc', 'Oldest open first'],
  ['wo-asc', 'SAP no'],
  ['account-asc', 'Account'],
  ['engineer-asc', 'Engineer'],
];
const PAGE = 150;

/** The engineer's TAT on the list: assigned to completed, or to now while open (the user, 23 Nov). */
const runTat = (t) => (t.assigned_at
  ? Math.max(0, ((t.closed_by && t.closed_at ? Date.parse(t.closed_at) : Date.now()) - Date.parse(t.assigned_at)) / 1000) : null);
const When = ({ at }) => (at ? <>{dayOf(at)}<div className="mt-muted">{timeOf(at)}</div></> : '—');

/*
 * Medtronic's close-by day: the TM's Preferred Start Time (the user, 23 Nov: "this is actually eng should
 * close the call on or before this date"). Day first, as every TM so far: "05/11/2026, 11:30 am".
 */
const pad2 = (n) => String(n).padStart(2, '0');
function mtBy(t) {
  const s = String(t.preferred_start ?? '').trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) {
    const d = Number(m[1]); const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${m[3]}-${pad2(mo)}-${pad2(d)}` : null;
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/);
  const mon = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase()) : -1;
  return mon >= 0 ? `${m[3]}-${pad2(mon + 1)}-${pad2(Number(m[1]))}` : null;
}
const daysFrom = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const isOpenWork = (t) => !t.closed_by && t.status === 'open';
/** Where a ticket stands against Medtronic's day: late (days past, open), soon (within 2 days), closed late, our date later. */
function closeBy(t, today) {
  const by = mtBy(t);
  if (!by) return { by: null, late: 0, soon: false, left: null, closedLate: 0, oursLater: false };
  const open = isOpenWork(t);
  const left = open && by >= today ? daysFrom(today, by) : null;
  return {
    by,
    late: open && by < today ? daysFrom(by, today) : 0,
    soon: left != null && left <= 2,
    left,
    closedLate: t.closed_by && t.closed_on && t.closed_on > by ? daysFrom(by, t.closed_on) : 0,
    oursLater: open && Boolean(t.due_on) && t.due_on > by,
  };
}
const shortDay = (d, today) => (d.slice(0, 4) === today.slice(0, 4) ? dayOf(d).replace(/\s\d{4}$/, '') : dayOf(d));
const lateText = (c) => (c.late ? `${c.late} d late` : c.closedLate ? `closed ${c.closedLate} d late`
  : c.soon ? (c.left === 0 ? 'today' : `in ${c.left} ${c.left === 1 ? 'day' : 'days'}`) : '');
/** One column for both dates (the user, 23 Nov): Medtronic's on top, ours under it. */
function CloseBy({ t, today }) {
  const c = closeBy(t, today);
  const ours = t.due_on && <div className={`mt-muted${c.oursLater ? ' mt-ours-later' : ''}`}>Ours {shortDay(t.due_on, today)}</div>;
  if (!c.by) return ours || '—';
  const tone = c.late || c.closedLate ? ' is-late' : c.soon ? ' is-soon' : '';
  const note = lateText(c);
  return <><span className={`mt-due${tone}`}>{shortDay(c.by, today)}{note ? ` · ${note}` : ''}</span>{ours}</>;
}
const CLOSES = [['', 'Close by: All'], ['late', 'Late'], ['soon', 'In 2 days'], ['ours', 'Our date later'], ['none', 'No Medtronic date']];
function closeMatch(t, f, today) {
  if (!f) return true;
  const c = closeBy(t, today);
  if (f === 'none') return !c.by;
  if (f === 'late') return c.late > 0;
  if (f === 'soon') return c.soon;
  return c.oursLater;
}

function sortValue(t, key, today) {
  switch (key) {
    case 'created': return t.created_on ?? '';
    case 'closed': return (t.closed_by || t.status === 'closed') ? (t.closed_on ?? '') : '';
    case 'age': return ageDays(t, today) ?? -1;
    case 'accepted': return t.accepted_at ?? '';
    case 'started': return t.started_at ?? '';
    case 'tat': return runTat(t) ?? -1;
    case 'due': return mtBy(t) ?? '9999';
    case 'wo': return refOf(t);
    case 'account': return (t.account ?? '').toLowerCase();
    case 'engineer': return (t.engineer_name ?? '~').toLowerCase();
    case 'status': return stateOf(t).label;
    default: return '';
  }
}

function Tickets({ tickets: own, teamTickets = [], lead, role, team, startView, narrow, onOpen, onAssigned, action }) {
  const manager = role === 'manager';
  const manages = role !== 'engineer';
  // All first (the user, 31 Oct: "ALL, not assigned, open, closed").
  // The engineer's four steps (the user, 23 Nov: "to accept, to start, pending, completed").
  const views = manages
    ? [['all', 'All'], ['unassigned', 'Not assigned'], ['to_accept', 'To accept'], ['to_start', 'To start'],
      ['pending', 'Pending'], ['completed', 'Completed'], ['closed', 'Closed']]
    : [['to_accept', 'To accept'], ['to_start', 'To start'], ['pending', 'Pending'], ['completed', 'Completed'],
      ['all', 'All'], ...(lead ? [['team', 'My team']] : [])];
  // "all|late": a tab and a Close by filter, from the dashboard's cards.
  const [startTab, startClose] = String(startView ?? '').split('|');
  const [view, setView] = useState(() => {
    if (startTab && views.some(([id]) => id === startTab)) return startTab;
    return views[0][0];
  });
  /** Medtronic's own state: all, still open there, or closed there. */
  const [mt, setMt] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [cardErr, setCardErr] = useState(null);
  const step = async (t, fn, text) => {
    setBusyId(t.id); setCardErr(null);
    try { await fn(); await onAssigned(text); } catch (e) { setCardErr({ id: t.id, text: e.message }); }
    setBusyId(null);
  };
  const [q, setQ] = useState('');
  const [eng, setEng] = useState('');
  const [purpose, setPurpose] = useState('');
  const [due, setDue] = useState(() => (CLOSES.some(([v]) => v === startClose) ? startClose : ''));
  const [sort, setSort] = useState('created-desc');
  /** Closed date: All time / This month / Custom From – To (the user, 19 Nov: "need filters"). */
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState(() => new Set());
  const today = todayIst();

  const inMt = useCallback((t) => (mt === 'closed' ? Boolean(t.mt_closed_on) : mt === 'open' ? !t.mt_closed_on : true), [mt]);
  const inView = useCallback((t) => inMt(t) && (view === 'all' || view === 'team' || stageOf(t) === view), [view, inMt]);
  /** My team: the lead's people's tickets, every stage, read as a manager reads them. */
  const tickets = view === 'team' ? teamTickets : own;
  const mineView = !manages && view !== 'team';

  const counts = useMemo(() => Object.fromEntries(views.map(([id]) => [
    id, id === 'team' ? teamTickets.filter(inMt).length
      : own.filter((t) => inMt(t) && (id === 'all' || stageOf(t) === id)).length,
  ])), [own, teamTickets, inMt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Purposes in this tab, with their counts, the same way as the engineers.
  const purposes = useMemo(() => {
    const m = new Map();
    for (const t of tickets) if (inView(t) && t.purpose) m.set(t.purpose, (m.get(t.purpose) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tickets, inView]);
  // Each engineer with how many tickets this tab holds for them; nobody with none (the user, 31 Oct).
  const engineers = useMemo(() => {
    const m = new Map();
    let none = 0; let all = 0;
    for (const t of tickets) {
      if (!inView(t)) continue;
      all += 1;
      if (!t.engineer_code) { none += 1; continue; }
      const e = m.get(t.engineer_code) ?? { name: t.engineer_name, n: 0 };
      e.n += 1; m.set(t.engineer_code, e);
    }
    return { all, none, list: [...m].sort((a, b) => a[1].name.localeCompare(b[1].name)) };
  }, [tickets, inView]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const [key, dir] = sort.split('-');
    const list = tickets.filter((t) => {
      if (!inView(t)) return false;
      if (eng === '-' ? t.engineer_code : eng && t.engineer_code !== eng) return false;
      if (purpose && t.purpose !== purpose) return false;
      if (!closeMatch(t, due, today)) return false;
      if ((view === 'closed' || view === 'completed') && period !== 'all') {
        const d = t.closed_on ?? '';
        if (period === 'month' ? d.slice(0, 7) !== today.slice(0, 7) : (!d || (from && d < from) || (to && d > to))) return false;
      }
      if (!words.length) return true;
      const hay = [t.wo, t.account, t.site, t.city, t.product, t.sap_order, t.sap_notification, t.engineer_name]
        .join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    list.sort((a, b) => {
      const x = sortValue(a, key, today); const y = sortValue(b, key, today);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (dir === 'asc' ? c : -c) || a.wo.localeCompare(b.wo);
    });
    return list;
  }, [tickets, inView, eng, purpose, due, manages, q, sort, today, view, period, from, to]);

  const canPick = (t) => manager && !t.closed_by;
  // Only the steps a tab has reached (the user, 23 Nov: none in To accept, no Started in To start).
  const showAcc = view !== 'to_accept';
  const showStart = showAcc && view !== 'to_start';
  const pickable = shown.filter(canPick);
  const allPicked = pickable.length > 0 && pickable.every((t) => picked.has(t.id));
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(pickable.map((t) => t.id)));

  const sortBy = (key) => setSort((s) => {
    const [k, d] = s.split('-');
    if (k === key) return `${key}-${d === 'asc' ? 'desc' : 'asc'}`;
    return `${key}-${key === 'created' || key === 'age' ? 'desc' : 'asc'}`;
  });
  const mark = (key) => {
    const [k, d] = sort.split('-');
    return k === key ? <span className="sort-mark">{d === 'asc' ? '▲' : '▼'}</span> : null;
  };

  return (
    <div className="mt-tickets">
      <div className="mt-head-row">
      {/* On a phone the tabs are one dropdown, not a strip that scrolls sideways (the user, 23 Nov). */}
      {narrow ? (
        <div className="mt-views-pick">
          <Picker
            title="Tickets"
            value={view}
            onChange={(id) => { setView(id); setLimit(PAGE); setPicked(new Set()); if (id === 'unassigned') setEng(''); }}
            options={views.map(([id, label]) => ({ value: id, label, count: counts[id] }))}
          />
        </div>
      ) : (
      <div className="mt-views segmented" role="tablist" aria-label="Tickets">
        {views.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} data-tone={id}
                  onClick={() => { setView(id); setLimit(PAGE); setPicked(new Set()); if (id === 'unassigned') setEng(''); }}>
            {label} <span className="mt-count">{counts[id]}</span>
          </button>
        ))}
      </div>
      )}
      {action}
      </div>

      <div className="mt-filters">
        <div className="field-search mt-search">
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
                 placeholder="Search SAP no, account, city" aria-label="Search" />
        </div>
        {!mineView && view !== 'unassigned' && (
          <Picker
            title="Engineer"
            value={eng}
            onChange={setEng}
            options={[
              { value: '', label: 'All engineers', count: engineers.all },
              ...(engineers.none > 0 || eng === '-' ? [{ value: '-', label: 'Not assigned', count: engineers.none }] : []),
              ...engineers.list.map(([code, e]) => ({ value: code, label: e.name, count: e.n })),
              ...(eng && eng !== '-' && !engineers.list.some(([code]) => code === eng)
                ? [{ value: eng, label: tickets.find((t) => t.engineer_code === eng)?.engineer_name ?? eng, count: 0 }] : []),
            ]}
          />
        )}
        <Picker
          title="Purpose of visit"
          value={purpose}
          onChange={setPurpose}
          options={[
            { value: '', label: 'All purposes', count: engineers.all },
            ...purposes.map(([p, n]) => ({ value: p, label: p, count: n })),
            ...(purpose && !purposes.some(([p]) => p === purpose) ? [{ value: purpose, label: purpose, count: 0 }] : []),
          ]}
        />
        <Picker
          title="Medtronic"
          value={mt}
          onChange={(v) => { setMt(v); setLimit(PAGE); }}
          options={[{ value: '', label: 'Medtronic: All' }, { value: 'open', label: 'Open in Medtronic' }, { value: 'closed', label: 'Closed in Medtronic' }]}
        />
        {view !== 'closed' && (
          <Picker
            title="Close by"
            value={due}
            onChange={(v) => { setDue(v); setLimit(PAGE); }}
            options={CLOSES.map(([value, label]) => ({ value, label, count: tickets.filter((t) => inView(t) && closeMatch(t, value, today)).length }))}
          />
        )}
        {(view === 'closed' || view === 'completed') && (
          <Picker
            title={view === 'completed' ? 'Completed' : 'Closed'}
            value={period}
            onChange={(v) => { setPeriod(v); setLimit(PAGE); }}
            options={[{ value: 'all', label: 'All time' }, { value: 'month', label: 'This month' }, { value: 'custom', label: 'Custom' }]}
          />
        )}
        {(view === 'closed' || view === 'completed') && period === 'custom' && (
          <div className="mt-range">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <span>–</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </div>
        )}
        {narrow && (
          <Picker title="Sort" value={sort} onChange={setSort} options={SORTS.map(([id, label]) => ({ value: id, label }))} />
        )}
      </div>

      {manager && pickable.length > 0 && (
        <label className="mt-pickall">
          <input type="checkbox" checked={allPicked} onChange={toggleAll} />
          Select all {pickable.length}
        </label>
      )}

      {!shown.length ? <p className="empty">No tickets</p> : narrow ? (
        <ul className="mt-cards">
          {shown.slice(0, limit).map((t) => {
            const s = stateOf(t);
            const age = ageDays(t, today);
            const cb = closeBy(t, today);
            return (
              <li key={t.id} className={`mt-card${picked.has(t.id) ? ' is-picked' : ''}${cb.late ? ' is-late' : ''}`} data-state={s.id}>
                {canPick(t) && (
                  <input type="checkbox" className="mt-card-pick" checked={picked.has(t.id)}
                         onChange={() => toggle(t.id)} aria-label={`Select ${refOf(t)}`} />
                )}
                <div className="mt-card-main">
                <button type="button" className="mt-card-body" onClick={() => onOpen(t.id)}>
                  <span className="mt-card-top">
                    <span className="mt-wo">{refOf(t)}</span>
                    <span className={`mt-badge is-${s.id}${s.work ? ` is-${s.work}` : ''}`}>{s.label}</span>
                  </span>
                  <span className="mt-card-line mt-strong">{t.account ?? '—'}</span>
                  <span className="mt-card-line">{[t.city, t.product].filter(Boolean).join(' · ')}</span>
                  {(t.mt_closed_on || cb.by || t.due_on) && (
                    <span className="mt-card-tags">
                      {cb.by && <span className={`mt-tag${cb.late || cb.closedLate ? ' is-mt-closed' : cb.soon ? ' is-soon' : ''}`}>By {shortDay(cb.by, today)}{lateText(cb) ? ` · ${lateText(cb)}` : ''}</span>}
                      {t.due_on && <span className={`mt-tag${cb.oursLater ? ' is-soon' : ''}`}>Ours {shortDay(t.due_on, today)}</span>}
                      {t.mt_closed_on && <span className="mt-tag is-mt-closed">Closed in Medtronic</span>}
                    </span>
                  )}
                  <span className="mt-card-foot">
                    <span className="mt-card-meta">
                      {t.purpose ?? '—'} · {dayOf(t.created_on)}{mineView ? (t.assigned_at ? ` · TAT ${fmtDur(runTat(t))}` : '') : t.closed_by || t.status === 'closed' ? (t.closed_on ? ` · ${t.closed_by ? 'Completed' : 'Closed'} ${dayOf(t.closed_on)}` : '') : age != null ? ` · ${age} d` : ''}
                    </span>
                    <span className="mt-card-right">
                      {t.closed_by && t.csat != null && <span className={`mt-csat ${t.csat ? 'is-yes' : 'is-no'}`}>CSAT {t.csat ? 'Yes' : 'No'}</span>}
                      {mineView ? null : t.engineer_name
                        ? <span className="mt-who">{t.engineer_name}</span>
                        : <span className="mt-muted">Not assigned</span>}
                    </span>
                  </span>
                </button>
                {mineView && (s.id === 'to_accept' || s.id === 'to_start') && (
                  <div className="mt-card-act">
                    <button type="button" className={`mt-btn ${s.id === 'to_accept' ? 'mt-btn-primary' : 'mt-btn-go'}`} disabled={busyId === t.id}
                            onClick={() => (s.id === 'to_accept'
                              ? onOpen(t.id)
                              : step(t, () => startTicket(t.id), `${refOf(t)} started`))}>
                      {busyId === t.id ? '…' : s.id === 'to_accept' ? 'Accept' : 'Start'}
                    </button>
                    {cardErr?.id === t.id && <p className="mt-err">{cardErr.text}</p>}
                  </div>
                )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="panel mt-table-wrap">
          <table className="mt-table">
            <thead>
              <tr>
                {manager && <th className="mt-col-pick" aria-label="Select" />}
                <th><button type="button" className="th-sort" onClick={() => sortBy('wo')}>SAP no{mark('wo')}</button></th>
                <th><button type="button" className="th-sort" onClick={() => sortBy('account')}>Account{mark('account')}</button></th>
                <th>Product</th>
                <th>Purpose</th>
                <th><button type="button" className="th-sort" onClick={() => sortBy('created')}>Created{mark('created')}</button></th>
                {(view === 'all' || view === 'completed' || view === 'closed') && <th><button type="button" className="th-sort" onClick={() => sortBy('closed')}>Closed{mark('closed')}</button></th>}
                <th><button type="button" className="th-sort" onClick={() => sortBy('due')}>Close by{mark('due')}</button></th>
                {!mineView ? <>
                  <th className="mt-num"><button type="button" className="th-sort" onClick={() => sortBy('age')}>Age{mark('age')}</button></th>
                  <th><button type="button" className="th-sort" onClick={() => sortBy('engineer')}>Engineer{mark('engineer')}</button></th>
                </> : <>
                  {showAcc && <th><button type="button" className="th-sort" onClick={() => sortBy('accepted')}>Accepted{mark('accepted')}</button></th>}
                  {showStart && <th><button type="button" className="th-sort" onClick={() => sortBy('started')}>Started{mark('started')}</button></th>}
                  <th className="mt-num"><button type="button" className="th-sort" onClick={() => sortBy('tat')}>TAT{mark('tat')}</button></th>
                </>}
                <th><button type="button" className="th-sort" onClick={() => sortBy('status')}>Status{mark('status')}</button></th>
                <th>Medtronic</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((t) => {
                const s = stateOf(t);
                const age = ageDays(t, today);
                return (
                  <tr key={t.id} className={`${picked.has(t.id) ? 'is-picked' : ''}${closeBy(t, today).late ? ' is-late' : ''}`} data-state={s.id} onClick={() => onOpen(t.id)}>
                    {manager && (
                      <td className="mt-col-pick" onClick={(e) => e.stopPropagation()}>
                        {canPick(t) && <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${refOf(t)}`} />}
                      </td>
                    )}
                    <td className="mt-wo">{refOf(t)}</td>
                    <td><div className="mt-strong">{t.account ?? '—'}</div><div className="mt-muted">{[t.site !== t.account ? t.site : null, t.city].filter(Boolean).join(' · ')}</div></td>
                    <td>{t.product ?? '—'}</td>
                    <td>{t.purpose ?? '—'}</td>
                    <td className="mt-nowrap">{dayOf(t.created_on)}</td>
                    {(view === 'all' || view === 'completed' || view === 'closed') && <td className="mt-nowrap">{(t.closed_by || t.status === 'closed') && t.closed_on ? dayOf(t.closed_on) : '—'}</td>}
                    <td className="mt-nowrap"><CloseBy t={t} today={today} /></td>
                    {!mineView ? <>
                      <td className="mt-num">{age ?? '—'}</td>
                      <td>{t.engineer_name ?? <span className="mt-muted">Not assigned</span>}</td>
                    </> : <>
                      {showAcc && <td className="mt-nowrap"><When at={t.accepted_at} /></td>}
                      {showStart && <td className="mt-nowrap"><When at={t.started_at} /></td>}
                      <td className="mt-num mt-nowrap">{fmtDur(runTat(t))}</td>
                    </>}
                    <td className="mt-nowrap">
                      <span className={`mt-badge is-${s.id}${s.work ? ` is-${s.work}` : ''}`}>{s.label}</span>
                      {t.closed_by && t.csat != null && <span className={`mt-csat ${t.csat ? 'is-yes' : 'is-no'}`}>CSAT {t.csat ? 'Yes' : 'No'}</span>}
                    </td>
                    <td className="mt-nowrap">{t.mt_closed_on ? <span className="mt-mt-state is-closed">Closed</span> : <span className="mt-mt-state">Open</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shown.length > limit && (
        <button type="button" className="mt-btn mt-more" onClick={() => setLimit((n) => n + PAGE)}>
          Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
        </button>
      )}

      {manager && picked.size > 0 && (
        <AssignBar
          ids={[...picked]}
          team={team}
          onCancel={() => setPicked(new Set())}
          onAssigned={(text) => { setPicked(new Set()); onAssigned(text); }}
        />
      )}
    </div>
  );
}

function AssignBar({ ids, team, onCancel, onAssigned }) {
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    if (!who) { setErr('Choose an engineer'); return; }
    setBusy(true); setErr(null);
    try {
      const n = await assignTickets(ids, who);
      const name = team.find((p) => p.id === who)?.name ?? 'the engineer';
      onAssigned(`${n} ${n === 1 ? 'ticket' : 'tickets'} assigned to ${name}`);
    } catch (e) {
      setErr(e.message); setBusy(false);
    }
  };
  return (
    <div className="mt-assign" role="region" aria-label="Assign">
      <span className="mt-assign-n">{ids.length} selected</span>
      <Picker
        title="Assign to"
        placeholder="Choose engineer"
        tone="invert"
        bad={Boolean(err && !who)}
        value={who}
        onChange={(v) => { setWho(v); setErr(null); }}
        options={team.map((p) => ({ value: p.id, label: p.name }))}
      />
      <button type="button" className="mt-btn mt-btn-primary" onClick={go} disabled={busy}>
        {busy ? 'Assigning…' : 'Assign'}
      </button>
      <button type="button" className="mt-x" onClick={onCancel} aria-label="Clear selection">×</button>
      {err && <p className="mt-err mt-assign-err">{err}</p>}
    </div>
  );
}

/* ======================================================== ticket detail == */

/*
 * One work order. A sheet up from the bottom on a phone, a card in the middle
 * on a computer (the user, 31 Oct: "POP UP not good, and make it very
 * userfriendly and attractive"). What the person came to do is first — close
 * the call, or assign it — then the few facts anyone needs, with the TM's
 * reference numbers folded away under More details.
 */

const I = {
  hospital: <><path d="M4 21V7l8-4 8 4v14" /><path d="M9 21v-5h6v5" /><path d="M12 7v5M9.5 9.5h5" /></>,
  pin: <><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  box: <><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>,
  tool: <><path d="M14.5 6.5a4 4 0 0 0 5 5l-8.8 8.8a2.1 2.1 0 0 1-3-3z" /><path d="M14.5 6.5 17 4l3 3-2.5 2.5" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  status: <><path d="M4 12h4l2-5 4 10 2-5h4" /></>,
  up: <><path d="M7 11v9H4v-9z" /><path d="M7 11l4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7" /></>,
  down: <><path d="M7 13V4H4v9z" /><path d="M7 13l4 7a2 2 0 0 0 2-2v-4h5.5a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.3 4H7" /></>,
  camera: <><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v11H4z" /><circle cx="12" cy="13.5" r="3.5" /></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7.5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  play: <><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5v7l6-3.5z" /></>,
  file: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
};
const Svg = ({ d, size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

function Fact({ icon, label, children, sub, tone }) {
  if (!children) return null;
  return (
    <div className={`mt-fact${tone ? ` is-${tone}` : ''}`}>
      <span className="mt-fact-icon"><Svg d={I[icon]} size={18} /></span>
      <span className="mt-fact-text">
        <span className="mt-fact-label">{label}</span>
        <span className="mt-fact-value">{children}</span>
        {sub && <span className="mt-fact-sub">{sub}</span>}
      </span>
    </div>
  );
}

function Row({ label, children }) {
  return <div className="dl-row"><dt>{label}</dt><dd>{children || '—'}</dd></div>;
}

function TicketSheet({ t, role, lead, team, profile, onClose, onChanged }) {
  const s = stateOf(t);
  const mine = sameCode(t.engineer_code, profile?.code) && !t.closed_by;
  const canClose = mine && Boolean(t.started_at);
  /** The Completed box opens only from its own button in the status list (the user, 23 Nov). */
  const [completing, setCompleting] = useState(false);
  // A lead moves a ticket between himself and his people (0082); never to nobody.
  const canAssign = (role === 'manager' || lead) && !t.closed_by;
  const age = ageDays(t);
  const sheetCb = closeBy(t, todayIst());

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = was;
    };
  }, [onClose]);

  return (
    <div className="mt-scrim" onClick={onClose}>
      <div className={`mt-sheet${t.engineer_id && t.assigned_at ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={refOf(t)} onClick={(e) => e.stopPropagation()}>
        <header className="mt-sheet-head">
          <span className="mt-sheet-grab" aria-hidden="true" />
          <div className="mt-sheet-title">
            <span className="mt-sheet-badges">
              <span className={`mt-badge is-${s.id}${s.work ? ` is-${s.work}` : ''}`}>{s.label}</span>
              <MtTag t={t} full />
            </span>
            <h2>{refOf(t)}</h2>
            <p>{[t.account, t.city].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="mt-sheet-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div className="mt-sheet-body">
         <div className="mt-sheet-main">
          {(t.closed_by || t.status === 'closed') && <Closure t={t} />}
          {mine && <EngineerStep t={t} onChanged={onChanged} completing={completing} onComplete={setCompleting} />}
          {canClose && completing && <CloseForm t={t} onClosed={(text) => { onChanged(text); onClose(); }} />}
          {t.engineer_id && t.assigned_at && <TatBlock t={t} />}
          {canAssign && <AssignOne t={t} team={team} lead={lead} onDone={onChanged} />}

          <section className="mt-facts">
            {!canAssign && (
              <Fact icon="user" label="Engineer">{t.engineer_name ?? 'Not assigned'}</Fact>
            )}
            <Fact icon="hospital" label="Account" sub={t.site && t.site !== t.account ? t.site : null}>{t.account}</Fact>
            <Fact icon="pin" label="City">{t.city}</Fact>
            <Fact icon="box" label="Product">{t.product}</Fact>
            <Fact icon="tool" label="Purpose of visit">{t.purpose}</Fact>
            <Fact icon="calendar" label="Created" sub={age != null ? `${age} ${age === 1 ? 'day' : 'days'}` : null}>
              {t.created_on ? dayOf(t.created_on) : null}
            </Fact>
            <Fact icon="clock" label="Medtronic by" tone={sheetCb.late || sheetCb.closedLate ? 'danger' : undefined}
                  sub={sheetCb.late || sheetCb.closedLate ? lateText(sheetCb) : null}>{tmWhen(t.preferred_start)}</Fact>
            <Fact icon="status" label="Order status">{t.order_status}</Fact>
            {t.due_on && <Fact icon="calendar" label="Expected closure" tone={sheetCb.oursLater || (!t.closed_by && t.due_on < todayIst()) ? 'danger' : undefined}
                  sub={sheetCb.by && t.due_on > sheetCb.by ? `${daysFrom(sheetCb.by, t.due_on)} d after Medtronic's date` : null}>{dayOf(t.due_on)}</Fact>}
            {t.due_reason && <Fact icon="status" label="Why later">{t.due_reason}</Fact>}
            {t.mt_closed_on && <Fact icon="lock" label="Closed in Medtronic" tone="danger">{dayOf(t.mt_closed_on)}</Fact>}
          </section>

          {/* Every detail on show (the user, 23 Nov: "full details like revive lab has"). */}
          <section className="mt-card-block mt-all-details">
            <span className="mt-block-label">Ticket details</span>
            <dl className="dl">
              <Row label="SAP notification">{t.sap_notification}</Row>
              <Row label="SAP service order">{t.sap_order}</Row>
              <Row label="Work order">{t.wo}</Row>
              <Row label="Assigned">{t.assigned_at ? `${dayOf(t.assigned_at)}, ${timeOf(t.assigned_at)}` : null}</Row>
              {t.spare_request && <Row label="PI / PO Number">{t.spare_request}</Row>}
              {t.observation && <Row label="Observation">{t.observation}</Row>}
              <Row label="Technician in TM">{t.technician}</Row>
              <Row label="PM planned">{tmWhen(t.pm_planned)}</Row>
              <Row label="Scheduled">{tmWhen(t.scheduled)}</Row>
              <Row label="Manager">{t.manager_name}</Row>
              <Row label="In the TM">{t.first_seen === t.last_seen ? dayOf(t.first_seen) : `${dayOf(t.first_seen)} – ${dayOf(t.last_seen)}`}</Row>
            </dl>
          </section>
         </div>
          {t.engineer_id && t.assigned_at && <aside className="mt-sheet-side"><History t={t} /></aside>}
        </div>
      </div>
    </div>
  );
}

function Closure({ t }) {
  const [proof, setProof] = useState(null);
  useEffect(() => {
    setProof(null);
    if (t.proof_path) proofUrl(t.proof_path).then(setProof).catch(() => setProof(null));
  }, [t.proof_path]);
  const isImage = /\.(jpe?g|png|webp|heic|heif)$/i.test(t.proof_path ?? '');
  const byEngineer = Boolean(t.closed_by);
  return (
    <section className={`mt-closure${byEngineer ? '' : ' is-tm'}`}>
      <span className="mt-closure-mark"><Svg d={I.check} size={22} /></span>
      <div className="mt-closure-text">
        <strong>{byEngineer ? 'Completed' : 'Not in the TM any more'}</strong>
        <span>{dayOf(t.closed_on)}{byEngineer ? ` · ${t.closed_by_name}` : ''}</span>
        {byEngineer && t.csat != null && (
          <span className={`mt-chip ${t.csat ? 'is-yes' : 'is-no'}`}>CSAT {t.csat ? 'Yes' : 'No'}</span>
        )}
        {t.close_note && <p className="mt-closure-note">“{t.close_note}”</p>}
        {t.report_paths?.length > 0 && <Reports paths={t.report_paths} />}
      </div>
      {t.proof_path && (
        proof
          ? (
            <a className="mt-closure-proof" href={proof} target="_blank" rel="noreferrer">
              {isImage ? <img src={proof} alt="CSAT proof" /> : <span>Open the CSAT proof</span>}
            </a>
          )
          : <span className="mt-closure-proof is-loading" />
      )}
    </section>
  );
}

/** The service report files, each opened through a short-lived link. */
function Reports({ paths }) {
  const open = async (path) => {
    try { window.open(await proofUrl(path), '_blank', 'noopener'); } catch { /* the link failed; nothing to open */ }
  };
  return (
    <span className="mt-reports">
      {paths.map((path, i) => (
        <button key={path} type="button" className="mt-report-link" onClick={() => open(path)}>
          Service report{paths.length > 1 ? ` ${i + 1}` : ''}
        </button>
      ))}
    </span>
  );
}

/*
 * The engineer's next step (0077): Accept, then Start, then a status while it
 * is pending. Completing is the form below it.
 */
function EngineerStep({ t, onChanged, completing, onComplete }) {
  const [busy, setBusy] = useState(null);
  const [due, setDue] = useState('');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState(null);
  const by = mtBy(t);
  const needWhy = Boolean(by && due && due > by);
  const run = async (key, fn, text) => {
    setBusy(key); setErr(null);
    try { await fn(); await onChanged(text); } catch (e) { setErr(e.message); }
    setBusy(null);
  };
  if (!t.accepted_at) {
    return (
      <section className="mt-card-block mt-step-block">
        {by && (
          <div className={`mt-by${by < todayIst() ? ' is-late' : ''}`}>
            <span>Medtronic by</span><b>{tmWhen(t.preferred_start)}</b>
          </div>
        )}
        <label className="mt-field mt-due-field"><span>Expected closure</span>
          <input type="date" className="mt-input" value={due} min={todayIst()} onChange={(e) => { setDue(e.target.value); setErr(null); }} />
        </label>
        {needWhy && (
          <label className="mt-field mt-due-field mt-why"><span>Why after {dayOf(by)}?</span>
            <textarea className="mt-input" rows={2} value={why} placeholder="Spare comes from Mumbai"
                      onChange={(e) => { setWhy(e.target.value); setErr(null); }} />
          </label>
        )}
        <button type="button" className="mt-go" disabled={Boolean(busy)}
                onClick={() => (!due ? setErr('Choose the expected closure date')
                  : needWhy && !why.trim() ? setErr(`Say why it will be after ${dayOf(by)}`)
                    : run('a', () => acceptTickets([t.id], due, needWhy ? why.trim() : null), `${refOf(t)} accepted`))}>
          <Svg d={I.check} size={22} />{busy ? 'Accepting…' : 'Accept'}
        </button>
        {err && <p className="mt-err">{err}</p>}
      </section>
    );
  }
  if (!t.started_at) {
    return (
      <section className="mt-card-block mt-step-block">
        <button type="button" className="mt-go is-start" disabled={Boolean(busy)}
                onClick={() => run('s', () => startTicket(t.id), `${refOf(t)} started`)}>
          <Svg d={I.play} size={22} />{busy ? 'Starting…' : 'Start'}
        </button>
        {err && <p className="mt-err">{err}</p>}
      </section>
    );
  }
  return <StatusPicker t={t} busy={busy} err={err} setErr={setErr} run={run} completing={completing} onComplete={onComplete} />;
}

/*
 * The pending status. Observation and Waiting for spare open a box that must
 * be filled (0078); the rest switch on the press.
 */
function StatusPicker({ t, busy, err, setErr, run, completing, onComplete }) {
  const [asking, setAsking] = useState(null);
  const [text, setText] = useState('');
  const box = useRef(null);
  useEffect(() => { if (asking) box.current?.focus(); }, [asking]);
  const press = (id, label) => {
    setErr(null); onComplete(false);
    if (WORK_DETAIL[id]) {
      setAsking(id);
      setText(id === 'waiting_spare' ? (t.spare_request ?? '') : '');
      return;
    }
    setAsking(null);
    if (t.work_status !== id) run(id, () => setWorkStatus(t.id, id), `${refOf(t)}: ${label}`);
  };
  const save = () => {
    if (!text.trim()) { setErr(`Enter the ${asking === 'waiting_spare' ? 'PI / PO number' : 'observation'}`); return; }
    const label = workLabel(asking);
    run(asking, () => setWorkStatus(t.id, asking, text.trim()), `${refOf(t)}: ${label}`).then(() => setAsking(null));
  };
  return (
    <section className="mt-card-block">
      <span className="mt-block-label">Status</span>
      <div className="mt-work">
        {/* Started is where Start leaves it, not a choice (the user, 23 Nov). */}
        {/* Row 1: Under repair, Waiting for spare, Waiting for customer; row 2: Observation beside Completed (the user, 23 Nov). */}
        {['under_repair', 'waiting_spare', 'waiting_customer', 'observation'].map((id) => WORK.find(([w]) => w === id)).map(([id, label]) => (
          <button key={id} type="button" className={`mt-work-btn is-${id}`}
                  aria-pressed={completing ? false : asking ? asking === id : t.work_status === id}
                  disabled={Boolean(busy)} onClick={() => press(id, label)}>
            {busy === id && !asking ? '…' : label}
          </button>
        ))}
        <button type="button" className="mt-work-btn is-completed" aria-pressed={completing}
                disabled={Boolean(busy)} onClick={() => { setAsking(null); setErr(null); onComplete(!completing); }}>
          Completed
        </button>
      </div>
      {asking && (
        <div className="mt-work-ask">
          {asking === 'observation'
            ? <textarea ref={box} className={`mt-note${err ? ' is-bad' : ''}`} rows={3} value={text}
                        placeholder={WORK_DETAIL[asking]} maxLength={1000}
                        onChange={(e) => { setText(e.target.value); setErr(null); }} />
            : <input ref={box} className={`mt-input${err ? ' is-bad' : ''}`} value={text}
                     placeholder={WORK_DETAIL[asking]} maxLength={100}
                     onChange={(e) => { setText(e.target.value); setErr(null); }} />}
          <button type="button" className="mt-btn mt-btn-primary mt-btn-lg" disabled={Boolean(busy)} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
      {err && <p className="mt-err">{err}</p>}
      {!asking && (t.spare_request || t.observation) && (
        <dl className="mt-work-said">
          {t.spare_request && <div><dt>PI / PO Number</dt><dd>{t.spare_request}</dd></div>}
          {t.observation && <div><dt>Observation</dt><dd>{t.observation}</dd></div>}
        </dl>
      )}
    </section>
  );
}

/** When each step happened and how long it took: the KPI's TAT. */
function TatBlock({ t }) {
  const tat = tatOf(t);
  const when = (iso) => (iso ? `${dayOf(iso)}, ${timeOf(iso)}` : null);
  const rows = [
    ['Assigned', when(t.assigned_at), null],
    ['Accepted', when(t.accepted_at), tat.accept],
    ['Started', when(t.started_at), tat.start],
    ['Completed', t.closed_by ? when(t.closed_at) : null, tat.job],
  ];
  return (
    <section className="mt-card-block mt-tat-block">
      <span className="mt-block-label">TAT</span>
      <ul className="mt-tat-steps">
        {rows.map(([label, at, d]) => (
          <li key={label} className={`is-${label.toLowerCase()}${at ? ' is-done' : ''}`}>
            <span className="mt-tat-dot" aria-hidden="true" />
            <span className="mt-tat-label">{label}</span>
            <span className="mt-tat-at">{at ?? '—'}</span>
            {d != null && <span className="mt-tat-d">{fmtDur(d)}</span>}
          </li>
        ))}
      </ul>
      {tat.spare > 0 && <p className="mt-tat-spare">Waiting for spare {fmtDur(tat.spare)}{t.spare_request ? ` · ${t.spare_request}` : ''}</p>}
      {t.observation && <p className="mt-tat-obs">Observation: {t.observation}</p>}
      {tat.total != null && <p className="mt-tat-total">Total {fmtDur(tat.total)}</p>}
    </section>
  );
}

/*
 * Every change with its date and time, and how long it lasted (the user, 23 Nov:
 * "they cant see the status changed date to time, like in revive lab history").
 */
function eventLabel(e) {
  const d = e.detail ?? '';
  if (e.kind === 'assigned') return ['Assigned', null];
  if (e.kind === 'accepted') {
    const [dd, w] = d.split(' | why: ');
    return ['Accepted', dd.startsWith('due: ') ? `Expected closure ${dayOf(dd.slice(5, 15))}${w ? ` · ${w}` : ''}` : null];
  }
  if (e.kind === 'completed') return ['Completed', null];
  if (e.kind === 'started') return ['Started', null];
  if (e.kind === 'status') {
    const i = d.indexOf(': ');
    const code = i < 0 ? d : d.slice(0, i);
    return [workLabel(code), i < 0 ? null : (code === 'waiting_spare' ? `PI / PO ${d.slice(i + 2)}` : d.slice(i + 2))];
  }
  return [e.kind, d || null];
}
function History({ t }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const stamp = `${t.assigned_at}|${t.accepted_at}|${t.started_at}|${t.work_status_at}|${t.closed_at}`;
  useEffect(() => {
    let on = true;
    loadEvents(t.id).then((x) => on && setRows(x)).catch((e) => on && setErr(e.message));
    return () => { on = false; };
  }, [t.id, stamp]);
  if (err) return <section className="mt-card-block"><p className="mt-err">{err}</p></section>;
  if (!rows?.length) return null;
  // From the latest assignment only: an earlier engineer's steps are not this one's.
  const from = rows.map((e) => e.kind).lastIndexOf('assigned');
  const list = rows.slice(Math.max(0, from));
  const end = t.closed_by ? null : Date.now();
  return (
    <section className="mt-card-block mt-history">
      <span className="mt-block-label">History</span>
      <ol className="mt-hist">
        {list.flatMap((e, i) => {
          const [label, note] = eventLabel(e);
          const last = i === list.length - 1;
          const next = list[i + 1] ? Date.parse(list[i + 1].at) : e.kind === 'completed' ? null : end;
          const lasted = next != null ? (next - Date.parse(e.at)) / 1000 : null;
          // The dot takes the colour of what it was set to; the time it lasted sits on the line to the next.
          const tone = e.kind === 'status' ? (e.detail ?? '').split(': ')[0] : e.kind;
          const out = [(
            <li key={e.id} className={`is-${tone}${last ? ' is-now' : ''}`}>
              <span className="mt-hist-dot" aria-hidden="true" />
              <span className="mt-hist-main">
                <span className="mt-hist-label">{label}</span>
                <span className="mt-hist-at">{dayOf(e.at)}, {timeOf(e.at)}</span>
                {note && <span className="mt-hist-note">{note}</span>}
              </span>
            </li>
          )];
          if (lasted != null) {
            out.push(
              <li key={`${e.id}-gap`} className={`mt-hist-gap is-${tone}${last ? ' is-running' : ''}`}>
                <span className="mt-hist-time">{fmtDur(lasted)}</span>
              </li>,
            );
          }
          return out;
        })}
      </ol>
    </section>
  );
}

function AssignOne({ t, team, lead, onDone }) {
  const [who, setWho] = useState(t.engineer_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { setWho(t.engineer_id ?? ''); }, [t.engineer_id]);
  const changed = (who || null) !== (t.engineer_id ?? null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await assignTickets([t.id], who || null);
      const name = team.find((p) => p.id === who)?.name;
      await onDone(name ? `${refOf(t)} assigned to ${name}` : `${refOf(t)} is not assigned now`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <section className="mt-card-block">
      <span className="mt-block-label">Engineer</span>
      <div className="mt-row">
        <Picker
          title="Engineer"
          tone="lg"
          value={who}
          onChange={setWho}
          options={[...(lead ? [] : [{ value: '', label: 'Not assigned' }]), ...team.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <button type="button" className="mt-btn mt-btn-primary mt-btn-lg" disabled={!changed || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {err && <p className="mt-err">{err}</p>}
    </section>
  );
}

function CloseForm({ t, onClosed }) {
  const [note, setNote] = useState('');
  const [reports, setReports] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const reportInput = useRef(null);
  const addReports = (list) => {
    const files = [...(list ?? [])];
    if (files.some((f) => f.size > 10 * 1024 * 1024)) { setErr({ at: 'report', text: 'A file is over 10 MB' }); return; }
    setReports((r) => [...r, ...files].slice(0, 5)); setErr(null);
  };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await closeCall(t.id, null, null, note.trim(), reports);
      onClosed(`${refOf(t)} completed`);
    } catch (e) {
      setErr({ at: 'button', text: e.message }); setBusy(false);
    }
  };

  return (
    <section className="mt-close-card">

      <div className="mt-step">
        <span className="mt-step-q">Service report</span>
        <input ref={reportInput} type="file" multiple hidden
               onChange={(e) => { addReports(e.target.files); e.target.value = ''; }} />
        {reports.length > 0 && (
          <ul className="mt-files">
            {reports.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <Svg d={I.file} size={16} /><span className="mt-file-name">{f.name}</span>
                <button type="button" className="mt-file-x" aria-label={`Remove ${f.name}`}
                        onClick={() => setReports((r) => r.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ul>
        )}
        {reports.length < 5 && (
          <button type="button" className="mt-camera mt-camera-sm" onClick={() => reportInput.current?.click()}>
            <span className="mt-camera-icon"><Svg d={I.file} size={22} /></span>
            <span>{reports.length ? 'Add another file' : 'Add a file'}</span>
          </button>
        )}
        {err?.at === 'report' && <p className="mt-err">{err.text}</p>}
      </div>

      <label className="mt-step">
        <span className="mt-step-q">Remarks</span>
        <textarea className="mt-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <div className="mt-close-foot">
        <button type="button" className="mt-go" onClick={submit} disabled={busy}>
          <Svg d={I.check} size={22} />
          {busy ? 'Saving…' : 'Submit'}
        </button>
        {err?.at === 'button' && <p className="mt-err">{err.text}</p>}
      </div>
    </section>
  );
}

/* =============================================================== upload == */

function UploadSheet({ tickets, team, profile, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const input = useRef(null);

  const pick = async (f) => {
    if (!f) return;
    setFile(f); setRows(null); setErr(null); setReading(true);
    try { setRows(await readTm(f)); } catch (e) { setErr(e.message); }
    setReading(false);
  };

  const plan = useMemo(() => {
    if (!rows) return null;
    const mine = tickets.filter((t) => sameCode(t.manager_code, profile?.code));
    const known = new Map(mine.map((t) => [t.wo, t]));
    const inFile = new Set(rows.map((r) => r.wo));
    const codes = new Set(team.map((m) => m.ecode.toUpperCase()));
    const named = rows.filter((r) => r.assign_to);
    return {
      assigning: named.filter((r) => codes.has(r.assign_to)).length,
      unknown: [...new Set(named.map((r) => r.assign_to).filter((c) => !codes.has(c)))],
      rows: inFile.size,
      added: [...inFile].filter((wo) => !known.has(wo)).length,
      refreshed: [...inFile].filter((wo) => known.has(wo)).length,
      closing: mine.filter((t) => !t.mt_closed_on && !inFile.has(t.wo)).length,
      back: mine.filter((t) => t.mt_closed_on && inFile.has(t.wo)).length,
    };
  }, [rows, tickets, team, profile]);

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await uploadTm(rows, file.name);
      setResult(r);
      onDone();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal mt-modal" role="dialog" aria-label="Upload TM">
        <div className="modal-head">
          <h2>{result ? 'TM uploaded' : 'Upload TM'}</h2>
          {!result && <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">×</button>}
        </div>
        <div className="modal-body">
          {result ? (
            <ul className="mt-plan">
              <li><b>{result.rows}</b> tickets in the file</li>
              <li><b>{result.added}</b> new, not assigned</li>
              <li><b>{result.refreshed}</b> already here, updated</li>
              {result.reopened > 0 && <li><b>{result.reopened}</b> back in the TM, open in Medtronic again</li>}
              <li className={result.closed ? 'is-closing' : ''}><b>{result.closed}</b> not in the file, marked Closed in Medtronic</li>
              {result.assigned > 0 && <li><b>{result.assigned}</b> assigned from the Assign to column</li>}
              {result.unknown?.length > 0 && <li className="is-closing">Not in your team, left unassigned: {result.unknown.join(', ')}</li>}
            </ul>
          ) : (
            <>
              <input ref={input} type="file" accept=".xlsx" hidden onChange={(e) => pick(e.target.files?.[0])} />
              <button type="button" className={`mt-drop mt-drop-big${file ? ' has-file' : ''}`} onClick={() => input.current?.click()}>
                <UploadIcon />
                <span>{file ? file.name : 'Choose the TM file'}</span>
              </button>
              {reading && <p className="empty-inline">Reading…</p>}
              {plan && (
                <ul className="mt-plan">
                  <li><b>{plan.rows}</b> tickets in the file</li>
                  <li><b>{plan.added}</b> new, not assigned</li>
                  <li><b>{plan.refreshed}</b> already here, updated</li>
                  {plan.back > 0 && <li><b>{plan.back}</b> back in the TM, open in Medtronic again</li>}
                  <li className={plan.closing ? 'is-closing' : ''}><b>{plan.closing}</b> not in the file, will be marked Closed in Medtronic</li>
                  {plan.assigning > 0 && <li><b>{plan.assigning}</b> assigned from the Assign to column</li>}
                  {plan.unknown.length > 0 && <li className="is-closing">Not in your team, left unassigned: {plan.unknown.join(', ')}</li>}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="modal-foot mt-modal-foot">
          {err && <p className="mt-err">{err}</p>}
          {result
            ? <button type="button" className="mt-btn mt-btn-primary" onClick={onClose}>OK</button>
            : (
              <button type="button" className="mt-btn mt-btn-primary" disabled={!plan || busy} onClick={send}>
                {busy ? 'Uploading…' : 'Upload'}
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
