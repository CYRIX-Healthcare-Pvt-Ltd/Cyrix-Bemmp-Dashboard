import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { formatDay, label, ticketLabel } from '../data/store.js';
import { supabase } from '../data/supabase.js';
import {
  DETAIL_FIELDS, PRIMARY_FIELDS, ensureRows, loadNotes, reconcileOpen, saveField,
} from '../data/meeting.js';

/**
 * The daily penalty meeting.
 *
 * Left of the divider is the export — district, facility, equipment, age,
 * penalty — and none of it is editable, because it is rebuilt from the TM file
 * every morning and anything typed over it would be gone by the next one. Right
 * of it is what the meeting decides, which lives in Supabase and follows the
 * ticket across exports.
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

export default function MeetingTab({ ds, rows, referenceDay, canEdit, onSelectRow }) {
  const { cols, dict } = ds;
  const state = ds.meta.id;

  const [notes, setNotes] = useState(null);
  const [types, setTypes] = useState([]);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [sync, setSync] = useState(null);

  // The ticket string is the join key, and the only thing shared between the
  // export and the database.
  const tickets = useMemo(
    () => rows.map((i) => ({ row: i, ticket: ticketLabel(ds, i) })),
    [ds, rows],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const ids = tickets.map((t) => t.ticket);
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
  }, [state, tickets, canEdit]);

  useEffect(() => { load(); }, [load]);

  const commit = (ticket, key) => async (value) => {
    const updated = await saveField(state, ticket, key, value);
    setNotes((prev) => new Map(prev).set(ticket, updated));
  };

  if (!notes) {
    return <div className="panel"><div className="loader" aria-hidden="true" /></div>;
  }

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
      </div>

      <div className="panel">
        <div className="table-scroll meeting-scroll">
          <table className="meeting-table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th className="num">Age</th>
                <th>District</th>
                <th>Facility</th>
                <th>Equipment</th>
                <th className="num">Penalty ₹</th>
                {PRIMARY_FIELDS.map((f) => <th key={f.key} className="meeting-edit">{f.label}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {tickets.map(({ row, ticket }) => {
                const note = notes.get(ticket);
                const open = expanded === ticket;
                return (
                  <Fragment key={ticket}>
                    <tr className={open ? 'is-expanded' : undefined}>
                      <td>
                        <button type="button" className="linkish" onClick={() => onSelectRow(row)}>
                          {ticket}
                        </button>
                      </td>
                      <td className="num">{referenceDay - cols.loggedDay[row]}d</td>
                      <td>{label(dict.district, cols.district[row])}</td>
                      <td>{label(dict.facilityName, cols.facilityName[row])}</td>
                      <td>{label(dict.equipment, cols.equipment[row])}</td>
                      <td className="num">
                        {cols.dayRate[row] > 0
                          ? `₹${cols.dayRate[row].toLocaleString('en-IN')}/d`
                          : <span className="money-nil">—</span>}
                      </td>
                      {PRIMARY_FIELDS.map((f) => (
                        <td key={f.key} className="meeting-edit">
                          <Cell
                            value={note?.[f.key]}
                            kind={f.kind}
                            options={types}
                            disabled={!canEdit}
                            onCommit={commit(ticket, f.key)}
                          />
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className="row-more"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : ticket)}
                        >
                          {open ? 'Less' : 'More'}
                        </button>
                      </td>
                    </tr>

                    {/* The twenty-one purchasing fields. Behind an expander
                        because fewer than 3% of rows carry any of them, and as
                        columns they would be a wall of empty cells. */}
                    {open && (
                      <tr className="meeting-detail">
                        <td colSpan={7 + PRIMARY_FIELDS.length}>
                          <div className="meeting-detail-grid">
                            {DETAIL_FIELDS.map((f) => (
                              <label key={f.key} className="field">
                                <span>{f.label}</span>
                                <Cell
                                  value={note?.[f.key]}
                                  kind={f.kind}
                                  options={types}
                                  disabled={!canEdit}
                                  onCommit={commit(ticket, f.key)}
                                />
                              </label>
                            ))}
                          </div>
                          {note?.legacy_values && (
                            <p className="caption meeting-legacy">
                              From the old sheet:{' '}
                              {Object.entries(note.legacy_values)
                                .map(([k, v]) => `${k} = ${v}`).join(' · ')}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
