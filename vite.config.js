import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * A GitHub Pages *project* site is served from https://<user>.github.io/<repo>/,
 * so assets need that prefix. The deploy workflow passes it in as VITE_BASE from
 * actions/configure-pages; local builds and user/org sites stay at "/".
 */
const base = process.env.VITE_BASE
  ? `${process.env.VITE_BASE.replace(/\/+$/, '')}/`
  : '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173 },
});
