/*
 * Care 360 dashboard: the picture by contract type (the user, 26 Nov: "amc camc we need a clear picture"). Contract
 * type comes from the asset master by barcode; until one is uploaded the panel offers the upload instead.
 */
const d2 = (n) => (n == null ? '–' : `${n.toFixed(2)} d`);
const p1 = (n) => (n == null ? '–' : `${n.toFixed(1)}%`);

export default function ContractPanel({ table, hasAssets, onUpload }) {
  if (!hasAssets) {
    return (
      <div className="panel contract-panel contract-empty" style={{ '--i': 0 }}>
        <h2>By contract type</h2>
        <button type="button" className="upload-btn" onClick={onUpload}>Upload asset master</button>
      </div>
    );
  }
  if (!table) return null;
  const most = Math.max(1, ...table.map((r) => r.calls));
  const total = table.reduce((s, r) => s + r.calls, 0);

  // One colour per contract, the same wherever it is drawn; AMC and CAMC lead (the user, 28 Nov: "more beautiful").
  const TONE = { AMC: 'var(--series-1)', CAMC: 'var(--series-2)', Warranty: 'var(--series-3)', 'In House': 'var(--series-5)' };
  const ftfrTone = (pct) => (pct == null ? 'var(--text-muted)' : pct >= 70 ? 'var(--status-good)' : pct >= 50 ? 'var(--status-warning)' : 'var(--status-critical)');

  return (
    <div className="panel contract-panel" style={{ '--i': 0 }}>
      <h2>By contract type</h2>
      <div className="contract-cards">
        {table.map((r, k) => {
          const share = total ? Math.round((r.calls / total) * 100) : 0;
          const key = r.name === 'AMC' || r.name === 'CAMC';
          // No empty places in the last row (the user, 28 Nov): three small cards a row, the last one or two widened.
          const small = table.filter((x) => x.name !== 'AMC' && x.name !== 'CAMC');
          const at = small.indexOf(r);
          const left = small.length % 3;
          // One left over from four or more: the last four go two and two rather than three and one.
          const halves = left === 1 && small.length >= 4 ? 4 : left === 2 ? 2 : 0;
          const fill = key || at < 0 ? '' : at >= small.length - halves ? ' fill-half' : left === 1 && at === small.length - 1 ? ' fill-full' : '';
          // Two a row on a tablet: an odd last card takes the row.
          const odd = table.length % 2 === 1 && k === table.length - 1 ? ' fill-pair' : '';
          return (
            <section key={r.name} className={`contract-card${key ? ' is-key' : ''}${fill}${odd}`} style={{ '--tone': TONE[r.name] ?? 'var(--text-secondary)' }}>
              <header className="contract-card-head">
                <span className="contract-name"><span className="contract-dot" aria-hidden="true" />{r.name}</span>
                <span className="contract-pill">{share}%</span>
              </header>
              <div className="contract-big">
                <strong>{r.calls.toLocaleString()}</strong>
                <span>calls</span>
              </div>
              <div className="contract-track" aria-hidden="true">
                <span style={{ width: `${(r.calls / most) * 100}%` }} />
              </div>
              <dl className="contract-stats">
                <div>
                  <dt>FTFR</dt>
                  <dd style={{ color: ftfrTone(r.ftfr.pct) }}>{p1(r.ftfr.pct)}</dd>
                  {r.ftfr.calls > 0 && <dd className="contract-of">{r.ftfr.fixed.toLocaleString()} of {r.ftfr.calls.toLocaleString()}</dd>}
                </div>
                <div>
                  <dt>Open</dt>
                  <dd>{r.open.toLocaleString()}</dd>
                  <dd className="contract-of">{r.notStarted.toLocaleString()} not started</dd>
                </div>
                <div>
                  <dt>Response TAT</dt>
                  <dd>{d2(r.response)}</dd>
                </div>
                <div>
                  <dt>Resolution TAT</dt>
                  <dd>{d2(r.resolution)}</dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}
