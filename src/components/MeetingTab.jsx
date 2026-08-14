import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDay, label, ticketLabel } from '../data/store.js';
import { penaltyAmountIn } from '../data/query.js';
import { supabase } from '../data/supabase.js';
import {
  MEETING_FIELDS, ensureRows, loadLog, loadNotes, reconcileOpen, saveField,
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
function Cell({ value, kind, options, disabled, onCommit }) {
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
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    className: `cell cell-${state}`,
  };

  if (kind === 'select') {
    return (
      <select {...common} onChange={(e) => { setDraft(e.target.value); }} onBlur={commit}>
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
                <Cell
                  value={note?.[f.key]}
                  kind={f.kind}
                  options={types}
                  disabled={!canEdit}
                  onCommit={onCommit(f.key)}
                />
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
function exportColumns(hasZone) {
  return [
    { key: 'ticket', label: 'Ticket', type: 'text' },
    { key: 'age', label: 'Age', type: 'num', align: 'num' },
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
    { key: 'rate', label: 'Penalty ₹', type: 'num', align: 'num' },
    { key: 'accrued', label: 'Accrued ₹', type: 'num', align: 'num' },
  ];
}

export default function MeetingTab({ ds, rows, referenceDay, canEdit, onSelectRow }) {
  const { cols, dict } = ds;
  const state = ds.meta.id;
  const hasZone = dict.zone.length > 0;

  const [notes, setNotes] = useState(null);
  const [types, setTypes] = useState([]);
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
      age: referenceDay - cols.loggedDay[row],
      zone,
      district,
      facility,
      equipment,
      rate: cols.dayRate[row],
      /* Everything this ticket has run up, from the day its grace window closed
         to the reference date. `0` as the lower bound rather than the selected
         range: the tracker is the whole backlog and ignores the date window, so
         scoping the money to it would understate the oldest calls — the ones
         that have accrued the most. */
      accrued: penaltyAmountIn(ds, row, 0, referenceDay),
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
  const visible = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = terms.length
      ? records.filter((r) => terms.every((t) => r.haystack.includes(t)))
      : records;

    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      const col = columns.find((c) => c.key === sort.key);
      list = [...list].sort((a, b) => (col?.type === 'num'
        ? (a[sort.key] - b[sort.key]) * dir
        : String(a[sort.key]).localeCompare(String(b[sort.key])) * dir));
    }
    return list;
  }, [records, query, sort, columns]);

  const toggleSort = (key) => setSort((s) => {
    if (s?.key !== key) return { key, dir: 'asc' };
    // asc → desc → off, so a column can be let go of without reloading.
    if (s.dir === 'asc') return { key, dir: 'desc' };
    return null;
  });

  if (!notes) {
    return <div className="panel"><div className="loader" aria-hidden="true" /></div>;
  }

  const detailRecord = detail && records.find((r) => r.ticket === detail);

  return (
    <div className="grid" style={{ gap: 16 }}>
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
          {!canEdit && <span className="drill-badge">read only</span>}
        </div>
        {error && <p className="upload-error">{error}</p>}

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

          {(query || sort) && (
            <button
              type="button"
              className="filter-reset"
              onClick={() => { setQuery(''); setSort(null); }}
            >
              Clear {query && sort ? 'search and sort' : (query ? 'search' : 'sort')}
            </button>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="table-scroll meeting-scroll">
          <table className="meeting-table is-sortable">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={c.align === 'num' ? 'num' : undefined}
                    aria-sort={sort?.key === c.key
                      ? (sort.dir === 'asc' ? 'ascending' : 'descending')
                      : 'none'}
                  >
                    <button type="button" className="th-sort" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      <SortMark active={sort?.key === c.key} dir={sort?.dir} />
                    </button>
                  </th>
                ))}
                <th />
                <th>Log</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const note = notes.get(r.ticket);
                return (
                  <tr key={r.ticket}>
                    <td>
                      <button type="button" className="linkish" onClick={() => onSelectRow(r.row)}>
                        {r.ticket}
                      </button>
                    </td>
                    <td className="num">{r.age}d</td>
                    {hasZone && <td>{r.zone}</td>}
                    <td>{r.district}</td>
                    <td>{r.facility}</td>
                    <td>{r.equipment}</td>
                    <td className="num">
                      {r.rate > 0
                        ? `₹${r.rate.toLocaleString('en-IN')}/d`
                        : <span className="money-nil">—</span>}
                    </td>
                    <td className="num">
                      {r.accrued > 0
                        ? `₹${r.accrued.toLocaleString('en-IN')}`
                        : <span className="money-nil">—</span>}
                    </td>
                    <td>
                      {/* Named for what it does. "More" said there was extra
                          reading somewhere; this is the button you press to
                          record what the meeting just decided. */}
                      <button
                        type="button"
                        className={`row-more${note ? ' has-entry' : ''}`}
                        onClick={() => setDetail(r.ticket)}
                      >
                        {canEdit ? 'Update entry' : 'View entry'}
                      </button>
                    </td>
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
