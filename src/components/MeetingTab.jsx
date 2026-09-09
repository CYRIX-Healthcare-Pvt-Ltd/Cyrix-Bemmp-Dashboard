import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDay, label, ticketLabel, MONTHS } from '../data/store.js';
import { writeSheet, saveBlob } from '../data/xlsx.js';
import { supabase } from '../data/supabase.js';
import { trackerSummary } from '../data/summary.js';
import TrackerSummary from './TrackerSummary.jsx';
import {
  BLANK, BLANK_LABEL, ENTRY_WIDTH, MEETING_FIELDS, applyFilters, asChoice,
  buildChoices, computeField, ensureRows, exportColumns, isComputed, loadLog,
  loadNotes, reconcileOpen, saveField,
} from '../data/meeting.js';

/** Column keys are database names; the log has to read like the form does. */
const FIELD_LABEL = Object.fromEntries(MEETING_FIELDS.map((f) => [f.key, f.label]));
const DATE_FIELDS = new Set(MEETING_FIELDS.filter((f) => f.kind === 'date').map((f) => f.key));

/**
 * `13 Aug 2026`.
 *
 * The database hands dates back as `2026-08-13`, which is unambiguous to a
 * machine and to nobody else — read aloud in a meeting it invites the question
 * of which number is the month. A named month cannot be misread.
 *
 * The same shape `formatDay` gives the export's own dates, deliberately. The
 * two used to differ by the separator alone, which put `08 Jul 2026` in the
 * Logged column and `13-Aug-2026` four columns along in PI Date — close
 * enough to look like a mistake in the data rather than in the app.
 */
