import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadDataset, loadStates, datasetFrom, formatDay, monthStart, BUCKET, BUCKET_LABEL,
} from './data/store.js';
import { listUploads, getUpload } from './data/uploads.js';
import { listSharedDatasets, fetchSharedDataset } from './data/datasets.js';
import { STATES } from '../shared/schema.mjs';
import UploadPanel from './components/UploadPanel.jsx';
import {
  filterRows, summarize, analyzeRepeats, countBy, topN, buildSeries,
  defaultGranularity, rowsInBucket, penaltyRows, resolvedRows, FTFR_MAX_DAYS,
  accruingRows, closurePenalty, penaltyEligibleThrough, ftfrSettledThrough,
  maxResolvedDay,
} from './data/query.js';
import Logo, { Tagline } from './components/Logo.jsx';
import LoginPage from './components/LoginPage.jsx';
import SideNav from './components/SideNav.jsx';
import MeetingTab from './components/MeetingTab.jsx';
import {
  supabase, isConfigured, loadProfile, signOut, canEditMeeting,
} from './data/supabase.js';
import ThemeToggle from './components/ThemeToggle.jsx';
import StateSwitcher from './components/StateSwitcher.jsx';
import RefreshButton from './components/RefreshButton.jsx';
import Filters from './components/Filters.jsx';
import KpiTiles from './components/KpiTiles.jsx';
import MetricChart from './components/MetricChart.jsx';
import BarList from './components/BarList.jsx';
import DrillExplorer, { TOP_N } from './components/DrillExplorer.jsx';
import TicketDrawer from './components/TicketDrawer.jsx';
import AssistantPanel from './components/AssistantPanel.jsx';

/** The charted metrics. All read from one `buildSeries` result. */
const METRICS = [
  {
    id: 'volume', tab: 'Call volume', label: 'Calls logged',
    color: 'var(--series-1)', value: (d) => d.volume,
    caption: 'Tickets logged per period in the current selection',
  },
  {
    id: 'ftfr', tab: 'FTFR %', label: 'First time fix rate',
    color: 'var(--status-good)', value: (d) => d.ftfrPct, percent: true,
    caption: 'Share of each period\'s logged calls fixed by the next service day',
    // Stops where the verdict is final. Sunday is not a service day, so the gap
    // is two days midweek and three on a Monday.
    through: (ds, referenceDay) => ftfrSettledThrough(referenceDay, maxResolvedDay(ds)),
    note: (ds, referenceDay) =>
      `Ends ${formatDay(ftfrSettledThrough(referenceDay, maxResolvedDay(ds)))}`
      + ' — later calls can still be fixed',
    detail: (d) => [['Fixed in window', d.fixes]],
  },
  {
    id: 'repeats', tab: 'Repeat calls', label: 'Repeat calls',
    color: 'var(--series-2)', value: (d) => d.repeats,
    caption: 'Calls that were not the first on their asset, by period logged',
  },
  {
    id: 'penalty', tab: 'Penalty calls', label: 'Penalty calls',
    color: 'var(--status-critical)', value: (d) => d.penalties,
    caption: 'Calls still open past SLA, placed in the period they were logged',
    // The last days before the reference date cannot breach yet, whatever
    // happens in them, so plotting them would draw a cliff that is not there.
    through: penaltyEligibleThrough,
    note: (ds, referenceDay) =>
      `Ends ${formatDay(penaltyEligibleThrough(ds, referenceDay))} — later calls are inside SLA`,
  },
];

const GRANULARITIES = [
  { id: 'month', label: 'Monthly' },
  { id: 'week', label: 'Weekly' },
  { id: 'day', label: 'Daily' },
];

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'calls', label: 'Open calls' },
  { id: 'penalty', label: 'Penalty calls' },
  { id: 'repeats', label: 'Repeat calls' },
  { id: 'performance', label: 'FTFR and Closure TAT' },
  { id: 'money', label: 'Penalty ₹' },
];

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Caption suffix telling the reader the list is longer than what is on screen. */
const inScope = (items) => (items.length > TOP_N
  ? ` · ${items.length.toLocaleString()} in this selection`
  : '');

/**
 * The two money measures from "KL Penalty Logic.xlsx".
 *
 * Per-day penalty is column AU summed over tickets accruing inside the selected
 * range — the daily burn rate. Closure penalty is column AZ over tickets *closed*
 * inside the range, which is why it filters on Resolved Date instead of Logged
 * Date: the charge settles when the ticket closes, however long ago it was logged.
 */
