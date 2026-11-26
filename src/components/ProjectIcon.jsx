/**
 * A project's mark: the state's own outline for a contract, the brand's mark
 * for a brand (the user, 31 Oct: "show icon as state map, if any brand ie
 * medtronics use their logo").
 *
 * The outlines are Natural Earth's admin-1 boundaries (public domain, v5.1.1),
 * simplified and fitted to a 48-unit box. Medtronic is the round blue M the
 * user sent.
 */
const STATE_PATHS = {
  up: "M34.7 20.5L35.2 21.8L37.4 22.1L38.3 22.9L38.9 22.0L41.8 22.9L42.8 25.5L43.7 25.7L43.9 26.6L44.7 27.3L43.0 27.3L42.0 28.0L42.0 28.5L43.5 29.0L43.5 29.7L42.4 30.2L44.0 32.0L46.0 32.9L45.5 33.5L44.3 33.2L44.0 33.8L43.3 33.2L38.6 36.7L38.7 38.8L39.7 39.7L39.7 41.1L38.9 41.3L39.2 42.2L37.9 44.8L36.2 45.0L35.1 44.1L34.7 43.3L35.2 42.4L35.1 40.9L35.5 40.7L34.9 39.9L33.3 39.8L33.2 40.4L32.6 40.4L32.0 39.0L30.5 38.9L29.9 37.8L28.3 37.5L28.1 36.7L27.4 37.3L26.4 36.9L25.5 38.6L23.6 38.1L24.0 36.6L23.0 37.0L23.3 37.5L22.4 37.0L21.8 37.3L21.9 37.9L20.9 37.9L20.7 37.4L21.6 36.8L20.8 35.3L20.3 35.3L18.2 36.5L18.3 37.0L16.5 36.9L15.4 37.6L15.9 36.1L15.1 36.4L15.1 35.6L14.9 36.9L13.5 36.9L13.3 36.2L12.6 36.8L13.1 35.2L12.7 34.5L12.4 35.3L11.7 34.8L11.7 35.8L10.9 35.4L10.5 36.2L11.7 39.0L11.7 40.3L12.6 40.4L13.1 41.8L12.2 43.1L10.3 41.8L9.6 42.6L8.8 41.1L9.1 40.5L8.5 38.9L9.4 38.0L9.6 36.8L8.9 35.4L9.6 34.4L11.8 33.8L11.8 33.0L13.6 28.7L12.9 26.9L9.5 25.9L8.7 26.2L8.9 25.5L8.5 25.3L7.6 25.9L5.9 25.4L4.0 26.4L4.1 25.8L5.9 24.9L4.6 24.5L5.5 23.7L4.2 22.4L3.4 20.3L3.3 19.8L4.7 18.8L4.4 17.8L4.8 16.9L3.4 14.8L2.4 11.3L2.5 9.3L2.0 9.3L2.9 5.8L5.5 3.0L7.2 4.0L6.0 5.7L6.5 7.7L7.3 7.3L8.4 7.6L8.8 5.8L11.2 8.5L12.8 9.3L11.6 10.1L12.8 11.3L13.6 11.0L15.9 13.0L18.0 12.8L19.0 13.8L19.6 13.2L22.0 14.9L22.4 14.1L25.9 16.2L26.7 17.7L27.3 17.5L29.9 19.5L30.9 19.1L33.1 20.6L34.7 20.5Z",
  ap: "M21.4 37.5L20.7 36.3L20.2 37.0L21.3 37.8L20.1 37.4L18.7 39.2L16.9 38.5L15.3 40.2L12.9 40.1L11.4 42.4L10.6 42.3L10.3 41.2L11.5 41.2L11.2 40.8L12.1 38.9L11.1 38.6L11.0 37.1L9.4 36.7L9.4 35.6L8.6 35.7L8.6 35.0L7.9 35.1L7.2 36.1L6.0 36.5L5.7 35.6L4.3 35.3L4.2 36.1L3.3 36.1L3.6 35.2L2.9 33.8L5.6 35.4L5.3 34.1L6.1 33.7L5.6 32.8L5.6 33.4L4.3 32.8L3.9 33.4L3.0 33.3L3.1 32.1L2.1 31.3L2.6 29.5L2.0 29.2L2.2 28.5L3.7 29.1L4.2 28.3L3.4 26.2L4.0 25.3L3.7 24.1L4.8 23.5L9.5 24.4L10.3 23.2L13.3 23.2L14.6 22.0L15.6 22.1L15.9 20.2L18.7 19.3L19.7 19.8L20.3 18.8L20.0 18.3L20.7 17.6L23.2 18.9L23.1 18.1L22.0 17.9L22.1 17.3L22.5 17.5L23.1 17.0L24.6 17.4L25.0 16.7L27.6 15.6L29.5 12.6L31.1 11.8L32.6 11.8L33.2 9.1L34.3 10.8L35.2 9.6L36.5 9.9L36.4 8.4L38.4 7.2L37.9 6.5L38.7 6.6L38.8 6.0L39.1 6.4L39.6 5.7L41.2 7.5L42.6 7.6L43.6 7.5L44.3 6.2L45.9 5.5L42.4 10.4L38.8 12.5L37.6 14.4L32.8 17.1L32.2 18.1L32.5 18.6L32.8 18.3L32.5 20.1L29.5 21.6L26.8 21.5L25.4 24.7L24.8 23.2L24.3 25.0L24.1 24.1L23.6 23.9L21.4 25.1L20.2 28.6L21.0 31.5L20.9 32.8L20.2 33.6L20.6 33.5L21.4 37.5Z",
  kl: "M15.3 9.4L11.8 2.2L12.5 2.0L14.2 3.5L15.7 3.8L15.6 4.4L16.7 5.0L16.9 6.7L19.2 8.6L20.5 9.0L21.0 10.0L22.4 10.3L23.5 10.0L23.7 11.0L26.5 12.1L26.7 13.1L26.0 13.6L25.1 13.5L25.0 14.2L28.0 16.1L27.1 17.4L29.5 17.1L30.1 19.0L29.4 19.1L29.3 19.9L31.3 21.6L30.7 23.0L30.8 26.2L32.0 27.0L34.2 25.8L34.7 26.4L34.9 29.7L34.2 33.2L35.6 33.3L36.3 34.5L34.0 39.0L34.8 40.5L34.2 42.5L35.1 43.6L34.4 44.1L33.9 45.9L32.3 45.2L28.0 39.9L28.7 39.7L28.3 39.6L29.2 38.9L27.8 39.5L27.4 37.3L26.7 36.6L27.0 37.6L26.2 35.8L25.0 29.7L25.5 30.8L25.7 30.4L26.0 32.2L25.8 30.6L26.2 31.0L26.2 33.9L27.6 33.8L26.7 33.4L26.5 30.8L25.1 28.2L24.8 28.1L25.1 29.3L24.5 28.2L25.1 26.9L24.6 26.6L24.7 27.3L24.2 27.1L20.2 15.8L16.1 10.3L17.0 10.4L16.9 9.9L16.3 10.1L15.8 9.6L17.0 8.2L15.3 8.7L15.3 9.4Z"
};

