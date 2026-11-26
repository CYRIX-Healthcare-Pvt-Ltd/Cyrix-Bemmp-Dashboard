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

  return (
    <div className="panel contract-panel" style={{ '--i': 0 }}>
      <h2>By contract type</h2>
      <div className="summary-scroll">
        <table className="summary-grid contract-grid">
          <thead>
            <tr>
              <th>Contract</th>
              <th className="num">Calls</th>
              <th className="num">Open</th>
              <th className="num">Not started</th>
              <th className="num">FTFR</th>
              <th className="num">Response TAT</th>
              <th className="num">Resolution TAT</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr key={r.name} className={r.name === 'AMC' || r.name === 'CAMC' ? 'is-key' : ''}>
                <td><strong>{r.name}</strong></td>
                <td className="num contract-calls">
                  <span className="contract-bar" style={{ width: `${(r.calls / most) * 100}%` }} aria-hidden="true" />
                  <span className="contract-n">{r.calls.toLocaleString()}</span>
                  <span className="contract-share">{total ? `${Math.round((r.calls / total) * 100)}%` : ''}</span>
                </td>
                <td className="num">{r.open.toLocaleString()}</td>
                <td className="num">{r.notStarted.toLocaleString()}</td>
                <td className="num">
                  {p1(r.ftfr.pct)}
                  {r.ftfr.calls > 0 && <span className="contract-of">{r.ftfr.fixed.toLocaleString()}/{r.ftfr.calls.toLocaleString()}</span>}
                </td>
                <td className="num">{d2(r.response)}</td>
                <td className="num">{d2(r.resolution)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
