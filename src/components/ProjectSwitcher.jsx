import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ProjectIcon, { hasProjectIcon } from './ProjectIcon.jsx';
import '../medtronic.css';

/**
 * The project on screen, and a press away from the others assigned.
 *
 * The contracts sat side by side as a strip of pills; with Medtronic among
 * them the strip outgrew a phone and showed people projects they rarely open.
 * Now it is one pill naming the project — pressed, it lists the rest (the user,
 * 31 Oct: "on click dropdown for other assigned projects"). Somebody with one
 * project gets the pill alone, with nothing to open. "All projects" goes back
 * to the grid BEMMP opens on.
 *
 * The list is drawn on the page itself, not inside the masthead: the masthead
 * clips what overflows it, which cut the list off below the pill.
 */
export default function ProjectSwitcher({ projects, active, onChange, onHome, busy }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null);
  const ref = useRef(null);
  const menu = useRef(null);
  const current = projects.find((p) => p.id === active) ?? projects[0];

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setAt({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), width: r.width });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!ref.current?.contains(e.target) && !menu.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut);
    };
  }, [open]);

  if (!current) return null;
  const many = projects.length > 1;

  const badge = (p) => (
    <span className={`project-code${p.id === 'mt' ? ' is-brand' : ''}`}>
      {hasProjectIcon(p.id) ? <ProjectIcon id={p.id} /> : p.short}
    </span>
  );

  return (
    <div className="project-switch" ref={ref}>
      {many ? (
        <button
          type="button"
          className="project-pill"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
        >
          {badge(current)}
          <span className="project-name">{current.name}</span>
          <svg className="project-caret" viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      ) : (
        <span className="project-pill is-alone">
          {badge(current)}
          <span className="project-name">{current.name}</span>
        </span>
      )}

      {open && at && createPortal(
        <ul
          ref={menu}
          className="project-menu"
          role="listbox"
          aria-label="Projects"
          style={{ top: at.top, right: at.right, minWidth: Math.max(220, at.width) }}
        >
          {projects.map((p) => {
            const on = p.id === current.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className="project-option"
                  onClick={() => { setOpen(false); if (!on) onChange(p.id); }}
                >
                  {badge(p)}
                  <span className="project-name">{p.name}</span>
                  {on && (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                         strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
          {onHome && (
            <li className="project-menu-home">
              <button type="button" className="project-option" onClick={() => { setOpen(false); onHome(); }}>
                <span className="project-code is-grid" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
                    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
                  </svg>
                </span>
                <span className="project-name">All projects</span>
              </button>
            </li>
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
