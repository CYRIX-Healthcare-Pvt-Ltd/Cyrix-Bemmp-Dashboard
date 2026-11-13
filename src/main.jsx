import { startSessionGuard } from './data/sessionGuard.js'
import { supabase } from './data/supabase.js'
import { startErrorReporting } from './data/reportErrors.js'
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled rather than fetched from a CDN, and bundled at all: the
// stylesheet has always asked for this face and nothing ever loaded it, so
// every machine without SF Pro silently fell back to system-ui.
import '@fontsource-variable/inter';
import App from './App.jsx';
import './styles.css';

/*
  A number box changes only by typing: the mouse wheel over a focused one changed its value (Travel, 22 Oct;
  every app 13 Nov: "when scrolling numbers are changing ... we dont need"). The box lets go as the wheel turns,
  so the page scrolls, and the up and down arrow keys do nothing.
*/
document.addEventListener('wheel', () => {
  const el = document.activeElement
  if (el instanceof HTMLInputElement && el.type === 'number') el.blur()
}, { passive: true })
document.addEventListener('keydown', e => {
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target instanceof HTMLInputElement && e.target.type === 'number') e.preventDefault()
})

// Signed out within a minute when another device signs everybody out (0149).
startSessionGuard()
// Before React mounts, so an error during the first render is caught too (shared DB, KPI 0230).
startErrorReporting(supabase, 'bemmp', import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA?.slice(0, 7))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
