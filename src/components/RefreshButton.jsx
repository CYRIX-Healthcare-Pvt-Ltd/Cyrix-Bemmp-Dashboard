import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRefreshStatus, triggerRefresh } from '../data/store.js';

const POLL_MS = 1200;

function ago(ms) {
  if (!ms) return 'never';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/**
 * Re-reads the source workbooks on demand.
 *
 * The build runs on the server that hosts the app, so this renders nothing when
 * the dashboard is served from a static host where no such endpoint exists.
 */
export default function RefreshButton({ onRefreshed }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    const next = await fetchRefreshStatus();
    setInfo(next);
    return next;
  }, []);

  useEffect(() => { poll(); }, [poll]);

  // Poll only while a build is in flight; otherwise this sits idle.
  useEffect(() => {
    if (info?.status !== 'running') return undefined;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [info?.status, poll]);

  useEffect(() => {
    if (info?.status === 'running') { wasRunning.current = true; return; }
    if (wasRunning.current && info?.status === 'done') {
      wasRunning.current = false;
      setOpen(true);
      onRefreshed();
    }
    if (wasRunning.current && info?.status === 'error') wasRunning.current = false;
  }, [info?.status, onRefreshed]);

  if (!info?.refreshAvailable) return null;

  const running = info.status === 'running';
  const stale = info.states?.some((s) => s.stale);
  const missing = info.states?.some((s) => s.missing);

  const start = async () => {
    setOpen(true);
    try {
      await triggerRefresh();
    } finally {
      const next = await poll();
      if (next.status === 'running') wasRunning.current = true;
    }
  };

  // Last build time, so the button can answer "is this current?" on hover without
  // needing a second control to open.
  const builtAt = info.states?.reduce(
    (min, s) => (s.builtAt && (!min || s.builtAt < min) ? s.builtAt : min),
    null,
  );
  const hint = running
    ? 'Rebuilding from BEMMP DATA/'
    : `${stale ? 'A newer export is on disk. ' : ''}Last built ${ago(builtAt)}. Click to re-read the source workbooks.`;

  return (
    <div className="refresh">
      <button
        type="button"
        className={`refresh-btn${running ? ' is-running' : ''}${stale ? ' is-stale' : ''}`}
        onClick={running ? () => setOpen((v) => !v) : start}
        aria-busy={running}
        title={hint}
      >
        <svg
          className={`refresh-icon${running ? ' spin' : ''}`} viewBox="0 0 24 24"
          width="16" height="16" fill="none" stroke="currentColor"
          strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
          <path d="M20.5 4.2v4.6h-4.6" />
        </svg>
        <span className="refresh-label">{running ? 'Refreshing…' : 'Refresh'}</span>
        {stale && !running && <span className="refresh-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className="refresh-pop">
          <div className="refresh-pop-head">
            <strong>Source data</strong>
            <button type="button" className="refresh-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>

          <table className="refresh-table">
            <thead>
              <tr><th>State</th><th>Export saved</th><th>Dashboard built</th></tr>
            </thead>
            <tbody>
              {info.states.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.short}</strong>
                    {s.stale && <span className="tag tag-stale">new data</span>}
                    {s.missing && <span className="tag tag-missing">file missing</span>}
                  </td>
                  <td>{s.missing ? '—' : ago(s.sourceAt)}</td>
                  <td>{ago(s.builtAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {missing && (
            <p className="refresh-note warn">
              A source workbook is missing from <code>BEMMP DATA/</code>. Check the SharePoint sync.
            </p>
          )}
          {!missing && !stale && info.status !== 'running' && (
            <p className="refresh-note">The dashboard is up to date with the files on disk.</p>
          )}
          {stale && info.status !== 'running' && (
            <p className="refresh-note">
              The export is newer than the dashboard. Refresh to pick it up.
            </p>
          )}

          {info.status === 'error' && (
            <p className="refresh-note warn">Refresh failed: {info.error}</p>
          )}

          {(running || info.log?.length > 0) && (
            <pre className="refresh-log">{info.log.join('\n')}</pre>
          )}

          {!running && (
            <button type="button" className="refresh-run" onClick={start}>
              Refresh again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