const MONEY = [
  {
    id: 'perday',
    label: 'Per-day penalty',
    tab: 'Per-day penalty',
    color: 'var(--status-critical)',
    kind: 'sum',
    sort: 'desc',
    dateField: 'loggedDay',
    format: (v) => `${inr(v)}/d`,
    subtitle: (n) => `${n.toLocaleString()} tickets`,
    caption: 'Penalty accruing each day, by Asset Value band (column AU)',
  },
  {
    id: 'closure',
    label: 'Closure penalty',
    tab: 'Closure penalty',
    color: 'var(--series-2)',
    kind: 'sum',
    sort: 'desc',
    dateField: 'resolvedDay',
    format: inr,
    subtitle: (n) => `${n.toLocaleString()} closed`,
    caption: 'Penalty settled on tickets closed in this period (column AZ)',
  },
];

/**
 * Drill measures that are a rate or a mean rather than a count.
 *
 * Both run over resolved calls only — an open call has no fix to rate and no
 * resolution time. `minSamples` keeps one-ticket groups off the ranking, which
 * would otherwise show a perfect or terrible score with no evidence behind it.
 */
const PERFORMANCE = [
  {
    id: 'ftfr',
    label: 'FTFR',
    tab: 'FTFR %',
    color: 'var(--status-good)',
    sort: 'asc',
    minSamples: 10,
    format: (v) => `${(v * 100).toFixed(1)}%`,
    subtitle: (n) => `${n.toLocaleString()} resolved`,
    caption: 'Share of resolved calls fixed within 1 day of logging, worst first',
  },
  {
    id: 'resolution',
    label: 'Avg resolution',
    tab: 'Avg resolution',
    color: 'var(--series-2)',
    sort: 'desc',
    minSamples: 10,
    format: (v) => `${v.toFixed(1)} d`,
    subtitle: (n) => `${n.toLocaleString()} resolved`,
    caption: 'Mean days from logged to resolved, slowest first',
  },
];

const STATE_KEY = 'bemmp-state';

/** Sub-tab id for the tracker. A string, so it can never collide with a bucket. */
const TRACKER = 'tracker';

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** "beyond 7 days" for Kerala, "beyond 2 days for critical…" for Andhra. */
function describeSla(penaltyDays) {
  const crit = penaltyDays.CRITICAL;
  const non = penaltyDays['NON CRITICAL'];
  if (crit === non) return `beyond ${non} days`;
  return `beyond ${crit} days for critical and ${non} days for non-critical equipment`;
}

/** The logged date is not counted, so a window of N breaches on day N+2. */
function slaExample(penaltyDays) {
  const crit = penaltyDays.CRITICAL;
  const non = penaltyDays['NON CRITICAL'];
  const lead = 'The logged date is not counted, so a call logged on the 1st breaches on the ';
  if (crit === non) return `${lead}${ordinal(non + 2)}.`;
  return `${lead}${ordinal(crit + 2)} if critical and the ${ordinal(non + 2)} if not.`;
}

/*
 * Opens on the current month rather than all time — the month in the data, not the
 * calendar, since the export lags reality and "this month" from today can be empty.
 */
function blankFilters(meta) {
  return {
    preset: 'month',
    dayFrom: monthStart(meta.dateRange.maxDay),
    dayTo: meta.dateRange.maxDay,
    district: new Set(),
    facilityType: new Set(),
    equipmentType: new Set(),
    bucket: new Set(),
  };
}

