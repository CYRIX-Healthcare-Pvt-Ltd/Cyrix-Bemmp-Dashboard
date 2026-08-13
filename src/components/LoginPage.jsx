import { useEffect, useRef, useState } from 'react';
import Logo from './Logo.jsx';
import { signIn } from '../data/supabase.js';

/**
 * The way in.
 *
 * Two halves: an ink panel that says what this is, and a white one that asks
 * for two fields. The split is doing real work — on a phone the ink half
 * collapses to a band above the form, so the form is always the thing in reach
 * rather than something below a hero.
 */
export default function LoginPage({ onSignedIn }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [help, setHelp] = useState(false);
  const first = useRef(null);

  useEffect(() => { first.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(code, password);
      onSignedIn?.();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login-brand">
        <div className="login-brand-top">
          <Logo height={26} />
        </div>

        <div className="login-brand-mid">
          <p className="eyebrow">Biomedical equipment maintenance</p>
          {/* Two weights, not one: the company name carries the weight and the
              product name sits beside it in the lighter cut, which is what stops
              a two-word lockup reading as one long word. */}
          <h1 className="login-wordmark">
            <b>CYRI<span className="login-x">X</span></b> BEMMP<span className="login-dot">.</span>
          </h1>
          <p className="login-strap">
            Measure. Review. Resolve.
            <br />
            Daily penalty tracking across every contract.
          </p>
        </div>

        <div className="login-brand-foot">
          <ul className="login-meta">
            <li>Open call review</li>
            <li>Penalty accrual</li>
            <li>Contract insight</li>
          </ul>
          <span className="login-region">India operations</span>
        </div>
      </aside>

      <main className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <h2>Sign in to continue.</h2>

          <label className="login-field">
            <span className="eyebrow">Employee code</span>
            <input
              ref={first}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="username"
              /* Not `characters`. Codes are mixed case — KLCoord, not KLCOORD —
                 and a phone that shouts every letter makes the field look wrong
                 while you type it. Sign-in folds the case anyway. */
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck="false"
              placeholder="E1042"
              required
            />
          </label>

          <label className="login-field">
            <span className="eyebrow">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <button
            type="button"
            className="login-forgot"
            onClick={() => setHelp((v) => !v)}
            aria-expanded={help}
          >
            Forgot password?
          </button>

          {/* Live so a screen reader hears the failure without moving focus off
              the field the person is about to correct. */}
          <p className="login-error" role="status" aria-live="polite">
            {error ?? ' '}
          </p>

          {/* Not disabled on empty fields: `required` already blocks the submit,
              and a greyed-out slab is the first thing anyone sees on this page.
              It stays solid until there is a request actually in flight. */}
          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          {help && (
            <p className="login-help">
              Codes are issued per person rather than shared, so ask your project
              head to reset yours.
            </p>
          )}
        </form>

        <footer className="login-foot">
          <span>Cyrix Health Care</span>
          <span>© {new Date().getFullYear()}</span>
        </footer>
      </main>
    </div>
  );
}
