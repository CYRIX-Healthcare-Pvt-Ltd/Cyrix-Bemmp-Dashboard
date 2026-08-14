import { useEffect, useId, useMemo, useState } from 'react';
import { serialToISO, dateToSerial, monthStart, formatDay, BUCKET_LABEL } from '../data/store.js';
import {
  FILTER_DIMS, defaultFiltersFor, saveDefaultFilters, clearDefaultFilters, hasDefaultFilters,
} from '../data/query.js';

/** Presets are anchored to the latest logged date in the data, not today —
 *  the export lags reality and "last 30 days" from today can be empty. */
const PRESETS = [
  { id: 'month', label: 'This month', range: (r) => [monthStart(r.maxDay), r.maxDay] },
  { id: '30', label: 'Last 30 days', range: (r) => [r.maxDay - 29, r.maxDay] },
  { id: '90', label: 'Last 90 days', range: (r) => [r.maxDay - 89, r.maxDay] },
  { id: '365', label: 'Last 12 months', range: (r) => [r.maxDay - 364, r.maxDay] },
  { id: 'all', label: 'All time', range: (r) => [r.minDay, r.maxDay] },
];

/**
 * What each filterable column is called on screen, and how it is chosen.
 *
 * `search` is not a style preference: Kerala has 1,572 facilities and 556
 * equipment names, and a select that long is a scroll nobody finishes. Zone and
 * district are closed sets of two and fourteen, where a dropdown is faster than
 * typing.
 */
const FIELDS = {
  zone: { label: 'Zone', all: 'All zones' },
  district: { label: 'District', all: 'All districts' },
  facilityName: { label: 'Facility', all: 'All facilities', search: true },
  equipment: { label: 'Equipment', all: 'All equipment', search: true },
};

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

/**
 * Type-ahead over a long dictionary, on a native `datalist`.
 *
 * Deliberately not a custom popup: the browser's own list filters as you type,
 * scrolls with the keyboard, and on a phone opens the picker the person already
 * knows. A hand-rolled combobox over 1,572 rows would be more code and worse.
 *
 * The control's value is a name while the filter's value is a dictionary id, so
 * a name that matches nothing simply selects nothing — which is the right
 * behaviour for a half-typed word.
 */
