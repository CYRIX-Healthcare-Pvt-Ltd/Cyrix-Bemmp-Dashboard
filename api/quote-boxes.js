import { caller, configured, json, readBody } from './_lib/server.js';

/**
 * Gemini names a quotation template's boxes (the user, 25 Nov: "the field they should understand"). The rules in
 * yellowDoc.js read the Word first; this only renames each box, or says it is no box at all (fixed text someone
 * coloured yellow). Quotation-tracker people only; the key (GEMINI_API_KEY, Vercel) never leaves this function.
 * Any failure answers 502 and the upload goes on with the rules' names.
 */
// Pro first, Flash if Pro fails or is slow (the user, 25 Nov); then the rules alone.
const MODELS = [['gemini-2.5-pro', 40000], ['gemini-2.5-flash', 15000]];
export const config = { maxDuration: 60 };

const PROMPT = `You read a company quotation template (Word). People marked in yellow the parts that change in each quotation; a program turned each yellow part into a form box and guessed a label. For each box you get: key, kind, the guessed label, the yellow sample text, and the words around it (the yellow part is in [brackets]).
For each box decide:
- label: a short plain-English name a sales coordinator understands (2-4 words, Title case, no colon), e.g. "Doctor Name", "Hospital Address", "Contract Period", "Breakdown Response Time", "Number Of PM Visits". Keep the guessed label if it is already right.
- box: false only when the yellow text is a heading or fixed wording that never changes between quotations (e.g. "Annexure 1", "SIGNATURE", a section title); otherwise true.
You also get the template's other text (not yellow, so the program keeps it fixed). List up to 8 places in it that look like they would change in each quotation but were not marked yellow: a customer or doctor name, hospital or address, a date, a quotation or reference number, a contract period, a price, a quantity, a person's name, designation or phone in the signature. Skip company boilerplate, terms and Cyrix's own address. For each give the exact words (as written, max 60 characters) and a short label.
Answer JSON only: {"boxes":[{"key":"...","label":"...","box":true}],"missed":[{"text":"...","label":"..."}]} with every box key given, in the same order.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
  if (!configured()) { json(res, 503, { error: 'Not configured.' }); return; }
  const who = await caller(req);
  if (!who) { json(res, 401, { error: 'Sign in first.' }); return; }
  if (!(who.scope ?? []).includes('qt')) { json(res, 403, { error: 'Quotation tracker only.' }); return; }
  const key = process.env.GEMINI_API_KEY;
  if (!key) { json(res, 503, { error: 'No Gemini key on this deployment.' }); return; }

  const { boxes, plain } = readBody(req) ?? {};
  if (!Array.isArray(boxes) || boxes.length > 80) { json(res, 400, { error: 'boxes: 1–80 needed.' }); return; }
  const slim = boxes.map((b) => ({
    key: String(b.key).slice(0, 80), kind: String(b.kind ?? '').slice(0, 20),
    label: String(b.label ?? '').slice(0, 60), sample: String(b.sample ?? '').slice(0, 200), around: String(b.around ?? '').slice(0, 300),
  }));

  try {
    const ask = (model, ms) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ boxes: slim, otherText: String(plain ?? '').slice(0, 12000) }) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(ms),
    }).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error?.message ?? `${model} ${r.status}`);
      return JSON.parse(body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '');
    });
    let out = null; let last = null;
    for (const [model, ms] of MODELS) { try { out = await ask(model, ms); break; } catch (e) { last = e; } }
    if (!out) { json(res, 502, { error: `Gemini: ${last?.message}` }); return; }
    const known = new Set(slim.map((b) => b.key));
    const answer = (out?.boxes ?? [])
      .filter((b) => known.has(b.key))
      .map((b) => ({ key: b.key, label: String(b.label ?? '').trim().slice(0, 40), box: b.box !== false }));
    const missed = (out?.missed ?? []).slice(0, 8).map((m) => ({ text: String(m.text ?? '').slice(0, 60), label: String(m.label ?? '').slice(0, 40) })).filter((m) => m.text && String(plain ?? '').includes(m.text));
    json(res, 200, { boxes: answer, missed });
  } catch (e) {
    json(res, 502, { error: `Gemini: ${e.message}` });
  }
}
