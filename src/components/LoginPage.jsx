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
          <Logo height={34} />
        </div>

        <div className="login-brand-mid">
          <p className="eyebrow">Biomedical equipment maintenance</p>
          <h1 className="login-wordmark">
            CYRI<span className="login-x">X</span> BEMMP<span className="login-dot">.</span>
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
              autoCapitalize="characters"
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

          {/* Live so a screen reader hears the failure without moving focus off
              the field the person is about to correct. */}
          <p className="login-error" role="status" aria-live="polite">
            {error ?? ' '}
          </p>

          <button type="submit" className="login-submit" disabled={busy || !code || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="login-help">
            Lost your password? Ask your project head to reset it — codes are
            issued per person, not shared.
          </p>
        </form>

        <footer className="login-foot">
          <span>Cyrix Health Care</span>
          <span>© {new Date().getFullYear()}</span>
        </footer>
      </main>
    </div>
  );
}
