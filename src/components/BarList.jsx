/** Horizontal bar list. Every bar carries a visible label and value, which is the
 *  relief the palette validator requires for the low-contrast series colours. */
export default function BarList({ items, total, color = 'var(--series-1)', onSelect, emptyText = 'No data in range' }) {
  if (!items.length) return <p className="empty">{emptyText}</p>;
  const max = items[0].value || 1;

  return (
    <div className="bars">
      {items.map((item) => {
        const pct = total ? ((item.value / total) * 100).toFixed(1) : null;
        const Row = onSelect ? 'button' : 'div';
        return (
          <Row
            key={item.id ?? item.label}
            className={`bar-row${onSelect ? ' clickable' : ''}`}
            {...(onSelect ? { type: 'button', onClick: () => onSelect(item) } : {})}
            title={pct ? `${item.label} — ${item.value.toLocaleString()} (${pct}%)` : item.label}
          >
            <div>
              <div className="b-label">{item.label}</div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: color }}
                />
              </div>
            </div>
            <div className="b-value">{item.value.toLocaleString()}</div>
          </Row>
        );
      })}
    </div>
  );
}
