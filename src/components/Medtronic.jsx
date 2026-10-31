import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SideNav from './SideNav.jsx';
import Avatar from './Avatar.jsx';
import Picker from './Picker.jsx';
import { ProjectMasthead } from './ProjectHome.jsx';
import {
  roleOf, loadMtData, readTm, uploadTm, assignTickets, closeCall, proofUrl, todayIst, ageDays, AGE_BANDS,
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
const sameCode = (a, b) => String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase();

/** Where a work order stands, in the words on its badge. */
function stateOf(t) {
  if (t.status === 'open') return t.engineer_id ? { id: 'open', label: 'Open' } : { id: 'unassigned', label: 'Not assigned' };
  return { id: 'closed', label: 'Closed' };
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
                ? <Dashboard tickets={tickets} role={role} team={data.team} onList={toList} action={uploadBtn} />
                : (
                  <Tickets
                    key={view ?? 'list'}
                    tickets={tickets}
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

function Dashboard({ tickets, role, team, onList, action }) {
  const [period, setPeriod] = useState({ id: 'month', from: '', to: '' });
  const today = todayIst();

  const f = useMemo(() => {
    const open = tickets.filter((t) => t.status === 'open');
    const unassigned = open.filter((t) => !t.engineer_id);
    const closed = tickets.filter((t) => t.status === 'closed' && inPeriod(t.closed_on, period));
    const byEngineer = closed.filter((t) => t.closed_by);
    const yes = byEngineer.filter((t) => t.csat).length;

    const people = new Map();
    for (const m of team) people.set(m.ecode, { name: m.name, code: m.ecode, open: 0, closed: 0, yes: 0, of: 0 });
    for (const t of tickets) {
      if (!t.engineer_code) continue;
      const p = people.get(t.engineer_code)
        ?? people.set(t.engineer_code, { name: t.engineer_name, code: t.engineer_code, open: 0, closed: 0, yes: 0, of: 0 }).get(t.engineer_code);
      if (t.status === 'open') p.open += 1;
      if (t.status === 'closed' && t.closed_by && inPeriod(t.closed_on, period)) {
        p.closed += 1; p.of += 1; if (t.csat) p.yes += 1;
      }
    }
    const ages = AGE_BANDS.map((b) => ({ label: b.label, n: 0, tint: null }));
    for (const t of open) {
      const a = ageDays(t, today);
      if (a == null) continue;
      ages[AGE_BANDS.findIndex((b) => a <= b.max)].n += 1;
    }
    ages.forEach((a, i) => { a.tint = ['var(--series-3)', 'var(--series-1)', 'var(--status-warning)', 'var(--series-2)', 'var(--status-critical)'][i]; });

    return {
      open, unassigned, closed, byEngineer, yes,
      people: [...people.values()].sort((a, b) => b.open - a.open || b.closed - a.closed || a.name.localeCompare(b.name)),
      purpose: countBy(open, 'purpose'),
      status: countBy(open, 'order_status'),
      ages,
    };
  }, [tickets, team, period, today]);

  const csat = f.byEngineer.length ? `${Math.round((f.yes * 100) / f.byEngineer.length)}%` : '—';
  const manages = role !== 'engineer';
  const peopleMax = Math.max(1, ...f.people.map((p) => p.open + p.closed));

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

      <div className={`mt-tiles${manages ? '' : ' is-three'}`}>
        <Tile i={0} label="Open" value={f.open.length} tint="var(--series-1)"
              note={manages ? `${f.open.length - f.unassigned.length} assigned` : null}
              onClick={() => onList('open')}
              icon={<Ico d={<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M7.5 9h9M7.5 13h6" /></>} />} />
        {manages && (
          <Tile i={1} label="Not assigned" value={f.unassigned.length} tint="var(--status-warning)"
                onClick={() => onList('unassigned')}
                icon={<Ico d={<><circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /><path d="M18 4l4 4M22 4l-4 4" /></>} />} />
        )}
        <Tile i={2} label="Closed" value={f.closed.length} tint="var(--status-good)"
              note={f.closed.length - f.byEngineer.length > 0 ? `${f.closed.length - f.byEngineer.length} without CSAT` : null}
              onClick={() => onList('closed')}
              icon={<Ico d={<><circle cx="12" cy="12" r="8.5" /><path d="M8 12.5l2.7 2.7L16.5 9.5" /></>} />} />
        <Tile i={3} label="CSAT" value={csat} tint="var(--series-5)"
              note={f.byEngineer.length ? `${f.yes} of ${f.byEngineer.length}` : null}
              onClick={() => onList('closed')}
              icon={<Ico d={<><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></>} />} />
      </div>

      <div className="mt-panels">
        {manages && (
          <section className="panel mt-panel mt-panel-wide" style={{ '--i': 1 }}>
            <h2>By engineer</h2>
            {!f.people.length ? <p className="empty-inline">None</p> : (
              <ul className="mt-people">
                {f.people.map((p) => (
                  <li key={p.code} className="mt-person">
                    <Avatar name={p.name} className="mt-person-face" />
                    <div className="mt-person-main">
                      <div className="mt-person-top">
                        <span className="mt-person-name">{p.name}</span>
                        <span className="mt-person-csat">{p.of ? `CSAT ${p.yes} of ${p.of}` : ''}</span>
                      </div>
                      <div className="mt-stack" aria-hidden="true">
                        <span className="mt-stack-open" style={{ width: `${(p.open / peopleMax) * 100}%` }} />
                        <span className="mt-stack-closed" style={{ width: `${(p.closed / peopleMax) * 100}%` }} />
                      </div>
                      <div className="mt-person-nums">
                        <span><i className="mt-dot is-open" />{p.open} open</span>
                        <span><i className="mt-dot is-closed" />{p.closed} closed</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
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

/* ============================================================== tickets == */

const SORTS = [
  ['created-desc', 'Newest first'],
  ['created-asc', 'Oldest first'],
  ['age-desc', 'Oldest open first'],
  ['wo-asc', 'Work order'],
  ['account-asc', 'Account'],
  ['engineer-asc', 'Engineer'],
];
const PAGE = 150;

function sortValue(t, key, today) {
  switch (key) {
    case 'created': return t.created_on ?? '';
    case 'age': return ageDays(t, today) ?? -1;
    case 'wo': return t.wo;
    case 'account': return (t.account ?? '').toLowerCase();
    case 'engineer': return (t.engineer_name ?? '~').toLowerCase();
    case 'status': return stateOf(t).label;
    default: return '';
  }
}

function Tickets({ tickets, role, team, startView, narrow, onOpen, onAssigned, action }) {
  const manager = role === 'manager';
  const manages = role !== 'engineer';
  // All first (the user, 31 Oct: "ALL, not assigned, open, closed").
  const views = manages
    ? [['all', 'All'], ['unassigned', 'Not assigned'], ['open', 'Open'], ['closed', 'Closed']]
    : [['all', 'All'], ['todo', 'To close'], ['closed', 'Closed']];
  const [view, setView] = useState(() => {
    if (startView === 'open' && !manages) return 'todo';
    if (startView && views.some(([id]) => id === startView)) return startView;
    return 'all';
  });
  const [q, setQ] = useState('');
  const [eng, setEng] = useState('');
  const [purpose, setPurpose] = useState('');
  const [sort, setSort] = useState('created-desc');
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState(() => new Set());
  const today = todayIst();

  const inView = useCallback((t) => {
    switch (view) {
      case 'unassigned': return t.status === 'open' && !t.engineer_id;
      case 'open': return t.status === 'open';
      case 'todo': return !t.closed_by;
      case 'closed': return manages ? t.status === 'closed' : Boolean(t.closed_by);
      default: return true;
    }
  }, [view, manages]);

  const counts = useMemo(() => Object.fromEntries(views.map(([id]) => {
    const fn = {
      unassigned: (t) => t.status === 'open' && !t.engineer_id,
      open: (t) => t.status === 'open',
      todo: (t) => !t.closed_by,
      closed: (t) => (manages ? t.status === 'closed' : Boolean(t.closed_by)),
      all: () => true,
    }[id];
    return [id, tickets.filter(fn).length];
  })), [tickets, manages]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [tickets, inView, eng, purpose, q, sort, today]);

  const canPick = (t) => manager && !t.closed_by;
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
      <div className="mt-views segmented" role="tablist" aria-label="Tickets">
        {views.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} data-tone={id}
                  onClick={() => { setView(id); setLimit(PAGE); setPicked(new Set()); if (id === 'unassigned') setEng(''); }}>
            {label} <span className="mt-count">{counts[id]}</span>
          </button>
        ))}
      </div>
      {action}
      </div>

      <div className="mt-filters">
        <div className="field-search mt-search">
          <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
                 placeholder="Search work order, account, site, city" aria-label="Search" />
        </div>
        {manages && view !== 'unassigned' && (
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
            return (
              <li key={t.id} className={`mt-card${picked.has(t.id) ? ' is-picked' : ''}`} data-state={s.id}>
                {canPick(t) && (
                  <input type="checkbox" className="mt-card-pick" checked={picked.has(t.id)}
                         onChange={() => toggle(t.id)} aria-label={`Select ${t.wo}`} />
                )}
                <div className="mt-card-main">
                <button type="button" className="mt-card-body" onClick={() => onOpen(t.id)}>
                  <span className="mt-card-top">
                    <span className="mt-wo">{t.wo}</span>
                    <span className={`mt-badge is-${s.id}`}>{s.label}</span>
                  </span>
                  <span className="mt-card-line mt-strong">{t.account ?? '—'}</span>
                  <span className="mt-card-line">{[t.city, t.product].filter(Boolean).join(' · ')}</span>
                  <span className="mt-card-foot">
                    <span className="mt-card-meta">
                      {t.purpose ?? '—'} · {dayOf(t.created_on)}{age != null ? ` · ${age} d` : ''}
                    </span>
                    <span className="mt-card-right">
                      {t.closed_by && <span className={`mt-csat ${t.csat ? 'is-yes' : 'is-no'}`}>CSAT {t.csat ? 'Yes' : 'No'}</span>}
                      {t.engineer_name
                        ? <span className="mt-who"><Avatar name={t.engineer_name} className="mt-who-face" />{t.engineer_name}</span>
                        : <span className="mt-muted">Not assigned</span>}
                    </span>
                  </span>
                </button>
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
                <th><button type="button" className="th-sort" onClick={() => sortBy('wo')}>Work order{mark('wo')}</button></th>
                <th><button type="button" className="th-sort" onClick={() => sortBy('account')}>Account{mark('account')}</button></th>
                <th>Product</th>
                <th>Purpose</th>
                <th><button type="button" className="th-sort" onClick={() => sortBy('created')}>Created{mark('created')}</button></th>
                <th className="mt-num"><button type="button" className="th-sort" onClick={() => sortBy('age')}>Age{mark('age')}</button></th>
                <th>Order status</th>
                <th><button type="button" className="th-sort" onClick={() => sortBy('engineer')}>Engineer{mark('engineer')}</button></th>
                <th><button type="button" className="th-sort" onClick={() => sortBy('status')}>Status{mark('status')}</button></th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((t) => {
                const s = stateOf(t);
                const age = ageDays(t, today);
                return (
                  <tr key={t.id} className={picked.has(t.id) ? 'is-picked' : ''} data-state={s.id} onClick={() => onOpen(t.id)}>
                    {manager && (
                      <td className="mt-col-pick" onClick={(e) => e.stopPropagation()}>
                        {canPick(t) && <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.wo}`} />}
                      </td>
                    )}
                    <td className="mt-wo">{t.wo}</td>
                    <td><div className="mt-strong">{t.account ?? '—'}</div><div className="mt-muted">{[t.site !== t.account ? t.site : null, t.city].filter(Boolean).join(' · ')}</div></td>
                    <td>{t.product ?? '—'}</td>
                    <td>{t.purpose ?? '—'}</td>
                    <td className="mt-nowrap">{dayOf(t.created_on)}</td>
                    <td className="mt-num">{age ?? '—'}</td>
                    <td>{t.order_status ?? '—'}</td>
                    <td>{t.engineer_name ?? <span className="mt-muted">Not assigned</span>}</td>
                    <td className="mt-nowrap">
                      <span className={`mt-badge is-${s.id}`}>{s.label}</span>
                      {t.closed_by && <span className={`mt-csat ${t.csat ? 'is-yes' : 'is-no'}`}>CSAT {t.csat ? 'Yes' : 'No'}</span>}
                    </td>
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
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
};
const Svg = ({ d, size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

function Fact({ icon, label, children, sub }) {
  if (!children) return null;
  return (
    <div className="mt-fact">
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

function TicketSheet({ t, role, team, profile, onClose, onChanged }) {
  const s = stateOf(t);
  const canClose = sameCode(t.engineer_code, profile?.code) && !t.closed_by;
  const canAssign = role === 'manager' && !t.closed_by;
  const age = ageDays(t);

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
      <div className="mt-sheet" role="dialog" aria-modal="true" aria-label={t.wo} onClick={(e) => e.stopPropagation()}>
        <header className="mt-sheet-head">
          <span className="mt-sheet-grab" aria-hidden="true" />
          <div className="mt-sheet-title">
            <span className={`mt-badge is-${s.id}`}>{s.label}</span>
            <h2>{t.wo}</h2>
            <p>{[t.account, t.city].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" className="mt-sheet-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div className="mt-sheet-body">
          {t.status === 'closed' && <Closure t={t} />}
          {canClose && <CloseForm t={t} onClosed={(text) => { onChanged(text); onClose(); }} />}
          {canAssign && <AssignOne t={t} team={team} onDone={onChanged} />}

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
            <Fact icon="clock" label="Preferred start">{t.preferred_start}</Fact>
            <Fact icon="status" label="Order status">{t.order_status}</Fact>
          </section>

          <details className="mt-more-details">
            <summary>More details</summary>
            <dl className="dl">
              <Row label="SAP service order">{t.sap_order}</Row>
              <Row label="SAP notification">{t.sap_notification}</Row>
              <Row label="Technician in TM">{t.technician}</Row>
              <Row label="PM planned">{t.pm_planned}</Row>
              <Row label="Scheduled">{t.scheduled}</Row>
              <Row label="Manager">{t.manager_name}</Row>
              <Row label="In the TM">{t.first_seen === t.last_seen ? dayOf(t.first_seen) : `${dayOf(t.first_seen)} – ${dayOf(t.last_seen)}`}</Row>
            </dl>
          </details>
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
        <strong>{byEngineer ? 'Call closed' : 'Not in the TM any more'}</strong>
        <span>{dayOf(t.closed_on)}{byEngineer ? ` · ${t.closed_by_name}` : ''}</span>
        {byEngineer && (
          <span className={`mt-chip ${t.csat ? 'is-yes' : 'is-no'}`}>CSAT {t.csat ? 'Yes' : 'No'}</span>
        )}
        {t.close_note && <p className="mt-closure-note">“{t.close_note}”</p>}
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

function AssignOne({ t, team, onDone }) {
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
      await onDone(name ? `${t.wo} assigned to ${name}` : `${t.wo} is not assigned now`);
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
          options={[{ value: '', label: 'Not assigned' }, ...team.map((p) => ({ value: p.id, label: p.name }))]}
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
  const [csat, setCsat] = useState(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const input = useRef(null);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const submit = async () => {
    if (csat === null) { setErr({ at: 'csat', text: 'Choose Yes or No' }); return; }
    if (csat && !file) { setErr({ at: 'proof', text: 'Add the CSAT photo' }); return; }
    if (file && file.size > 10 * 1024 * 1024) { setErr({ at: 'proof', text: 'The file is over 10 MB' }); return; }
    setBusy(true); setErr(null);
    try {
      await closeCall(t.id, csat, csat ? file : null, note.trim());
      onClosed(`${t.wo} closed`);
    } catch (e) {
      setErr({ at: 'button', text: e.message }); setBusy(false);
    }
  };

  const late = t.status === 'closed';

  return (
    <section className="mt-close-card">
      <span className="mt-block-label">{late ? 'Add the CSAT' : 'Close this call'}</span>

      <div className="mt-step">
        <span className="mt-step-q">Was the CSAT taken?</span>
        <div className={`mt-thumbs${err?.at === 'csat' ? ' is-bad' : ''}`}>
          <button type="button" className="is-yes" aria-pressed={csat === true} onClick={() => { setCsat(true); setErr(null); }}>
            <Svg d={I.up} size={26} /><span>Yes</span>
          </button>
          <button type="button" className="is-no" aria-pressed={csat === false} onClick={() => { setCsat(false); setErr(null); }}>
            <Svg d={I.down} size={26} /><span>No</span>
          </button>
        </div>
        {err?.at === 'csat' && <p className="mt-err">{err.text}</p>}
      </div>

      {csat && (
        <div className="mt-step">
          <span className="mt-step-q">CSAT photo</span>
          <input ref={input} type="file" accept="image/*,application/pdf" hidden
                 onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); }} />
          {file ? (
            <div className="mt-photo">
              {preview ? <img src={preview} alt="CSAT" /> : <span className="mt-photo-file">{file.name}</span>}
              <button type="button" className="mt-photo-change" onClick={() => input.current?.click()}>Change</button>
            </div>
          ) : (
            <button type="button" className={`mt-camera${err?.at === 'proof' ? ' is-bad' : ''}`} onClick={() => input.current?.click()}>
              <span className="mt-camera-icon"><Svg d={I.camera} size={28} /></span>
              <span>Take a photo or choose a file</span>
            </button>
          )}
          {err?.at === 'proof' && <p className="mt-err">{err.text}</p>}
        </div>
      )}

      <label className="mt-step">
        <span className="mt-step-q">Note <span className="mt-muted">(optional)</span></span>
        <textarea className="mt-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <div className="mt-close-foot">
        <button type="button" className="mt-go" onClick={submit} disabled={busy}>
          <Svg d={I.check} size={22} />
          {busy ? 'Closing…' : late ? 'Save CSAT' : 'Close call'}
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
      closing: mine.filter((t) => t.status === 'open' && !inFile.has(t.wo)).length,
      back: mine.filter((t) => t.status === 'closed' && !t.closed_by && inFile.has(t.wo)).length,
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
              {result.reopened > 0 && <li><b>{result.reopened}</b> back in the TM, open again</li>}
              <li className={result.closed ? 'is-closing' : ''}><b>{result.closed}</b> not in the file, closed</li>
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
                  {plan.back > 0 && <li><b>{plan.back}</b> back in the TM, open again</li>}
                  <li className={plan.closing ? 'is-closing' : ''}><b>{plan.closing}</b> not in the file, will be closed</li>
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
