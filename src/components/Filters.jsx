import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  serialToISO, dateToSerial, monthStart, financialYearStart, formatDay, BUCKET_LABEL,
} from '../data/store.js';
import {
  FILTER_DIMS, defaultFiltersFor, saveDefaultFilters, saveFilterLayout, clearDefaultFilters, hasDefaultFilters,
  sameFilters, facetOptions,
} from '../data/query.js';
import { extraFields, extraLabel, extraOptions } from '../data/extraFilters.js';

/** Presets are anchored to the latest logged date in the data, not today —
 *  the export lags reality and "last 30 days" from today can be empty. */
const PRESETS = [
  { id: 'month', label: 'This month', range: (r) => [monthStart(r.maxDay), r.maxDay] },
  { id: '30', label: 'Last 30 days', range: (r) => [r.maxDay - 29, r.maxDay] },
  { id: '90', label: 'Last 90 days', range: (r) => [r.maxDay - 89, r.maxDay] },
  { id: '365', label: 'Last 12 months', range: (r) => [r.maxDay - 364, r.maxDay] },
  /* April to March, and distinct from "Last 12 months": in August those are two
     different windows — five months against twelve — and it is the April one the
     penalty accounts and the contract reviews are written against. */
  { id: 'fy', label: 'This financial year', range: (r) => [financialYearStart(r.maxDay), r.maxDay] },
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

function Dropdown({ label, dict, value, onChange, allLabel, allow }) {
  /* `allow` is what the other filters have left available. The selected value
     is kept whatever happens, so a list that has just narrowed still shows what
     it is set to rather than appearing blank. */
  const options = useMemo(
    () => dict
      .map((name, id) => ({ id, name }))
      .filter((o) => !allow || allow.has(o.id) || o.id === value)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [dict, allow, value],
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
function Search({ label, dict, value, onChange, allLabel, allow }) {
  const listId = useId();
  const [text, setText] = useState('');

  // Reverse map built once per dictionary. Case-folded, because the person
  // typing has no reason to reproduce the export's capitalisation.
  const byName = useMemo(() => {
    const m = new Map();
    dict.forEach((name, id) => m.set(name.toLowerCase(), id));
    return m;
  }, [dict]);

  const sorted = useMemo(
    () => dict
      .map((name, id) => ({ name, id }))
      .filter((o) => !allow || allow.has(o.id) || o.id === value)
      .map((o) => o.name)
      .sort((a, b) => a.localeCompare(b)),
    [dict, allow, value],
  );

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

/**
 * A list to tick any number from (the user, 28 Nov: "except dates we need filter multiple selection"). Opens in
 * place inside the drawer, so on a phone it is one press and a scroll; the long lists get a find box.
 */
function MultiPick({ id, label, options, selected, onChange, allLabel, find = false, onRemove = null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  // A press anywhere else closes it (the user, 28 Nov).
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const chosen = options.filter((o) => selected.has(o.value));
  const needle = q.trim().toLowerCase();
  // What is ticked first, then the rest, so a choice made never scrolls away.
  const list = [...chosen, ...options.filter((o) => !selected.has(o.value))]
    .filter((o) => !needle || o.label.toLowerCase().includes(needle));
  const text = !chosen.length ? allLabel : chosen.length <= 2 ? chosen.map((o) => o.label).join(', ') : `${chosen.length} selected`;
  const toggle = (v) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };
  return (
    <div ref={box} className={`field multi-pick${open ? ' is-open' : ''}`}>
      <div className="multi-pick-head">
        <label htmlFor={id}>{label}</label>
        {onRemove && (
          <button type="button" className="multi-pick-remove" onClick={onRemove} aria-label={`Remove ${label} filter`}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        )}
      </div>
      <button id={id} type="button" className={`multi-pick-btn${chosen.length ? ' has-value' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>{text}</span>
        <svg className={`chev${open ? ' up' : ''}`} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="multi-pick-list">
          {options.length > 6 && (
            <input className="multi-pick-find" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${label.toLowerCase()}`} autoComplete="off" spellCheck="false" />
          )}
          <div className="multi-pick-options">
            {list.map((o) => (
              <label key={o.value} className="multi-pick-option">
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
          {chosen.length > 0 && <button type="button" className="linkish multi-pick-clear" onClick={() => onChange(new Set())}>Clear</button>}
        </div>
      )}
    </div>
  );
}

export default function Filters({ ds, assets = null, filters, setFilters, contractTypes, ticketStatuses, slotRef, slotTall = false }) {
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
  const care = ['c360', 'pvt'].includes(stateId);
  const activeCount = dims.reduce((n, k) => n + (filters[k].size ? 1 : 0), 0)
    + (filters.bucket.size ? 1 : 0)
    + (care && filters.lifecycle?.size ? 1 : 0)
    + (filters.ticketStatus?.size ? 1 : 0)
    + (filters.contract?.size ? 1 : 0)
    + Object.values(filters.extra ?? {}).filter((v) => v?.size).length
    + (filters.preset === 'all' ? 0 : 1);
  // Add filters (the user, 28 Nov): any TM export or asset master column, Care 360 only.
  const [adding, setAdding] = useState(false);
  const [addFind, setAddFind] = useState('');
  const fields = useMemo(() => (care && adding ? extraFields(ds, assets) : []), [care, adding, ds, assets]);
  const extra = filters.extra ?? {};
  const extraKeys = Object.keys(extra);
  const setExtra = (next) => set({ extra: next });
  /*
   * The drawer's own filters as one list with the added ones (the user, 28 Nov: "need currently available filter
   * also"): each can move up or down, or come off and back from Add filters. `filters.layout` is the order; none
   * saved means every standard filter in its usual place, then the added ones.
   */
  const standard = [
    ...dims.map((k) => ({ id: `b:${k}`, label: FIELDS[k].label, key: k })),
    ...(care && dict.lifecycle?.length > 0 ? [{ id: 'b:lifecycle', label: 'Job type', key: 'lifecycle' }] : []),
    { id: 'b:bucket', label: 'Status', key: 'bucket' },
    ...(ticketStatuses?.length > 0 ? [{ id: 'b:ticketStatus', label: 'Ticket status', key: 'ticketStatus' }] : []),
    ...(contractTypes?.length > 0 ? [{ id: 'b:contract', label: 'Contract type', key: 'contract' }] : []),
  ];
  const standardById = Object.fromEntries(standard.map((f) => [f.id, f]));
  const known = (id) => Boolean(standardById[id]) || (care && id in extra);
  const layout = (() => {
    const base = care && Array.isArray(filters.layout) ? filters.layout.filter(known) : standard.map((f) => f.id);
    for (const k of care ? extraKeys : []) if (!base.includes(k)) base.push(k);
    return base;
  })();
  const labelOf = (id) => standardById[id]?.label ?? extraLabel(id);
  const setLayout = (next, patch = {}) => {
    saveFilterLayout(stateId, next, Object.keys(patch.extra ?? extra));
    set({ layout: next, ...patch });
  };
  const toggleField = (id) => {
    if (layout.includes(id)) {
      const patch = {};
      if (standardById[id]) patch[standardById[id].key] = new Set();
      else { const e = { ...extra }; delete e[id]; patch.extra = e; }
      setLayout(layout.filter((x) => x !== id), patch);
    } else {
      setLayout([...layout, id], standardById[id] ? {} : { extra: { ...extra, [id]: new Set() } });
    }
  };
  // Up or down one place (the user, 28 Nov: "user can change the order also").
  const moveField = (id, by) => {
    const next = [...layout];
    const at = next.indexOf(id); const to = at + by;
    if (at < 0 || to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to], next[at]];
    setLayout(next);
  };
  const extraOpts = useMemo(
    () => Object.fromEntries(extraKeys.map((k) => [k, open ? extraOptions(ds, assets, k) : []])),
    [extraKeys.join('|'), ds, assets, open],
  );

  /*
   * What each list can still offer, given everything else selected.
   *
   * Only computed while the panel is open. It is a pass over 265k rows and the
   * bar is collapsed for most of a session, so doing it on every filter change
   * regardless would be work nobody can see the result of.
   */
  const facets = useMemo(
    () => (open ? facetOptions(ds, filters) : {}),
    [open, ds, filters],
  );

  // One choice by its name; more than one as a count.
  const named = (s, nameOf, noun) => (!s?.size ? null : s.size === 1 ? nameOf([...s][0]) : `${s.size} ${noun}`);
  const NOUN = { zone: 'zones', district: 'districts', facilityName: 'facilities', equipment: 'equipment' };
  const optionsOf = (key) => (dict[key] ?? [])
    .map((name, id) => ({ value: id, label: name }))
    .filter((o) => !facets[key] || facets[key].has(o.value) || filters[key]?.has(o.value))
    .sort((a, b) => a.label.localeCompare(b.label));

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
      ...dims.map((k) => named(filters[k], (id) => dict[k][id], NOUN[k] ?? 'chosen')),
      care ? named(filters.lifecycle, (id) => dict.lifecycle?.[id], 'job types') : null,
      named(filters.bucket, (id) => BUCKET_LABEL[id], 'statuses'),
      named(filters.ticketStatus, (v) => v, 'ticket statuses'),
      named(filters.contract, (v) => v, 'contract types'),
      ...Object.entries(filters.extra ?? {}).map(([k, v]) => named(v, (x) => `${extraLabel(k)}: ${x}`, extraLabel(k))),
    ].filter(Boolean).join(' · ');
  }, [filters, dict, dims, care]);

  const applyPreset = (p) => {
    const [from, to] = p.range(dateRange);
    set({ preset: p.id, dayFrom: Math.max(from, dateRange.minDay), dayTo: to });
  };


  /*
   * Reset returns the page to whatever it *opens* on, which is the saved default
   * if this person has one and the blank selection otherwise — not a third
   * state. It used to be a second copy of the blank object written out here, and
   * the copy still said "this month", so Reset put you somewhere the page had
   * never been.
   */
  /*
   * Reset clears what is ticked, not the filters somebody chose to have (the user, 28 Nov: "on reset custom added
   * is done"): the order and the added columns stay, emptied.
   */
  const reset = () => {
    const d = defaultFiltersFor(ds);
    const keepExtra = Object.fromEntries(Object.keys(filters.extra ?? {}).map((k) => [k, d.extra?.[k] ?? new Set()]));
    setFilters({ ...d, extra: { ...keepExtra, ...(d.extra ?? {}) }, ...(filters.layout ? { layout: filters.layout } : {}) });
  };

  /*
   * Whether pressing Reset would actually change anything.
   *
   * `activeCount` answers "is the page narrowed", which stopped being the same
   * question once a view could be saved: with one saved the page *opens*
   * narrowed, so a Reset offered on the count alone sat in the bar permanently
   * and did nothing when pressed. A control that is always there and never does
   * anything is worse than no control.
   */
  // Only ticked values count: adding or ordering filters is not something to reset.
  const valuesOnly = (f) => ({ ...f, layout: null, extra: Object.fromEntries(Object.entries(f.extra ?? {}).filter(([, v]) => v?.size)) });
  const dirty = !sameFilters(valuesOnly(filters), valuesOnly(defaultFiltersFor(ds)));

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

  /** One filter of the drawer by its id: a standard one (b:zone …) or an added column (tm: / am:). */
  const pickOf = (id) => {
    const remove = care ? () => toggleField(id) : null;
    const f = standardById[id];
    if (f) {
      const k = f.key;
      const common = { key: id, id: `f-${k === 'bucket' ? 'status' : k}`, label: f.label, onRemove: remove, onChange: (next) => set({ [k]: next }) };
      if (FIELDS[k]) return <MultiPick {...common} options={optionsOf(k)} selected={filters[k]} allLabel={FIELDS[k].all} find={Boolean(FIELDS[k].search)} />;
      if (k === 'lifecycle') {
        return <MultiPick {...common} id="f-job-type" options={dict.lifecycle.map((name, i) => ({ value: i, label: name })).sort((x, y) => x.label.localeCompare(y.label))} selected={filters.lifecycle ?? new Set()} allLabel="All job types" />;
      }
      if (k === 'bucket') return <MultiPick {...common} options={BUCKET_LABEL.map((l, i) => ({ value: i, label: l }))} selected={filters.bucket} allLabel="All statuses" />;
      if (k === 'ticketStatus') return <MultiPick {...common} id="f-ticket-status" options={ticketStatuses.map((t) => ({ value: t, label: t }))} selected={filters.ticketStatus ?? new Set()} allLabel="All ticket statuses" />;
      if (k === 'contract') return <MultiPick {...common} options={contractTypes.map((t) => ({ value: t, label: t }))} selected={filters.contract ?? new Set()} allLabel="All contract types" />;
      return null;
    }
    const opts = extraOpts[id];
    return (
      <MultiPick
        key={id}
        id={`f-x-${id}`}
        label={extraLabel(id)}
        options={(opts ?? []).map((v) => ({ value: v, label: v }))}
        selected={extra[id] ?? new Set()}
        onChange={(next) => setExtra({ ...extra, [id]: next })}
        allLabel={opts === null ? 'Too many values' : 'All'}
        find
        onRemove={remove}
      />
    );
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
        {dirty && (
          <button type="button" className="filter-reset" onClick={reset}>
            {saved ? 'Back to saved view' : 'Reset all filters'}
          </button>
        )}
        {/* Care 360 summary cards on pages without sub-tabs sit here, opposite Filters (the user, 26 Nov). */}
        {slotRef && <div className={`bar-stats-slot${slotTall ? ' is-tall' : ''}`} ref={slotRef} />}
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

        {/* Every list takes any number of choices (the user, 28 Nov); only the dates stay single. Two a row, one
            opened takes the row. */}
        <div className="filter-grid">
          {layout.map((id) => pickOf(id))}
        </div>

        {care && (
          <button type="button" className="filter-add" onClick={() => { setAddFind(''); setAdding(true); }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Add filters
          </button>
        )}

        {/* Over the whole page, not inside the drawer's width (the user, 28 Nov: "need big pop up"). */}
        {adding && createPortal(
          <div className="addf-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setAdding(false); }}>
            <div className="addf-card" role="dialog" aria-modal="true" aria-label="Add filters">
              <div className="addf-head">
                <strong>Add filters</strong>
                <button type="button" className="multi-pick-remove" onClick={() => setAdding(false)} aria-label="Close">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              {/* Wide (the user, 28 Nov): what is in the drawer on the left, what can be added on the right. */}
              <div className="addf-body">
                <div className="addf-order">
                  <div className="addf-group">Your filters</div>
                  {layout.map((k, n) => (
                    <div key={k} className="addf-row">
                      <span>{labelOf(k)}</span>
                      <button type="button" className="multi-pick-remove" disabled={n === 0} onClick={() => moveField(k, -1)} aria-label={`Move ${labelOf(k)} up`}>
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
                      </button>
                      <button type="button" className="multi-pick-remove" disabled={n === layout.length - 1} onClick={() => moveField(k, 1)} aria-label={`Move ${labelOf(k)} down`}>
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                      <button type="button" className="multi-pick-remove" onClick={() => toggleField(k)} aria-label={`Remove ${labelOf(k)} filter`}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </div>
                  ))}
                  {!layout.length && <p className="caption">None</p>}
                </div>
                <div className="addf-side">
                  <input className="multi-pick-find" value={addFind} onChange={(e) => setAddFind(e.target.value)} placeholder="Find a column" autoComplete="off" spellCheck="false" />
                  <div className="addf-list">
                {['Standard', 'TM export', 'Asset master'].map((g) => {
                  const needle = addFind.trim().toLowerCase();
                  const pool = g === 'Standard' ? standard.map((f) => ({ key: f.id, label: f.label, group: g })) : fields;
                  const items = pool.filter((f) => f.group === g && !layout.includes(f.key) && (!needle || f.label.toLowerCase().includes(needle)));
                  if (!items.length) return null;
                  return (
                    <div key={g}>
                      <div className="addf-group">{g}</div>
                      {items.map((f) => (
                        <label key={f.key} className="multi-pick-option">
                          <input type="checkbox" checked={false} onChange={() => toggleField(f.key)} />
                          <span>{f.label}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
                  </div>
                </div>
              </div>
              <button type="button" className="addf-done" onClick={() => setAdding(false)}>Done</button>
            </div>
          </div>,
          document.body,
        )}

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
                disabled={!dirty}
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
      </div>
    </>
  );
}
