import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A dropdown drawn by the app rather than the phone.
 *
 * A plain <select> opens the operating system's own list — grey, small, and
 * nothing like the page around it (the user, 31 Oct: "the dropdown looks
 * local"). This one is a list under the button on a computer, and a sheet up
 * from the bottom with large rows on a phone, where a thumb has to hit it.
 * Each option can carry a count, shown at the right.
 */
export default function Picker({
  value, options, onChange, title, placeholder, tone = '', disabled = false, bad = false,
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const current = options.find((o) => o.value === value);
  const changed = value !== '' && value != null && options[0]?.value === '';

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const sheet = window.innerWidth <= 640;
    const h = Math.min(380, options.length * 46 + 14);
    const below = window.innerHeight - r.bottom;
    const up = below < h + 12 && r.top > below;
    setAt({
      sheet,
      minWidth: Math.max(r.width, 240),
      maxWidth: window.innerWidth - 16,
      left: Math.max(8, r.left),
      top: up ? undefined : r.bottom + 6,
      bottom: up ? window.innerHeight - r.top + 6 : undefined,
    });
  }, [open, options.length]);

  // The list is as wide as its longest option; one that would run off the right edge moves left.
  useLayoutEffect(() => {
    if (!at || at.sheet || !menu.current) return;
    const w = menu.current.getBoundingClientRect().width;
    if (at.left + w > window.innerWidth - 8) menu.current.style.left = `${Math.max(8, window.innerWidth - 8 - w)}px`;
  }, [at]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!btn.current?.contains(e.target) && !menu.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', shut);
    };
  }, [open]);

  const pick = (v) => { setOpen(false); if (v !== value) onChange(v); };

  const list = (
    <ul className="mt-pick-list" role="listbox" aria-label={title}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <li key={o.value}>
            <button type="button" role="option" aria-selected={on} className="mt-pick-option" onClick={() => pick(o.value)}>
              <span className="mt-pick-label">{o.label}</span>
              {o.count != null && <span className="mt-pick-count">{o.count}</span>}
              <svg className="mt-pick-tick" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`mt-picker${changed ? ' is-set' : ''}${tone ? ` is-${tone}` : ''}${bad ? ' is-bad' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mt-picker-text">
          {current ? current.label : <span className="mt-picker-placeholder">{placeholder ?? title}</span>}
        </span>
        <svg className="mt-picker-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && at && createPortal(
        at.sheet ? (
          <div className="mt-pick-scrim">
            <div ref={menu} className="mt-pick-sheet" role="dialog" aria-label={title}>
              <span className="mt-sheet-grab is-on" aria-hidden="true" />
              <div className="mt-pick-title">{title}</div>
              {list}
            </div>
          </div>
        ) : (
          <div ref={menu} className="mt-pick-pop" style={{ left: at.left, top: at.top, bottom: at.bottom, minWidth: at.minWidth, maxWidth: at.maxWidth }}>
            {list}
          </div>
        ),
        document.body,
      )}
    </>
  );
}
