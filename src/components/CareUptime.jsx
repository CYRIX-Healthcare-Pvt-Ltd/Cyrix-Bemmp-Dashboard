import { useMemo, useState } from 'react';
import { formatDay } from '../data/store.js';
import { UNKNOWN, uptimeBy } from '../data/careUptime.js';

const p1 = (n) => (n == null ? '–' : `${(n * 100).toFixed(1)}%`);
const num = (n) => n.toLocaleString();
// Each sub-tab drills to the barcodes (the user, 27 Nov: "remove uptime %, make others drill").
const SUBS = [['state', 'State wise'], ['customer', 'Customer wise'], ['contract', 'Contract wise']];
const LEVELS = { state: ['state', 'customer'], customer: ['sc'], contract: ['contract', 'state', 'customer'] };
const HEAD = { state: 'State', customer: 'Customer', sc: 'Customer', contract: 'Contract' };

/** Green at 95% and over, amber from 90%, red under (the bar beside each figure). */
const toneOf = (u) => (u == null ? '' : u >= 0.95 ? 'good' : u >= 0.9 ? 'warn' : 'bad');
function Up({ value, strong = false }) {
  return (
    <td className={`num${strong ? ' strong' : ''}`}>
      <span className={`uptime-fig tone-${toneOf(value)}`}>{p1(value)}</span>
    </td>
  );
}

/** Every heading sorts its column (the user, 27 Nov): a press sorts, a second turns it round. */
function useSort(key0, dir0) {
  const [sort, setSort] = useState({ key: key0, dir: dir0 });
  const by = (key, text) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: text ? 1 : -1 }));
  const apply = (rows, get = (r, k) => r[k]) => [...rows].sort((a, b) => {
    const x = get(a, sort.key); const y = get(b, sort.key);
    const c = typeof x === 'string' || typeof y === 'string'
      ? String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) : (x ?? -1) - (y ?? -1);
    return c * sort.dir;
  });
  function Th({ k, text = false, num = false, wide = false, children }) {
    const on = sort.key === k;
    return (
      <th className={`${num ? 'num' : ''}${wide ? ' uptime-wide' : ''}`} aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`uptime-sort${on ? ' is-on' : ''}`} onClick={() => by(k, text)}>
          {children}<span className="uptime-sort-mark" aria-hidden="true">{on ? (sort.dir > 0 ? '▲' : '▼') : '⇅'}</span>
        </button>
      </th>
    );
  }
  return { apply, Th };
}

/** One table of groups; a press on a row goes a level down when `onOpen` is given. */
/** A customer's contract types, small under its name (the user, 27 Nov): "AMC" or "AMC 12 · CAMC 3" when mixed. */
function contractsOf(items) {
  const n = new Map();
  for (const b of items) n.set(b.contract, (n.get(b.contract) ?? 0) + 1);
  // AMC and CAMC only (the user, 27 Nov); the name alone when every asset is that one.
  const all = [...n].filter(([c]) => c === 'AMC' || c === 'CAMC').sort((a, b) => b[1] - a[1]);
  if (all.length === 1 && all[0][1] === items.length) return all[0][0];
  return all.map(([c, k]) => `${c} ${k}`).join(' · ');
}

