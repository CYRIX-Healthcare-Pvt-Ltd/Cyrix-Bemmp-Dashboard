/**
 * Cyrix Healthcare wordmark, redrawn as SVG text so it inherits the theme —
 * the dark half of the logo flips to white in dark mode via `currentColor`.
 *
 * To use the official artwork instead, drop the file at `public/cyrix-logo.svg`
 * and swap this component's body for an <img>. The proportions here match the
 * supplied lockup: CYRIX with a red X and registered mark, rule, then the
 * letterspaced entity line.
 */
export default function Logo({ height = 42 }) {
  return (
    <svg
      className="logo"
      viewBox="0 0 300 78"
      height={height}
      role="img"
      aria-label="Cyrix Health Care Pvt Ltd"
    >
      <text
        x="0" y="44"
        fontSize="52" fontWeight="700" letterSpacing="1"
        fill="currentColor"
        fontFamily="var(--font)"
      >
        CYRI<tspan fill="var(--brand-red)">X</tspan>
      </text>
      <text
        x="171" y="16"
        fontSize="13" fontWeight="600"
        fill="var(--brand-red)"
        fontFamily="var(--font)"
      >
        ®
      </text>
      <text
        x="1" y="66"
        fontSize="13.5" fontWeight="500" letterSpacing="3.4"
        fill="currentColor"
        fontFamily="var(--font)"
      >
        HEALTH CARE PVT LTD
      </text>
    </svg>
  );
}

/** The strapline, used under the masthead heading. */
export function Tagline() {
  return (
    <span className="tagline">
      The <span className="tagline-x">X</span>-Factor in Medical Technology Reliability
    </span>
  );
}
