import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadDataset, loadStates, datasetFrom, formatDay, monthStart, BUCKET, BUCKET_LABEL,
} from './data/store.js';
import { listUploads, getUpload } from './data/uploads.js';
import { STATES } from '../shared/schema.mjs';
import UploadPanel from './components/UploadPanel.jsx';
import {
  filterRows, summarize, analyzeRepeats, countBy, topN, buildSeries,
  defaultGranularity, rowsInBucket, penaltyRows,
} from './data/query.js';
import Backdrop from './components/Backdrop.jsx';
import Logo, { Tagline } from './components/Logo.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import MotionToggle from './components/MotionToggle.jsx';
import StateSwitcher from './components/StateSwitcher.jsx';
import RefreshButton from './components/RefreshButton.jsx';
import Filters from './components/Filters.jsx';
import KpiTiles from './components/KpiTiles.jsx';
import MetricChart from './components/MetricChart.jsx';
import BarList from './components/BarList.jsx';
import DrillExplorer from './components/DrillExplorer.jsx';
import TicketDrawer from './components/TicketDrawer.jsx';

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
    caption: 'Share of each period\'s resolved calls fixed within 1 day of logging',
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
  },
];

const GRANULARITIES = [
  { id: 'month', label: 'Monthly' },
  { id: 'week', label: 'Weekly' },
  { id: 'day', label: 'Daily' },
];

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'calls', label: 'Open calls' },
  { id: 'penalty', label: 'Penalty calls' },
  { id: 'repeats', label: 'Repeat calls' },
];

