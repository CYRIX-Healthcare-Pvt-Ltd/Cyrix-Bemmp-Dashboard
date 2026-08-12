import { useEffect, useState } from 'react';

/**
 * Vertical navigation, collapsible to a rail of icons.
 *
 * The tabs were a horizontal strip, which on this dashboard cost a whole band of
 * the first screen and could not grow: six labels already filled the width, and
 * the strip scrolled sideways on a laptop. Down the side they cost a rail, and
 * the rail collapses to icons when the content wants the room.
 *
 * Collapsed state is remembered, because it is a working preference rather than
 * a per-visit decision — someone on a small laptop wants it collapsed every time.
 */

const KEY = 'bemmp-nav-collapsed';

/*
 * Below this the expanded rail is borrowing space rather than owning it, so it
 * gets out of the way once it has been used — picking a section closes it, and
 * so does a click anywhere in the working column.
 *
 * Above it the rail is a fixed column with room to spare, and closing itself
 * after every click would be a nav that keeps undoing what you asked for. The
 * remembered preference is left alone there.
 *
 * Matched to the shell's own grid: `--nav-w` is 208px and the working column
 * needs roughly 900px before a table stops scrolling sideways.
 */
const AUTO_COLLAPSE_BELOW = '(max-width: 1180px)';

/** One 24px stroke icon per tab, in the same visual weight as the rest of the UI. */
const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  calls: <><path d="M4 5h16M4 12h16M4 19h9" /></>,
  penalty: <><path d="M12 4l9 16H3l9-16Z" /><path d="M12 10v4M12 17v.5" /></>,
  repeats: <><path d="M4 10a6 6 0 0 1 6-6h7" /><path d="M14 1.5 17.5 4 14 6.5" /><path d="M20 14a6 6 0 0 1-6 6H7" /><path d="M10 17.5 6.5 20 10 22.5" /></>,
  performance: <><path d="M3 17l5-6 4 4 5-8 4 5" /></>,
  money: <><path d="M7 5h10M7 9h10M8 5c4 0 6 1.6 6 4s-2 4-6 4h-1l7 6" /></>,
  accounts: <><circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
};

export default function SideNav({ tabs, active, onSelect }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(KEY) === '1',
  );

  useEffect(() => {
    localStorage.setItem(KEY, collapsed ? '1' : '0');
    // The main grid column is sized from this, so the attribute lives on the
    // root rather than being threaded through every layout rule.
    document.documentElement.dataset.nav = collapsed ? 'rail' : 'full';
  }, [collapsed]);

  /*
   * Clicking into the work closes an expanded rail on a narrow screen.
   *
   * `pointerdown` rather than `click`, so the rail is already on its way out
   * as the press lands rather than a frame after whatever was pressed has
   * responded. Nothing is swallowed — the event runs its normal course.
   */
  useEffect(() => {
    if (collapsed) return undefined;
    const narrow = window.matchMedia(AUTO_COLLAPSE_BELOW);
    if (!narrow.matches) return undefined;

    const onDown = (e) => {
      if (!e.target.closest('.sidenav')) setCollapsed(true);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [collapsed]);

  const select = (id) => {
    onSelect(id);
    if (window.matchMedia(AUTO_COLLAPSE_BELOW).matches) setCollapsed(true);
  };

  return (
    <nav className={`sidenav${collapsed ? ' is-rail' : ''}`} aria-label="Sections">
      <ul className="sidenav-list">
        {tabs.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="sidenav-item"
              aria-current={active === t.id ? 'page' : undefined}
              // Collapsed, the label is gone from the page but must still reach
              // a screen reader and a hover.
              title={collapsed ? t.label : undefined}
              aria-label={t.label}
              onClick={() => select(t.id)}
            >
              {/* The icon carries the section's own colour — the same hue the
                  charts use for that measure, so the rail teaches the palette
                  rather than inventing a second one. Only the icon: a coloured
                  label would make six competing headings. */}
              <svg
                viewBox="0 0 24 24" width="18" height="18" fill="none"
                stroke={`var(--nav-${t.id})`} strokeWidth="1.7"
                strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true"
              >
                {ICONS[t.id]}
              </svg>
              <span className="sidenav-label">{t.label}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Icon only. A labelled control and an "as of" line under six labelled
          controls was three kinds of text in a column that wants one, and the
          date is already in the masthead. */}
      <button
        type="button"
        className="sidenav-collapse"
        onClick={() => setCollapsed((v) => !v)}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
        </svg>
      </button>
    </nav>
  );
}
