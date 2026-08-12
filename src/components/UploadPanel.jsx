import { useCallback, useEffect, useRef, useState } from 'react';
import { STATES, detectState } from '../../shared/schema.mjs';
import { deleteUpload, listUploads, putUpload } from '../data/uploads.js';
import { publishDataset } from '../data/datasets.js';
import { isConfigured } from '../data/supabase.js';

/** Runs one workbook through the parser worker, reporting progress. */
function parseInWorker(file, stateId, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/parse.worker.js', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') { onProgress(msg); return; }
      worker.terminate();
      if (msg.type === 'done') resolve({ buffer: msg.buffer, meta: msg.meta });
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ file, stateId });
  });
}

function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/**
 * Lets the user supply the TM export themselves.
 *
 * The workbook is parsed in this browser and cached in IndexedDB — the file is
 * never uploaded anywhere, which is what makes a static deployment safe.
 */
export default function UploadPanel({
  serverStates, onLoaded, onClose, onPublished, landing = false, contracts = STATES,
}) {
  const [stored, setStored] = useState({});
  const [busy, setBusy] = useState(null); // { stateId, phase, pct, detail }
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const pendingState = useRef(null);

  const reload = useCallback(() => { listUploads().then(setStored); }, []);
  useEffect(() => { reload(); }, [reload]);

  const handleFile = useCallback(async (file, forcedStateId) => {
    setError(null);
    const state = forcedStateId
      ? STATES.find((s) => s.id === forcedStateId)
      : detectState(file.name);

    if (!state) {
      setError(
        `Could not tell which contract "${file.name}" is for. `
        + 'Use the Upload button on the contract you want.',
      );
      return;
    }
    if (!/\.xlsx$/i.test(file.name)) {
      setError('That is not an .xlsx file. Export the TM report as Excel and try again.');
      return;
    }

    setBusy({ stateId: state.id, phase: 'Starting', pct: 0 });
    try {
      const { buffer, meta } = await parseInWorker(file, state.id, (p) => {
        setBusy({ stateId: state.id, ...p });
      });
      // Copy before storing: the same buffer is handed to the dashboard, and
      // IndexedDB would otherwise keep a reference to memory we hand away.
      await putUpload(state.id, { buffer: buffer.slice(0), meta, filename: file.name });
      reload();
      onLoaded(state.id, meta, buffer);

      /*
       * Publish after handing the dashboard its data, not before. Uploading 27 MB
       * takes a while and there is no reason to make this person watch it — their
       * figures are already on screen. A failure here is reported but does not
       * undo the local load, because a dataset only they can see still beats none.
       */
      if (isConfigured()) {
        setBusy({ stateId: state.id, phase: 'Sharing with the team', pct: 100 });
        try {
          await publishDataset(state.id, { meta, buffer, filename: file.name });
          onPublished?.();
        } catch (e) {
          setError(`Loaded here, but could not share it: ${e.message}`);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }, [onLoaded, reload]);

  const pick = (stateId) => {
    pendingState.current = stateId;
    inputRef.current.value = '';
    inputRef.current.click();
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file, null);
  };

  return (
    <div className={landing ? 'upload-landing' : 'upload-sheet'}>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file, pendingState.current);
        }}
      />

      <div className="panel" style={{ '--i': 0 }}>
        <div className="panel-head">
          <div>
            <h2>{landing ? 'Load a BEMMP ticket export' : 'Data sources'}</h2>
            <p className="caption">
              Files are read in this browser and stored on this device only — nothing is
              uploaded to a server.
            </p>
          </div>
          {!landing && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>

        <div
          className={`dropzone${dragOver ? ' is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
               strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <p>
            Drop <strong>TM-KL.xlsx</strong> or <strong>TM-AP.xlsx</strong> here, or use a
            contract below. The contract is taken from the filename.
          </p>
        </div>

        {error && <p className="upload-error">{error}</p>}

        <div className="upload-list">
          {contracts.map((s) => {
            const up = stored[s.id];
            const server = serverStates?.find((x) => x.id === s.id);
            const running = busy?.stateId === s.id;

            return (
              <div className="upload-row" key={s.id}>
                <span className="state-code">{s.short}</span>
                <div className="upload-meta">
                  <div className="upload-name">{s.name}</div>
                  {running ? (
                    <div className="upload-progress">
                      <div className="upload-bar">
                        <div className="upload-bar-fill" style={{ width: `${busy.pct}%` }} />
                      </div>
                      <span>{busy.phase}{busy.detail ? ` · ${busy.detail}` : ''}</span>
                    </div>
                  ) : (
                    <div className="upload-sub">
                      {up
                        ? `${up.rows.toLocaleString()} tickets · ${up.filename} · ${ago(up.uploadedAt)}`
                        : (server
                          ? `${server.rows.toLocaleString()} tickets · built on the server`
                          : `Expects ${s.file}`)}
                    </div>
                  )}
                </div>
                <div className="upload-actions">
                  {up && !running && (
                    <button
                      type="button"
                      className="upload-clear"
                      onClick={async () => { await deleteUpload(s.id); reload(); }}
                    >
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    className="upload-btn"
                    disabled={!!busy}
                    onClick={() => pick(s.id)}
                  >
                    {up ? 'Replace' : 'Upload'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="caption upload-foot">
          A Kerala export is about 46 MB and takes roughly 5–15 seconds to read. Keep the
          tab open while it runs.
        </p>
      </div>
    </div>
  );
}
