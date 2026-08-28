import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled rather than fetched from a CDN, and bundled at all: the
// stylesheet has always asked for this face and nothing ever loaded it, so
// every machine without SF Pro silently fell back to system-ui.
import '@fontsource-variable/inter';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