export const hasProjectIcon = (id) => id === 'mt' || id === 'pm' || id in STATE_PATHS;

export default function ProjectIcon({ id, className = '' }) {
  // The PM checklist is a project of the work, not of a place or a brand: a ticked clipboard.
  if (id === 'pm') {
    return (
      <svg className={"project-mark " + className} viewBox="0 0 48 48" aria-hidden="true" fill="none"
           stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="11" y="8" width="26" height="33" rx="5" />
        <path d="M18 8.5V5.5h12v3" />
        <path d="M17.5 25l4.5 4.5 9-9.5" />
      </svg>
    );
  }
  if (id === 'mt') {
    return (
      <svg className={"project-mark is-brand " + className} viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="24" fill="#1f2be0" />
        <circle cx="24" cy="24" r="20.5" fill="none" stroke="#fff" strokeWidth="1.6" />
        <text x="24" y="32" textAnchor="middle" fontSize="23" fontWeight="800" fill="#fff"
              fontFamily="Arial, Helvetica, sans-serif">M</text>
      </svg>
    );
  }
  const d = STATE_PATHS[id];
  if (!d) return null;
  return (
    <svg className={"project-mark " + className} viewBox="0 0 48 48" aria-hidden="true">
      <path d={d} fill="currentColor" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}
