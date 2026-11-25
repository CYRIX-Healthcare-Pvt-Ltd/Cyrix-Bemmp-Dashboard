import { caller, configured, json, readBody } from './_lib/server.js';

/**
 * Gemini names a quotation template's boxes (the user, 25 Nov: "the field they should understand"). The rules in
 * yellowDoc.js read the Word first; this only renames each box, or says it is no box at all (fixed text someone
 * coloured yellow). Quotation-tracker people only; the key (GEMINI_API_KEY, Vercel) never leaves this function.
 * Any failure answers 502 and the upload goes on with the rules' names.
 */
// Pro first, Flash if Pro fails or is slow (the user, 25 Nov); then the rules alone. Google retires model names for new
// keys (2.5 refused on 25 Nov), so the newest Pro and Flash this key may use are looked up, not written in.
const FALLBACK = [['gemini-3.8-pro', 40000], ['gemini-3.8-flash', 15000]];
const ver = (n) => (n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [0, '0'])[1] * 1;
async function pickModels(key) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(5000) });
    const names = ((await r.json())?.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      // Previews kept (the newest Pro is often only a preview); never 2.x, which Google lists but refuses new keys.
      .filter((n) => /^gemini-\d/.test(n) && ver(n) >= 3 && !/lite|exp|image|tts|audio|live|embed|thinking|-\d{3,}$/.test(n));
    // Every Pro newest first (a finished one before its preview), then every Flash: a refusal is instant, so trying more costs nothing.
    const rank = (kind) => names.filter((n) => n.includes(`-${kind}`)).sort((a, b) => ver(b) - ver(a) || /preview/.test(a) - /preview/.test(b) || a.length - b.length);
    const out = [...rank('pro').slice(0, 3).map((n) => [n, 30000]), ...rank('flash').slice(0, 3).map((n) => [n, 25000])];
    return out.length ? out : FALLBACK;
  } catch { return FALLBACK; }
}
export const config = { maxDuration: 60 };

const PROMPT = `You read a company quotation template (Word). People marked in yellow the parts that change in each quotation; a program turned each yellow part into a form box and guessed a label. For each box you get: key, kind, the guessed label, the yellow sample text, and the words around it (the yellow part is in [brackets]).
For each box decide:
- label: a short plain-English name a sales coordinator understands (2-4 words, Title case, no colon), e.g. "Doctor Name", "Hospital Address", "Contract Period", "Breakdown Response Time", "Number Of PM Visits". Keep the guessed label if it is already right.
- common: true when the text is a standard term that stays the same for most customers (number of visits, response or support times, payment terms wording); false for anything about this customer or this quotation (names, hospital, address, dates, numbers, prices, subject, signer).
- size: "short" when a typical value fits in about 25 characters (a time, a count, a code), "long" when it is a phrase or sentence.
- box: false only when the yellow text is a heading or fixed wording that never changes between quotations (e.g. "Annexure 1", "SIGNATURE", a section title); otherwise true.
You also get the template's other text (not yellow, so the program keeps it fixed). List up to 8 places in it that look like they would change in each quotation but were not marked yellow: a customer or doctor name, hospital or address, a date, a quotation or reference number, a contract period, a price, a quantity, a person's name, designation or phone in the signature. Skip company boilerplate, terms and Cyrix's own address. For each give the exact words (as written, max 60 characters), a short label, and common and size as for boxes.
Answer JSON only: {"boxes":[{"key":"...","label":"...","box":true,"common":false,"size":"short"}],"missed":[{"text":"...","label":"...","common":false,"size":"short"}]} with every box key given, in the same order.`;

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
    let out = null; let last = null; let used = null;
    // Busy or rate-limited ("high demand", 25 Nov): one more try after 2 s before the next model. Every reason is kept.
    const why = [];
    const end = Date.now() + 54000; // the function may run 60 s
    for (const [model, ms] of await pickModels(key)) {
      for (let k = 0; k < 2 && !out; k++) {
        const left = end - Date.now(); if (left < 4000) break;
        try { out = await ask(model, Math.min(ms, left)); used = model; } catch (e) { last = e; why.push(`${model}: ${String(e.message).slice(0, 80)}`); if (!/demand|overload|busy|unavailable|429|503|exhaust|rate/i.test(e.message)) break; await new Promise((r) => setTimeout(r, 2000)); }
      }
      if (out) break;
    }
    if (!out && why.length) last = new Error(why.join(' · '));
    if (!out) { json(res, 502, { error: `Gemini: ${last?.message}` }); return; }
    const known = new Set(slim.map((b) => b.key));
    const answer = (out?.boxes ?? [])
      .filter((b) => known.has(b.key))
      .map((b) => ({ key: b.key, label: String(b.label ?? '').trim().slice(0, 40), box: b.box !== false, common: b.common === true, size: b.size === 'long' ? 'long' : 'short' }));
    const missed = (out?.missed ?? []).slice(0, 8).map((m) => ({ text: String(m.text ?? '').slice(0, 60), label: String(m.label ?? '').slice(0, 40), common: m.common === true, size: m.size === 'long' ? 'long' : 'short' })).filter((m) => m.text && String(plain ?? '').includes(m.text));
    json(res, 200, { boxes: answer, missed, model: used + (why.length ? ` · tried ${why.join(" · ")}` : "") });
  } catch (e) {
    json(res, 502, { error: `Gemini: ${e.message}` });
  }
}
