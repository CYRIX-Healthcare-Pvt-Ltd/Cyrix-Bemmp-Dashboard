import Logo, { Tagline } from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Avatar from './Avatar.jsx';
import { firstName } from '../data/supabase.js';
import ProjectIcon, { hasProjectIcon } from './ProjectIcon.jsx';

const SignOutIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 17l5-5-5-5" /><path d="M20 12H9" /><path d="M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
  </svg>
);

/**
 * The masthead for the screens that are not a contract's dashboard — the
 * project grid and Medtronic. Same brand block and the same account controls,
 * so moving between projects never changes the frame around them.
 */
export function ProjectMasthead({ profile, narrow, sub, right, extra, onSignOut, withAccount }) {
  return (
    <>
    <header className="masthead">
      <div className="brand">
        <a className="brand-home" href="/" aria-label="All Cyrix modules" title="All Cyrix modules">
          <Logo height={36} />
        </a>
        <div className="brand-divider" aria-hidden="true" />
        <div className="brand-text">
          <h1>BEMMP Service Dashboard</h1>
          <Tagline />
          {sub && <div className="sub"><span className="live-dot" aria-hidden="true" />{sub}</div>}
        </div>
      </div>
      <div className="masthead-right">
        {!narrow && right}
        {(narrow || withAccount) && (
          <>
            {profile && (
              <span className="who" title={`Signed in as ${profile.code}`}>
                <span className="who-name">{firstName(profile)}</span>
                <Avatar name={profile.full_name} src={profile.avatar} />
              </span>
            )}
            <ThemeToggle />
            {extra}
            {profile && (
              withAccount && !narrow
                ? <button type="button" className="sign-out" onClick={onSignOut} title="Sign out"><SignOutIcon /><span>Sign out</span></button>
                : <button type="button" className="icon-toggle" onClick={onSignOut} title={`Signed in as ${profile.code} — sign out`} aria-label="Sign out"><SignOutIcon /></button>
            )}
          </>
        )}
      </div>
    </header>
    {narrow && right && <div className="project-row">{right}</div>}
    </>
  );
}

const TINT = { kl: '#0d9488', ap: '#2563eb', up: '#d97706', mt: '#7c3aed', pm: '#059669' };

/**
 * BEMMP's own home: one tile per project assigned, the way the portal shows
 * the modules (the user, 31 Oct: "add sub modules inside bemmp, ie each
 * projects"). Somebody with a single project never sees it — they go straight
 * in — and the project menu's "All projects" brings everybody else back here.
 */
export default function ProjectHome({ projects, onPick, profile, narrow, onSignOut }) {
  return (
    <div className="app">
      <ProjectMasthead profile={profile} narrow={narrow} onSignOut={onSignOut} withAccount />
      <main className="project-home">
        {/* The way back to the portal, as the side bar has it inside a project (the user, 31 Oct). */}
        <div className="project-home-head">
          <h2 className="project-home-title">Projects</h2>
          <a className="project-home-apps" href="/" aria-label="All Cyrix modules">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
              <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
              <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
            </svg>
            Modules
          </a>
        </div>
        <div className="project-grid">
          {projects.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className="project-tile"
              style={{ '--tint': TINT[p.id] ?? 'var(--series-1)', '--i': i }}
              onClick={() => onPick(p.id)}
            >
              <span className={`project-tile-code${p.id === 'mt' ? ' is-brand' : ''}`}>
                {hasProjectIcon(p.id) ? <ProjectIcon id={p.id} /> : p.short}
              </span>
              <span className="project-tile-text">
                <span className="project-tile-name">{p.name}</span>
                {p.rows != null && <span className="project-tile-sub">{p.rows.toLocaleString('en-IN')} tickets</span>}
              </span>
              <svg className="project-tile-go" viewBox="0 0 24 24" width="18" height="18" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