function asDate(value) {
  // Date columns arrive as `YYYY-MM-DD`; anything else is passed through rather
  // than run through a parser that would turn a PO number into a date.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return value;
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A value as it should read in the log: dates named, everything else verbatim. */
const shownValue = (column, value) => (DATE_FIELDS.has(column) ? asDate(value) : value);

/** When a change was made. Date in the same shape, plus the time. */
function stamp(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
}


/**
 * How many distinct values a list will draw before it asks you to narrow.
 *
 * Ticket has nine hundred of them and current status is a sentence per
 * row. The search box inside the list is the way through those; drawing
 * every one first would spend a second building a list nobody reads to
 * the end of.
 */
const CHOICE_LIMIT = 200;

/** Where the filter panel's dragged size is kept, for every column. */
const SIZE_KEY = 'bemmp.tracker.filter-size';

/**
 * Whether a column holds dates.
 *
 * The meeting's own date fields say so on the field definition. The
 * export's two — Logged and Installed — do not: they are plain text
 * columns carrying an already-formatted date, because that is what the
 * cell shows. Named here so the filter and the sort cannot disagree
 * about which columns those are.
 */
export const isDateColumn = (c) => c.entry?.kind === 'date'
  || c.key === 'logged' || c.key === 'installed';

/**
 * A date column's value as a number to sort on. Blanks last, always.
 *
 * Sorting these as text put "01 Apr 2024" above "01 Aug 2022" and every
 * first of the month above every second — ascending did not give the
 * oldest first, it gave the alphabet.
 */
const dateOrder = (v) => {
  const d = parseChoiceDate(String(v ?? ''));
  return d ? d.y * 10000 + d.m * 100 + d.d : null;
};

/**
 * A filter value read as a date, or null if it is not one.
 *
 * Two shapes reach here. The meeting's own date columns come off the
 * database as `2026-08-13`; the export's own — Logged, Installed — are
 * already formatted for the screen as `13 Aug 2026`, because that is what
 * the cell holds and the filter lists what the cells hold.
 */
function parseChoiceDate(v) {
  const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(v);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  // Character classes, not escapes: this file is written by tooling that
  // has eaten a lone backslash more than once, and a regex that matches
  // nothing fails silently — every date simply stops being a date.
  const shown = /^([0-9]{1,2})[ ]+([A-Za-z]{3})[ ]+([0-9]{4})$/.exec(v);
  if (shown) {
    const m = MONTHS.indexOf(shown[2]) + 1;
    if (m) return { y: +shown[3], m, d: +shown[1] };
  }
  return null;
}

/**
 * Dates as a year / month / day tree, the way a spreadsheet shows them.
 *
 * A flat list is the wrong shape for a date column and unusable at this
 * size: Logged has 1,283 distinct days, sorted as text, so "01 Apr 2024"
 * sits next to "01 Apr 2025" and every first-of-the-month comes before
 * any second. Nobody filters a date column one day at a time — they want
 * a year, or a month, and the tree is how you say that in one click.
 *
 * Everything not readable as a date — (blank), and anything somebody
 * typed by hand — keeps a flat row at the bottom rather than being
 * dropped, because those are exactly the rows worth finding.
 */
function DateTree({ groups, loose, isTicked, setMany, toggle, expanded, onExpand }) {
  const rowsFor = (vals) => vals.map(([v]) => v);
  const state = (vals) => {
    const on = vals.filter(([v]) => isTicked(v)).length;
    return on === 0 ? 'off' : (on === vals.length ? 'on' : 'some');
  };

  return (
    <>
      {groups.map(({ year, total, months, all: yearVals }) => {
        const yState = state(yearVals);
        const yOpen = expanded.has(String(year));
        return (
          <div className="datetree-year" key={year}>
            <div className="datetree-row">
              <button
                type="button"
                className="datetree-twist"
                aria-expanded={yOpen}
                aria-label={`${yOpen ? 'Collapse' : 'Expand'} ${year}`}
                onClick={() => onExpand(String(year))}
              >
                {yOpen ? '−' : '+'}
              </button>
              <label className="datetree-label">
                <input
                  type="checkbox"
                  checked={yState === 'on'}
                  ref={(el) => { if (el) el.indeterminate = yState === 'some'; }}
                  onChange={() => setMany(rowsFor(yearVals), yState !== 'on')}
                />
                <span className="datetree-name">{year}</span>
                <span className="colfilter-count">{total}</span>
              </label>
            </div>

            {yOpen && months.map(({ month, name, total: mTotal, days }) => {
              const key = `${year}-${month}`;
              const mState = state(days);
              const mOpen = expanded.has(key);
              return (
                <div className="datetree-month" key={key}>
                  <div className="datetree-row">
                    <button
                      type="button"
                      className="datetree-twist"
                      aria-expanded={mOpen}
                      aria-label={`${mOpen ? 'Collapse' : 'Expand'} ${name} ${year}`}
                      onClick={() => onExpand(key)}
                    >
                      {mOpen ? '−' : '+'}
                    </button>
                    <label className="datetree-label">
                      <input
                        type="checkbox"
                        checked={mState === 'on'}
                        ref={(el) => { if (el) el.indeterminate = mState === 'some'; }}
                        onChange={() => setMany(rowsFor(days), mState !== 'on')}
                      />
                      <span className="datetree-name">{name}</span>
                      <span className="colfilter-count">{mTotal}</span>
                    </label>
                  </div>

                  {mOpen && days.map(([v, n, day]) => (
                    <label className="datetree-row datetree-day" key={v}>
                      <input type="checkbox" checked={isTicked(v)} onChange={() => toggle(v)} />
                      <span className="datetree-name">{String(day).padStart(2, '0')}</span>
                      <span className="colfilter-count">{n}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}

      {loose.map(([v, n, text]) => (
        <label key={v} className={`colfilter-row${v === BLANK ? ' is-blank' : ''}`}>
          <input type="checkbox" checked={isTicked(v)} onChange={() => toggle(v)} />
          <span className="colfilter-value" title={text}>{text}</span>
          <span className="colfilter-count">{n}</span>
        </label>
      ))}
    </>
  );
}

/**
 * One column's filter: what is in this column, and which of it to keep.
 *
 * Values come with their counts because the count is half the decision —
 * "Cautery (3)" tells you whether narrowing to it is worth doing before
 * you do it. The search box inside matters at facility, where a state
 * has hundreds and scrolling a list of them is not better than the grid
 * it was meant to save you from.
 */
export function ColumnFilter({ label, choices, picked, onChange, onClose, isDate }) {
  const [find, setFind] = useState('');
  /** Which years and year-months are open. Newest year starts open. */
  const [expanded, setExpanded] = useState(() => new Set());
  const ref = useRef(null);

  /*
   * The size somebody dragged this to, kept for the next one they open.
   *
   * One size for every column rather than one each: a person who widens
   * a filter because their statuses are long wants the next filter wide
   * too, and being asked to drag thirty of them is worse than the
   * truncation it fixes.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    try {
      const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null');
      if (saved?.w) el.style.width = `${saved.w}px`;
      if (saved?.h) el.style.height = `${saved.h}px`;
    } catch { /* blocked storage; the default size is fine */ }

    const ro = new ResizeObserver(() => {
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify({
          w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight),
        }));
      } catch { /* see above */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onAway = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('keydown', onKey);
    // mousedown, not click: a click listener fires on the press that
    // opened it and closes it again in the same gesture.
    document.addEventListener('mousedown', onAway);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onAway);
    };
  }, [onClose]);

  const needle = find.trim().toLowerCase();
  const named = choices.map(([v, n]) => [v, n, v === BLANK ? BLANK_LABEL : v]);
  const matched = needle
    ? named.filter(([, , text]) => text.toLowerCase().includes(needle))
    : named;
  // Everything past the cap stays filterable through the box above it.
  const shown = matched.slice(0, CHOICE_LIMIT);
  const hidden = matched.length - shown.length;

  /*
   * An unfiltered column shows every box ticked.
   *
   * Internally an empty selection means "no filter on this column", which
   * is not the same thing as "nothing chosen" — every value is included.
   * Drawn literally that was every box empty on a column that was
   * excluding nothing, and next to a column that *was* filtered it read as
   * though the values had been deselected. It is how a spreadsheet shows
   * it, and the spreadsheet is what everybody here is comparing against.
   *
   * So the boxes are drawn from what passes rather than from what is
   * stored, and unticking one from the all-state stores everything else.
   */
  const all = choices.map(([v]) => v);
  /* null is "no filter on this column", and everything is therefore in. */
  const unfiltered = picked === null;
  const chosen = unfiltered ? all : picked;
  const isTicked = (v) => chosen.includes(v);

  /* Every box ticked is the same as no filter, and storing it as one would
     leave the funnel marked on a column that excludes nothing. */
  const store = (next) => onChange(next.length === all.length ? null : next);

  const toggle = (v) => store(
    chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v],
  );

  /** Several at once: a year, a month, or everything the search left. */
  const setMany = (vals, on) => {
    const base = new Set(chosen);
    for (const v of vals) { if (on) base.add(v); else base.delete(v); }
    store([...base]);
  };

  /*
   * The dates, grouped.
   *
   * Years newest first — a meeting is about what is open now, and the
   * oldest date on a backlog is the least likely thing anybody scrolls
   * for. Months and days read forwards inside them, as a calendar does.
   */
  const tree = useMemo(() => {
    if (!isDate) return null;
    const byYear = new Map();
    const loose = [];
    for (const [v, n, text] of named) {
      const d = parseChoiceDate(v);
      if (!d) { loose.push([v, n, text]); continue; }
      if (!byYear.has(d.y)) byYear.set(d.y, new Map());
      const months = byYear.get(d.y);
      if (!months.has(d.m)) months.set(d.m, []);
      months.get(d.m).push([v, n, d.d]);
    }
    const groups = [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, months]) => {
        const list = [...months.entries()].sort((a, b) => a[0] - b[0]).map(([month, days]) => {
          days.sort((a, b) => a[2] - b[2]);
          return {
            month, name: MONTHS[month - 1], days,
            total: days.reduce((t, [, n]) => t + n, 0),
          };
        });
        return {
          year,
          months: list,
          all: list.flatMap((m) => m.days),
          total: list.reduce((t, m) => t + m.total, 0),
        };
      });
    return { groups, loose };
  }, [isDate, named]);

  /* Searching a tree that is shut shows nothing, so it opens itself. */
  /* Which days the search matched, as year-month-day, so the tree can be
     narrowed without re-running the match for every branch. */
  const matchedSet = useMemo(() => {
    const out = new Set();
    if (!tree || !needle) return out;
    for (const [v, , text] of matched) {
      const d = parseChoiceDate(v);
      if (d) out.add(`${d.y}-${d.m}-${d.d}`);
    }
    return out;
  }, [tree, needle, matched]);

  const openKeys = useMemo(() => {
    if (!tree || !needle) return expanded;
    const out = new Set(expanded);
    for (const g of tree.groups) {
      out.add(String(g.year));
      for (const m of g.months) out.add(`${g.year}-${m.month}`);
    }
    return out;
  }, [tree, needle, expanded]);

  /*
   * What "(Select all)" covers: everything, or everything the search left.
   *
   * Taken from `matched` rather than `shown`, which is capped — a cap is
   * about how much to draw, and a person who searched and pressed select
   * all means the search, not the first two hundred of it.
   */
  const scope = matched.map(([v]) => v);
  const scopeCount = matched.reduce((t, [, n]) => t + n, 0);
  const ticked = scope.filter((v) => isTicked(v)).length;
  const scopeState = ticked === 0 ? 'off' : (ticked === scope.length ? 'on' : 'some');

  const onExpand = (key) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="colfilter" ref={ref} role="dialog" aria-label={`Filter ${label}`}>
      <div className="colfilter-head">
        <input
          autoFocus
          className="colfilter-find"
          placeholder={`Find in ${label.toLowerCase()}`}
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
      </div>

      {/*
        * Excel's "(Select All)", and it is here for the reason Excel has
        * it: picking one district out of fourteen should be untick-all
        * then tick-one, not thirteen separate unticks.
        *
        * It acts on whatever the search has left, so after typing
        * "Kannur" it means those. Tri-state, because "some of them" is a
        * real answer and a plain tick would lie about it.
        */}
      <label className="colfilter-row colfilter-all">
        <input
          type="checkbox"
          checked={scopeState === 'on'}
          ref={(el) => { if (el) el.indeterminate = scopeState === 'some'; }}
          onChange={() => setMany(scope, scopeState !== 'on')}
        />
        <span className="colfilter-value">
          {needle ? `(Select these ${scope.length})` : '(Select all)'}
        </span>
        <span className="colfilter-count">{scopeCount}</span>
      </label>

      <div className={`colfilter-list${tree ? ' is-tree' : ''}`}>
        {shown.length === 0 && <p className="colfilter-none">Nothing matches “{find}”.</p>}
        {/* A tree has no cap: a year is one row until it is opened, so the
            whole range fits without the list needing to be cut short. */}
        {!tree && hidden > 0 && (
          <p className="colfilter-more">{hidden} more — type to narrow</p>
        )}
        {tree ? (
          <DateTree
            groups={needle
              ? tree.groups
                .map((g) => ({
                  ...g,
                  months: g.months
                    .map((m) => ({ ...m, days: m.days.filter(([, , d]) => matchedSet.has(g.year + '-' + m.month + '-' + d)) }))
                    .filter((m) => m.days.length),
                }))
                .map((g) => ({ ...g, all: g.months.flatMap((m) => m.days) }))
                .filter((g) => g.months.length)
              : tree.groups}
            loose={needle ? tree.loose.filter(([, , t]) => t.toLowerCase().includes(needle)) : tree.loose}
            isTicked={isTicked}
            setMany={setMany}
            toggle={toggle}
            expanded={openKeys}
            onExpand={onExpand}
          />
        ) : (
        shown.map(([v, n, text]) => (
          <label key={v} className={`colfilter-row${v === BLANK ? ' is-blank' : ''}`}>
            <input
              type="checkbox"
              checked={isTicked(v)}
              onChange={() => toggle(v)}
            />
            <span className="colfilter-value" title={text}>{text}</span>
            <span className="colfilter-count">{n}</span>
          </label>
        )))}
      </div>

      <div className="colfilter-foot">
        {/* Acts on what the search left, so "All" after typing "Cautery"
            means those, which is the only reading that is any use. */}
        {/* Named for what it does to the column, not to the boxes: it takes
            the filter off, which is why it is dead when there is none. The
            ticking is all done by the row at the top now. */}
        <button type="button" onClick={() => onChange(null)} disabled={unfiltered}>
          Clear filter
        </button>
      </div>
    </div>
  );
}

/**
 * The daily penalty meeting.
 *
 * Left of the divider is the export — zone, district, facility, equipment, age,
 * penalty — and none of it is editable, because it is rebuilt from the TM file
 * every morning and anything typed over it would be gone by the next one. Right
 * of it is what the meeting decides, which lives in Supabase and follows the
 * ticket across exports.
 *
 * The global filter bar narrows which calls arrive here. The search and sort
 * below are a second, finer pass over that — during the meeting somebody says a
 * ticket number or a hospital name and it has to be found in one move, which is
 * not what a date range and a district dropdown are for.
 */

/** Saved on blur rather than on every keystroke — one row per word typed would
 *  fill the audit trail with noise and hammer the connection during a meeting. */
function Cell({ value, kind, options, disabled, onCommit, autoFocus, onDone }) {
  const [draft, setDraft] = useState(value ?? '');
  const [state, setState] = useState('idle'); // idle | saving | saved | error

  // A colleague's edit arriving over the wire should win over a stale draft,
  // but not while this person is mid-word in the field.
  useEffect(() => { setDraft(value ?? ''); }, [value]);

  const commit = async () => {
    const next = draft === '' ? null : draft;
    if ((value ?? null) === next) return;
    setState('saving');
    try {
      await onCommit(next);
      setState('saved');
      setTimeout(() => setState('idle'), 1200);
    } catch (e) {
      setDraft(value ?? '');
      setState('error');
      setTimeout(() => setState('idle'), 2600);
    }
  };

  const common = {
    value: draft,
    disabled,
    autoFocus,
    onChange: (e) => setDraft(e.target.value),
    // Save first, then hand back — a grid cell that closed before the
    // write went out would lose whatever was typed into it.
    onBlur: async () => { await commit(); onDone?.(); },
    className: `cell cell-${state}`,
  };

  if (kind === 'select') {
    return (
      <select {...common}>
        <option value="">—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input
      {...common}
      type={kind === 'date' ? 'date' : (kind === 'number' ? 'number' : 'text')}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

/**
 * One meeting field in the grid: a value you can read, and an editor when
 * you want one.
 *
 * Nine hundred rows times twenty-three fields is twenty thousand cells.
 * As live inputs that is twenty thousand controlled components, which is
 * the reason these were pulled out of the grid the first time — it does
 * not scroll, it crawls. A span costs nothing, and the row you are
 * actually editing is one.
 *
 * The editor is the same Cell the form uses, so there is one definition
 * of how a date behaves, one save-on-blur, and one place for it to go
 * wrong.
 */
export function GridCell({ fieldKey, value, kind, options, disabled, onCommit }) {
  const [editing, setEditing] = useState(false);
  const shown = shownValue(fieldKey, value);

  if (editing) {
    return (
      <Cell
        value={value}
        kind={kind}
        options={options}
        disabled={disabled}
        autoFocus
        onCommit={onCommit}
        onDone={() => setEditing(false)}
      />
    );
  }
  return (
    <button
      type="button"
      className={`grid-cell${shown ? '' : ' is-nil'}`}
      title={shown ? String(shown) : undefined}
      disabled={disabled}
      onClick={() => setEditing(true)}
      /*
       * Opened by intent, never by arriving.
       *
       * This opened on focus, to make tabbing across a row feel like a
       * spreadsheet. It does the opposite: committing a cell moves focus
       * to the next button, which opened that one, which opened the next
       * — four cells at a time left standing as live inputs, which is the
       * cost this whole arrangement exists to avoid. Tab now moves, and
       * Enter or a click opens, which is what a spreadsheet actually does.
       */
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); setEditing(true); }
      }}
    >
      {/* The text is clamped, not the button. Chrome refuses
          `display: -webkit-box` on a <button> — it computes to flow-root —
          so the line clamp on the button itself never did anything, the
          content ran to whatever height it liked, and the row grew with
          it. A span takes the box. */}
      <span className="grid-cell-text">{shown || '—'}</span>
    </button>
  );
}

/**
 * Everything the meeting records against a ticket — all twenty-three fields.
 *
 * Two of them used to sit in the grid as live inputs. That put a dropdown and a
 * free-text box on every one of nine hundred rows, which is a lot of controls to
 * scroll past to reach the ticket you want, and it pushed the columns that
 * identify the row off the side of the screen. The grid now identifies calls;
 * this form changes them.
 */
function EntryDialog({ ticket, note, types, canEdit, onCommit, onClose, subtitle }) {
  const ref = useRef(null);

  useEffect(() => {
    /*
     * Focus the dialog, never a field in it.
     *
     * It used to focus the first control, which is a date input — and on a phone
     * focusing one opens the native picker, so simply pressing More put today's
     * date into TRC given and the blur handler saved it. Three tickets were
     * stamped that way before anyone touched a field. Opening a form must not
     * fill it in.
     */
    ref.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // The grid scrolls horizontally; letting the page move underneath a modal
    // makes it look like the dialog is sliding.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Meeting entry for ticket ${ticket}`}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">Ticket {ticket}</span>
            <h2>Meeting entry</h2>
            {subtitle && <p className="caption">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {/* Penalty type and current status lead, because they are the two the
              meeting fills on almost every ticket — 99% and 27% of the source
              sheet, against under 3% for everything below them. */}
          <div className="modal-grid">
            {MEETING_FIELDS.map((f) => (
              <label key={f.key} className="field">
                <span>{f.label}</span>
                {isComputed(f.key) ? (
                  <span className="field-computed">
                    {computeField(f.key, note) ?? '—'}
                    <em>worked out from the dates</em>
                  </span>
                ) : (
                  <Cell
                    value={note?.[f.key]}
                    kind={f.kind}
                    options={types}
                    disabled={!canEdit}
                    onCommit={onCommit(f.key)}
                  />
                )}
              </label>
            ))}
          </div>

          {note?.legacy_values && (
            <p className="caption meeting-legacy">
              From the old sheet:{' '}
              {Object.entries(note.legacy_values).map(([k, v]) => `${k} = ${v}`).join(' · ')}
            </p>
          )}
        </div>

        <div className="modal-foot">
          <p className="caption">
            {canEdit ? 'Each field saves as you leave it.' : 'Read only.'}
          </p>
          <button type="button" className="modal-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything ever recorded against one ticket, newest first.
 *
 * The trigger has been writing this since the schema was created — column,
 * before, after, who, when — and nothing had ever shown it. A meeting that
 * carries money needs to be able to answer "who put that there, and when",
 * including when the answer is that somebody cleared a field.
 */
function LogDialog({ state, ticket, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    loadLog(state, ticket)
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) { setError(e.message); setRows([]); } });
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      live = false;
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [state, ticket, onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`History for ticket ${ticket}`}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">Ticket {ticket}</span>
            <h2>Entry history</h2>
            <p className="caption">
              Every change to this ticket&rsquo;s meeting entries, newest first.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {error && <p className="upload-error">{error}</p>}
          {!rows && <div className="loader" aria-hidden="true" />}
          {rows && rows.length === 0 && (
            <p className="empty">Nothing has been entered against this ticket yet.</p>
          )}
          {rows && rows.length > 0 && (
            <ol className="log-list">
              {rows.map((r) => (
                <li key={r.id} className="log-entry">
                  {/* The name leads and the code follows it.
                      "E641" is a lookup, and the person who has to do the
                      lookup is whoever just asked who changed this. The
                      code stays because it is what people are addressed by
                      here and what a search box takes, and a name alone is
                      ambiguous the day there are two of them. */}
                  <div className="log-when">
                    <strong>{r.changed_by_name ?? r.changed_by_code ?? 'System'}</strong>
                    {r.changed_by_name && r.changed_by_code && (
                      <span className="log-who-code">{r.changed_by_code}</span>
                    )}
                    <span>{stamp(r.changed_at)}</span>
                  </div>
                  <div className="log-what">
                    <span className="log-field">{FIELD_LABEL[r.column_name] ?? r.column_name}</span>
                    {/* Cleared and set are different events and must not both
                        render as an arrow into nothing. */}
                    {r.new_value == null ? (
                      <span className="log-change">
                        cleared <s>{shownValue(r.column_name, r.old_value)}</s>
                      </span>
                    ) : (
                      <span className="log-change">
                        {r.old_value != null && (
                          <><s>{shownValue(r.column_name, r.old_value)}</s> → </>
                        )}
                        <b>{shownValue(r.column_name, r.new_value)}</b>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="modal-foot">
          <p className="caption">
            {rows ? `${rows.length} change${rows.length === 1 ? '' : 's'} recorded` : ' '}
          </p>
          <button type="button" className="modal-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}


/*
 * What the tracker is doing while you wait, and how far through it is.
 *
 * Three round trips of work, weighted by what each was measured to cost so
 * the bar moves at something like a steady rate rather than sitting at 35%
 * for most of the wait. Within a phase the fraction is real: every request
 * that lands moves it.
 *
 * The wording is what is happening, not what the code is called. "Loading
 * the meeting entries" is a thing somebody waiting can recognise; "fetching
 * meeting_note" is not.
 */
/*
 * The log column's width.
 *
 * It is the one column not in `columns` — it carries a button rather than a
 * value, so it has no filter, no sort and no entry field, and it is written
 * by hand at the end of both rows. That is exactly why it needs stating
 * here: the table is laid out at the sum of its columns, and a column left
 * out of that sum is a column with nothing left over for it. It rendered at
 * nought pixels wide, heading and button and all.
 */
const LOG_WIDTH = 96;

const LOAD_PHASES = [
  { key: 'prepare', label: 'Preparing the tracker', weight: 0.3 },
  { key: 'closed', label: 'Checking what has closed since the last export', weight: 0.1 },
  { key: 'entries', label: 'Loading the meeting entries', weight: 0.6 },
];

export default function MeetingTab({
  ds, rows, unresolvedRows = null, referenceDay, canEdit, onSelectRow,
}) {
  const { cols, dict } = ds;
  const state = ds.meta.id;
  const hasZone = dict.zone.length > 0;
  const grace = ds.meta.graceDays ?? 7;

  const [view, setView] = useState('tickets');
  const [notes, setNotes] = useState(null);
  /** null once loaded; `{ pct, label }` while the three phases run. */
  const [progress, setProgress] = useState({ pct: 0, label: LOAD_PHASES[0].label });
  const [types, setTypes] = useState([]);
  /**
   * The tracker, filling the screen.
   *
   * Asked for by the people who spend the meeting in it: thirty-one
   * columns inside a panel on a dashboard is a letterbox, and the width
   * is the whole point once the meeting's own fields are in the grid.
   */
  const [full, setFull] = useState(false);
  /** Column key -> the values kept. An absent or empty key filters nothing. */
  const [filters, setFilters] = useState({});
  /** Which column's list is open. One at a time. */
  const [openFilter, setOpenFilter] = useState(null);

  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [log, setLog] = useState(null);

  /*
   * Escape closes the innermost thing that is open.
   *
   * Every layer listens on the document, so without this a filter list
   * open inside full screen took both away with one press — the list you
   * meant to close, and the screen you were reading it on. Moved below
   * the dialogs it has to know about, because a dependency array naming
   * a const declared further down is read during render and throws.
   */
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // A list or a dialog is nearer the front; its own handler has it.
      if (openFilter || detail || log) return;
      setFull(false);
    };
    document.addEventListener('keydown', onKey);
    // Nothing should scroll behind it, the same way the entry form does it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [full, openFilter, detail, log]);
  const [sync, setSync] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null); // { key, dir } — null keeps the export's order

  const columns = useMemo(() => exportColumns(hasZone), [hasZone]);

  /*
   * Column widths somebody has set for themselves.
   *
   * Per device and per contract, like the saved filter view: how wide
   * Facility should be depends on the screen it is being read on, and
   * Kerala's facility names are not Andhra's. Kept as plain pixels
   * because that is what the drag produces and what the style takes —
   * nothing is gained by storing a ratio and recomputing it.
   *
   * A column with no entry here falls back to the ceiling on its field
   * definition, so the defaults keep working and only what has actually
   * been dragged is remembered.
   */
  const widthKey = `bemmp.tracker.widths.${state}`;
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(widthKey) ?? '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      // Private windows and blocked storage throw rather than return
      // null. Default widths are a fine answer; failing to draw is not.
      return {};
    }
  });

  /*
   * The width a column is laid out at.
   *
   * A dragged width wins; otherwise the column's own default. Every column
   * carries one, and that matters more than it looks: the layout is fixed,
   * which takes its widths from the first row — and with only the visible
   * rows built, "the first row" is whichever one you have scrolled to. A
   * column left to size itself would therefore change width as you scroll.
   */
  const widthStyle = useCallback((key, fallback) => {
    const w = widths[key] ?? fallback;
    return w ? { width: w, minWidth: w, maxWidth: w } : undefined;
  }, [widths]);

  /*
   * The table's own width: the sum of its columns.
   *
   * Stating it is what makes the fixed layout hold. Left to size itself the
   * table falls back to measuring content — a heading with a sort control
   * and a filter button will not shrink below the two of them side by side,
   * so several columns came out wider than asked and the widths stopped
   * being the widths. Given a number, every column is exactly what it says.
   */
  const tableWidth = useMemo(
    () => columns.reduce((n, c) => n + (widths[c.key] ?? c.w ?? 0), 0) + LOG_WIDTH,
    [columns, widths],
  );

  const remember = useCallback((next) => {
    setWidths(next);
    try { localStorage.setItem(widthKey, JSON.stringify(next)); } catch { /* see above */ }
  }, [widthKey]);

  /**
   * Drag one column edge.
   *
   * Pointer events rather than mouse: the same code then works for a
   * finger and a stylus, and setPointerCapture keeps the drag alive when
   * the cursor runs ahead of the header, which it will — the whole point
   * is to make a column wider than the space it currently has.
   */
  const startResize = (key, e) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest('th');
    const from = th.getBoundingClientRect().width;
    const x0 = e.clientX;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);

    // The last width the drag produced, so the write at the end does
    // not have to go looking for it in state.
    let settled = from;
    const move = (ev) => {
      // 70px is about as narrow as a heading can be and still be read.
      settled = Math.max(70, Math.round(from + (ev.clientX - x0)));
      setWidths((w) => (w[key] === settled ? w : { ...w, [key]: settled }));
    };
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      document.body.classList.remove('is-resizing');
      // Written once at the end rather than on every pixel of the drag,
      // and from a plain value rather than inside a state updater —
      // StrictMode runs those twice, and a double write is a side effect
      // sitting where React expects a pure function.
      remember({ ...widths, [key]: settled });
    };
    document.body.classList.add('is-resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  };

  /** Double-click an edge to give that column its default back. */
  const resetWidth = (key) => {
    const next = { ...widths };
    delete next[key];
    remember(next);
  };



  /*
   * The row's display values, resolved once.
   *
   * Search and sort both need the text, and reading it off the typed arrays and
   * through the dictionaries on every keystroke would do that work hundreds of
   * times for a single word typed. `haystack` is pre-lowercased for the same
   * reason.
   */
  const records = useMemo(() => rows.map((row) => {
    const ticket = ticketLabel(ds, row);
    const zone = hasZone ? label(dict.zone, cols.zone[row]) : '';
    const district = label(dict.district, cols.district[row]);
    const facility = label(dict.facilityName, cols.facilityName[row]);
    const equipment = label(dict.equipment, cols.equipment[row]);
    const barcode = label(dict.barcode, cols.barcode[row], '');
    const manufacturer = label(dict.manufacturer, cols.manufacturer[row], '');
    const model = label(dict.model, cols.model[row], '');
    const status = label(dict.status, cols.status[row], '');
    const assigned = label(dict.engineer, cols.engineer[row], '');
    const remark = label(dict.parkedReason, cols.parkedReason[row], '');
    const logged = cols.loggedDay[row] ? formatDay(cols.loggedDay[row]) : '';
    // The column is absent from anything published before it existed, which
    // reads as an empty cell rather than an error — see `datasetFrom`.
    const installedDay = cols.installedDay ? cols.installedDay[row] : -1;
    const installed = installedDay > 0 ? formatDay(installedDay) : '';
    return {
      row,
      ticket,
      /*
       * The export's own Down Days, not `referenceDay - loggedDay`.
       *
       * The meeting reconciles this grid against `KL Ticket Wise - Tracker.xlsx`,
       * which drives every figure off column AI. The two disagree by exactly one
       * day on 667 of 807 open Kerala rows — the export does not count the day a
       * call was logged — and that one day moves 13 calls across the penalty
       * threshold. A tracker that cannot be tied back to the workbook it is
       * checked against is a tracker nobody trusts, so the tracker follows the
       * workbook and the dashboard keeps its own rule.
       */
      age: cols.downDays[row],
      zone,
      district,
      facility,
      equipment,
      rate: cols.dayRate[row],
      /* `(Down Days - grace) x rate`, floored — the workbook's own column R,
         for the same reason. Floored because a ticket still inside its grace
         window owes nothing and the subtraction would otherwise go negative. */
      accrued: Math.max(0, cols.downDays[row] - grace) * cols.dayRate[row],
      barcode,
      manufacturer,
      model,
      logged,
      installed,
      status,
      assigned,
      remark,
      // Everything somebody might have in front of them when they come
      // looking: a barcode off the machine, an engineer's name, a model.
      haystack: `${ticket} ${zone} ${district} ${facility} ${equipment} ${barcode} ${manufacturer} ${model} ${status} ${assigned} ${remark}`.toLowerCase(),
    };
  }), [ds, rows, cols, dict, referenceDay, hasZone]);

  const load = useCallback(async () => {
    setError(null);

    /*
     * Progress across the phases, never backwards.
     *
     * Each phase reports how far through its own requests it is; this turns
     * that into one number by adding up the phases already finished. A bar
     * that goes back because a later phase turned out to have more requests
     * in it than an earlier one is worse than no bar.
     */
    const before = (key) => LOAD_PHASES
      .slice(0, LOAD_PHASES.findIndex((ph) => ph.key === key))
      .reduce((n, ph) => n + ph.weight, 0);

    /* The weights add to one, so the arithmetic cannot exceed a hundred.
       Clamped anyway: a bar that reads 105% is a bar nobody believes the
       rest of, and one wrong weight is all it would take. */
    const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

    const phase = (key) => {
      const self = LOAD_PHASES.find((ph) => ph.key === key);
      const base = before(key);
      setProgress({ pct: clamp(base * 100), label: self.label });
      return (done, total) => setProgress({
        pct: clamp((base + self.weight * (total ? Math.min(done / total, 1) : 1)) * 100),
        label: self.label,
      });
    };

    try {
      const ids = records.map((t) => t.ticket);

      const step = phase('prepare');
      const [list] = await Promise.all([
        supabase.from('penalty_type').select('name').eq('archived', false).order('sort'),
        canEdit ? ensureRows(state, ids, step) : Promise.resolve(),
      ]);
      setTypes((list.data ?? []).map((r) => r.name));

      if (canEdit) {
        phase('closed');
        setSync(await reconcileOpen(state, ids));
      }

      const loaded = await loadNotes(state, ids, phase('entries'));
      setProgress({ pct: 100, label: 'Ready' });
      setNotes(loaded);
    } catch (e) {
      setError(e.message);
      setNotes(new Map());
    }
  }, [state, records, canEdit]);

  useEffect(() => { load(); }, [load]);

  const commit = useCallback((ticket, key) => async (value) => {
    const updated = await saveField(state, ticket, key, value);
    setNotes((prev) => new Map(prev).set(ticket, updated));
  }, [state]);

  /*
   * Search then sort, both over the same list.
   *
   * The search covers what is said out loud in the meeting — a ticket number, a
   * hospital, a piece of equipment — and every word has to match, so "kannur
   * dialysis" narrows rather than widening the way a single-substring match on
   * the whole phrase would.
   */
  /*
   * The meeting's own answers, joined onto each row.
   *
   * Deliberately not folded into `records`: load() depends on records, so
   * records depending on notes would make load a new function every time
   * a field saved — a refetch loop rather than a join.
   *
   * It buys two things. Sorting on any of the twenty-three, because the
   * sort reads the value off the row; and finding a ticket by its PO
   * number, which is the thing people actually have in front of them
   * when they come looking.
   */
  const joined = useMemo(() => {
    /*
     * Null until the first load returns, and this runs before it.
     *
     * It has to: hooks cannot sit below the `if (!notes)` return further
     * down, which the note beside the summary memo already says. So the
     * guard belongs here rather than in where the hook is placed —
     * `notes.size` on the first render took the whole dashboard down to
     * a white page, because a throw in a memo is a throw in render and
     * there is no error boundary above it.
     */
    if (!notes || notes.size === 0) return records;
    return records.map((r) => {
      const n = notes.get(r.ticket);
      if (!n) return r;
      const extra = {};
      let text = '';
      for (const f of MEETING_FIELDS) {
        const v = isComputed(f.key) ? computeField(f.key, n) : n[f.key];
        extra[f.key] = v ?? '';
        if (v != null && v !== '') text += ` ${String(v).toLowerCase()}`;
      }
      return { ...r, ...extra, haystack: r.haystack + text };
    });
  }, [records, notes]);

  /*
   * What is actually in each filterable column, and how often.
   *
   * Off `records` rather than off the filtered list on purpose: a value
   * that disappears from its own filter the moment you pick it is a
   * list you cannot correct without starting again.
   */
  /*
   * What the search alone leaves, before any column filter.
   *
   * Shared on purpose: the rows below are this narrowed further by the
   * filters, and each filter's own list is this narrowed by every filter
   * EXCEPT its own. Computing it once is also the difference between one
   * pass over nine hundred rows and thirty-one of them.
   */
  const searched = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length
      ? joined.filter((r) => terms.every((t) => r.haystack.includes(t)))
      : joined;
  }, [joined, query]);

  /*
   * A column with no entry here is not filtered. A column with an empty
   * list is filtered to nothing.
   *
   * Those used to be the same value, which is why there was no way to
   * unselect all: emptying the list read as "no filter" and put every row
   * back. Isolating one district out of fourteen therefore meant unticking
   * thirteen, one at a time.
   *
   * `Array.isArray` rather than a length test, so the empty list survives
   * into applyFilters — where `[].includes(x)` is false for every x, which
   * is exactly what filtering to nothing means.
   */
  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, v]) => Array.isArray(v)),
    [filters],
  );

  /*
   * Each column's list, narrowed by the other columns.
   *
   * Filtering to a district and then opening Facility should offer the
   * facilities in that district, not all four hundred in the state —
   * otherwise the second filter is a list of options that mostly return
   * nothing.
   *
   * Every filter EXCEPT this column's own, which is the part that is
   * easy to get wrong: narrowing a list by its own filter leaves it
   * showing only what is already ticked, and there is then no way to add
   * a second district or to see what you have excluded.
   */
  const choices = useMemo(
    () => buildChoices(searched, columns, activeFilters),
    [searched, columns, activeFilters],
  );

  /*
   * How many rows to draw, and where.
   *
   * The tracker holds every call without a resolved date — about eight
   * thousand three hundred on Kerala — and thirty-eight columns across
   * all of them is a quarter of a million cells and half a million DOM
   * nodes. Measured: sixteen and a half seconds before the first row
   * appeared, which is not a grid, it is a wait.
   *
   * So only what is on screen is built, with a band above and below so
   * scrolling has somewhere to go before the next batch is needed, and
   * two spacer rows standing in for the height of everything else. The
   * scrollbar is the true size of the backlog; the DOM is a window onto
   * it.
   *
   * Fixed row height is what makes the arithmetic possible, and is why
   * the table lays out fixed with a width on every column: with an
   * automatic layout the widths would be computed from whichever forty
   * rows happened to be in view and would jump as you scrolled.
   */
  /*
   * One row, one height.
   *
   * Two lines of a status at this size, plus the padding around them. It
   * was 38, which is one line — but the clamp meant to hold it there was
   * on a button and silently did nothing, so a long current-status ran to
   * sixty-nine pixels and the arithmetic below, which assumes every row is
   * ROW_H, drifted further from the truth the further you scrolled.
   *
   * Fewer rows on screen than 38 gave. That is the trade for being able to
   * read the column the meeting spends its time in; the whole value is on
   * the cell's title, and in the entry form, either way.
   */
  const ROW_H = 52;
  const OVERSCAN = 12;
  /*
   * A callback ref, not a useRef with an empty dependency list.
   *
   * The scroll box does not exist on the first render — the component
   * shows a loader until the notes arrive — so an effect that looks once
   * at mount finds null, attaches nothing, and never looks again. The
   * scrollbar then worked and the window never moved: the same forty
   * rows at the top, the middle and the bottom.
   *
   * A callback ref runs when the node appears and again when it goes, so
   * the listener follows the element rather than the mount.
   */
  /*
   * Swipe-to-go-back, off while the pointer is over the grid.
   *
   * overscroll-behavior on the grid itself is not enough, and that is the
   * part worth writing down: `contain` stops a scroll chaining to the
   * element's ancestors, but the browser's back gesture is triggered at
   * the viewport, not by the chain. A nested scroller that has run out of
   * room hands the gesture straight to the browser regardless, and the
   * only place the rule is read for that is the root element.
   *
   * So it is set on the root, and only while somebody is actually in the
   * grid — 38 columns read by scrolling sideways is where the gesture
   * fires, and taking Back away from the whole app to fix one panel is a
   * bigger change than the problem.
   */
  const holdBack = useCallback((on) => {
    document.documentElement.classList.toggle('no-swipe-back', on);
  }, []);

  // Whatever happens to the component — a tab change, full screen, an
  // error boundary — the page must not be left unable to go back.
  useEffect(() => () => holdBack(false), [holdBack]);

  const [box, setBox] = useState(null);
  const scrollBox = useCallback((el) => setBox(el), []);
  const [scrollTop, setScrollTop] = useState(0);
  const [boxH, setBoxH] = useState(600);

  useEffect(() => {
    if (!box) return undefined;
    const onScroll = () => setScrollTop(box.scrollTop);
    box.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => setBoxH(box.clientHeight || 600));
    ro.observe(box);
    setBoxH(box.clientHeight || 600);
    setScrollTop(box.scrollTop);
    return () => { box.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [box]);

  const visible = useMemo(() => {
    let list = searched;

    if (activeFilters.length) {
      list = applyFilters(list, activeFilters);
    }

    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      const col = columns.find((c) => c.key === sort.key);
      const byDate = col && isDateColumn(col);
      list = [...list].sort((a, b) => {
        if (col?.type === 'num') return (a[sort.key] - b[sort.key]) * dir;
        if (byDate) {
          const x = dateOrder(a[sort.key]);
          const y = dateOrder(b[sort.key]);
          // A cell with no date sits at the bottom either way round. It is
          // the absence of one, not a date before all the others.
          if (x === null && y === null) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          return (x - y) * dir;
        }
        return String(a[sort.key]).localeCompare(String(b[sort.key])) * dir;
      });
    }
    return list;
  }, [searched, sort, columns, activeFilters]);

  /*
   * The slice of rows actually built.
   *
   * Clamped to what exists, so a filter that shrinks the list while it
   * is scrolled down cannot leave the window past the end showing
   * nothing on a table that plainly has rows in it.
   */
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const count = Math.ceil(boxH / ROW_H) + OVERSCAN * 2;
  const start = Math.min(first, Math.max(0, visible.length - 1));
  const end = Math.min(visible.length, start + count);
  const window_ = visible.slice(start, end);
  const before = start;
  const after = Math.max(0, visible.length - end);

  /*
   * The tracker as a spreadsheet.
   *
   * Exports exactly what is on screen — after the search, in the current sort
   * order — because the button sits beside the search box and anything else
   * would be a surprise. Downloading 915 rows having just narrowed to 12 is not
   * what "download" means next to a filter.
   *
   * The meeting's own fields come with it. Zone, district and equipment are
   * already in the export somebody could open themselves; what is only here is
   * what the meeting decided, and that is the reason to take this file away.
   */
  const download = async () => {
    const columns = [
      { header: 'Ticket', key: 'ticket' },
      { header: 'Down Days', key: 'age', numeric: true },
      ...(hasZone ? [{ header: 'Zone', key: 'zone' }] : []),
      { header: 'District', key: 'district' },
      { header: 'Facility', key: 'facility' },
      { header: 'Equipment', key: 'equipment' },
      { header: 'Per day penalty', key: 'rate', numeric: true },
      { header: 'Penalty', key: 'accrued', numeric: true },
      ...MEETING_FIELDS.map((f) => ({ header: f.label, key: f.key })),
    ];

    const rows = visible.map((r) => {
      const note = notes.get(r.ticket) ?? {};
      return {
        ...r,
        // Dates as the page shows them. A date serial in a text column would be
        // a number nobody can read, and a real date cell needs a number format
        // this writer deliberately does not carry.
        ...Object.fromEntries(MEETING_FIELDS.map((f) => [
          f.key,
          isComputed(f.key) ? computeField(f.key, note) : shownValue(f.key, note[f.key]),
        ])),
      };
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const scope = query.trim() ? 'filtered' : 'all';
    saveBlob(
      await writeSheet({ sheetName: 'Ticket tracker', columns, rows }),
      `ticket-tracker-${state}-${scope}-${stamp}.xlsx`,
    );
  };

  const toggleSort = (key) => setSort((s) => {
    if (s?.key !== key) return { key, dir: 'asc' };
    // asc → desc → off, so a column can be let go of without reloading.
    if (s.dir === 'asc') return { key, dir: 'desc' };
    return null;
  });

  /*
   * The Summary, computed only while it is on screen.
   *
   * It walks every *unresolved* row — open and parked both, because the
   * workbook's "Total Open Calls" column counts both — where the grid above
   * walks open ones only. Penalty types are read off `records`, which covers the
   * open rows, and that is enough: a penalty call is open by definition.
   *
   * Above the `!notes` return below, and it has to stay there. A hook after an
   * early return is called on some renders and not others, so the first paint
   * (notes still loading) runs one fewer than the next one and React tears the
   * whole tree down — a blank page, not a broken panel.
   */
  const summary = useMemo(() => {
    if (view !== 'summary' || !notes) return null;
    const typeByRow = new Map();
    for (const r of records) {
      const name = notes.get(r.ticket)?.penalty_type;
      if (name) typeByRow.set(r.row, name);
    }
    return trackerSummary(
      ds, unresolvedRows ?? rows, (row) => typeByRow.get(row) ?? null, types,
    );
  }, [view, notes, records, ds, unresolvedRows, rows, types]);

  if (!notes) {
    return (
      <div className="panel tracker-loading">
        <h2>Daily penalty meeting</h2>
        <p className="caption">
          {rows.length.toLocaleString()} calls, and what the meeting has recorded
          against each one.
        </p>
        {/* A real figure, from requests that have actually landed. A bar
            that moves on a timer says the same thing whether the network is
            working or not, which is the one moment it is being read. */}
        <div
          className="tracker-progress"
          role="progressbar"
          aria-valuenow={progress.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={progress.label}
        >
          <div
            className="tracker-progress-fill"
            style={{
              width: `${progress.pct}%`,
              /* The gradient spans the track, not the fill — see the
                 stylesheet. At 25% the fill is a quarter as wide as the
                 track, so the gradient has to be four times the fill. */
              backgroundSize: `${progress.pct > 0 ? (10000 / progress.pct) : 100}% 100%`,
            }}
          />
        </div>
        <p className="tracker-progress-note">
          <span>{progress.label}</span>
          <span className="tracker-progress-pct">{progress.pct}%</span>
        </p>
      </div>
    );
  }

  const detailRecord = detail && records.find((r) => r.ticket === detail);

  return (
    <div className={`grid${full ? ' tracker-full' : ''}`} style={{ gap: 16 }}>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Daily penalty meeting</h2>
            {/* Says "every date" out loud, because the filter bar above this may
                well read "This month" — and a count that disagrees with the
                filter summary next to it looks like a fault rather than a
                decision. The oldest calls are the point of the meeting. */}
            <p className="caption">
              {rows.length.toLocaleString()} open calls as of {formatDay(referenceDay)}
              {' '}— the whole backlog, every date, not just the selected range.
              {' '}Entries save as you leave each field and carry over to tomorrow.
              {sync?.closed ? ` ${sync.closed.toLocaleString()} closed since the last export.` : ''}
            </p>
          </div>
          <div className="meeting-views">
            {/* Two readings of one backlog, so a segmented control rather than a
                tab of its own: the meeting works the list and checks the totals
                in the same sitting, and the sub-tabs above already carry the
                choice between the three buckets. */}
            <div className="segmented">
              {[['tickets', 'Tickets'], ['summary', 'Summary']].map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  aria-selected={view === id}
                  onClick={() => setView(id)}
                >
                  {text}
                </button>
              ))}
            </div>
            {!canEdit && <span className="drill-badge">read only</span>}
          </div>
        </div>
        {error && <p className="upload-error">{error}</p>}

        {view === 'tickets' && (
        <div className="meeting-tools">
          <div className="meeting-search">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
            </svg>
            <input
              type="search"
              value={query}
              placeholder={`Search ticket, ${hasZone ? 'zone, ' : ''}district, facility or equipment`}
              aria-label="Search the open calls"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button" className="field-clear" aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                     stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>

          {/* Only when it says something the caption above does not. Unfiltered
              it repeated the "724 open calls" already stated a line higher, which
              is a number to check rather than a number to read. */}
          {visible.length !== records.length && (
            <span className="meeting-count">
              {visible.length.toLocaleString()} of {records.length.toLocaleString()}
            </span>
          )}

          {/* Said once, and only until it has been used — a permanent
              instruction on a screen people work in every day is furniture. */}
          {!sort && (
            <span className="meeting-hint">Select any column heading to sort</span>
          )}

          {/* Beside the search, because what it downloads is what the search
              left on screen. */}
          <button
            type="button"
            className="meeting-export"
            onClick={download}
            title={query.trim()
              ? `Download these ${visible.length.toLocaleString()} calls as Excel`
              : `Download all ${visible.length.toLocaleString()} open calls as Excel`}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4v11M8 11l4 4 4-4" />
              <path d="M5 19h14" />
            </svg>
            Excel
          </button>

          <button
            type="button"
            className="meeting-full"
            onClick={() => setFull((v) => !v)}
            title={full
              ? 'Back to the dashboard (Esc)'
              : 'Fill the screen — easier to read across thirty-one columns'}
          >
            {full ? (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
              </svg>
            )}
            {full ? 'Exit full screen' : 'Full screen'}
          </button>

          {/* Says what it will undo, and is not there when there is
              nothing to undo. Filters join the same button rather than
              growing a second one beside it. */}
          {(query || sort || activeFilters.length > 0) && (
            <button
              type="button"
              className="filter-reset"
              onClick={() => { setQuery(''); setSort(null); setFilters({}); }}
            >
              Clear {[
                query ? 'search' : null,
                activeFilters.length ? 'filters' : null,
                sort ? 'sort' : null,
              ].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1')}
            </button>
          )}
        </div>
        )}
      </div>

      {view === 'summary' && summary && (
        <TrackerSummary summary={summary} referenceDay={referenceDay} formatDay={formatDay} />
      )}

      {view === 'tickets' && (
      <div className="panel">
        <div
          className="table-scroll meeting-scroll"
          ref={scrollBox}
          onPointerEnter={() => holdBack(true)}
          onPointerLeave={() => holdBack(false)}
        >
          <table className="meeting-table is-sortable" style={{ width: tableWidth }}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={[
                      c.align === 'num' ? 'num' : null,
                      // The ticket heading rides with its column.
                      c.key === 'ticket' ? 'col-pin' : null,
                      // Entry columns take a fixed ceiling and wrap; without
                      // it the widest free-text column eats the table.
                      c.entry ? `entry entry-${c.entry.kind}` : null,
                    ].filter(Boolean).join(' ') || undefined}
                    style={widthStyle(c.key, c.w)}
                    aria-sort={sort?.key === c.key
                      ? (sort.dir === 'asc' ? 'ascending' : 'descending')
                      : 'none'}
                  >
                    <span className="th-inner">
                    <button type="button" className="th-sort" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      <SortMark active={sort?.key === c.key} dir={sort?.dir} />
                    </button>
                    {/* Beside the sort rather than inside it: sorting and
                        narrowing are different intentions, and one control
                        doing both is the one people press by mistake. */}
                    {choices[c.key] && (
                      <span className="th-filter-wrap">
                        <button
                          type="button"
                          className={`th-filter${Array.isArray(filters[c.key]) ? ' is-on' : ''}`}
                          onClick={() => setOpenFilter(openFilter === c.key ? null : c.key)}
                          aria-label={Array.isArray(filters[c.key])
                            ? `${c.label}: ${filters[c.key].length} selected`
                            : `Filter by ${c.label}`}
                          title={`Filter by ${c.label}`}
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
                               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
                               strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 5h18l-7 8v6l-4 2v-8z" />
                          </svg>
                          {/* Shown at nought as well: a column filtered to
                              nothing is the one most worth marking, and an
                              unmarked funnel over an empty grid is a puzzle. */}
                          {Array.isArray(filters[c.key]) && (
                            <span className="th-filter-n">{filters[c.key].length}</span>
                          )}
                        </button>
                        {openFilter === c.key && (
                          <ColumnFilter
                            label={c.label}
                            isDate={isDateColumn(c)}
                            choices={choices[c.key]}
                            picked={filters[c.key] ?? null}
                            onChange={(next) => setFilters((f) => {
                              // null takes the filter off; an array — empty or
                              // not — is one.
                              if (next === null) {
                                const rest = { ...f };
                                delete rest[c.key];
                                return rest;
                              }
                              return { ...f, [c.key]: next };
                            })}
                            onClose={() => setOpenFilter(null)}
                          />
                        )}
                      </span>
                    )}
                    </span>
                    {/* The edge you drag. Its own element rather than a
                        border on the heading, because a two-pixel target
                        is one nobody hits — this is ten wide and sits
                        half over the gridline. */}
                    <span
                      className="th-resize"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c.label}`}
                      onPointerDown={(e) => startResize(c.key, e)}
                      onDoubleClick={() => resetWidth(c.key)}
                      title="Drag to resize · double-click to reset"
                    />
                  </th>
                ))}
                <th style={{ width: LOG_WIDTH, minWidth: LOG_WIDTH, maxWidth: LOG_WIDTH }}>
                  Log
                </th>
              </tr>
            </thead>
            <tbody>
              {/* The height of everything above the window. */}
              {before > 0 && <tr className="spacer" style={{ height: before * ROW_H }} />}
              {window_.map((r) => {
                const note = notes.get(r.ticket);
                return (
                  <tr key={r.ticket}>
                    {/* Pinned. With thirty-one columns the one thing that
                        must never scroll away is which row you are on. */}
                    <td className="col-pin">
                      <button type="button" className="linkish" onClick={() => onSelectRow(r.row)}>
                        {r.ticket}
                      </button>
                      {/* The whole form, for when somebody is filling in one
                          ticket properly rather than scanning across. Not a
                          column of its own — an affordance on a cell that is
                          always on screen anyway. */}
                      <button
                        type="button"
                        className="row-form"
                        onClick={() => setDetail(r.ticket)}
                        aria-label={`${canEdit ? 'Update' : 'View'} the entry for ${r.ticket}`}
                        title={canEdit ? 'Open the full entry form' : 'View the full entry'}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                             stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                             strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 20h4L19 9a2.8 2.8 0 10-4-4L4 16v4z" />
                        </svg>
                      </button>
                    </td>
                    {/* The number alone. The heading says "Down Days", so a
                        "d" on every one of eight thousand rows is the unit
                        repeated eight thousand times, and it stops the
                        column being read as figures. The dialog subtitle
                        keeps its "d" — there it is prose, and "5 open"
                        would say something else. */}
                    <td className="num">{r.age}</td>
                    {hasZone && <td>{r.zone}</td>}
                    <td>{r.district}</td>
                    <td>{r.facility}</td>
                    <td>{r.equipment}</td>
                    {/* The rest of what the export knows. In the heading
                        order above, and every one of them present: a body
                        row shorter than its heading row does not leave a
                        gap at the end, it slides every column after the
                        short one under the wrong title. */}
                    <td>{r.barcode || '—'}</td>
                    <td>{r.manufacturer || '—'}</td>
                    <td>{r.model || '—'}</td>
                    <td>{r.logged || '—'}</td>
                    <td>{r.installed || '—'}</td>
                    <td>{r.status || '—'}</td>
                    <td>{r.assigned || '—'}</td>
                    <td>{r.remark || '—'}</td>
                    {/* Bare numbers. Both columns are rupees, both say so in
                        their heading, and a ₹ on nine hundred rows is nine
                        hundred repetitions of a fact stated at the top. */}
                    <td className="num">
                      {r.rate > 0
                        ? r.rate.toLocaleString('en-IN')
                        : <span className="money-nil">—</span>}
                    </td>
                    <td className="num">
                      {r.accrued > 0
                        ? r.accrued.toLocaleString('en-IN')
                        : <span className="money-nil">—</span>}
                    </td>
                    {/* What the meeting decided, in the grid rather than
                        behind a click each. Text until pressed — see
                        GridCell for why that matters at this row count. */}
                    {MEETING_FIELDS.map((f) => (
                      <td
                        key={f.key}
                        className={`entry entry-${f.kind}${f.kind === 'number' ? ' num' : ''}`}
                        style={widthStyle(f.key, ENTRY_WIDTH[f.key])}
                      >
                        {/* Four of these are arithmetic on the dates beside
                            them, so there is nothing to type and no way to
                            type it. See COMPUTED in data/meeting.js. */}
                        {isComputed(f.key) ? (
                          <span className="cell-computed">
                            {computeField(f.key, note) ?? '—'}
                          </span>
                        ) : (
                          <GridCell
                            fieldKey={f.key}
                            value={note?.[f.key]}
                            kind={f.kind}
                            options={types}
                            disabled={!canEdit}
                            onCommit={commit(r.ticket, f.key)}
                          />
                        )}
                      </td>
                    ))}
                    {/* One label on every row. Carrying the count and the last
                        editor here made the widest column in the grid out of the
                        least urgent thing in it — the trail matters when
                        somebody asks, and then a click is the right price. */}
                    <td className="log-cell">
                      <button
                        type="button"
                        className="row-more"
                        onClick={() => setLog(r.ticket)}
                      >
                        See log
                      </button>
                    </td>
                  </tr>
                );
              })}
              {after > 0 && <tr className="spacer" style={{ height: after * ROW_H }} />}
            </tbody>
          </table>

          {visible.length === 0 && (
            <p className="empty">No open call matches “{query}”.</p>
          )}
        </div>
      </div>
      )}

      {detail && (
        <EntryDialog
          ticket={detail}
          note={notes.get(detail)}
          types={types}
          canEdit={canEdit}
          subtitle={detailRecord
            ? `${detailRecord.facility} · ${detailRecord.equipment} · ${detailRecord.age}d open`
            : null}
          onCommit={(key) => commit(detail, key)}
          onClose={() => setDetail(null)}
        />
      )}

      {log && <LogDialog state={state} ticket={log} onClose={() => setLog(null)} />}
    </div>
  );
}

/**
 * The pair of arrows every sortable heading carries.
 *
 * It used to appear only on the column already sorted, on the argument that six
 * arrows say nothing — which was wrong in the way that matters: with no mark at
 * all, nobody could tell the headings were controls, so the sort went unused.
 * Both arrows faint means "this sorts"; one lit means "this is the sort, this
 * way". The unlit half stays visible so the lit one reads as a direction rather
 * than as decoration.
 */
function SortMark({ active, dir }) {
  return (
    <svg
      className={`sort-mark${active ? ' is-active' : ''}`}
      viewBox="0 0 8 13" width="8" height="13" aria-hidden="true"
    >
      <path className={active && dir === 'asc' ? 'is-on' : undefined} d="M4 0.5 7.2 4.6H0.8Z" />
      <path className={active && dir === 'desc' ? 'is-on' : undefined} d="M4 12.5 0.8 8.4H7.2Z" />
    </svg>
  );
}
