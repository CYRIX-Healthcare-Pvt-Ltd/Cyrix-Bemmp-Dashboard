/**
 * Switches the active state contract. Each state is a separate artifact with its
 * own schema, dictionaries and penalty SLA, so changing this reloads the dataset.
 */
export default function StateSwitcher({ states, active, onChange, busy }) {
  if (states.length < 2) return null;

  return (
    <div className="state-switch" role="tablist" aria-label="BEMMP contract">
      <span className="state-switch-label">BEMMP</span>
      <div className="state-switch-track">
        {states.map((s) => {
          const selected = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className="state-btn"
              disabled={busy}
              onClick={() => !selected && onChange(s.id)}
              title={`${s.name} · ${s.rows.toLocaleString()} tickets`}
            >
              <span className="state-code">{s.short}</span>
              <span className="state-name">{s.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
