import { supabase } from './supabase.js';

/*
  Gemini names a template's boxes at upload (the user, 25 Nov; api/quote-boxes.js). Only plain boxes are sent (text,
  number, a name block); dates, periods, worked-out words and the price table keep the rules' reading. A box Gemini
  calls no box becomes kind 'fixed': hidden on the form, its text left as the template has it. Any failure: the
  rules' names stand, the upload is never stopped.
*/
const ASK = new Set(['text', 'num', 'lines']);

export async function nameBoxes(Y) {
  const boxes = Y.fields.filter((f) => ASK.has(f.kind) && !f.role).map((f) => ({ key: f.key, kind: f.kind, label: f.label, sample: f.sample, around: f.around ?? '' }));
  const { plain, ...rest } = Y; Y = rest;
  if (!boxes.length && !plain) return { Y, ai: false };
  try {
    const { data } = await supabase.auth.getSession();
    const r = await fetch(`${import.meta.env.BASE_URL}api/quote-boxes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data?.session?.access_token ?? ''}` },
      body: JSON.stringify({ boxes, plain }),
      signal: AbortSignal.timeout(65000),
    });
    if (!r.ok) return { Y, ai: false };
    const ans = await r.json();
    const by = new Map((ans?.boxes ?? []).map((b) => [b.key, b]));
    const fields = Y.fields.map((f) => {
      const b = by.get(f.key); if (!b) return f;
      return b.box ? { ...f, label: b.label || f.label } : { ...f, kind: 'fixed', label: b.label || f.label };
    });
    // Not yellow but likely to change: a note on the Boxes list, nothing more (the user, 25 Nov: "just a companion").
    return { Y: { ...Y, fields, missed: ans?.missed ?? [] }, ai: true };
  } catch { return { Y, ai: false }; }
}