export default function App() {
  const [states, setStates] = useState(null);
  const [stateId, setStateId] = useState(() => localStorage.getItem(STATE_KEY) || 'kl');
  const [ds, setDs] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(null);
  const [tab, setTab] = useState('dashboard');
  /* Which view of the open backlog is showing. Either a bucket, or the
     tracker — the same rows in the form the daily meeting works through. */
  const [callView, setCallView] = useState(BUCKET.OPEN);
  const [drawerRow, setDrawerRow] = useState(null);
  const [metricId, setMetricId] = useState('volume');
  const [perfId, setPerfId] = useState('ftfr');
  const [moneyId, setMoneyId] = useState('perday');
  const [granularity, setGranularity] = useState(null); // null = follow the range
  // Bumped after a refresh; busts the HTTP cache and re-runs the loader below.
  const [dataVersion, setDataVersion] = useState('');
  const [uploads, setUploads] = useState(null); // stateId -> summary
  const [shared, setShared] = useState({}); // stateId -> row in `dataset`
  const [showUpload, setShowUpload] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  // undefined while the stored session is being restored, null when signed out.
  const [session, setSession] = useState(isConfigured() ? undefined : null);
  const [profile, setProfile] = useState(null);

  /*
   * A build with no Supabase configured is a supported state, not a broken one:
   * it is the offline and on-prem case, and the dashboard's figures come from
   * files rather than from an account. Only the meeting tab needs to be signed
   * in, and it is the thing that disappears when nobody is.
   */
  useEffect(() => {
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Role and scope decide which tabs exist, so they are loaded before the app
  // renders rather than fetched by the tab that needs them.
  useEffect(() => {
    if (!session) { setProfile(null); return; }
    loadProfile().then(setProfile).catch(() => setProfile(null));
  }, [session]);

  useEffect(() => {
    // A static deployment ships no artifacts at all, so a missing states.json is a
    // normal state, not an error — the user supplies the workbooks instead.
    loadStates(dataVersion).then(setStates).catch(() => setStates([]));
  }, [dataVersion]);

  useEffect(() => { listUploads().then(setUploads); }, []);

  /* What the team has already published. This is what makes one person's upload
     everyone's data — without it a deployment with no server artifact is empty
     until each person goes and finds the workbook themselves. */
  const reloadShared = useCallback(() => {
    listSharedDatasets().then(setShared).catch(() => setShared({}));
  }, []);
  useEffect(() => { if (session) reloadShared(); }, [session, reloadShared]);

  // Depend on readiness rather than the array identity: a refresh refetches
  // states.json, and keying off the new array would load the dataset a second time.
  const ready = states !== null && uploads !== null;

  /** Contracts that actually have data behind them, uploads taking precedence. */
  const available = useMemo(() => {
    if (!ready) return [];
    const byId = new Map();
    for (const s of states) byId.set(s.id, { ...s, source: 'server' });
    for (const [id, d] of Object.entries(shared)) {
      const known = STATES.find((s) => s.id === id);
      byId.set(id, {
        id, short: known?.short, name: known?.name, rows: d.rows, source: 'shared',
      });
    }
    for (const [id, up] of Object.entries(uploads)) {
      const known = STATES.find((s) => s.id === id);
      byId.set(id, {
        id, short: up.short ?? known?.short, name: up.name ?? known?.name,
        rows: up.rows, source: 'upload',
      });
    }
    const built = STATES.map((s) => byId.get(s.id)).filter(Boolean);

    /*
     * Scope is the account's contract list from the login sheet — "Only KL",
     * "Only AP", "All". Filtering here rather than in the switcher means a
     * contract outside scope is not merely unclickable: it is never loaded, so
     * its dictionaries and figures never reach the page at all.
     *
     * Only applied once a profile exists. A build with no Supabase has no
     * accounts and therefore no scope to enforce.
     */
    if (!profile) return built;
    const allowed = built.filter((s) => profile.scope?.includes(s.id));
    return allowed.length ? allowed : built.slice(0, 0);
  }, [ready, states, uploads, shared, profile]);

  // Dictionaries are per state, so the dataset and every filter reload together.
  useEffect(() => {
    if (!ready || !available.length) return undefined;
    const target = available.some((s) => s.id === stateId) ? stateId : available[0].id;
    if (target !== stateId) { setStateId(target); return undefined; }

    let cancelled = false;
    setBusy(true);
    setDrawerRow(null);

    const load = (async () => {
      if (uploads[target]) {
        const u = await getUpload(target);
        return datasetFrom(u.meta, u.buffer, 'upload');
      }
      if (shared[target]) {
        const s = await fetchSharedDataset(target, shared[target].encoding);
        if (s) return datasetFrom(s.meta, s.buffer, 'shared');
      }
      return loadDataset(target, dataVersion);
    })();

    load
      .then((data) => {
        if (cancelled) return;
        setDs(data);
        setFilters(blankFilters(data.meta));
        setBusy(false);
        localStorage.setItem(STATE_KEY, target);
      })
      .catch((e) => { if (!cancelled) { setError(e.message); setBusy(false); } });
    return () => { cancelled = true; };
  }, [ready, available, stateId, dataVersion, uploads, shared]);

  /** A freshly parsed workbook becomes the active dataset immediately. */
  const onUploaded = useCallback((id, meta, buffer) => {
    setDs(datasetFrom(meta, buffer, 'upload'));
    setFilters(blankFilters(meta));
    setStateId(id);
    setError(null);
    setBusy(false);
    setShowUpload(false);
    listUploads().then(setUploads);
  }, []);

  // A finished rebuild replaces the artifact on disk; pull it in without a reload.
  const onRefreshed = useCallback(() => setDataVersion(String(Date.now())), []);

  const referenceDay = ds ? ds.meta.dateRange.maxDay : 0;

  useEffect(() => {
    if (ds) document.title = `BEMMP Dashboard — ${ds.meta.name}`;
  }, [ds]);

  const idx = useMemo(
    () => (ds && filters ? filterRows(ds, filters) : null),
    [ds, filters],
  );
  const summary = useMemo(
    () => (idx ? summarize(ds, idx, referenceDay) : null),
    [ds, idx, referenceDay],
  );
  const repeats = useMemo(() => (idx ? analyzeRepeats(ds, idx) : null), [ds, idx]);

  // Until the user picks one, granularity follows the width of the selected range.
  const autoGranularity = filters
    ? defaultGranularity(filters.dayFrom, filters.dayTo)
    : 'month';
  const activeGranularity = granularity ?? autoGranularity;

  const series = useMemo(
    () => (idx ? buildSeries(ds, idx, activeGranularity, referenceDay) : []),
    [ds, idx, activeGranularity, referenceDay],
  );
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];

  /**
   * Two of the four metrics cannot be judged right up to the reference date, and
   * plotting the part that cannot reads as a collapse rather than as a gap.
   *
   * Dropped by period, not by day: a period survives if it *starts* on or before
   * the cutoff, so a partly-settled week or month still plots. Only the daily
   * view, where period and day are the same thing, trims to the exact date.
   */
  const plotted = useMemo(() => {
    if (!metric.through || !series.length) return series;
    const cutoff = metric.through(ds, referenceDay);
    return series.filter((p) => p.key <= cutoff);
  }, [series, metric, ds, referenceDay]);

  const bucketRows = useMemo(
    () => (idx && callView !== TRACKER ? rowsInBucket(ds, idx, callView) : []),
    [ds, idx, callView],
  );
  const penalties = useMemo(
    () => (idx ? penaltyRows(ds, idx, referenceDay) : []),
    [ds, idx, referenceDay],
  );
  const resolved = useMemo(() => (idx ? resolvedRows(ds, idx) : []), [ds, idx]);

  const money = MONEY.find((m) => m.id === moneyId) ?? MONEY[0];

  // Closure penalty is scoped by Resolved Date; every other view is scoped by
  // Logged Date. The dimension filters apply either way.
  const closedIdx = useMemo(
    () => (ds && filters ? filterRows(ds, filters, { dateField: 'resolvedDay' }) : []),
    [ds, filters],
  );

  // Accrual ignores the logged-date window on purpose: a call logged in May is
  // still running up penalty in July, which is what the workbook's AN clamp does.
  const undatedIdx = useMemo(
    () => (ds && filters ? filterRows(ds, filters, { dateField: null }) : []),
    [ds, filters],
  );

  const accruing = useMemo(
    () => (idx ? accruingRows(ds, undatedIdx, filters.dayFrom, filters.dayTo) : []),
    [ds, idx, undatedIdx, filters],
  );

  // Both money figures feed the KPI tiles, so they are computed whichever tab is
  // showing rather than only inside the money view.
  const moneySummary = useMemo(() => {
    if (!ds) return { hasRateCard: false, perDay: 0, closure: 0, accruingCount: 0, closedCount: 0 };
    return {
      hasRateCard: Boolean(ds.meta.penaltyRates),
      perDay: accruing.reduce((sum, i) => sum + ds.cols.dayRate[i], 0),
      closure: closedIdx.reduce((sum, i) => sum + closurePenalty(ds, i), 0),
      accruingCount: accruing.length,
      closedCount: closedIdx.length,
    };
  }, [ds, accruing, closedIdx]);

  const moneyRows = money.id === 'closure' ? closedIdx : accruing;

  const moneyMeasure = useMemo(() => ({
    ...money,
    value: money.id === 'closure'
      ? (i) => closurePenalty(ds, i)
      : (i) => ds.cols.dayRate[i],
  }), [ds, money]);

  const moneyTotal = useMemo(
    () => moneyRows.reduce((sum, i) => sum + moneyMeasure.value(i), 0),
    [moneyRows, moneyMeasure],
  );

  const perfMeasure = useMemo(() => {
    const base = PERFORMANCE.find((m) => m.id === perfId) ?? PERFORMANCE[0];
    const { cols } = ds ?? {};
    return {
      ...base,
      value: base.id === 'ftfr'
        ? (i) => (cols.resolvedDay[i] - cols.loggedDay[i] <= FTFR_MAX_DAYS ? 1 : 0)
        : (i) => cols.resolvedDay[i] - cols.loggedDay[i],
    };
  }, [ds, perfId]);

  const breakdowns = useMemo(() => {
    if (!idx) return null;
    const { dict } = ds;
    return {
      // Full rankings; BarList shows TOP_N of each and expands on demand.
      district: topN(countBy(ds, idx, 'district'), dict.district, Infinity),
      facility: topN(countBy(ds, idx, 'facilityName'), dict.facilityName, Infinity),
      equipment: topN(countBy(ds, idx, 'equipment'), dict.equipment, Infinity),
      manufacturer: topN(countBy(ds, idx, 'manufacturer'), dict.manufacturer, Infinity),
      facilityType: topN(countBy(ds, idx, 'facilityType'), dict.facilityType, Infinity),
      parkedReason: topN(countBy(ds, idx, 'parkedReason'), dict.parkedReason, Infinity)
        .filter((r) => r.id >= 0),
    };
  }, [ds, idx]);

  const openBucket = useCallback((bucket) => {
    setCallView(bucket);
    setTab('calls');
  }, []);

  /*
   * The meeting is a working surface, not a report, so directors do not get the
   * tab — and a build with no Supabase has nowhere to save, so it does not
   * appear there either. Neither is the actual control: the row-level policy is,
   * and it refuses a director's write whether or not they can see this.
   */
  const showMeeting = isConfigured() && canEditMeeting(profile);
  // The tracker lost its own top-level tab and became a sub-tab of Open calls,
  // so nothing in the strip depends on the role any more.
  const visibleTabs = TABS;

  // Losing the tracker on sign-out must not leave the app looking at it.
  useEffect(() => {
    if (callView === TRACKER && !showMeeting) setCallView(BUCKET.OPEN);
  }, [callView, showMeeting]);

  // Restoring a stored session takes a tick. Rendering the login form in that
  // tick would flash it at somebody who is already signed in.
  if (session === undefined) {
    return (
      <div className="status-msg">
        <div className="loader" aria-hidden="true" />
      </div>
    );
  }

  if (isConfigured() && !session) return <LoginPage onSignedIn={() => {}} />;

  if (error) {
    return (
      <>
        <div className="status-msg">
          <p>{error}</p>
          <p>Run <code>npm run build:data</code>, then reload.</p>
        </div>
      </>
    );
  }

  // Signed in, but the account's scope covers no contract that is loaded. That
  // is a permissions answer, not a missing-file one, so it must not fall through
  // to the upload panel and invite them to supply the data themselves.
  if (ready && !available.length && profile) {
    return (
      <div className="status-msg">
        <p>No BEMMP contract is assigned to <strong>{profile.code}</strong>.</p>
        <p>Ask your project head to add one, then sign in again.</p>
        <button type="button" className="reset" onClick={signOut}>Sign out</button>
      </div>
    );
  }

  // Nothing built and nothing uploaded — the static-hosting case. Ask for a file
  // rather than showing an empty dashboard.
  if (ready && !available.length) {
    return (
      <>
        <div className="app">
          <header className="masthead">
            <div className="brand">
              <Logo height={36} />
              <div className="brand-divider" aria-hidden="true" />
              <div className="brand-text">
                <h1>BEMMP Service Dashboard</h1>
                <Tagline />
              </div>
            </div>
            <div className="masthead-right">
              <div className="toggle-group">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <UploadPanel serverStates={states} onLoaded={onUploaded} landing />
        </div>
      </>
    );
  }

  if (!ds || !filters || !idx) {
    return (
      <>
        <div className="status-msg">
          <div className="loader" aria-hidden="true" />
          <p>Loading ticket data…</p>
        </div>
      </>
    );
  }

  const { meta, dict } = ds;

  return (
    <>
      <div className={`app${busy ? ' is-busy' : ''}`}>
        <header className="masthead">
          <div className="brand">
            <Logo height={36} />
            <div className="brand-divider" aria-hidden="true" />
            <div className="brand-text">
              <h1>BEMMP Service Dashboard</h1>
              <Tagline />
              <div className="sub">
                <span className="live-dot" aria-hidden="true" />
                {meta.name} · {meta.rows.toLocaleString()} tickets ·{' '}
                {formatDay(meta.dateRange.minDay)} to {formatDay(referenceDay)}
              </div>
            </div>
          </div>
          <div className="masthead-right">
            <StateSwitcher
              states={available}
              active={stateId}
              onChange={setStateId}
              busy={busy}
            />
            <div className="toggle-group">
              <RefreshButton onRefreshed={onRefreshed} />
              <button
                type="button"
                className="icon-toggle"
                onClick={() => setShowUpload(true)}
                title="Load a TM export from this device"
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V4M8 8l4-4 4 4" />
                  <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                </svg>
                <span className="toggle-label">Data</span>
              </button>
              <ThemeToggle />
              {profile && (
                <button
                  type="button"
                  className="icon-toggle"
                  onClick={signOut}
                  title={`Signed in as ${profile.code} — sign out`}
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
                  </svg>
                  <span className="toggle-label">{profile.code}</span>
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="shell">
        <SideNav
          tabs={visibleTabs}
          active={tab}
          onSelect={setTab}
        />
        <div className="work">

        {showUpload && (
          <UploadPanel
            serverStates={states}
            onLoaded={onUploaded}
            onPublished={reloadShared}
            onClose={() => setShowUpload(false)}
          />
        )}

        <Filters
          dict={dict}
          dateRange={meta.dateRange}
          filters={filters}
          setFilters={setFilters}
        />

        <div className="tabview" key={tab}>

        {tab === 'dashboard' && (
          <div className="grid" style={{ gap: 16 }}>
            <KpiTiles
              summary={summary}
              repeats={repeats}
              penaltyDays={meta.penaltyDays}
              money={moneySummary}
              onOpenBucket={openBucket}
              onOpenPenalty={() => setTab('penalty')}
              onOpenRepeats={() => setTab('repeats')}
              onOpenPerformance={(id) => { setPerfId(id); setTab('performance'); }}
              onOpenMoney={(id) => { setMoneyId(id); setTab('money'); }}
            />
            <div className="panel chart-panel" style={{ '--i': 0 }}>
              <div className="chart-head">
                <div className="chart-tabs" role="tablist" aria-label="Metric">
                  {METRICS.map((m) => (
                    <button
                      key={m.id} type="button" role="tab"
                      aria-selected={m.id === metricId}
                      className="chart-tab"
                      style={{ '--tab-accent': m.color }}
                      onClick={() => setMetricId(m.id)}
                    >
                      {m.tab}
                    </button>
                  ))}
                </div>
                <div className="segmented" role="tablist" aria-label="Granularity">
                  {GRANULARITIES.map((g) => (
                    <button
                      key={g.id} type="button" role="tab"
                      aria-selected={g.id === activeGranularity}
                      onClick={() => setGranularity(g.id)}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
              <h2>{metric.label}</h2>
              <p className="caption">
                {metric.caption} · {plotted.length.toLocaleString()}{' '}
                {activeGranularity === 'month' ? 'months' : (activeGranularity === 'week' ? 'weeks' : 'days')}
                {granularity === null && ' · granularity follows the date range'}
                {/* Say why the line stops short, or the missing tail looks like
                    missing data. */}
                {metric.note && plotted.length < series.length
                  && ` · ${metric.note(ds, referenceDay)}`}
              </p>
              <MetricChart series={plotted} metric={metric} />
            </div>

            <div className="grid grid-2">
              <div className="panel" style={{ '--i': 1 }}>
                <h2>Districts</h2>
                <p className="caption">
                  Calls by district
                  {breakdowns.district.length > TOP_N
                    ? ` · ${breakdowns.district.length} in this selection, scroll for the rest`
                    : ''}
                </p>
                {/* No expander: the district list is short enough to render whole. */}
                <BarList items={breakdowns.district} total={summary.total} />
              </div>
              <div className="panel" style={{ '--i': 2 }}>
                <h2>Facilities</h2>
                <p className="caption">Calls by facility{inScope(breakdowns.facility)}</p>
                <BarList items={breakdowns.facility} total={summary.total} initial={TOP_N} />
              </div>
              <div className="panel" style={{ '--i': 3 }}>
                <h2>Equipment</h2>
                <p className="caption">
                  Calls by asset description{inScope(breakdowns.equipment)}
                </p>
                <BarList
                  items={breakdowns.equipment} total={summary.total}
                  color="var(--series-2)" initial={TOP_N}
                />
              </div>
              <div className="panel" style={{ '--i': 4 }}>
                <h2>Manufacturers</h2>
                <p className="caption">
                  Calls by manufacturer{inScope(breakdowns.manufacturer)}
                </p>
                <BarList
                  items={breakdowns.manufacturer} total={summary.total}
                  color="var(--series-3)" initial={TOP_N}
                />
              </div>
              <div className="panel" style={{ '--i': 5 }}>
                <h2>Facility types</h2>
                <p className="caption">Share of total calls{inScope(breakdowns.facilityType)}</p>
                <BarList
                  items={breakdowns.facilityType} total={summary.total}
                  color="var(--series-2)" initial={TOP_N}
                />
              </div>
              <div className="panel" style={{ '--i': 6 }}>
                <h2>Why calls are unresolved</h2>
                <p className="caption">
                  Ticket Remark on unresolved calls — these sit outside the open backlog
                </p>
                <BarList
                  items={breakdowns.parkedReason}
                  total={summary.parked}
                  color="var(--status-warning)"
                  initial={TOP_N}
                  emptyText="No unresolved calls in range"
                />
              </div>
            </div>
          </div>
        )}

        {tab === 'calls' && (
          <>
            <div className="segmented-row">
              <div className="segmented" role="tablist" aria-label="Backlog view">
                {[BUCKET.OPEN, BUCKET.PARKED].map((b) => (
                  <button
                    key={b} type="button" role="tab"
                    aria-selected={callView === b}
                    onClick={() => setCallView(b)}
                  >
                    {BUCKET_LABEL[b]}
                  </button>
                ))}
                {/* The tracker is the same open backlog, in the form the meeting
                    works through it — so it belongs beside the buckets rather
                    than in a tab of its own. */}
                {showMeeting && (
                  <button
                    type="button" role="tab"
                    aria-selected={callView === TRACKER}
                    onClick={() => setCallView(TRACKER)}
                  >
                    Ticket tracker
                  </button>
                )}
              </div>
            </div>

            {callView === TRACKER ? (
              <MeetingTab
                key={`tracker-${stateId}`}
                ds={ds}
                rows={rowsInBucket(ds, idx, BUCKET.OPEN)}
                referenceDay={referenceDay}
                canEdit={canEditMeeting(profile)}
                onSelectRow={setDrawerRow}
              />
            ) : (
              <DrillExplorer
                key={`calls-${stateId}-${callView}`}
                ds={ds}
                rows={bucketRows}
                referenceDay={referenceDay}
                onSelectRow={setDrawerRow}
                showAgeing
                // Only the parked bucket has remarks to explain; on the open
                // bucket the panel would be empty by definition.
                showParkedReasons={callView === BUCKET.PARKED}
                intro={(n) => (callView === BUCKET.OPEN
                  ? `${n.toLocaleString()} open calls — Resolved Date blank and no Ticket Remark. This is the live, actionable backlog.`
                  : `${n.toLocaleString()} unresolved calls — no Resolved Date, but out of service scope, with the reason held in Ticket Remark.`)}
              />
            )}
          </>
        )}

        {tab === 'penalty' && (
          <DrillExplorer
            key={`penalty-${stateId}`}
            ds={ds}
            rows={penalties}
            referenceDay={referenceDay}
            onSelectRow={setDrawerRow}
            showAgeing
            showPenaltyColumn
            intro={(n) => (
              `${n.toLocaleString()} penalty calls — open ${describeSla(meta.penaltyDays)}, `
              + `measured as of ${formatDay(referenceDay)}. ${slaExample(meta.penaltyDays)}`
            )}
          />
        )}

        {tab === 'performance' && (
          <>
            <div className="segmented-row">
              <div className="segmented" role="tablist" aria-label="Performance measure">
                {PERFORMANCE.map((m) => (
                  <button
                    key={m.id} type="button" role="tab"
                    aria-selected={perfId === m.id}
                    onClick={() => setPerfId(m.id)}
                  >
                    {m.tab}
                  </button>
                ))}
              </div>
            </div>
            <DrillExplorer
              key={`perf-${stateId}-${perfId}`}
              ds={ds}
              rows={resolved}
              referenceDay={referenceDay}
              onSelectRow={setDrawerRow}
              measure={perfMeasure}
              showResolutionColumn
              intro={(n) => (
                `${perfMeasure.caption}. Measured over the ${n.toLocaleString()} resolved `
                + `calls in range — open calls have no fix to rate. Groups with fewer than `
                + `${perfMeasure.minSamples} resolved calls are left out of the ranking.`
              )}
            />
          </>
        )}

        {tab === 'money' && (
          <>
            <div className="segmented-row">
              <div className="segmented" role="tablist" aria-label="Penalty measure">
                {MONEY.map((m) => (
                  <button
                    key={m.id} type="button" role="tab"
                    aria-selected={moneyId === m.id}
                    onClick={() => setMoneyId(m.id)}
                  >
                    {m.tab}
                  </button>
                ))}
              </div>
            </div>
            {!meta.penaltyRates ? (
              <div className="panel">
                <h2>No rate card for {meta.name}</h2>
                <p className="caption">
                  The penalty rate bands come from the state config. Kerala's are taken
                  from <code>KL Penalty Logic.xlsx</code>; no equivalent has been supplied
                  for {meta.name}, so money figures are not calculated here. Its export
                  does carry its own Penalty Down Days and Penalty Amount columns, which
                  are preserved in the artifact and can be surfaced once the rate card is
                  confirmed.
                </p>
              </div>
            ) : (
              <DrillExplorer
                key={`money-${stateId}-${moneyId}`}
                ds={ds}
                rows={moneyRows}
                referenceDay={referenceDay}
                onSelectRow={setDrawerRow}
                measure={moneyMeasure}
                showResolutionColumn={money.id === 'closure'}
                intro={(n) => (
                  `${money.id === 'closure' ? inr(moneyTotal) : `${inr(moneyTotal)} per day`}`
                  + ` across ${n.toLocaleString()} tickets. ${money.caption}. `
                  + (money.id === 'closure'
                    ? 'Scoped by Resolved Date, so a ticket logged months earlier counts '
                      + 'in the period it was closed. Tickets closed inside the grace '
                      + 'window contribute nothing.'
                    : 'Tickets exempted by an RBER date, a ticket remark or a standby '
                      + 'request are excluded, matching column AL.')
                )}
              />
            )}
          </>
        )}

        {tab === 'repeats' && (
          <DrillExplorer
            key={`repeats-${stateId}`}
            ds={ds}
            rows={idx}
            mode="repeats"
            referenceDay={referenceDay}
            onSelectRow={setDrawerRow}
            intro={(n, rep) => (
              `${rep.followUps.toLocaleString()} repeat calls — the 2nd and later call on `
              + `${rep.repeatAssets.toLocaleString()} assets, out of ${n.toLocaleString()} calls `
              + `those assets logged in total. Repeat status is re-derived at every level below.`
            )}
          />
        )}
        </div>
        </div>
        </div>
      </div>

      <TicketDrawer
        ds={ds}
        row={drawerRow}
        latestDay={referenceDay}
        onClose={() => setDrawerRow(null)}
      />

      <button
        type="button"
        className="assistant-fab"
        onClick={() => setShowAssistant(true)}
        aria-label="Ask the data"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.8-5a8.3 8.3 0 0 1-.8-3.6 8.4 8.4 0 0 1 8.5-8.4 8.4 8.4 0 0 1 8.5 8.4Z" />
        </svg>
        <span>Ask</span>
      </button>

      {showAssistant && (
        <AssistantPanel
          ds={ds}
          filters={filters}
          referenceDay={referenceDay}
          onClose={() => setShowAssistant(false)}
        />
      )}
    </>
  );
}
