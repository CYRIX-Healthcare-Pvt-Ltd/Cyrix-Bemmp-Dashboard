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

// Signed out within a minute when another device signs everybody out (0149).
startSessionGuard()
// Before React mounts, so an error during the first render is caught too (shared DB, KPI 0230).
startErrorReporting(supabase, 'bemmp', import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA?.slice(0, 7))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
