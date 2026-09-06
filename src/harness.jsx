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
import { StrictMode, useMemo, useState } from 'react';
import MeetingTab from './components/MeetingTab.jsx';
import { makeDataset, day } from '../test/fixture.mjs';
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
 * The real tracker, on a synthetic export.
 *
 * This used to be a hand-copied table of the grid's pieces, which caught
 * the things a copy can catch — a cell that would not close, a column
 * that ate the screen — and none of the things that actually took the
 * dashboard down. Both of those were plain render-time errors in
 * MeetingTab itself: a memo reading `notes.size` before the first load
 * returned, and a dependency array naming a const declared below it.
 * Either would have thrown on the first render of the real component,
 * and there was nowhere that rendered it.
 *
 * There is now. The tab is gated behind isConfigured() and a signed-in
 * profile in App, but the component itself is not — it takes an export
 * and some props. Without Supabase its own load() fails, it catches
 * that, and it draws with an empty note map: exactly the first render
 * that was going wrong, on every reload of this page.
 *
 * The fixture is the one the tests use, so the dataset is the shape the
 * browser really reads rather than a second guess at it.
 */
function TrackerHarness() {
  /*
   * A backlog the size of the real one.
   *
   * The tracker holds every call without a resolved date, which on
   * Kerala is around eight thousand three hundred rather than the nine
   * hundred it used to show. Thirty-eight columns across that many rows
   * is the thing worth knowing before anybody opens it in a meeting, and
   * five invented rows say nothing about it.
   */
  const ds = useMemo(() => makeDataset(
    Array.from({ length: 8300 }, (_, i) => ({
      ticketNo: 280000 + i,
      loggedDay: day('2026-07-08'),
      district: ['Ernakulam', 'Thrissur', 'Kollam', 'Kannur', 'Palakkad'][i % 5],
      facilityName: `DH ${i % 400}`,
      equipment: ['Electrolyte Analyser', 'Laryngoscope', 'BP Apparatus', 'Cautery'][i % 4],
      manufacturer: ['B.BRAUN', 'Easy care', 'Philips'][i % 3],
      model: `Model ${i % 60}`,
      status: 'work in progress',
      engineer: `CYR${i % 90} - Engineer ${i % 90}`,
      parkedReason: i % 3 ? 'rber' : '',
      // Roughly the share the real export carries one for, so the blank
      // case is on screen next to the filled one rather than only in a test.
      installedDay: i % 5 === 0 ? -1 : day('2019-04-11') + (i % 900),
    })),
  ), []);

  // A new array every render would invalidate records, which invalidates
  // load, which sets notes, which renders again — the loop the real App
  // avoids by passing a memoised slice.
  const allRows = useMemo(() => [...Array(ds.rows).keys()], [ds]);

  return (
    <div className="mx-auto" style={{ padding: 16 }}>
      <MeetingTab
        ds={ds}
        rows={allRows}
        unresolvedRows={null}
        referenceDay={day('2026-09-06')}
        canEdit
        onSelectRow={() => {}}
      />
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

      <TrackerHarness />

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
