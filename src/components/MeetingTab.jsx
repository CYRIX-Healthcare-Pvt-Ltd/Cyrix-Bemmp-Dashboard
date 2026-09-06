import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDay, label, ticketLabel } from '../data/store.js';
import { writeSheet, saveBlob } from '../data/xlsx.js';
import { supabase } from '../data/supabase.js';
import { trackerSummary } from '../data/summary.js';
import TrackerSummary from './TrackerSummary.jsx';
import {
  BLANK, BLANK_LABEL, MEETING_FIELDS, applyFilters, asChoice, buildChoices,
  computeField, ensureRows, isComputed, loadLog, loadNotes, reconcileOpen,
  saveField,
} from '../data/meeting.js';

/** Column keys are database names; the log has to read like the form does. */
const FIELD_LABEL = Object.fromEntries(MEETING_FIELDS.map((f) => [f.key, f.label]));
const DATE_FIELDS = new Set(MEETING_FIELDS.filter((f) => f.kind === 'date').map((f) => f.key));

/**
 * `13-Aug-2026`.
 *
 * The database hands dates back as `2026-08-13`, which is unambiguous to a
 * machine and to nobody else — read aloud in a meeting it invites the question
 * of which number is the month. A named month cannot be misread.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function asDate(value) {
  // Date columns arrive as `YYYY-MM-DD`; anything else is passed through rather
  // than run through a parser that would turn a PO number into a date.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return value;
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`;
}

/** A value as it should read in the log: dates named, everything else verbatim. */
const shownValue = (column, value) => (DATE_FIELDS.has(column) ? asDate(value) : value);