const STATE_KEY = 'bemmp-state';

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
  const [tab, setTab] = useState('overview');
  const [callBucket, setCallBucket] = useState(BUCKET.OPEN);
  const [drawerRow, setDrawerRow] = useState(null);
  const [metricId, setMetricId] = useState('volume');
  const [granularity, setGranularity] = useState(null); // null = follow the range
  // Bumped after a refresh; busts the HTTP cache and re-runs the loader below.
  const [dataVersion, setDataVersion] = useState('');
  const [uploads, setUploads] = useState(null); // stateId -> summary
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    // A static deployment ships no artifacts at all, so a missing states.json is a
    // normal state, not an error — the user supplies the workbooks instead.
    loadStates(dataVersion).then(setStates).catch(() => setStates([]));
  }, [dataVersion]);

  useEffect(() => { listUploads().then(setUploads); }, []);

  // Depend on readiness rather than the array identity: a refresh refetches
  // states.json, and keying off the new array would load the dataset a second time.
  const ready = states !== null && uploads !== null;

  /** Contracts that actually have data behind them, uploads taking precedence. */
  const available = useMemo(() => {
    if (!ready) return [];
    const byId = new Map();
    for (const s of states) byId.set(s.id, { ...s, source: 'server' });
    for (const [id, up] of Object.entries(uploads)) {
      const known = STATES.find((s) => s.id === id);
      byId.set(id, {
        id, short: up.short ?? known?.short, name: up.name ?? known?.name,
        rows: up.rows, source: 'upload',
      });
    }
    return STATES.map((s) => byId.get(s.id)).filter(Boolean);
  }, [ready, states, uploads]);

  // Dictionaries are per state, so the dataset and every filter reload together.
  useEffect(() => {
    if (!ready || !available.length) return undefined;
    const target = available.some((s) => s.id === stateId) ? stateId : available[0].id;
    if (target !== stateId) { setStateId(target); return undefined; }

    let cancelled = false;
    setBusy(true);
    setDrawerRow(null);

    const load = uploads[target]
      ? getUpload(target).then((u) => datasetFrom(u.meta, u.buffer, 'upload'))
      : loadDataset(target, dataVersion);

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
  }, [ready, available, stateId, dataVersion, uploads]);

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

  const bucketRows = useMemo(
    () => (idx ? rowsInBucket(ds, idx, callBucket) : []),
    [ds, idx, callBucket],
  );
  const penalties = useMemo(
    () => (idx ? penaltyRows(ds, idx, referenceDay) : []),
    [ds, idx, referenceDay],
  );

  const breakdowns = useMemo(() => {
    if (!idx) return null;
    const { dict } = ds;
    return {
      district: topN(countBy(ds, idx, 'district'), dict.district, 30),
      facility: topN(countBy(ds, idx, 'facilityName'), dict.facilityName, 10),
      equipment: topN(countBy(ds, idx, 'equipment'), dict.equipment, 10),
      manufacturer: topN(countBy(ds, idx, 'manufacturer'), dict.manufacturer, 10),
      facilityType: topN(countBy(ds, idx, 'facilityType'), dict.facilityType, 10),
      parkedReason: topN(countBy(ds, idx, 'parkedReason'), dict.parkedReason, 10)
        .filter((r) => r.id >= 0),
    };
  }, [ds, idx]);

  const openBucket = useCallback((bucket) => {
    setCallBucket(bucket);
    setTab('calls');
  }, []);

  if (error) {
    return (
      <>
        <Backdrop />
        <div className="status-msg">
          <p>{error}</p>
          <p>Run <code>npm run build:data</code>, then reload.</p>
        </div>
      </>
    );
  }

  // Nothing built and nothing uploaded — the static-hosting case. Ask for a file
  // rather than showing an empty dashboard.
  if (ready && !available.length) {
    return (
      <>
        <Backdrop />
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
                <MotionToggle />
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
        <Backdrop />
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
      <Backdrop />
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
              <MotionToggle />
              <ThemeToggle />
            </div>
          </div>
        </header>

        {showUpload && (
          <UploadPanel
            serverStates={states}
            onLoaded={onUploaded}
            onClose={() => setShowUpload(false)}
          />
        )}

        <Filters
          dict={dict}
          dateRange={meta.dateRange}
          filters={filters}
          setFilters={setFilters}
        />

        <KpiTiles
          summary={summary}
          repeats={repeats}
          penaltyDays={meta.penaltyDays}
          onOpenBucket={openBucket}
          onOpenPenalty={() => setTab('penalty')}
          onOpenRepeats={() => setTab('repeats')}
        />

        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id} type="button" role="tab" className="tab"
              aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="grid" style={{ gap: 16 }}>
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
                {metric.caption} · {series.length.toLocaleString()}{' '}
                {activeGranularity === 'month' ? 'months' : (activeGranularity === 'week' ? 'weeks' : 'days')}
                {granularity === null && ' · granularity follows the date range'}
              </p>
              <MetricChart series={series} metric={metric} />
            </div>

            <div className="grid grid-2">
              <div className="panel" style={{ '--i': 1 }}>
                <h2>Districts</h2>
                <p className="caption">Calls by district</p>
                <BarList items={breakdowns.district} total={summary.total} />
              </div>
              <div className="panel" style={{ '--i': 2 }}>
                <h2>Facilities</h2>
                <p className="caption">Calls by facility · top 10</p>
                <BarList items={breakdowns.facility} total={summary.total} />
              </div>
              <div className="panel" style={{ '--i': 3 }}>
                <h2>Equipment</h2>
                <p className="caption">Calls by asset description · top 10</p>
                <BarList items={breakdowns.equipment} total={summary.total} color="var(--series-2)" />
              </div>
              <div className="panel" style={{ '--i': 4 }}>
                <h2>Manufacturers</h2>
                <p className="caption">Calls by manufacturer · top 10</p>
                <BarList items={breakdowns.manufacturer} total={summary.total} color="var(--series-3)" />
              </div>
              <div className="panel" style={{ '--i': 5 }}>
                <h2>Facility types</h2>
                <p className="caption">Share of total calls</p>
                <BarList items={breakdowns.facilityType} total={summary.total} color="var(--series-2)" />
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
                  emptyText="No unresolved calls in range"
                />
              </div>
            </div>
          </div>
        )}

        {tab === 'calls' && (
          <>
            <div className="segmented-row">
              <div className="segmented" role="tablist" aria-label="Backlog type">
                {[BUCKET.OPEN, BUCKET.PARKED].map((b) => (
                  <button
                    key={b} type="button" role="tab"
                    aria-selected={callBucket === b}
                    onClick={() => setCallBucket(b)}
                  >
                    {BUCKET_LABEL[b]}
                  </button>
                ))}
              </div>
            </div>
            <DrillExplorer
              key={`calls-${stateId}-${callBucket}`}
              ds={ds}
              rows={bucketRows}
              referenceDay={referenceDay}
              onSelectRow={setDrawerRow}
              showAgeing
              intro={(n) => (callBucket === BUCKET.OPEN
                ? `${n.toLocaleString()} open calls — Resolved Date blank and no Ticket Remark. This is the live, actionable backlog.`
                : `${n.toLocaleString()} unresolved calls — no Resolved Date, but out of service scope, with the reason held in Ticket Remark.`)}
            />
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

      <TicketDrawer
        ds={ds}
        row={drawerRow}
        latestDay={referenceDay}
        onClose={() => setDrawerRow(null)}
      />
    </>
  );
}
