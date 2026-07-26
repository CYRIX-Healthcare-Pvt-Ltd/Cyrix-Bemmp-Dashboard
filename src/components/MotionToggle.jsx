import { useEffect, useState } from 'react';

const KEY = 'bemmp-motion';

/**
 * Resolves the stored preference, falling back to the OS setting.
 *
 * Windows' "Animation effects" toggle makes Chrome report `prefers-reduced-motion:
 * reduce`, which is why this needs an explicit override — without one the ambient
 * layer is invisible on those machines with no way to turn it on.
 */
function initialMotion() {
  const stored = localStorage.getItem(KEY);
  if (stored === 'full' || stored === 'reduced') return stored;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full';
}

export default function MotionToggle() {
  const [motion, setMotion] = useState(initialMotion);

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
    localStorage.setItem(KEY, motion);
  }, [motion]);

  const on = motion === 'full';

  return (
    <button
      type="button"
      className="icon-toggle"
      onClick={() => setMotion(on ? 'reduced' : 'full')}
      aria-pressed={on}
      aria-label={on ? 'Turn off background motion' : 'Turn on background motion'}
      title={on ? 'Motion on — click to still the background' : 'Motion off — click to animate the background'}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
           stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {on ? (
          <path d="M2 12h4l3-7 4 14 3-7h6" />
        ) : (
          <>
            <path d="M2 12h20" />
            <path d="M4 5l16 14" opacity="0.5" />
          </>
        )}
      </svg>
      <span className="toggle-label">{on ? 'Motion' : 'Still'}</span>
    </button>
  );
}
