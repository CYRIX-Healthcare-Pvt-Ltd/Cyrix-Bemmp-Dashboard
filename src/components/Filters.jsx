import { useMemo, useState } from 'react';
import { serialToISO, dateToSerial, monthStart, formatDay, BUCKET_LABEL } from '../data/store.js';

/** Presets are anchored to the latest logged date in the data, not today —
 *  the export lags reality and "last 30 days" from today can be empty. */
const PRESETS = [
  { id: 'month', label: 'This month', range: (r) => [monthStart(r.maxDay), r.maxDay] },
  { id: '30', label: 'Last 30 days', range: (r) => [r.maxDay - 29, r.maxDay] },
  { id: '90', label: 'Last 90 days', range: (r) => [r.maxDay - 89, r.maxDay] },
  { id: '365', label: 'Last 12 months', range: (r) => [r.maxDay - 364, r.maxDay] },
  { id: 'all', label: 'All time', range: (r) => [r.minDay, r.maxDay] },
];

function Dropdown({ label, dict, value, onChange, allLabel }) {
  const options = useMemo(
    () => dict.map((name, id) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    [dict],
  );
  return (
    <div className="field">
      <label htmlFor={`f-${label}`}>{label}</label>
      <select
        id={`f-${label}`}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}

export default function Filters({ dict, dateRange, filters, setFilters }) {
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  // Closed on load at every width. Expanded, the bar costs a third of the first
  // screen and pushes the figures below the fold — and most sessions never touch
  // it, because the default range is the one people want.
  const [open, setOpen] = useState(false);

  const activeCount = [
    filters.district, filters.facilityType, filters.equipmentType, filters.bucket,
  ].reduce((n, s) => n + (s.size ? 1 : 0), 0)
    // 'month' is the default range, so it does not count as a filter being applied.
    + (filters.preset === 'month' ? 0 : 1);

  const firstOf = (s) => (s.size ? [...s][0] : null);
  const named = (s, d) => (s.size ? d[firstOf(s)] : null);

  /**
   * What is selected, in one line. The bar is collapsed by default, so without
   * this the figures below it would have no visible provenance.
   */
  const summary = useMemo(() => {
    const preset = PRESETS.find((p) => p.id === filters.preset);
    const range = preset
      ? preset.label
      : `${formatDay(filters.dayFrom)} – ${formatDay(filters.dayTo)}`;
    return [
      range,
      named(filters.district, dict.district),
      named(filters.facilityType, dict.facilityType),
      named(filters.equipmentType, dict.equipmentType),
      filters.bucket.size ? BUCKET_LABEL[firstOf(filters.bucket)] : null,
    ].filter(Boolean).join(' · ');
  }, [filters, dict]);

  const applyPreset = (p) => {
    const [from, to] = p.range(dateRange);
    set({ preset: p.id, dayFrom: Math.max(from, dateRange.minDay), dayTo: to });
  };

  const single = (key) => (id) => set({ [key]: id == null ? new Set() : new Set([id]) });

  const reset = () => setFilters({
    preset: 'month',
    dayFrom: monthStart(dateRange.maxDay),
    dayTo: dateRange.maxDay,
    district: new Set(),
    facilityType: new Set(),
    equipmentType: new Set(),
    bucket: new Set(),
  });

  return (
    <>
      <div className="filter-bar">
        <button
          type="button"
          className="filter-toggle"
          aria-expanded={open}
          aria-controls="filter-panel"
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M7 12h10M11 18h2" />
          </svg>
          Filters
          {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
          <svg
            className={`chev${open ? ' up' : ''}`} viewBox="0 0 24 24" width="16" height="16"
            fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <span className="filter-summary">{summary}</span>

        {/* Only once something is applied — a reset that is always there invites
            the question of what it would undo. */}
        {activeCount > 0 && (
          <button type="button" className="filter-reset" onClick={reset}>
            Reset all filters
          </button>
        )}
      </div>

      {/* A drawer rather than a band across the page. Expanded in place it cost a
          third of the first screen on every tab, and most sessions never touch it
          because the default range is the one people want. */}
      {open && (
        <button
          type="button"
          className="filter-scrim"
          aria-label="Close filters"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="filters" id="filter-panel" hidden={!open}>
        <div className="filters-head">
          <span className="eyebrow">Filters</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close filters"
            onClick={() => setOpen(false)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="field field-presets">
          <label>Date range</label>
          <div className="presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="preset"
                aria-pressed={filters.preset === p.id}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="f-from">From</label>
          <input
            id="f-from" type="date"
            min={serialToISO(dateRange.minDay)} max={serialToISO(dateRange.maxDay)}
            value={serialToISO(filters.dayFrom)}
            onChange={(e) => e.target.value && set({
              preset: 'custom', dayFrom: dateToSerial(new Date(`${e.target.value}T00:00:00Z`)),
            })}
          />
        </div>

        <div className="field">
          <label htmlFor="f-to">To</label>
          <input
            id="f-to" type="date"
            min={serialToISO(dateRange.minDay)} max={serialToISO(dateRange.maxDay)}
            value={serialToISO(filters.dayTo)}
            onChange={(e) => e.target.value && set({
              preset: 'custom', dayTo: dateToSerial(new Date(`${e.target.value}T00:00:00Z`)),
            })}
          />
        </div>

        <Dropdown
          label="District" dict={dict.district} allLabel="All districts"
          value={firstOf(filters.district)} onChange={single('district')}
        />
        <Dropdown
          label="Facility type" dict={dict.facilityType} allLabel="All facility types"
          value={firstOf(filters.facilityType)} onChange={single('facilityType')}
        />
        <Dropdown
          label="Criticality" dict={dict.equipmentType} allLabel="All equipment"
          value={firstOf(filters.equipmentType)} onChange={single('equipmentType')}
        />

        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select
            id="f-status"
            value={filters.bucket.size ? firstOf(filters.bucket) : ''}
            onChange={(e) => set({
              bucket: e.target.value === '' ? new Set() : new Set([Number(e.target.value)]),
            })}
          >
            <option value="">All statuses</option>
            {BUCKET_LABEL.map((l, i) => <option key={l} value={i}>{l}</option>)}
          </select>
        </div>
      </div>
    </>
  );
}
