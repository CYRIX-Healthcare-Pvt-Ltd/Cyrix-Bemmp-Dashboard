/**
 * Parses an uploaded workbook off the main thread.
 *
 * A 265k-row Kerala export takes several seconds of solid CPU; doing it inline
 * would freeze the tab for the whole time and lose the progress bar.
 */
import { parseWorkbook } from '../data/workbook.js';

self.onmessage = async (event) => {
  const { file, stateId } = event.data;
  try {
    const { buffer, meta } = await parseWorkbook(file, {
      stateId,
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
    });
    // The buffer is transferred, not copied — it is 25 MB at Kerala's size.
    self.postMessage({ type: 'done', buffer, meta }, [buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