function Search({ label, dict, value, onChange, allLabel }) {
  const listId = useId();
  const [text, setText] = useState('');

  // Reverse map built once per dictionary. Case-folded, because the person
  // typing has no reason to reproduce the export's capitalisation.
  const byName = useMemo(() => {
    const m = new Map();
    dict.forEach((name, id) => m.set(name.toLowerCase(), id));
    return m;
  }, [dict]);

  const sorted = useMemo(() => [...dict].sort((a, b) => a.localeCompare(b)), [dict]);

  // Selected, the field shows the dictionary's own spelling; otherwise whatever
  // is being typed.
  const shown = value != null ? dict[value] : text;

  const commit = (raw) => {
    setText(raw);
    const id = byName.get(raw.trim().toLowerCase());
    onChange(id === undefined ? null : id);
  };

  return (
    <div className="field">
      <label htmlFor={`f-${label}`}>{label}</label>
      <div className="field-search">
        <input
          id={`f-${label}`}
          list={listId}
          value={shown}
          placeholder={allLabel}
          autoComplete="off"
          spellCheck="false"
          onChange={(e) => commit(e.target.value)}
        />
        {value != null && (
          <button
            type="button"
            className="field-clear"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => { setText(''); onChange(null); }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                 stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
        {/* The whole dictionary, uncapped. A cap here is invisible and worse than
            it sounds: it does not shorten the list the person sees — the browser
            already filters that to what they typed — it just silently removes the
            tail, so a facility late in the alphabet suggests nothing at all. */}
        <datalist id={listId}>
          {sorted.map((name) => <option key={name} value={name} />)}
        </datalist>
      </div>
    </div>
  );
}

export default function Filters({ ds, filters, setFilters }) {
  const { dict } = ds;
  const dateRange = ds.meta.dateRange;
  const stateId = ds.meta.id;
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  // Closed on load at every width. Expanded, the bar costs a third of the first
  // screen and pushes the figures below the fold — and most sessions never touch
  // it, because the default range is the one people want.
  const [open, setOpen] = useState(false);

  // A contract whose export has no such column has an empty dictionary, and a
  // dropdown over nothing is a control that cannot do anything. Andhra has no
  // zone, so Andhra gets no zone filter.
  const dims = useMemo(
    () => FILTER_DIMS.filter((k) => dict[k]?.length > 0),
    [dict],
  );

  /*
   * What is narrowing the figures. The badge and the reset both read it, so a
   * landing page nobody has touched must count zero — a "1" on the button with
   * nothing selected sends people into the panel to find out what they filtered.
   *
   * `all` is the resting range now, and it is not a narrowing at all: it is the
   * whole contract. Anything else is one, whether it came from a preset or from
   * two typed dates.
   */
  const activeCount = dims.reduce((n, k) => n + (filters[k].size ? 1 : 0), 0)
    + (filters.bucket.size ? 1 : 0)
    + (filters.preset === 'all' ? 0 : 1);

  const firstOf = (s) => (s.size ? [...s][0] : null);

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
      ...dims.map((k) => (filters[k].size ? dict[k][firstOf(filters[k])] : null)),
      filters.bucket.size ? BUCKET_LABEL[firstOf(filters.bucket)] : null,
    ].filter(Boolean).join(' · ');
  }, [filters, dict, dims]);

  const applyPreset = (p) => {
    const [from, to] = p.range(dateRange);
    set({ preset: p.id, dayFrom: Math.max(from, dateRange.minDay), dayTo: to });
  };

  const single = (key) => (id) => set({ [key]: id == null ? new Set() : new Set([id]) });

  /*
   * Reset returns the page to whatever it *opens* on, which is the saved default
   * if this person has one and the blank selection otherwise — not a third
   * state. It used to be a second copy of the blank object written out here, and
   * the copy still said "this month", so Reset put you somewhere the page had
   * never been.
   */
  const reset = () => setFilters(defaultFiltersFor(ds));

  /*
   * A saved default, so somebody who only ever looks at one district does not
   * select it every morning.
   *
   * One button with two jobs, because they are the two halves of one decision
   * and both cannot apply at once: with nothing saved it offers to save, and
   * with something saved it offers to take it away. `saved` is state rather than
   * read on every render — localStorage would not tell React it had changed.
   */
  const [saved, setSaved] = useState(() => hasDefaultFilters(stateId));
  useEffect(() => { setSaved(hasDefaultFilters(stateId)); }, [stateId]);

  const setAsDefault = () => { saveDefaultFilters(ds, filters); setSaved(true); };
  const forgetDefault = () => {
    clearDefaultFilters(stateId);
    setSaved(false);
    // Put the page back on the built-in default in the same press — the saved
    // one is gone by the time this runs, so it returns blank. Clearing it and
    // leaving its selection on screen would say nothing had happened.
    setFilters(defaultFiltersFor(ds));
  };

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
          {activeCount > 0 && (
            <span className={`filter-count${saved ? ' is-saved' : ''}`}>{activeCount}</span>
          )}
          <svg
            className={`chev${open ? ' up' : ''}`} viewBox="0 0 24 24" width="16" height="16"
            fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <span className="filter-summary">{summary}</span>

        {/* Only once something is applied — a reset that is always there invites
            the question of what it would undo. Named for where it lands, since
            with a saved view that is not "nothing selected". */}
        {activeCount > 0 && (
          <button type="button" className="filter-reset" onClick={reset}>
            {saved ? 'Back to saved view' : 'Reset all filters'}
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

        {/* Paired, because a date is four characters wide and two of them on
            their own rows pushed everything below off a phone's first screen.
            Only controls whose values are genuinely short go side by side —
            a facility name would be clipped to uselessness in half a drawer. */}
        <div className="field-pair">
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
        </div>

        {/* Zone and district are two values and fourteen, so they pair too. On a
            contract with no zone the pair holds one control and it fills the row
            rather than sitting in half of it. */}
        <div className="field-pair">
          {dims.filter((k) => !FIELDS[k].search).map((key) => (
            <Dropdown
              key={key}
              label={FIELDS[key].label}
              dict={dict[key]}
              allLabel={FIELDS[key].all}
              value={firstOf(filters[key])}
              onChange={single(key)}
            />
          ))}
        </div>

        {dims.filter((k) => FIELDS[k].search).map((key) => (
          <Search
            key={key}
            label={FIELDS[key].label}
            dict={dict[key]}
            allLabel={FIELDS[key].all}
            value={firstOf(filters[key])}
            onChange={single(key)}
          />
        ))}

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

        {/*
          * At the bottom, where a selection is finished, rather than in the
          * collapsed bar where it is started.
          *
          * One control at a time, because with a default saved the two overlap:
          * "Clear saved view" already returns the page to all time, so a Reset
          * beside it offering to return the page to all time was two buttons for
          * one outcome and the pair had to be read carefully to tell apart.
          */}
        <div className="filter-actions">
          {saved ? (
            <button type="button" className="filter-default is-clear" onClick={forgetDefault}>
              Clear saved view
            </button>
          ) : (
            <>
              <button
                type="button"
                className="filter-reset"
                onClick={reset}
                disabled={activeCount === 0}
              >
                Reset filters
              </button>
              <button
                type="button"
                className="filter-default is-save"
                onClick={setAsDefault}
                disabled={activeCount === 0}
              >
                Save as default view
              </button>
            </>
          )}
        </div>
        <p className="caption">
          {saved
            ? 'This contract opens on your saved view. Clearing it puts the page back on '
              + 'all time.'
            : 'Save a view and this contract opens on it every time, on this device.'}
        </p>
      </div>
    </>
  );
}
