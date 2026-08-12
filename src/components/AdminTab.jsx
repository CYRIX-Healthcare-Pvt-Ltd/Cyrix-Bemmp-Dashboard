import { useCallback, useEffect, useMemo, useState } from 'react';
import { STATES } from '../../shared/schema.mjs';
import {
  ROLES, ROLE_LABEL, createUser, listUsers, resetPassword, setDisabled, updateUser,
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
            autoCapitalize="characters"
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

export default function AdminTab({ profile }) {
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
                    <td>{u.full_name || <span className="money-nil">—</span>}</td>
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
    </div>
  );
}
