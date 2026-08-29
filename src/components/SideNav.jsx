import { useEffect, useState } from 'react';
import ThemeToggle from './ThemeToggle.jsx';

/**
 * Vertical navigation: a rail of icons, with the section names on demand.
 *
 * The tabs were a horizontal strip, which on this dashboard cost a whole band of
 * the first screen and could not grow: six labels already filled the width, and
 * the strip scrolled sideways on a laptop. Down the side they cost a rail.
 *
 * Opening it **widens the column** and the work moves over to make room, rather
 * than the names floating over the figures. A panel over the dashboard covers
 * exactly the tiles somebody opened the nav to navigate away from, and a number
 * half-hidden behind chrome is worse than a number off the edge of the screen.
 *
 * It closes itself the moment the work is touched — a press anywhere outside it,
 * or Escape — so the names are something you reach for rather than a column that
 * has to be put away by hand. Picking a section is not that signal: it is
 * somebody using the nav, and closing on it made moving between two sections
 * mean reopening the thing every time. Nothing is remembered between visits, for
 * the related reason that a nav which shuts itself has no resting open state
 * worth restoring.
 *
 * The width lives on the root as `--nav-w` because the shell's grid is sized
 * from it, and the attribute set here is what the stylesheet transitions.
 */

/*
 * Below 860px there is no rail at all — the sections become a horizontal strip,
 * where "open" means nothing. Every auto-close is gated on this so the strip is
 * never subject to rules written for a column that is not on screen.
 */
const HAS_RAIL = '(min-width: 861px)';

/** One 24px stroke icon per tab, in the same visual weight as the rest of the UI. */
const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  calls: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M7.5 9h9M7.5 13h6" /></>,
  repeats: <><path d="M4 10a6 6 0 0 1 6-6h7" /><path d="M14 1.5 17.5 4 14 6.5" /><path d="M20 14a6 6 0 0 1-6 6H7" /><path d="M10 17.5 6.5 20 10 22.5" /></>,
  performance: <><path d="M3 17l5-6 4 4 5-8 4 5" /></>,
  money: <><path d="M7 5h10M7 9h10M8 5c4 0 6 1.6 6 4s-2 4-6 4h-1l7 6" /></>,
  accounts: <><circle cx="12" cy="8" r="3.4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
};

