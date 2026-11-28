import { useEffect, useState } from 'react';
import { formatDay, label, parseEngineer, ticketLabel, BUCKET, BUCKET_LABEL } from '../data/store.js';
import { FTFR_MAX_DAYS, penaltyWindows } from '../data/query.js';
import { supabase } from '../data/supabase.js';
import { computeField, fieldsFor, isComputed } from '../data/meeting.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const asDay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : v;
};

const BUCKET_DOT = ['open', 'parked', 'resolved'];

function Row({ term, children }) {
  return (
    <div className="dl-row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Full detail for one ticket, including the assigned engineer. */
export default function TicketDrawer({ ds, row, latestDay, onClose, state }) {
  // What the tracker's people entered against this call (the user, 28 Nov), read fresh each time it opens.
  const ticket = row == null ? null : ticketLabel(ds, row);
  const [note, setNote] = useState(null);
  useEffect(() => {
    setNote(null);
    if (!ticket || !state || !supabase) return undefined;
    let live = true;
    supabase.from('meeting_note').select('*').eq('state', state).eq('ticket', ticket).maybeSingle()
      .then(({ data }) => { if (live) setNote(data ?? {}); });
    return () => { live = false; };
  }, [state, ticket]);
  const entered = state ? fieldsFor(state) : [];
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (row == null) return null;
  const { cols, dict } = ds;

  const logged = cols.loggedDay[row];
  const resolved = cols.resolvedDay[row];
  const bucket = cols.bucket[row];
  const engineer = parseEngineer(label(dict.engineer, cols.engineer[row]));

  const ageDays = resolved > 0 ? resolved - logged : latestDay - logged;
  const isFtfr = resolved > 0 && resolved - logged <= FTFR_MAX_DAYS;

  // SLA only bites on calls that are still open.
  const slaWindow = penaltyWindows(ds)[cols.equipmentType[row] + 1];
  const openAge = latestDay - logged;
  const onPenalty = bucket === BUCKET.OPEN && openAge > slaWindow;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} role="presentation" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Ticket detail">
        <header className="drawer-head">
          <div>
            <div className="drawer-eyebrow">Ticket</div>
            <h2>{ticketLabel(ds, row)}</h2>
          </div>
          <div className="drawer-head-right">
            {onPenalty && <span className="pill pill-penalty">Penalty</span>}
            <span className="pill">
              <span className={`dot ${BUCKET_DOT[bucket]}`} aria-hidden="true" />
              {BUCKET_LABEL[bucket]}
            </span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </header>

        <div className="drawer-body">
          <section>
            <h3>Engineer</h3>
            {engineer ? (
              <div className="engineer-card">
                <div className="avatar" aria-hidden="true">
                  {engineer.name.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div className="engineer-name">{engineer.name}</div>
                  <div className="engineer-meta">
                    {engineer.code}
                    {engineer.phone && <> · <a href={`tel:${engineer.phone}`}>{engineer.phone}</a></>}
                  </div>
                </div>
              </div>
            ) : (
              <p className="empty-inline">No engineer assigned</p>
            )}
          </section>

          <section>
            <h3>Timeline</h3>
            <dl className="dl">
              <Row term="Logged">{formatDay(logged)}</Row>
              <Row term="Resolved">{resolved > 0 ? formatDay(resolved) : 'Not resolved'}</Row>
              <Row term={resolved > 0 ? 'Resolution time' : 'Open for'}>
                {ageDays} {ageDays === 1 ? 'day' : 'days'}
              </Row>
              <Row term="First time fix">
                {resolved > 0
                  ? <span className={`pill ${isFtfr ? 'pill-good' : 'pill-bad'}`}>{isFtfr ? 'Yes' : 'No'}</span>
                  : '—'}
              </Row>
              {/* The state's own figure, named as theirs: the grid counts
                  days from the logged date, and these disagree by a day or
                  more depending on when their export was cut. */}
              <Row term="Down days (export)">{cols.downDays[row]}</Row>
              <Row term={`Non-penalty period (${slaWindow}d)`}>
                {bucket === BUCKET.OPEN
                  ? (onPenalty
                    ? <span className="pill pill-penalty">{openAge - slaWindow}d over</span>
                    : <span className="pill pill-good">Within period</span>)
                  : '—'}
              </Row>
            </dl>
          </section>

          <section>
            <h3>Asset</h3>
            <dl className="dl">
              <Row term="Barcode">{label(dict.barcode, cols.barcode[row])}</Row>
              <Row term="Equipment">{label(dict.equipment, cols.equipment[row])}</Row>
              <Row term="Model">{label(dict.model, cols.model[row])}</Row>
              <Row term="Manufacturer">{label(dict.manufacturer, cols.manufacturer[row])}</Row>
              <Row term="Device group">{label(dict.deviceGroup, cols.deviceGroup[row])}</Row>
              <Row term="Criticality">{label(dict.equipmentType, cols.equipmentType[row])}</Row>
            </dl>
          </section>

          <section>
            <h3>Location</h3>
            <dl className="dl">
              <Row term="Facility">{label(dict.facilityName, cols.facilityName[row])}</Row>
              <Row term="Facility type">{label(dict.facilityType, cols.facilityType[row])}</Row>
              <Row term="Department">{label(dict.department, cols.department[row])}</Row>
              <Row term="District">{label(dict.district, cols.district[row])}</Row>
              <Row term="Zone">{label(dict.zone, cols.zone[row])}</Row>
            </dl>
          </section>

          {state && (
            <section>
              <h3>Tracker</h3>
              <dl className="dl">
                {entered.map((f) => {
                  const v = note ? (isComputed(f.key) ? computeField(f.key, note) : note[f.key]) : null;
                  const shown = v == null || v === '' ? '—' : f.kind === 'date' ? asDay(v) : String(v);
                  return <Row key={f.key} term={f.label}>{note ? shown : '…'}</Row>;
                })}
              </dl>
            </section>
          )}

          <section>
            <h3>Status detail</h3>
            <dl className="dl">
              <Row term="Source status">{label(dict.status, cols.status[row])}</Row>
              <Row term="Lifecycle">{label(dict.lifecycle, cols.lifecycle[row])}</Row>
              <Row term="Remark">{label(dict.parkedReason, cols.parkedReason[row], 'None')}</Row>
            </dl>
          </section>
        </div>
      </aside>
    </>
  );
}
