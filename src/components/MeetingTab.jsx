import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDay, label, ticketLabel } from '../data/store.js';
import { supabase } from '../data/supabase.js';
import {
  DETAIL_FIELDS, PRIMARY_FIELDS, ensureRows, loadNotes, reconcileOpen, saveField,
} from '../data/meeting.js';

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
 * The twenty-one purchasing fields, over the grid rather than inside it.
 *
 * As an expanded row they were a form wearing a table's clothes: a `colSpan`
 * cell whose contents had no relationship to the columns above them, pushing
 * every other row down the page and leaving the ticket it belonged to scrolled
 * out of sight. Lifted out, the form is a form, and the row it came from is
 * still where it was when it closes.
 */
function DetailDialog({ ticket, note, types, canEdit, onCommit, onClose, subtitle }) {
  const ref = useRef(null);

  useEffect(() => {
    // Focus lands inside, so the next Tab continues in the form rather than
    // walking the table behind it.
    ref.current?.querySelector('input, select')?.focus();
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
        aria-label={`Purchase detail for ticket ${ticket}`}
        ref={ref}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">Ticket {ticket}</span>
            <h2>Purchase and spare detail</h2>
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
          <div className="modal-grid">
            {DETAIL_FIELDS.map((f) => (
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
    { key: 'rate', label: 'Penalty ₹', type: 'num', align: 'num' },
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
      const noteKey = !columns.some((c) => c.key === sort.key);
      const dir = sort.dir === 'asc' ? 1 : -1;
      const col = columns.find((c) => c.key === sort.key);
      list = [...list].sort((a, b) => {
        if (noteKey) {
          // Blank entries sort last in both directions: they are the rows with
          // nothing decided yet, and floating them to the top of a descending
          // sort would bury the ones that do carry an answer.
          const av = notes?.get(a.ticket)?.[sort.key] ?? '';
          const bv = notes?.get(b.ticket)?.[sort.key] ?? '';
          if (!av !== !bv) return av ? -1 : 1;
          return av.localeCompare(bv) * dir;
        }
        if (col.type === 'num') return (a[sort.key] - b[sort.key]) * dir;
        return String(a[sort.key]).localeCompare(String(b[sort.key])) * dir;
      });
    }
    return list;
  }, [records, query, sort, notes, columns]);

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
            <p className="caption">
              {rows.length.toLocaleString()} open calls as of {formatDay(referenceDay)}.
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
                {PRIMARY_FIELDS.map((f) => (
                  <th
                    key={f.key}
                    className="meeting-edit"
                    aria-sort={sort?.key === f.key
                      ? (sort.dir === 'asc' ? 'ascending' : 'descending')
                      : 'none'}
                  >
                    <button type="button" className="th-sort" onClick={() => toggleSort(f.key)}>
                      {f.label}
                      <SortMark active={sort?.key === f.key} dir={sort?.dir} />
                    </button>
                  </th>
                ))}
                <th />
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
                    {PRIMARY_FIELDS.map((f) => (
                      <td key={f.key} className="meeting-edit">
                        <Cell
                          value={note?.[f.key]}
                          kind={f.kind}
                          options={types}
                          disabled={!canEdit}
                          onCommit={commit(r.ticket, f.key)}
                        />
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className="row-more"
                        onClick={() => setDetail(r.ticket)}
                      >
                        More
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
        <DetailDialog
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
    </div>
  );
}

/** A caret that only appears on the sorted column — an arrow on every header is
 *  six arrows saying nothing. */
function SortMark({ active, dir }) {
  if (!active) return <span className="sort-mark" aria-hidden="true" />;
  return (
    <span className="sort-mark is-active" aria-hidden="true">
      {dir === 'asc' ? '▲' : '▼'}
    </span>
  );
}
