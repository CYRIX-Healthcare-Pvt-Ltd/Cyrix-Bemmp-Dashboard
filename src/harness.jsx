/*
 * Layout harness — `npm run dev`, then /bemmp/harness.html.
 *
 * The dashboard is behind a sign-in that lives in another module, so
 * there is no way to look at this app's chrome locally without an
 * account. That is how a bottom bar shipped as a full-height panel
 * covering the page: the rail is sticky at `top: 20px`, the phone rule
 * set `bottom: 0` without clearing `top`, and a fixed box with both
 * stretches between them. Nothing caught it because nothing rendered it.
 *
 * SideNav, ThemeToggle, Avatar and Logo are the real components and the
 * stylesheet is the real one, so anything they get wrong shows up here.
 * The masthead is a *copy* of App.jsx's, which is the one thing that can
 * drift — change one and change the other, or this stops telling the
 * truth about the header.
 *
 * Vite builds `index.html` only, so none of this ships.
 */
import { StrictMode, useState } from 'react';
import { GridCell, ColumnFilter } from './components/MeetingTab.jsx';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import Logo, { Tagline } from './components/Logo.jsx';
import SideNav from './components/SideNav.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import Avatar from './components/Avatar.jsx';
import './styles.css';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', short: 'Home' },
  { id: 'calls', label: 'Open calls', short: 'Open' },
  { id: 'repeats', label: 'Repeat calls', short: 'Repeats' },
  { id: 'performance', label: 'FTFR and Closure TAT', short: 'FTFR' },
  { id: 'money', label: 'Penalty', short: 'Penalty' },
  { id: 'accounts', label: 'Accounts', short: 'Accounts' },
];

const NARROW = '(max-width: 860px)';


/*
 * The tracker grid, with the meeting's own fields in it.
 *
 * The real one needs an account and a database, so the shapes that
 * matter could not be looked at before they shipped — which is exactly
 * how this arrangement was got wrong the first time. Real GridCell, real
 * ColumnFilter, real stylesheet, invented rows.
 *
 * What to look at: the ticket column staying put while the rest scrolls,
 * a cell turning into an editor when you click it, and the filter list
 * hanging off its own heading.
 */
