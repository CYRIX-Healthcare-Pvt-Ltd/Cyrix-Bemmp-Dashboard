import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadDataset, loadStates, datasetFrom, formatDay, BUCKET, BUCKET_LABEL,
} from './data/store.js';
import { listUploads, getUpload } from './data/uploads.js';
import { listSharedDatasets, fetchSharedDataset } from './data/datasets.js';
import { STATES } from '../shared/schema.mjs';
import UploadPanel from './components/UploadPanel.jsx';
import {
  filterRows, summarize, analyzeRepeats, countBy, topN, buildSeries,
  defaultGranularity, rowsInBucket, penaltyRows, resolvedRows, FTFR_MAX_DAYS,
  accruingRows, closurePenalty, penaltyEligibleThrough, ftfrSettledThrough,
  maxResolvedDay, defaultFiltersFor, isFirstTimeFix, areaLimitFor, setAreaLimit,
} from './data/query.js';
import Logo, { Tagline } from './components/Logo.jsx';
import SideNav from './components/SideNav.jsx';
import AdminTab from './components/AdminTab.jsx';
import MeetingTab from './components/MeetingTab.jsx';
import {
  supabase, isConfigured, loadProfile, signOut, canEditMeeting, isAdmin, firstName,
} from './data/supabase.js';
import ThemeToggle from './components/ThemeToggle.jsx';
import Avatar from './components/Avatar.jsx';
import StateSwitcher from './components/StateSwitcher.jsx';
import RefreshButton from './components/RefreshButton.jsx';
import Filters from './components/Filters.jsx';
import KpiTiles from './components/KpiTiles.jsx';
import MetricChart from './components/MetricChart.jsx';
import BarList from './components/BarList.jsx';
import DrillExplorer, { TOP_N } from './components/DrillExplorer.jsx';
import TicketDrawer from './components/TicketDrawer.jsx';
import AssistantPanel from './components/AssistantPanel.jsx';

/*
 * The width where the rail becomes a strip along the bottom. The same
 * number SideNav uses, and the stylesheet with it — below it there is no
 * column beside the work, so the account controls have nowhere to sit but
 * the header.
 */
const NARROW = '(max-width: 860px)';

/**
 * Whether the layout is in its phone shape.
 *
 * Asked in JavaScript rather than answered twice in CSS because these
 * controls must be *rendered* once, not rendered twice and one copy
 * hidden: two theme switches would each keep their own idea of the
 * current theme, and the hidden one would be wrong the moment the visible
 * one was pressed.
 */
function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const sync = (e) => setNarrow(e.matches);
    mq.addEventListener('change', sync);
    // A window dragged across the split between mount and here.
    setNarrow(mq.matches);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return narrow;
}

/** The upload arrow, in the two places that offer it. */
const DataIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true">
    <path d="M12 15V4M8 8l4-4 4 4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

/** The door out, in the two places that offer it. */
const SignOutIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden="true">
    <path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
  </svg>
);

/**
 * Back to the portal, which signs people in for every module.
 *
 * Rendered where the login form used to be. A render-time answer to "who
 * is this", not a redirect fired from an effect somewhere further up — the
 * spinner is only what shows for the moment the browser takes to leave.
 */
function ToPortal() {
  useEffect(() => {
    window.location.assign('/');
  }, []);
  return (
    <div className="status-msg">
      <div className="loader" aria-hidden="true" />
    </div>
  );
}

/**
 * The portal owns the session, so signing out here signs you out of every
 * module — and the way out is its front door rather than this app's, which
 * would only render a spinner on the way to the same place.
 */
