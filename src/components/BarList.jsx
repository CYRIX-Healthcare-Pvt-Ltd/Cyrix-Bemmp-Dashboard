import { useState } from 'react';

/**
 * Horizontal bar list. Every bar carries a visible label and value, which is the
 * relief the palette validator requires for the low-contrast series colours.
 *
 * Items may carry `display` (a preformatted value, e.g. "57.0%" or "2.1 d") and
 * `sub` (a denominator caption, e.g. "1,204 resolved"). Bars are scaled against
 * the largest value present rather than the first, since a rate or mean measure
 * is not necessarily sorted by magnitude.
 *
 * `initial` caps how many rows show before the expander; pass the full ranking
 * and the list handles the rest.
 */

/** Rows visible before the list starts scrolling inside its panel. */
const VISIBLE_ROWS = 10;

export default function BarList({
  items, total, color = 'var(--series-1)', onSelect,
  emptyText = 'No data in range', initial = null,
}) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <p className="empty">{emptyText}</p>;

  const cut = initial ?? items.length;
  const shown = expanded ? items : items.slice(0, cut);

  // Scaled against what is on screen, not the whole ranking. A measure sorted
  // ascending puts the smallest values first, and scaling those against a
  // distant maximum would leave every visible bar a stub.
  const max = Math.max(...shown.map((i) => i.value), 0) || 1;

  return (
    <>
      <div
        className={`bars${shown.length > VISIBLE_ROWS ? ' is-scroll' : ''}`}
        style={{ '--bar-color': color }}
      >
        {shown.map((item) => {
          const value = item.display ?? item.value.toLocaleString();
          const pct = total && item.display == null
            ? ((item.value / total) * 100).toFixed(1)
            : null;
          const Row = onSelect ? 'button' : 'div';
          return (
            <Row
              key={item.id ?? item.label}
              className={`bar-row${onSelect ? ' clickable' : ''}`}
              {...(onSelect ? { type: 'button', onClick: () => onSelect(item) } : {})}
              title={pct ? `${item.label} — ${value} (${pct}%)` : `${item.label} — ${value}`}
            >
              <div>
                <div className="b-label">
                  {item.label}
                  {item.sub && <span className="b-sub">{item.sub}</span>}
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: color }}
                  />
                </div>
              </div>
              <div className="b-value">{value}</div>
            </Row>
          );
        })}
      </div>

      {items.length > cut && (
        <button
          type="button"
          className="bar-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? `Show top ${cut}` : `Show all ${items.length.toLocaleString()}`}
        </button>
      )}
    </>
  );
}
