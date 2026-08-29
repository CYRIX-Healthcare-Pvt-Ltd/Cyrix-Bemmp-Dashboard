import onLight from '../assets/cyrix-logo.png';
import onDarkArt from '../assets/cyrix-logo-white.png';

/**
 * The Cyrix Healthcare lockup — the real artwork, not a drawing of it.
 *
 * Every module used to approximate this wordmark in its own SVG, which is
 * how one company came to have four that were nearly but not quite alike.
 * This is the supplied file, shipped as-is, so there is nothing left to
 * drift.
 *
 * Two files rather than one: the artwork is black type on a transparent
 * ground and would vanish on a dark page. The dark-page copy is the same
 * image with its *lightness* inverted and hue left alone — a plain invert
 * would turn the red cyan and the blue orange, which is another company's
 * logo. Both are in the markup and CSS picks one, so the swap happens in
 * the same frame as the theme and never flashes the wrong one.
 *
 * The lockup is three stacked bands, and the shorter ones are a crop of
 * the same file rather than separate exports — `.cyrix-logo` clips, so
 * asking for less shows less of one image.
 */

/** Where each band's ink ends, in the artwork's own 300 x 115 grid. */
const BAND = { wordmark: 67, entity: 92, full: 115 };

export default function Logo({
  className = '',
  height,
  onDark = false,
  showSubtitle = true,
  showTagline = false,
}) {
  const band = showTagline ? BAND.full : showSubtitle ? BAND.entity : BAND.wordmark;

  /*
   * Width stated outright, not left to `aspect-ratio`.
   *
   * A flex item stretches on its cross axis, and in a *column* container
   * that axis is the width. The box grows to the container, and once both
   * width and height are definite the ratio is ignored: the image inside
   * is `width: 100%`, so it renders many times too tall and the wrapper
   * clips it to a sliver of one letter.
   *
   * With both dimensions given there is nothing left to stretch. The
   * ratio stays for the caller that sizes by class instead, which is
   * always inside a row and never stretched.
   */
  const box = height === undefined
    ? { aspectRatio: `300 / ${band}` }
    : { height: `${height}px`, width: `${(height * 300) / band}px` };

  return (
    <span
      className={`cyrix-logo ${className}`}
      data-on={onDark ? 'dark' : undefined}
      style={box}
      role="img"
      aria-label="Cyrix Health Care Pvt Ltd"
    >
      <img className="cyrix-logo-light" src={onLight} alt="" />
      <img className="cyrix-logo-dark" src={onDarkArt} alt="" />
    </span>
  );
}

/**
 * The strapline, used under the masthead heading.
 *
 * Text rather than the strapline band of the artwork: here it belongs to
 * "BEMMP Service Dashboard" in the column beside the logo, not to the
 * lockup — showing the artwork's own band as well would print it twice.
 */
export function Tagline() {
  return (
    <span className="tagline">
      The <span className="tagline-x">X</span>-Factor in Medical Technology Reliability
    </span>
  );
}