/** When a change was made. Date in the same shape, plus the time. */
function stamp(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}, ${time}`;
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

/**
 * One column's filter: what is in this column, and which of it to keep.
 *
 * Values come with their counts because the count is half the decision —
 * "Cautery (3)" tells you whether narrowing to it is worth doing before
 * you do it. The search box inside matters at facility, where a state
 * has hundreds and scrolling a list of them is not better than the grid
 * it was meant to save you from.
 */
export function ColumnFilter({ label, choices, picked, onChange, onClose }) {
  const [find, setFind] = useState('');
  const ref = useRef(null);

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

  const toggle = (v) => onChange(
    picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v],
  );

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

      <div className="colfilter-list">
        {shown.length === 0 && <p className="colfilter-none">Nothing matches “{find}”.</p>}
        {hidden > 0 && (
          <p className="colfilter-more">{hidden} more — type to narrow</p>
        )}
        {shown.map(([v, n, text]) => (
          <label key={v} className={`colfilter-row${v === BLANK ? ' is-blank' : ''}`}>
            <input
              type="checkbox"
              checked={picked.includes(v)}
              onChange={() => toggle(v)}
            />
            <span className="colfilter-value">{text}</span>
            <span className="colfilter-count">{n}</span>
          </label>
        ))}
      </div>

      <div className="colfilter-foot">
        {/* Acts on what the search left, so "All" after typing "Cautery"
            means those, which is the only reading that is any use. */}
        <button type="button" onClick={() => onChange([
          ...new Set([...picked, ...shown.map(([v]) => v)]),
        ])}>
          Select all
        </button>
        <button type="button" onClick={() => onChange([])} disabled={picked.length === 0}>
          Clear
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
      {shown || '—'}
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
                  <div className="log-when">
                    <strong>{r.changed_by_code ?? 'System'}</strong>
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

/** Column definitions for the read-only half, so the header and the body cannot
 *  drift apart when one of them is conditional. */
/**
 * The meeting's own fields, as columns.
 *
 * Reversed from the note below: two of these used to be live inputs in
 * the grid and were pulled out because a dropdown and a text box on nine
 * hundred rows is a lot to scroll past, and because they pushed the
 * columns that identify a row off the side. The people who fill these in
 * asked for all twenty-three back, and the two objections are answered
 * rather than ignored — the ticket column is pinned so the row is always
 * identified, full screen gives the width, filters cut what you scroll
 * past, and a cell is text until you click it, so nine hundred rows are
 * nine hundred spans rather than twenty thousand live inputs.
 *
 * The low fill rate was probably the cause and not the reason: nothing
 * below the first two clears 3%, and reaching them cost a click per row.
 */
const ENTRY_COLUMNS = MEETING_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  type: f.kind === 'number' ? 'num' : 'text',
  align: f.kind === 'number' ? 'num' : undefined,
  /** Present on exactly the columns that are editable. */
  entry: f,
}));

function exportColumns(hasZone) {
  return [
    { key: 'ticket', label: 'Ticket', type: 'text' },
    /* "Down days", which is what the business calls it. On this tab it is exact:
       the tracker is open calls only, so days since logging is days the
       equipment has been down. */
    { key: 'age', label: 'Down Days', type: 'num', align: 'num' },
    ...(hasZone ? [{ key: 'zone', label: 'Zone', type: 'text' }] : []),
    { key: 'district', label: 'District', type: 'text' },
    { key: 'facility', label: 'Facility', type: 'text' },
    { key: 'equipment', label: 'Equipment', type: 'text' },
    /*
     * Two money columns, because they answer the two questions the meeting
     * actually asks. The rate is what this ticket costs per day it stays open;
     * `accrued` is what it has cost so far. A ₹50/d ticket open since October
     * has run up more than a ₹1,000/d one logged on Tuesday, and ranking on the
     * rate alone hides exactly that — which is the reason the column is here.
     */
    /* The heading carries the unit, so the cells do not repeat it. A column of
       "₹50/d" spends its width saying "per day" on every row. */
    { key: 'rate', label: 'Per day penalty', type: 'num', align: 'num' },
    { key: 'accrued', label: 'Penalty', type: 'num', align: 'num' },
    ...ENTRY_COLUMNS,
  ];
}

export default function MeetingTab({
  ds, rows, unresolvedRows = null, referenceDay, canEdit, onSelectRow,
}) {
  const { cols, dict } = ds;
  const state = ds.meta.id;
  const hasZone = dict.zone.length > 0;
  const grace = ds.meta.graceDays ?? 7;

  const [view, setView] = useState('tickets');
  const [notes, setNotes] = useState(null);
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

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    document.addEventListener('keydown', onKey);
    // Nothing should scroll behind it, the same way the entry form does it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [full]);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [log, setLog] = useState(null);
  const [sync, setSync] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(null); // { key, dir } — null keeps the export's order

  const columns = useMemo(() => exportColumns(hasZone), [hasZone]);

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
      haystack: `${ticket} ${zone} ${district} ${facility} ${equipment}`.toLowerCase(),
    };
  }), [ds, rows, cols, dict, referenceDay, hasZone]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const ids = records.map((t) => t.ticket);
      const [list] = await Promise.all([
        supabase.from('penalty_type').select('name').eq('archived', false).order('sort'),
        canEdit ? ensureRows(state, ids) : Promise.resolve(),
      ]);
      setTypes((list.data ?? []).map((r) => r.name));
      if (canEdit) setSync(await reconcileOpen(state, ids));
      setNotes(await loadNotes(state, ids));
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

  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, v]) => v && v.length),
    [filters],
  );

  const visible = useMemo(() => {
    let list = searched;

    if (activeFilters.length) {
      list = applyFilters(list, activeFilters);
    }

    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      const col = columns.find((c) => c.key === sort.key);
      list = [...list].sort((a, b) => (col?.type === 'num'
        ? (a[sort.key] - b[sort.key]) * dir
        : String(a[sort.key]).localeCompare(String(b[sort.key])) * dir));
    }
    return list;
  }, [searched, sort, columns, activeFilters]);

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
    return <div className="panel"><div className="loader" aria-hidden="true" /></div>;
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
        <div className="table-scroll meeting-scroll">
          <table className="meeting-table is-sortable">
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
                    style={c.entry?.width ? { maxWidth: c.entry.width } : undefined}
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
                          className={`th-filter${filters[c.key]?.length ? ' is-on' : ''}`}
                          onClick={() => setOpenFilter(openFilter === c.key ? null : c.key)}
                          aria-label={filters[c.key]?.length
                            ? `${c.label}: ${filters[c.key].length} selected`
                            : `Filter by ${c.label}`}
                          title={`Filter by ${c.label}`}
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
                               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
                               strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 5h18l-7 8v6l-4 2v-8z" />
                          </svg>
                          {filters[c.key]?.length > 0 && (
                            <span className="th-filter-n">{filters[c.key].length}</span>
                          )}
                        </button>
                        {openFilter === c.key && (
                          <ColumnFilter
                            label={c.label}
                            choices={choices[c.key]}
                            picked={filters[c.key] ?? []}
                            onChange={(next) => setFilters((f) => ({ ...f, [c.key]: next }))}
                            onClose={() => setOpenFilter(null)}
                          />
                        )}
                      </span>
                    )}
                    </span>
                  </th>
                ))}
                <th>Log</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
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
                    <td className="num">{r.age}d</td>
                    {hasZone && <td>{r.zone}</td>}
                    <td>{r.district}</td>
                    <td>{r.facility}</td>
                    <td>{r.equipment}</td>
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
                        style={f.width ? { maxWidth: f.width } : undefined}
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