function MeetingGrid() {
  const [widths, setWidths] = useState({});
  const startResize = (key, e) => {
    e.preventDefault(); e.stopPropagation();
    const th = e.currentTarget.closest('th');
    const from = th.getBoundingClientRect().width;
    const x0 = e.clientX;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const next = Math.max(70, Math.round(from + (ev.clientX - x0)));
      setWidths((w) => (w[key] === next ? w : { ...w, [key]: next }));
    };
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      document.body.classList.remove('is-resizing');
    };
    document.body.classList.add('is-resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
  };
  const resetWidth = (key) => setWidths((w) => { const n = { ...w }; delete n[key]; return n; });
  const ENTRY = [
    { key: 'penalty_type', label: 'Penalty type', kind: 'select' },
    { key: 'current_status', label: 'Current status as on date', kind: 'text' },
    { key: 'trc_given_date', label: 'TRC given', kind: 'date' },
    { key: 'standby_days', label: 'Standby days', kind: 'number' },
    { key: 'pi_no', label: 'PI no', kind: 'text' },
    { key: 'vendor_name', label: 'Vendor', kind: 'text' },
  ];
  const ROWS = [
    { ticket: '289123', age: 61, district: 'Ernakulam', facility: 'DH Aluva', equipment: 'Electrolyte Analyser', rate: 500 },
    { ticket: '289122', age: 44, district: 'Thrissur', facility: 'GH Chalakudy', equipment: 'Electrolyte Analyser', rate: 500 },
    { ticket: '289121', age: 12, district: 'Kollam', facility: 'THQH Punalur', equipment: 'Laryngoscope', rate: 50 },
    { ticket: '289120', age: 9, district: 'Kannur', facility: 'DH Thalassery', equipment: 'BP Apparatus', rate: 50 },
    { ticket: '289118', age: 120, district: 'Palakkad', facility: 'DH Palakkad', equipment: 'Cautery', rate: 1000 },
  ];
  const [values, setValues] = useState({});
  const [openFilter, setOpenFilter] = useState(null);
  const [picked, setPicked] = useState([]);
  const [full, setFull] = useState(false);

  const choices = [['BP Apparatus', 2], ['Cautery', 1], ['Electrolyte Analyser', 2], ['Laryngoscope', 1]];

  return (
    <div className={`grid${full ? ' tracker-full' : ''}`} style={{ gap: 16 }}>
      <div className="panel">
        <div className="meeting-tools">
          <div className="meeting-search"><input className="cell" placeholder="Search ticket…" readOnly /></div>
          <button type="button" className="meeting-export">Excel</button>
          <button type="button" className="meeting-full" onClick={() => setFull((v) => !v)}>
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
          {picked.length > 0 && (
            <button type="button" className="filter-reset" onClick={() => setPicked([])}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="table-scroll meeting-scroll">
          <table className="meeting-table is-sortable">
            <thead>
              <tr>
                <th className="col-pin"><button type="button" className="th-sort">Ticket</button></th>
                <th className="num"><button type="button" className="th-sort">Down Days</button></th>
                <th><button type="button" className="th-sort">District</button></th>
                <th><button type="button" className="th-sort">Facility</button></th>
                <th>
                  <span className="th-inner">
                  <button type="button" className="th-sort">Equipment</button>
                  <span className="th-filter-wrap">
                    <button
                      type="button"
                      className={`th-filter${picked.length ? ' is-on' : ''}`}
                      onClick={() => setOpenFilter(openFilter ? null : 'equipment')}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                           strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 5h18l-7 8v6l-4 2v-8z" />
                      </svg>
                      {picked.length > 0 && <span className="th-filter-n">{picked.length}</span>}
                    </button>
                    {openFilter && (
                      <ColumnFilter
                        label="Equipment"
                        choices={choices}
                        picked={picked}
                        onChange={setPicked}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                  </span>
                  </span>
                </th>
                <th className="num"><button type="button" className="th-sort">Per day penalty</button></th>
                {ENTRY.map((f) => (
                  <th key={f.key} className={`entry entry-${f.kind}`}
                      style={widths[f.key] ? { width: widths[f.key], minWidth: widths[f.key], maxWidth: widths[f.key] } : undefined}>
                    <span className="th-inner">
                      <button type="button" className="th-sort">{f.label}</button>
                    </span>
                    <span className="th-resize" onPointerDown={(e) => startResize(f.key, e)}
                          onDoubleClick={() => resetWidth(f.key)} aria-label={`Resize ${f.label}`} />
                  </th>
                ))}
                <th>Log</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.ticket}>
                  <td className="col-pin">
                    <button type="button" className="linkish">{r.ticket}</button>
                    <button type="button" className="row-form" aria-label="Open the full entry form">
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 20h4L19 9a2.8 2.8 0 10-4-4L4 16v4z" />
                      </svg>
                    </button>
                  </td>
                  <td className="num">{r.age}d</td>
                  <td>{r.district}</td>
                  <td>{r.facility}</td>
                  <td>{r.equipment}</td>
                  <td className="num">{r.rate.toLocaleString('en-IN')}</td>
                  {ENTRY.map((f) => (
                    <td key={f.key} className={`entry entry-${f.kind}${f.kind === 'number' ? ' num' : ''}`}>
                      <GridCell
                        fieldKey={f.key}
                        value={values[`${r.ticket}.${f.key}`]}
                        kind={f.kind}
                        options={['Vendor delay', 'Spare awaited', 'Not in scope']}
                        onCommit={async (v) => setValues((m) => ({ ...m, [`${r.ticket}.${f.key}`]: v }))}
                      />
                    </td>
                  ))}
                  <td><button type="button" className="row-more">See log</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Harness() {
  const [tab, setTab] = useState('dashboard');
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  // The app uses a matchMedia hook for this; the harness watches on resize
  // as well so dragging the pane across the split is visible immediately.
  window.onresize = () => setNarrow(window.matchMedia(NARROW).matches);

  const profile = { code: 'E1427', full_name: 'Kevin Raju', avatar: null };

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <a className="brand-home" href="#" aria-label="All Cyrix modules">
            <Logo height={36} />
          </a>
          <div className="brand-divider" aria-hidden="true" />
          <div className="brand-text">
            <h1>BEMMP Service Dashboard</h1>
            <Tagline />
            <div className="sub">
              <span className="live-dot" aria-hidden="true" />
              Kerala · 2,72,153 tickets · 31 Dec 2021 to 28 Aug 2026
            </div>
          </div>
        </div>
        <div className="masthead-right">
          <span className="who" title="Signed in as E1427">
            <span className="who-name">Kevin</span>
            <Avatar name={profile.full_name} src={profile.avatar} />
          </span>
          {narrow && (
            <>
              <ThemeToggle />
              <button type="button" className="icon-toggle" aria-label="Load a TM export">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V4M8 8l4-4 4 4" />
                  <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>
              <button type="button" className="icon-toggle" aria-label="Sign out">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>

      <div className="shell">
        <SideNav
          tabs={TABS}
          active={tab}
          onSelect={setTab}
          onUpload={() => {}}
          onSignOut={() => {}}
          signedIn
          showAccountControls={!narrow}
        />
        <div className="work">
          <div className="grid" style={{ gap: 16 }}>
            {['Total calls', 'Resolved', 'Open calls', 'Unresolved calls',
              'Repeat calls', 'Penalty calls', 'Per-day penalty', 'Closure penalty'].map((t) => (
              <div key={t} className="card" style={{ padding: 18 }}>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t}</div>
                <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>2,72,153</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tickets logged in range</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <MeetingGrid />

      <button type="button" className="assistant-fab">
        <span>Ask Cyra</span>
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