function GroupTable({ first, rows: given, total, onOpen, extra, small, customers = false }) {
  const { apply, Th } = useSort('uptime', 1);
  // "Not given" stays last whatever the sort: it is the assets the master names no state or customer for.
  const sorted = apply(given, (r, k) => (k === 'extra' ? extra.of(r) : r[k]));
  const rows = [...sorted.filter((r) => r.name !== UNKNOWN), ...sorted.filter((r) => r.name === UNKNOWN)];
  return (
    <div className="summary-scroll">
      <table className="summary-grid uptime-grid">
        <thead>
          <tr>
            <Th k="name" text>{first}</Th>
            {extra && <Th k="extra" text>{extra.label}</Th>}
            {customers && <Th k="customers" num>Customers</Th>}
            <Th k="assets" num>Assets</Th>
            <Th k="downAssets" num wide>Assets down</Th>
            <Th k="downDays" num>Down days</Th>
            <Th k="uptime" num>Uptime %</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.name + (extra ? extra.of(g) : '')} className={onOpen ? 'uptime-open' : ''} onClick={onOpen ? () => onOpen(g) : undefined}>
              <td>
                {onOpen ? <button type="button" className="uptime-link">{g.name}</button> : g.name}
                {small && small(g) && <span className="uptime-small">{small(g)}</span>}
              </td>
              {extra && <td>{extra.of(g)}</td>}
              {customers && <td className="num">{num(g.customers)}</td>}
              <td className="num">{num(g.assets)}</td>
              <td className="num uptime-wide">{num(g.downAssets)}</td>
              <td className="num">{num(g.downDays)}</td>
              <Up value={g.uptime} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="summary-total">
            <td className="strong">Total</td>
            {extra && <td />}
            {customers && <td className="num strong">{num(total.customers)}</td>}
            <td className="num strong">{num(total.assets)}</td>
            <td className="num strong uptime-wide">{num(total.downAssets)}</td>
            <td className="num strong">{num(total.downDays)}</td>
            <Up value={total.uptime} strong />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** A customer's barcodes, lowest uptime first. */
/** One barcode's calls in the range, with the days each kept it down. */
function TicketTable({ asset }) {
  const { apply, Th } = useSort('raised', -1);
  const rows = apply(asset.tickets);
  return (
    <div className="summary-scroll">
      <table className="summary-grid uptime-grid">
        <thead>
          <tr>
            <Th k="ticket" text>PMPT ID</Th>
            <Th k="raised" num>Raised</Th>
            <Th k="ended" num>Ended</Th>
            <Th k="status" text wide>Status</Th>
            <Th k="down" num>Down days</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.ticket + t.raised}>
              <td>{t.ticket}</td>
              <td className="num">{formatDay(t.raised)}</td>
              <td className="num">{t.ended == null ? 'Open' : formatDay(t.ended)}</td>
              <td className="uptime-wide">{t.status || '–'}</td>
              <td className="num">{num(t.down)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="summary-total">
            <td className="strong">{asset.equipment || asset.barcode}</td>
            <td /><td /><td className="uptime-wide" />
            <td className="num strong">{num(asset.down)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AssetTable({ items, total, onOpen }) {
  const { apply, Th } = useSort('uptime', 1);
  const rows = apply(items);
  return (
    <div className="summary-scroll">
      <table className="summary-grid uptime-grid">
        <thead>
          <tr>
            <Th k="barcode" text>Barcode</Th>
            <Th k="equipment" text>Equipment</Th>
            <Th k="contract" text wide>Contract</Th>
            <Th k="calls" num wide>Calls</Th>
            <Th k="down" num>Down days</Th>
            <Th k="uptime" num>Uptime %</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.barcode} className={b.calls ? 'uptime-open' : ''} onClick={b.calls ? () => onOpen(b) : undefined}>
              <td>{b.calls ? <button type="button" className="uptime-link">{b.barcode}</button> : b.barcode}</td>
              <td>{b.equipment || '–'}</td>
              <td className="uptime-wide">{b.contract}</td>
              <td className="num uptime-wide">{num(b.calls)}</td>
              <td className="num">{num(b.down)}</td>
              <Up value={b.uptime} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="summary-total">
            <td className="strong">Total</td>
            <td />
            <td className="uptime-wide" />
            <td className="num strong uptime-wide">{num(total.calls)}</td>
            <td className="num strong">{num(total.downDays)}</td>
            <Up value={total.uptime} strong />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Care 360's Uptime % tab (the user, 27 Nov): the dashboard's From – To, every asset master barcode. */
export default function CareUptime({ uptime }) {
  const [sub, setSubState] = useState(() => {
    try { const v = localStorage.getItem('bemmp-care-uptime-by'); return LEVELS[v] ? v : 'state'; } catch { return 'state'; }
  });
  const [path, setPath] = useState([]); // the names pressed so far, one per level
  const setSub = (v) => {
    setSubState(v);
    setPath([]);
    try { localStorage.setItem('bemmp-care-uptime-by', v); } catch { /* site data blocked */ }
  };

  // A customer is named within its state: the same hospital name can sit in two.
  const list = useMemo(() => (uptime?.list ?? []).map((b) => ({ ...b, sc: `${b.customer}\u0000${b.state}` })), [uptime]);
  if (!uptime) return <div className="panel"><p className="empty">Upload the asset master to see Uptime %.</p></div>;

  // Walk the path; a name no longer there (the filters changed) stops the walk where it is.
  const levels = LEVELS[sub];
  let items = list; let total = uptime; const crumbs = [];
  for (let n = 0; n < path.length && n < levels.length; n++) {
    const g = uptimeBy(items, levels[n]).find((x) => x.name === path[n]);
    if (!g) break;
    items = g.items; total = g;
    crumbs.push(levels[n] === 'sc' ? path[n].split('\u0000')[0] : path[n]);
  }
  const depth = crumbs.length;
  let table;
  // Past the last level, a barcode; past that, its calls.
  const asset = depth >= levels.length && path.length > levels.length ? items.find((b) => b.barcode === path[levels.length]) : null;
  if (asset) crumbs.push(asset.barcode);
  if (asset) table = <TicketTable asset={asset} />;
  else if (depth >= levels.length) table = <AssetTable items={items} total={total} onOpen={(b) => setPath([...path.slice(0, levels.length), b.barcode])} />;
  else {
    const key = levels[depth];
    const rows = uptimeBy(items, key).map((g) => (key === 'sc'
      ? { ...g, key: g.name, name: g.name.split('\u0000')[0], state: g.name.split('\u0000')[1] }
      : { ...g, key: g.name }));
    table = (
      <GroupTable
        first={HEAD[key]} rows={rows} total={total}
        onOpen={(g) => setPath([...crumbs.slice(0, depth).map((_, n) => path[n]), g.key])}
        extra={key === 'sc' ? { label: 'State', of: (g) => g.state } : null}
        small={key === 'sc' || key === 'customer' ? (g) => contractsOf(g.items) : null}
        customers={key === 'state' || key === 'contract'}
      />
    );
  }

  return (
    <div className="panel care-report care-uptime">
      <div className="care-report-controls">
        <div className="segmented" role="tablist" aria-label="Uptime by">
          {SUBS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={sub === id} onClick={() => setSub(id)}>{label}</button>
          ))}
        </div>
        <div className="uptime-head">
          <span>{formatDay(uptime.from)} – {formatDay(uptime.to)} · {num(uptime.days)} days</span>
          <span>{num(uptime.assets)} assets · {num(uptime.downAssets)} down</span>
          <span className={`uptime-fig big tone-${toneOf(uptime.uptime)}`}>{p1(uptime.uptime)}</span>
        </div>
      </div>
      {depth > 0 && (
        <nav className="uptime-crumbs" aria-label="Drill">
          <button type="button" onClick={() => setPath([])}>All</button>
          {crumbs.map((c, n) => (
            <span key={n} className="uptime-crumb">
              <span aria-hidden="true">›</span>
              {n < crumbs.length - 1 ? <button type="button" onClick={() => setPath(path.slice(0, n + 1))}>{c}</button> : <strong>{c}</strong>}
            </span>
          ))}
        </nav>
      )}
      {table}
    </div>
  );
}
