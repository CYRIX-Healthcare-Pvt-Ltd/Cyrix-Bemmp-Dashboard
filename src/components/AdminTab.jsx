import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STATES } from '../../shared/schema.mjs';
import {
  ROLES, ROLE_LABEL, createUser, listUsers, listAccountLog, resetPassword, setDisabled,
  updateUser,
} from '../data/users.js';

/**
 * Accounts.
 *
 * The one screen where the thing being edited is who may use the rest of the
 * app, so it states consequences rather than assuming they are known: what a
 * role can do sits next to the role, and the default-password rule is written
 * on the form rather than left to be discovered.
 *
 * Role and contract stay two separate questions throughout, because they are
 * independent in the business — the Andhra account in the original login sheet
 * is a Director who nonetheless sees only Andhra.
 */

function when(iso) {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Contract checkboxes. An admin has no list — the role grants every one. */
function ScopePicker({ value, onChange, disabled }) {
  if (disabled) return <span className="scope-all">every contract</span>;
  return (
    <div className="scope-picker">
      {STATES.map((s) => {
        const on = value.includes(s.id);
        return (
          <label key={s.id} className={`scope-chip${on ? ' is-on' : ''}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? value.filter((v) => v !== s.id) : [...value, s.id])}
            />
            {s.short}
          </label>
        );
      })}
    </div>
  );
}

/**
 * Zone or districts, never both.
 *
 * A zone is a whole set of districts, so holding both would leave two answers to
 * "what does this person see" and no way to tell which the page used — picking a
 * zone therefore clears the districts and hides them. The server applies the
 * same rule, so a hand-made API call cannot create the state this refuses to.
 *
 * Nothing ticked means everything, exactly as an admin's empty contract list
 * means every contract. That is what leaves all thirteen existing accounts
 * unrestricted without a backfill.
 *
 * The lists come from the loaded export's own dictionaries rather than a
 * constant: districts are a property of the data, and a hard-coded fourteen
 * would go stale the day a contract gains one.
 */
function AreaPicker({ zones, districts, options, disabled, onChange }) {
  const hasZone = options.zones.length > 0;
  const zoneMode = zones.length > 0;

  const toggle = (list, value) => (list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value]);

  return (
    <div className="admin-area">
      {hasZone && (
        <div className="admin-area-row">
          <span className="admin-area-label">Zone</span>
          {options.zones.map((z) => (
            <label key={z} className={`chip${zones.includes(z) ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                checked={zones.includes(z)}
                disabled={disabled}
                onChange={() => onChange({ zones: toggle(zones, z), districts: [] })}
              />
              {z}
            </label>
          ))}
        </div>
      )}

      {!zoneMode && (
        <div className="admin-area-row">
          <span className="admin-area-label">District</span>
          {options.districts.map((d) => (
            <label key={d} className={`chip${districts.includes(d) ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                checked={districts.includes(d)}
                disabled={disabled}
                onChange={() => onChange({ zones: [], districts: toggle(districts, d) })}
              />
              {d}
            </label>
          ))}
        </div>
      )}

      <p className="admin-area-note">
        {zoneMode
          ? `Sees ${zones.join(' and ')} only. Districts follow the zone.`
          : (districts.length
            ? `Sees ${districts.length} district${districts.length === 1 ? '' : 's'}.`
            : 'Nothing ticked — sees every zone and district.')}
      </p>
    </div>
  );
}

/**
 * The person's name, editable where it is displayed.
 *
 * Saved on leaving the field rather than behind an edit button, which is the
 * idiom the meeting grid already uses — somebody correcting a spelling should
 * not have to find a second control first. The employee code stays fixed: it is
 * what `account_audit` records, what the seed sheet calls the account, and what
 * the default password is, so it is an identity rather than a detail.
 *
 * Escape has to cancel through a ref. `setValue` is asynchronous, so resetting
 * the state and then blurring would still hand the blur handler the typed value
 * and save the thing the user just abandoned.
 */
function NameCell({ user, busy, onSave }) {
  const original = user.full_name ?? '';
  const [value, setValue] = useState(original);
  const cancelled = useRef(false);

  // A reload after any save re-renders every row; without this the cell would
  // keep whatever it had before somebody else's change landed.
  useEffect(() => { setValue(user.full_name ?? ''); }, [user.full_name]);

  return (
    <input
      className="cell admin-name"
      value={value}
      disabled={busy}
      placeholder="Add a name"
      aria-label={`Name for ${user.code}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (cancelled.current) { cancelled.current = false; setValue(original); return; }
        const next = value.trim();
        if (next !== original.trim()) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
      }}
    />
  );
}

function NewUserForm({ onCreated, onCancel }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('coordinator');
  const [scope, setScope] = useState(['kl']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isAdminRole = role === 'admin';

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createUser({
        code: code.trim(), full_name: name.trim() || null, role, scope,
      });
      onCreated(res);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="panel admin-form" onSubmit={submit}>
      <div className="panel-head">
        <div>
          <h2>New account</h2>
          <p className="caption">
            The password is the employee code itself. Tell them to sign in with it
            twice and change nothing else.
          </p>
        </div>
      </div>

      <div className="admin-form-grid">
        <label className="field">
          <span>Employee code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="KLTech04"
            /* The code becomes the password verbatim, so a phone silently
               upper-casing it would issue a credential nobody typed. */
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            required
          />
        </label>

        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
          />
        </label>

        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>

        <div className="field">
          <span>Contracts</span>
          <ScopePicker value={scope} onChange={setScope} disabled={isAdminRole} />
        </div>
      </div>

      <p className="caption admin-role-hint">
        {ROLES.find((r) => r.id === role)?.hint}
      </p>

      {/* Said before it happens, not after it fails. A code under six characters
          can have itself as a password once, at creation, but the policy refuses
          it on every later reset. */}
      {code.trim().length > 0 && code.trim().length < 6 && (
        <p className="caption admin-warn">
          “{code.trim()}” is short. It will work as the password now, but
          <strong> reset to default will not work</strong> on this account later.
        </p>
      )}

      {error && <p className="upload-error">{error}</p>}

      <div className="admin-form-actions">
        <button type="button" className="preset" onClick={onCancel}>Cancel</button>
        <button type="submit" className="modal-done" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </div>
    </form>
  );
}

export default function AdminTab({ profile, areaOptions = { zones: [], districts: [] } }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    listUsers().then((u) => { setUsers(u); setError(null); })
      .catch((e) => { setError(e.message); setUsers([]); });
  }, []);

  useEffect(load, [load]);

  const act = async (id, fn, message) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      setNotice(message);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const sorted = useMemo(
    () => [...(users ?? [])].sort((a, b) => {
      // Administrators first — a short list of people who can change the others.
      if ((a.role === 'admin') !== (b.role === 'admin')) return a.role === 'admin' ? -1 : 1;
      return a.code.localeCompare(b.code);
    }),
    [users],
  );

  if (!users) return <div className="panel"><div className="loader" aria-hidden="true" /></div>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Accounts</h2>
            <p className="caption">
              {users.length} account{users.length === 1 ? '' : 's'}. Role decides what
              somebody can do; contracts decide which data they see. The two are
              separate on purpose.
            </p>
          </div>
          {!adding && (
            <button type="button" className="modal-done" onClick={() => setAdding(true)}>
              New account
            </button>
          )}
        </div>
        {error && <p className="upload-error">{error}</p>}
        {notice && <p className="caption admin-notice">{notice}</p>}
      </div>

      {adding && (
        <NewUserForm
          onCancel={() => setAdding(false)}
          onCreated={(res) => {
            setAdding(false);
            setNotice(
              `${res.user.code} created. Password is “${res.defaultPassword}”.`
              + (res.warning ? ` ${res.warning}` : ''),
            );
            load();
          }}
        />
      )}

      <div className="panel">
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Role</th>
                <th>Contracts</th>
                <th>Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => {
                const self = u.id === profile.id;
                const isAdminRole = u.role === 'admin';
                return (
                  <tr key={u.id} className={u.disabled ? 'is-disabled' : undefined}>
                    <td>
                      <strong>{u.code}</strong>
                      {self && <span className="admin-you">you</span>}
                      {u.disabled && <span className="admin-off">disabled</span>}
                    </td>
                    <td>
                      <NameCell
                        user={u}
                        busy={busyId === u.id}
                        onSave={(name) => act(
                          u.id,
                          () => updateUser(u.id, { full_name: name }),
                          name ? `${u.code} is now ${name}.` : `${u.code}'s name was cleared.`,
                        )}
                      />
                    </td>
                    <td>
                      <select
                        className="cell"
                        value={u.role}
                        disabled={self || busyId === u.id}
                        onChange={(e) => act(
                          u.id,
                          () => updateUser(u.id, { role: e.target.value }),
                          `${u.code} is now ${ROLE_LABEL[e.target.value]}.`,
                        )}
                      >
                        {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <ScopePicker
                        value={u.scope ?? []}
                        disabled={isAdminRole}
                        onChange={(next) => act(
                          u.id,
                          () => updateUser(u.id, { scope: next }),
                          `${u.code} now sees ${next.length ? next.join(' and ').toUpperCase() : 'nothing'}.`,
                        )}
                      />
                      {/* Area sits under the contracts because it is the same
                          question one level down: which contracts, then which
                          part of them. An admin has neither. */}
                      {!isAdminRole && (areaOptions.zones.length || areaOptions.districts.length) ? (
                        <AreaPicker
                          zones={u.zones ?? []}
                          districts={u.districts ?? []}
                          options={areaOptions}
                          disabled={busyId === u.id}
                          onChange={(next) => act(
                            u.id,
                            () => updateUser(u.id, next),
                            next.zones.length
                              ? `${u.code} now sees ${next.zones.join(' and ')} only.`
                              : (next.districts.length
                                ? `${u.code} now sees ${next.districts.length} district(s).`
                                : `${u.code} now sees every zone and district.`),
                          )}
                        />
                      ) : null}
                    </td>
                    <td className="admin-when">{when(u.last_sign_in_at)}</td>
                    <td className="admin-actions">
                      <button
                        type="button"
                        className="row-more"
                        disabled={busyId === u.id}
                        onClick={() => act(
                          u.id,
                          () => resetPassword(u.id),
                          `${u.code}'s password is back to “${u.code}”.`,
                        )}
                      >
                        Reset password
                      </button>
                      {/* Disabled rather than deleted: the meeting notes record
                          who wrote them, and removing the account would take
                          that with it. */}
                      <button
                        type="button"
                        className="row-more"
                        disabled={self || busyId === u.id}
                        onClick={() => act(
                          u.id,
                          () => setDisabled(u.id, !u.disabled),
                          u.disabled ? `${u.code} can sign in again.` : `${u.code} can no longer sign in.`,
                        )}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <AccountLog refreshKey={users.length + (notice ?? '')} />
    </div>
  );
}

const ACTION_LABEL = {
  create: 'created',
  update: 'changed',
  reset: 'password reset',
  disable: 'disabled',
  enable: 'enabled',
};

/** `{ role: { from: 'coordinator', to: 'project_head' } }` as one readable line. */
function changeSummary(detail, action) {
  if (!detail) return '';
  if (action === 'create') {
    const scope = Array.isArray(detail.scope) && detail.scope.length
      ? detail.scope.join(', ').toUpperCase()
      : 'every contract';
    return `${ROLE_LABEL[detail.role] ?? detail.role} · ${scope}`;
  }
  return Object.entries(detail)
    .map(([field, { from, to }]) => {
      const show = (v) => (Array.isArray(v) ? (v.join(', ').toUpperCase() || 'none')
        : (v ?? 'none'));
      return `${field}: ${show(from)} → ${show(to)}`;
    })
    .join(' · ');
}

/**
 * Who did what to which account.
 *
 * Written server-side by `/api/users` with the service key, which is the only
 * credential that can write to the table at all — it has a read policy for
 * admins and no write policy whatsoever, so nobody can add a line here, amend
 * one or remove one from a browser. An audit trail the audited party can edit is
 * not one.
 *
 * Never holds a password: a reset records that it happened and by whom.
 */
function AccountLog({ refreshKey }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listAccountLog()
      .then((e) => { if (!cancelled) { setEntries(e); setError(null); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setEntries([]); } });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Account history</h2>
          <p className="caption">
            Every account change, newest first. Written by the server as it happens and
            not editable from here — not by an administrator either. Passwords are never
            recorded, only that a reset took place.
          </p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      {entries && entries.length === 0 && !error && (
        <p className="caption">Nothing recorded yet.</p>
      )}

      {entries && entries.length > 0 && (
        <div className="table-scroll" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>When</th><th>Who</th><th>Action</th><th>Account</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.at)}</td>
                  <td>{e.actor_code}</td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td>{e.target_code}</td>
                  <td className="muted">{changeSummary(e.detail, e.action)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