export default function SideNav({
  tabs, active, onSelect, onUpload, onSignOut, signedIn,
  /**
   * False on a phone, where the rail is a strip along the bottom and the
   * account controls live in the header instead — the same place Spare
   * keeps them at that width. They are rendered once either way: two
   * copies of the theme switch would each hold their own idea of the
   * current theme, and the hidden one would be wrong the moment the
   * visible one was pressed.
   */
  showAccountControls = true,
}) {
  const [open, setOpen] = useState(false);

  /*
   * The shell's grid column is sized from this, so the width lives on the root
   * rather than being threaded through every layout rule. The rail is the
   * absence of the attribute, which is what lets the first paint be correct
   * without anything having to be stamped ahead of it.
   */
  useEffect(() => {
    document.documentElement.dataset.nav = open ? 'full' : 'rail';
  }, [open]);

  /*
   * Working in the page closes the panel.
   *
   * `pointerdown` rather than `click`, so it is already on its way out as the
   * press lands rather than a frame after whatever was pressed has responded.
   * Nothing is swallowed — the event runs its normal course.
   *
   * The width is tested inside the handler rather than when the listener is
   * attached: a window dragged from phone width to desktop while the panel was
   * open would otherwise keep a listener that had already decided it did not
   * apply.
   */
  useEffect(() => {
    if (!open) return undefined;

    const onDown = (e) => {
      if (!window.matchMedia(HAS_RAIL).matches) return;
      if (!e.target.closest('.sidenav')) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /*
   * Picking a section deliberately does *not* close it.
   *
   * It used to, and that made the names unusable for the thing they are for:
   * moving between sections. Open the nav to read the labels, press Penalty, and
   * it shut — so comparing two sections meant reopening it every single time.
   * A press on a nav item is somebody *using* the nav, not finishing with it.
   *
   * Working in the page is the signal that it is finished with, and that is
   * handled above.
   */
  const select = (id) => onSelect(id);

  return (
    <nav className={`sidenav${open ? ' is-open' : ''}`} aria-label="Sections">
      <ul className="sidenav-list">
        {tabs.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="sidenav-item"
              aria-current={active === t.id ? 'page' : undefined}
              // The label is clipped away in the rail but must still reach a
              // screen reader and a hover.
              title={open ? undefined : t.label}
              aria-label={t.label}
              onClick={() => select(t.id)}
            >
              {/* The icon carries the section's own colour — the same hue the
                  charts use for that measure, so the rail teaches the palette
                  rather than inventing a second one. Only the icon: a coloured
                  label would make six competing headings.

                  It sits at the same x in both states, which is why the panel
                  appears to grow out from behind it instead of shunting it. */}
              <svg
                viewBox="0 0 24 24" width="18" height="18" fill="none"
                stroke={`var(--nav-${t.id})`} strokeWidth="1.7"
                strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true"
              >
                {ICONS[t.id]}
              </svg>
              {/* Both names ship and CSS picks one: the rail has room for
                  "FTFR and Closure TAT", a phone cell has room for "FTFR".
                  aria-label above already carries the full one either way. */}
              <span className="sidenav-label sidenav-full">{t.label}</span>
              <span className="sidenav-label sidenav-short">{t.short ?? t.label}</span>
            </button>
          </li>
        ))}

        {/* The way out to the other Cyrix modules. Last, so the sections
            above keep the positions people already reach for, and an anchor
            rather than a button because it genuinely leaves this app — the
            portal is above the /bemmp base and is a different application.
            Neutral rather than tinted: the rail's colours name measures on
            the charts, and this is not one of them. */}
        {/* Its own class because on a phone this cell is pinned to the
            right edge while the sections scroll past behind it — the way
            out should not be something you have to scroll to find. */}
        <li className="sidenav-apps-cell">
          <a
            className="sidenav-item sidenav-apps"
            href="/"
            title={open ? undefined : 'All Cyrix apps'}
            aria-label="All Cyrix apps"
          >
            <svg
              viewBox="0 0 24 24" width="18" height="18" fill="none"
              stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
              <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
              <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
            </svg>
            <span className="sidenav-label">Apps</span>
          </a>
        </li>
      </ul>

      {/*
        The controls that belong to the account rather than to the data.
        They were three pills at the top right, which put loading a
        workbook, changing the theme and signing out in the same row as
        the contract switcher — one of those is a thing you do to the
        dashboard and the others are things you do to your session.

        Down here they read as what they are, and they are in the place
        every other module keeps them: Spare has had exactly this group at
        the foot of its rail all along.

        Separated by a rule rather than a gap, because the sections above
        are a list you move through and these are not part of it.
      */}
      {showAccountControls && (
      <div className="sidenav-foot">
        {onUpload && (
          <button
            type="button"
            className="sidenav-item"
            onClick={onUpload}
            title={open ? undefined : 'Load a TM export from this device'}
            aria-label="Load a TM export from this device"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                 aria-hidden="true">
              <path d="M12 15V4M8 8l4-4 4 4" />
              <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
            <span className="sidenav-label">Data</span>
          </button>
        )}

        <ThemeToggle className="sidenav-item" labelClassName="sidenav-label" />

        {signedIn && (
          <button
            type="button"
            className="sidenav-item sidenav-signout"
            onClick={onSignOut}
            title={open ? undefined : 'Sign out'}
            aria-label="Sign out"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                 stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                 aria-hidden="true">
              <path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
            </svg>
            <span className="sidenav-label">Sign out</span>
          </button>
        )}
      </div>
      )}

      {/* Icon only. A labelled control and an "as of" line under six labelled
          controls was three kinds of text in a column that wants one, and the
          date is already in the masthead. */}
      <button
        type="button"
        className="sidenav-collapse"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Hide section names' : 'Show section names'}
        title={open ? 'Hide names' : 'Show names'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={open ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
        </svg>
      </button>
    </nav>
  );
}