async function signOutToPortal() {
  await signOut();
  window.location.assign('/');
}

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
    // The same violet as the rail icon and the KPI tile. A measure that is one
    // colour in the tile and another on the chart is two measures to the eye.
    color: 'var(--series-5)', value: (d) => d.repeats,
    caption: 'Calls that were not the first on their asset, by period logged',
  },
  {
    id: 'penalty', tab: 'Penalty calls', label: 'Penalty calls',
    color: 'var(--status-critical)', value: (d) => d.penalties,
    caption: 'Calls still open past their non-penalty period, plotted where they were logged',
    // The last days before the reference date cannot breach yet, whatever
    // happens in them, so plotting them would draw a cliff that is not there.
    through: penaltyEligibleThrough,
    note: (ds, referenceDay) =>
      `Ends ${formatDay(penaltyEligibleThrough(ds, referenceDay))} — later calls are still `
      + 'inside their non-penalty period',
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
  { id: 'repeats', label: 'Repeat calls' },
  { id: 'performance', label: 'FTFR and Closure TAT' },
  // Penalty calls and penalty rupees are the same backlog counted two ways, so
  // they are sub-tabs of one section rather than two sections asking the same
  // question.
  { id: 'money', label: 'Penalty' },
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
  /*
   * The calls the money is charged on, between the two rupee views rather than
   * in a section of its own. They were separate tabs asking one question twice —
   * a per-day figure is the same backlog counted in rupees, and reading one
   * without the other is how a small number of expensive calls hides behind a
   * large number of cheap ones.
   *
   * `money: false` marks it out: it needs no rate card, so it is the one penalty
   * view Andhra can still show.
   */
  {
    id: 'calls',
    label: 'Penalty calls',
    tab: 'Penalty calls',
    money: false,
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
 * The two run over **different row sets**, which is the thing to keep straight.
 * Avg resolution is over resolved calls, because an open call has no resolution
 * time to average. FTFR is over calls *logged*, because a call still open is a
 * call that was not fixed in its window — dropping it is what made the drill
 * read 58.9% for a zone the tile scored 49%.
 *
 * `minSamples` keeps one-ticket groups off the ranking, which would otherwise
 * show a perfect or terrible score with no evidence behind it.
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
    /* "logged", not "resolved" — the noun is the denominator, and it is the
       only thing on screen that says which of the two figures this is. */
    subtitle: (n) => `${n.toLocaleString()} logged`,
    caption: 'Share of logged calls fixed within 1 working day of logging, worst first',
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

export default function App() {
  const narrow = useNarrow();
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
  /* Which export the current filter selection was built for. See the loader. */
  const loadedSig = useRef(null);

  /*
   * A build with no Supabase configured is a supported state, not a broken one:
   * it is the offline and on-prem case, and the dashboard's figures come from
   * files rather than from an account. Only the meeting tab needs to be signed
   * in, and it is the thing that disappears when nobody is.
   */
  useEffect(() => {
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    /*
     * Keyed on *who* is signed in, not on the session object.
     *
     * GoTrue refreshes the access token when a backgrounded tab comes back, and
     * hands a brand new session object to every listener when it does. Storing
     * that unconditionally re-ran the profile load, which produced a new profile
     * object, which recomputed `available`, which re-ran the dataset loader —
     * and the loader resets the filters. So minimising the window and returning
     * to it silently cleared whatever had been selected.
     *
     * Nothing downstream reads the token off this object: `authHeader` asks
     * `supabase.auth.getSession()` for it at the moment of the request, so it is
     * always the fresh one.
     */
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession((prev) => (prev?.user?.id === (s?.user?.id ?? null) ? prev : (s ?? null)));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Role and scope decide which tabs exist, so they are loaded before the app
  // renders rather than fetched by the tab that needs them.
  useEffect(() => {
    if (!session) { setProfile(null); return; }
    // Same reasoning as above, one level down: an identical row must not arrive
    // as a new object, or every consumer of `profile` recomputes for nothing.
    loadProfile()
      .then((p) => setProfile((prev) => (
        prev && p && prev.id === p.id && prev.role === p.role
          && String(prev.scope) === String(p.scope) ? prev : p
      )))
      .catch(() => setProfile(null));
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
    listSharedDatasets().then((next) => {
      /*
       * Replace the state only when something actually changed.
       *
       * The dataset loader depends on this object, and `listSharedDatasets`
       * hands back a fresh one every call — so setting it unconditionally would
       * make every poll re-download 27 MB and rebuild every typed array.
       * Comparing on the publish timestamps is enough: that is the only field
       * that decides whether the artifact behind them is a different one.
       */
      const sig = (m) => Object.entries(m)
        .map(([id, d]) => `${id}:${d.uploaded_at}`).sort().join('|');
      setShared((prev) => (sig(prev) === sig(next) ? prev : next));
    }).catch(() => { /* keep whatever we had; the dashboard still works */ });
  }, []);

  /*
   * The site is hosted, so an export somebody publishes in one office has to
   * reach a page already open in another. Checking on sign-in alone only covers
   * the person who reloads.
   *
   * Two triggers, both cheap — a single row per contract:
   *   focus/visibility, for the ordinary case of coming back to the tab, and
   *   a slow poll, for a screen left open all day on a wall.
   */
  useEffect(() => {
    if (!session) return undefined;
    reloadShared();

    const check = () => { if (document.visibilityState === 'visible') reloadShared(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      clearInterval(timer);
    };
  }, [session, reloadShared]);

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
    return built.filter((s) => profile.scope?.includes(s.id));
  }, [ready, states, uploads, shared, profile]);

  /**
   * The contracts this account is entitled to, whether or not any data has
   * arrived for them. `available` is the intersection with what is loaded; this
   * is the other half, and the two answer different questions — "you have no
   * contract" versus "your contract has no export yet".
   */
  const scoped = useMemo(
    () => (profile ? STATES.filter((s) => profile.scope?.includes(s.id)) : STATES),
    [profile],
  );

  // Dictionaries are per state, so the dataset and every filter reload together.
  useEffect(() => {
    if (!ready || !available.length) return undefined;
    const target = available.some((s) => s.id === stateId) ? stateId : available[0].id;
    if (target !== stateId) { setStateId(target); return undefined; }

    let cancelled = false;
    setBusy(true);
    setDrawerRow(null);

    const load = (async () => {
      /*
       * Whichever export is newer wins, not whichever is closer.
       *
       * This browser's own upload used to take precedence unconditionally, which
       * quietly broke the thing publishing exists for: somebody who uploaded on
       * Monday went on seeing Monday's figures all week while the rest of the
       * team had Thursday's. Nobody would notice — the numbers look like numbers.
       *
       * A tie goes to the local copy, because a tie means it is the same export
       * and the local one is already on the disk.
       */
      const mine = uploads[target];
      const theirs = shared[target];
      const preferShared = theirs
        && (!mine || new Date(theirs.uploaded_at) > new Date(mine.uploadedAt));

      /*
       * A shared artifact that will not load must not take the page down with
       * it. There is very often a perfectly good copy behind it — this browser's
       * own upload, or whatever the server build shipped — and a dead-end error
       * screen hides all of them. It happened: a stale `tickets.bin.gz` held in
       * one browser's HTTP cache blanked the whole deployment.
       *
       * Reported to the console rather than swallowed, because the next thing
       * shown is a *different* export and silently substituting one for another
       * is how somebody reads Monday's figures on Thursday.
       */
      const tryShared = async () => {
        try {
          const s = await fetchSharedDataset(target, theirs);
          return s ? datasetFrom(s.meta, s.buffer, 'shared') : null;
        } catch (e) {
          console.error(`Shared ${target} export could not be read, falling back:`, e);
          return null;
        }
      };

      if (preferShared) {
        const s = await tryShared();
        if (s) return s;
      }
      if (mine) {
        const u = await getUpload(target);
        if (u) return datasetFrom(u.meta, u.buffer, 'upload');
      }
      if (theirs && !preferShared) {
        const s = await tryShared();
        if (s) return s;
      }
      return loadDataset(target, dataVersion);
    })();

    load
      .then((data) => {
        if (cancelled) return;
        setDs(data);
        /*
         * The filters survive anything short of the export actually changing.
         *
         * This effect resets them, and it re-runs for reasons that have nothing
         * to do with the data — a token refresh on window focus was enough. The
         * signature is what a filter selection is meaningful against: another
         * contract, a different number of rows, a different date range or a
         * different source all invalidate it, and a re-run over the same export
         * does not. Belt and braces against every other cause of a re-run, found
         * or not: whatever wakes this effect, a selection is not lost by it.
         */
        const sig = `${data.meta.id}|${data.source}|${data.meta.rows}`
          + `|${data.meta.dateRange.minDay}|${data.meta.dateRange.maxDay}`;
        if (loadedSig.current !== sig) {
          loadedSig.current = sig;
          setFilters(defaultFiltersFor(data));
        }
        setBusy(false);
        localStorage.setItem(STATE_KEY, target);
      })
      .catch((e) => { if (!cancelled) { setError(e.message); setBusy(false); } });
    return () => { cancelled = true; };
  }, [ready, available, stateId, dataVersion, uploads, shared]);

  /** A freshly parsed workbook becomes the active dataset immediately. */
  const onUploaded = useCallback((id, meta, buffer) => {
    const next = datasetFrom(meta, buffer, 'upload');
    setDs(next);
    // The saved default is resolved against the dictionaries of *this* export,
    // so a district that has left the contract simply drops out of it.
    setFilters(defaultFiltersFor(next));
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

  /*
   * The account's area scope, resolved against this export's dictionaries.
   *
   * Set before anything queries, and recomputed when either the profile or the
   * dataset changes — the names are stored per account but the ids they resolve
   * to belong to whichever export is loaded. `useMemo` rather than an effect so
   * it is in place for the very first `filterRows` below rather than one render
   * late, which would flash the whole contract's figures at somebody scoped to
   * one district.
   */
  const area = useMemo(() => {
    const limit = areaLimitFor(ds, profile);
    setAreaLimit(limit);
    return limit;
  }, [ds, profile]);

  const idx = useMemo(
    () => (ds && filters ? filterRows(ds, filters) : null),
    [ds, filters, area],
  );
  /*
   * The newest logged date whose fix verdict is final — the same cutoff the FTFR
   * chart stops at, so the tile and the line cannot disagree. Monday's last
   * settled day is Friday; Tuesday's is Sunday.
   */
  const ftfrThrough = useMemo(
    () => (ds ? ftfrSettledThrough(referenceDay, maxResolvedDay(ds)) : 0),
    [ds, referenceDay],
  );

  const summary = useMemo(
    () => (idx ? summarize(ds, idx, referenceDay, { ftfrThrough }) : null),
    [ds, idx, referenceDay, ftfrThrough],
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

  /**
   * What the FTFR drill measures over: every call logged, up to the last day
   * whose verdict is final — not just the calls that happen to be closed.
   *
   * The drill used to take `resolved` like the resolution measure does, so it
   * asked "of the ones we closed, how many were quick" while the tile above it
   * asked "of the ones we took, how many were quick". Two different questions
   * with the same name on them, and the drill's answer was always the kinder
   * one: it read 58.9% for South zone against a tile showing 49%.
   *
   * The cutoff is the same `ftfrThrough` the tile and the chart stop at, so a
   * call logged yesterday is not counted as a miss for a window still open.
   */
  const ftfrRows = useMemo(
    () => (idx ? idx.filter((i) => ds.cols.loggedDay[i] <= ftfrThrough) : []),
    [ds, idx, ftfrThrough],
  );

  const money = MONEY.find((m) => m.id === moneyId) ?? MONEY[0];

  // Closure penalty is scoped by Resolved Date; every other view is scoped by
  // Logged Date. The dimension filters apply either way.
  const closedIdx = useMemo(
    () => (ds && filters ? filterRows(ds, filters, { dateField: 'resolvedDay' }) : []),
    [ds, filters, area],
  );

  // Accrual ignores the logged-date window on purpose: a call logged in May is
  // still running up penalty in July, which is what the workbook's AN clamp does.
  const undatedIdx = useMemo(
    () => (ds && filters ? filterRows(ds, filters, { dateField: null }) : []),
    [ds, filters, area],
  );

  /*
   * Every row still without a resolved date — open and parked both.
   *
   * The tracker's grid stays open-only, but its Summary counts both, because the
   * meeting's own workbook does: the sheet's "Total Open Calls" column is really
   * "everything unresolved", and its penalty columns then narrow to the open
   * ones. Kerala has roughly ten parked calls for every open one, so which of
   * the two a column means is the difference between 8,516 and 986.
   */
  const unresolvedRows = useMemo(
    () => (ds && undatedIdx.length
      ? Array.from(undatedIdx).filter((r) => ds.cols.bucket[r] !== BUCKET.RESOLVED)
      : []),
    [ds, undatedIdx],
  );

  const accruing = useMemo(
    () => (idx ? accruingRows(ds, undatedIdx, filters.dayFrom, filters.dayTo) : []),
    [ds, idx, undatedIdx, filters, area],
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
      // `isFirstTimeFix` rather than a bare subtraction, so a Saturday call is
      // not marked a failure for the Sunday nobody works — the same rule the
      // tile and the chart use.
      value: base.id === 'ftfr'
        ? (i) => (isFirstTimeFix(cols.loggedDay[i], cols.resolvedDay[i]) ? 1 : 0)
        : (i) => cols.resolvedDay[i] - cols.loggedDay[i],
    };
  }, [ds, perfId]);

  const breakdowns = useMemo(() => {
    if (!idx) return null;
    const { dict } = ds;
    return {
      // Full rankings; BarList shows TOP_N of each and expands on demand.
      // Empty for a contract whose export has no zone column, which is what the
      // panel checks before rendering rather than drawing an empty heading.
      zone: topN(countBy(ds, idx, 'zone'), dict.zone, Infinity),
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

  /*
   * Accounts is the one section that is not about the contract, so it sits at
   * the end of the rail rather than among the measures — and only for an admin.
   * As always the rail is a courtesy: `/api/users` re-checks the role against
   * the database on every request, and the profile policy is what actually
   * refuses anyone else.
   */
  const visibleTabs = useMemo(
    () => (isAdmin(profile) ? [...TABS, { id: 'accounts', label: 'Accounts' }] : TABS),
    [profile],
  );

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

  /*
   * Signing in belongs to the portal at app.cyrix.in, which shares this
   * database — so a session made there is already a session here and there
   * is nothing left for a login form of our own to do. Sending people back
   * to it beats a second password for the same account.
   *
   * A location assignment, not a router push: the portal sits above this
   * app's /bemmp base and is a different application entirely.
   */
  if (isConfigured() && !session) return <ToPortal />;

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

  /*
   * Signed in with no contract at all. Only a genuinely empty scope reaches this
   * — the test used to be "nothing is loaded", which on the hosted build is the
   * normal state before anyone has uploaded, so an account with Kerala assigned
   * was told Kerala was not assigned to it and given a sign-out button as its
   * only way forward.
   */
  if (ready && profile && !scoped.length) {
    return (
      <div className="status-msg">
        <p>No BEMMP contract is assigned to <strong>{profile.code}</strong>.</p>
        <p>Ask your project head to add one, then sign in again.</p>
        <button type="button" className="sign-out" onClick={signOutToPortal} title="Sign out"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 17l5-5-5-5" /><path d="M20 12H9" /><path d="M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" /></svg><span>Sign out</span></button>
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
              {/* Plain anchor, not a router link: the portal sits above
                  this app's /bemmp base. */}
              <a className="brand-home" href="/" aria-label="All Cyrix apps" title="All Cyrix apps">
                <Logo height={36} />
              </a>
              <div className="brand-divider" aria-hidden="true" />
              <div className="brand-text">
                <h1>BEMMP Service Dashboard</h1>
                <Tagline />
              </div>
            </div>
            {/* This screen has no rail to put them in — there is no dataset
                yet, so there are no sections to navigate. The controls stay
                in the masthead here and move into the rail on the screen
                that has one. */}
            <div className="masthead-right">
              {profile && (
                <span className="who" title={`Signed in as ${profile.code}`}>
                  <span className="who-name">{firstName(profile)}</span>
                  <Avatar name={profile.full_name} src={profile.avatar} />
                </span>
              )}
              <div className="toggle-group">
                <ThemeToggle />
              </div>
              {profile && (
                <button type="button" className="sign-out" onClick={signOutToPortal} title="Sign out"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 17l5-5-5-5" /><path d="M20 12H9" /><path d="M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" /></svg><span>Sign out</span></button>
              )}
            </div>
          </header>
          {/* Only this account's contracts: offering a Kerala coordinator the
              Andhra slot invites an upload that scope would then hide. */}
          <UploadPanel
            contracts={scoped}
            serverStates={states}
            shared={shared}
            onLoaded={onUploaded}
            onPublished={reloadShared}
            landing
          />
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
            <a className="brand-home" href="/" aria-label="All Cyrix apps" title="All Cyrix apps">
              <Logo height={36} />
            </a>
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
              {/* On a desktop, loading data, the theme and signing out live
                  in the rail. What stays here belongs to the figures on
                  screen — which contract, and how fresh — not the session. */}
            </div>
            {/* Who is signed in, shown the way every module shows it. The
                code stays in the tooltip: it is what the account is called
                in the database and on the seed sheet, so it has to be
                recoverable — just not the thing read back at somebody on
                every screen. */}
            {profile && (
              <span className="who" title={`Signed in as ${profile.code}`}>
                <span className="who-name">{firstName(profile)}</span>
                <Avatar name={profile.full_name} src={profile.avatar} />
              </span>
            )}
            {/* On a phone the rail is a strip along the bottom carrying the
                sections, so the account controls come back up here — which
                is where Spare keeps them at this width too. Icons only:
                their labels are hidden below 860px, and four labelled pills
                would be wider than the phone. */}
            {narrow && (
              <>
                <ThemeToggle />
                <button
                  type="button"
                  className="icon-toggle"
                  onClick={() => setShowUpload(true)}
                  title="Load a TM export from this device"
                  aria-label="Load a TM export from this device"
                >
                  <DataIcon />
                </button>
                {profile && (
                  <button
                    type="button"
                    className="icon-toggle"
                    onClick={signOutToPortal}
                    title={`Signed in as ${profile.code} — sign out`}
                    aria-label="Sign out"
                  >
                    <SignOutIcon />
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        <div className="shell">
        <SideNav
          tabs={visibleTabs}
          active={tab}
          onSelect={setTab}
          onUpload={() => setShowUpload(true)}
          onSignOut={signOutToPortal}
          signedIn={Boolean(profile)}
          showAccountControls={!narrow}
        />
        <div className="work">

        {showUpload && (
          <UploadPanel
            contracts={scoped}
            serverStates={states}
            shared={shared}
            onLoaded={onUploaded}
            onPublished={reloadShared}
            onClose={() => setShowUpload(false)}
          />
        )}

        <Filters
          ds={ds}
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
              onOpenPenalty={() => { setMoneyId('calls'); setTab('money'); }}
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
              {/* Only Kerala's export carries a zone, so this panel is present or
                  absent by contract rather than showing a single empty bar. */}
              {breakdowns.zone.length > 0 && (
                <div className="panel" style={{ '--i': 1 }}>
                  <h2>Zones</h2>
                  <p className="caption">Calls by zone · each zone drills to its districts</p>
                  <BarList
                    items={breakdowns.zone} total={summary.total} color="var(--series-4)"
                  />
                </div>
              )}
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
              /*
               * The whole open backlog, not the selected month.
               *
               * `undatedIdx` rather than `idx`: a call logged in October with no
               * resolved date is still open in July and still on the meeting's
               * agenda, but a logged-date window drops it — and the ones it drops
               * are the oldest, which is to say the most overdue and the most
               * expensive. On the Kerala export the month view showed 724 of 807.
               * The dimension filters still apply; only the date window is lifted,
               * exactly as it is for penalty accrual.
               *
               * Open only, not everything without a resolved date: parked calls
               * carry a Ticket Remark putting them outside service scope, they
               * accrue no penalty at all, and there are ten of them for every open
               * one — enough to bury the agenda in rows that cost nothing.
               */
              <MeetingTab
                key={`tracker-${stateId}`}
                ds={ds}
                rows={rowsInBucket(ds, undatedIdx, BUCKET.OPEN)}
                unresolvedRows={unresolvedRows}
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
              rows={perfId === 'ftfr' ? ftfrRows : resolved}
              referenceDay={referenceDay}
              onSelectRow={setDrawerRow}
              measure={perfMeasure}
              /* Only for resolution. Over the FTFR row set most rows are still
                 open, so a "days to fix" column would be mostly blank and the
                 slowest-first sort would rank on a number half of them lack. */
              showResolutionColumn={perfId === 'resolution'}
              intro={(n) => (perfId === 'ftfr'
                ? `${perfMeasure.caption}. Measured over the ${n.toLocaleString()} calls `
                  + `logged in range whose window has closed — a call still open is a call `
                  + `that was not fixed in time, so it counts against the rate rather than `
                  + `being left out. Groups with fewer than ${perfMeasure.minSamples} logged `
                  + `calls are left out of the ranking.`
                : `${perfMeasure.caption}. Measured over the ${n.toLocaleString()} resolved `
                  + `calls in range — an open call has no resolution time. Groups with fewer `
                  + `than ${perfMeasure.minSamples} resolved calls are left out of the ranking.`
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
            {money.money === false ? (
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
            ) : !meta.penaltyRates ? (
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

        {tab === 'accounts' && isAdmin(profile) && <AdminTab
                profile={profile}
                areaOptions={{
                  zones: ds?.dict.zone ?? [],
                  districts: [...(ds?.dict.district ?? [])].sort((x, y) => x.localeCompare(y)),
                }}
              />}
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
        aria-label="Ask Cyra"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.8-5a8.3 8.3 0 0 1-.8-3.6 8.4 8.4 0 0 1 8.5-8.4 8.4 8.4 0 0 1 8.5 8.4Z" />
        </svg>
        <span>Ask Cyra</span>
      </button>

      {showAssistant && (
        <AssistantPanel
          ds={ds}
          referenceDay={referenceDay}
          profile={profile}
          onClose={() => setShowAssistant(false)}
        />
      )}
    </>
  );
}
