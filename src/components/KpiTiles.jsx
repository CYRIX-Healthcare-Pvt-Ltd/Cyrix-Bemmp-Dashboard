import useCountUp from '../hooks/useCountUp.js';
import { FTFR_MAX_DAYS } from '../data/query.js';

/**
 * One glyph per measure, in a tinted square.
 *
 * Each takes the colour its own figures already use elsewhere — call volume
 * blue, penalty red, FTFR green — so the tile, the rail icon and the chart
 * series all agree on what a measure looks like. The tint is the same hue at
 * low alpha rather than a fill, which keeps eight of them on one screen from
 * reading as eight buttons.
 */
const ICONS = {
  total: <><path d="M4 19V9M10 19V5M16 19v-7M4 19h16" /></>,
  resolved: <><circle cx="12" cy="12" r="8.4" /><path d="M8.4 12.2l2.6 2.6 4.6-5" /></>,
  open: <><path d="M12 4.5 21 20H3Z" /><path d="M12 10.5v4M12 17v.4" /></>,
  parked: <><path d="M6.5 6.5 17 17M17 6.5 6.5 17" /><circle cx="12" cy="12" r="9" /></>,
  repeat: <><path d="M4 10a6 6 0 0 1 6-6h7" /><path d="M14 1.5 17.5 4 14 6.5" />
    <path d="M20 14a6 6 0 0 1-6 6H7" /><path d="M10 17.5 6.5 20 10 22.5" /></>,
  penalty: <><circle cx="12" cy="12" r="8.4" /><path d="M12 7.6v5M12 15.6v.4" /></>,
  perday: <><path d="M7 5h10M7 9h10M8 5c4 0 6 1.6 6 4s-2 4-6 4h-1l7 6" /></>,
  closure: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" />
    <path d="M9.5 15l1.8 1.8 3.4-3.6" /></>,
  ftfr: <><path d="M3 17l5-6 4 4 5-8 4 5" /></>,
  resolution: <><circle cx="12" cy="12" r="8.4" /><path d="M12 7.4V12l3 1.8" /></>,
};

function Tile({ label, dot, value, format, note, onClick, accent, children, index, icon }) {
  const animated = useCountUp(value);
  const Root = onClick ? 'button' : 'div';

  return (
    <Root
      className={`kpi${onClick ? ' clickable' : ''}${accent ? ` accent-${accent}` : ''}`}
      style={{ '--i': index }}
      {...(onClick ? { type: 'button', onClick } : {})}
    >
      <div className="k-top">
        <div className="k-label">
          {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
          {label}
        </div>
        {icon && (
          <span className="k-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                 strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              {ICONS[icon]}
            </svg>
          </span>
        )}
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
        index={0} label="Total calls" icon="total" value={summary.total} format={int}
        note="Tickets logged in range"
      />
      <Tile
        index={1} label="Resolved" icon="resolved" dot="resolved" value={summary.resolved} format={int}
        note={share(summary.resolved)}
      />
      <Tile
        index={2} label="Open calls" icon="open" dot="open" accent="critical"
        value={summary.open} format={int}
        note="Unresolved, no remark · drill in"
        onClick={() => onOpenBucket(0)}
      />
      <Tile
        index={3} label="Unresolved calls" icon="parked" dot="parked" accent="warning"
        value={summary.parked} format={int}
        note="Unresolved, with remark · drill in"
        onClick={() => onOpenBucket(1)}
      />
      <Tile
        index={4} label="Repeat calls" icon="repeat" value={repeats.followUps} format={int}
        note={`2nd+ call on ${repeats.repeatAssets.toLocaleString()} assets · drill in`}
        onClick={onOpenRepeats}
      />
      <Tile
        index={5} label="Penalty calls" icon="penalty" accent="critical"
        value={summary.penalty} format={int}
        note={`${slaNote(penaltyDays)} · drill in`}
        onClick={onOpenPenalty}
      />
      <Tile
        index={6} label="Per-day penalty" icon="perday" accent="critical"
        value={hasRateCard ? money.perDay : 0}
        format={(v) => (hasRateCard ? `${rupees(v)}/d` : '—')}
        note={hasRateCard
          ? `Accruing on ${money.accruingCount.toLocaleString()} open tickets · drill in`
          : 'No rate card for this state'}
        onClick={hasRateCard ? () => onOpenMoney('perday') : undefined}
      />
      <Tile
        index={7} label="Closure penalty" icon="closure" accent="warning"
        value={hasRateCard ? money.closure : 0}
        format={rupees}
        note={hasRateCard
          ? `Settled on ${money.closedCount.toLocaleString()} tickets closed in range · drill in`
          : 'No rate card for this state'}
        onClick={hasRateCard ? () => onOpenMoney('closure') : undefined}
      />
      <Tile
        index={8} label="FTFR" icon="ftfr" accent="good" value={summary.ftfrPct} format={pct1}
        /* Both halves of the fraction, so the percentage can be checked by hand
           — and so the denominator being *logged* calls is visible rather than
           something you have to know. */
        note={`${summary.firstTimeFixes.toLocaleString()} of ${summary.ftfrLogged.toLocaleString()} logged, fixed within ${FTFR_MAX_DAYS} day · drill in`}
        onClick={() => onOpenPerformance('ftfr')}
      >
        <Ring pct={summary.ftfrPct} />
      </Tile>
      <Tile
        index={9} label="Avg resolution" icon="resolution" value={summary.avgResolutionDays}
        format={(n) => `${n.toFixed(1)} d`}
        note="Logged to resolved · drill in"
        onClick={() => onOpenPerformance('resolution')}
      />
    </div>
  );
}
