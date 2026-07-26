/**
 * Horizontal bar list. Every bar carries a visible label and value, which is the
 * relief the palette validator requires for the low-contrast series colours.
 *
 * Items may carry `display` (a preformatted value, e.g. "57.0%" or "2.1 d") and
 * `sub` (a denominator caption, e.g. "1,204 resolved"). Bars are scaled against
 * the largest value present rather than the first, since a rate or mean measure
 * is not necessarily sorted by magnitude.
 */
export default function BarList({
  items, total, color = 'var(--series-1)', onSelect, emptyText = 'No data in range',
}) {
  if (!items.length) return <p className="empty">{emptyText}</p>;
  const max = Math.max(...items.map((i) => i.value), 0) || 1;

  return (
    <div className="bars">
      {items.map((item) => {
        const shown = item.display ?? item.value.toLocaleString();
        const pct = total && item.display == null
          ? ((item.value / total) * 100).toFixed(1)
          : null;
        const Row = onSelect ? 'button' : 'div';
        return (
          <Row
            key={item.id ?? item.label}
            className={`bar-row${onSelect ? ' clickable' : ''}`}
            {...(onSelect ? { type: 'button', onClick: () => onSelect(item) } : {})}
            title={pct ? `${item.label} — ${shown} (${pct}%)` : `${item.label} — ${shown}`}
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
            <div className="b-value">{shown}</div>
          </Row>
        );
      })}
    </div>
  );
}
