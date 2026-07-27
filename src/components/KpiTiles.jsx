import useCountUp from '../hooks/useCountUp.js';
import { FTFR_MAX_DAYS } from '../data/query.js';

function Tile({ label, dot, value, format, note, onClick, accent, children, index }) {
  const animated = useCountUp(value);
  const Root = onClick ? 'button' : 'div';

  return (
    <Root
      className={`kpi${onClick ? ' clickable' : ''}${accent ? ` accent-${accent}` : ''}`}
      style={{ '--i': index }}
      {...(onClick ? { type: 'button', onClick } : {})}
    >
      <div className="k-label">
        {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
        {label}
      </div>
      <div className="k-main">
        <div className="k-value">{format(animated)}</div>
        {children}
      </div>
      {note && <div className="k-note">{note}</div>}
      {onClick && (
        <span className="k-cta" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      )}
    </Root>
  );
}

const R = 17;
const C = 2 * Math.PI * R;

/** Small progress ring beside the FTFR figure. */
function Ring({ pct }) {
  return (
    <svg className="ring" viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
      <circle className="ring-track" cx="22" cy="22" r={R} />
      <circle
        className="ring-value" cx="22" cy="22" r={R}
        strokeDasharray={C}
        strokeDashoffset={C * (1 - Math.max(0, Math.min(100, pct)) / 100)}
      />
    </svg>
  );
}

const int = (n) => Math.round(n).toLocaleString();
const pct1 = (n) => `${n.toFixed(1)}%`;
const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** "2 / 7 days" for Andhra, "7 days" for Kerala. */
function slaNote(penaltyDays) {
  const values = [...new Set(Object.values(penaltyDays || {}))];
  if (values.length === 1) return `Open beyond ${values[0]} days`;
  const crit = penaltyDays.CRITICAL;
  const non = penaltyDays['NON CRITICAL'];
  return `Open beyond ${crit}d critical / ${non}d non-critical`;
}

/**
 * Ten tiles, in the order a service review reads them: volume, then how it split,
 * then what it cost, then how well it was served.
 *
 * The two money tiles are blank for a state with no rate card rather than showing
 * a confident ₹0 — Andhra supplies its own penalty figures instead of a card.
 */
export default function KpiTiles({
  summary, repeats, penaltyDays, money,
  onOpenBucket, onOpenPenalty, onOpenRepeats, onOpenPerformance, onOpenMoney,
}) {
  const share = (n) => (summary.total ? `${((n / summary.total) * 100).toFixed(1)}% of calls` : '—');
  const hasRateCard = money.hasRateCard;
  const rupees = (v) => (hasRateCard ? inr(v) : '—');

  return (
    <div className="kpis">
      <Tile
        index={0} label="Total calls" value={summary.total} format={int}
        note="Tickets logged in range"
      />
      <Tile
        index={1} label="Resolved" dot="resolved" value={summary.resolved} format={int}
        note={share(summary.resolved)}
      />
      <Tile
        index={2} label="Open calls" dot="open" accent="critical"
        value={summary.open} format={int}
        note="Unresolved, no remark · drill in"
        onClick={() => onOpenBucket(0)}
      />
      <Tile
        index={3} label="Unresolved calls" dot="parked" accent="warning"
        value={summary.parked} format={int}
        note="Out of service scope · drill in"
        onClick={() => onOpenBucket(1)}
      />
      <Tile
        index={4} label="Repeat calls" value={repeats.followUps} format={int}
        note={`2nd+ call on ${repeats.repeatAssets.toLocaleString()} assets · drill in`}
        onClick={onOpenRepeats}
      />
      <Tile
        index={5} label="Penalty calls" accent="critical"
        value={summary.penalty} format={int}
        note={`${slaNote(penaltyDays)} · drill in`}
        onClick={onOpenPenalty}
      />
      <Tile
        index={6} label="Per-day penalty" accent="critical"
        value={hasRateCard ? money.perDay : 0}
        format={(v) => (hasRateCard ? `${rupees(v)}/d` : '—')}
        note={hasRateCard
          ? `Accruing on ${money.accruingCount.toLocaleString()} open tickets · drill in`
          : 'No rate card for this state'}
        onClick={hasRateCard ? () => onOpenMoney('perday') : undefined}
      />
      <Tile
        index={7} label="Closure penalty" accent="warning"
        value={hasRateCard ? money.closure : 0}
        format={rupees}
        note={hasRateCard
          ? `Settled on ${money.closedCount.toLocaleString()} tickets closed in range · drill in`
          : 'No rate card for this state'}
        onClick={hasRateCard ? () => onOpenMoney('closure') : undefined}
      />
      <Tile
        index={8} label="FTFR" accent="good" value={summary.ftfrPct} format={pct1}
        note={`${summary.firstTimeFixes.toLocaleString()} fixed within ${FTFR_MAX_DAYS} day · drill in`}
        onClick={() => onOpenPerformance('ftfr')}
      >
        <Ring pct={summary.ftfrPct} />
      </Tile>
      <Tile
        index={9} label="Avg resolution" value={summary.avgResolutionDays}
        format={(n) => `${n.toFixed(1)} d`}
        note="Logged to resolved · drill in"
        onClick={() => onOpenPerformance('resolution')}
      />
    </div>
  );
}
