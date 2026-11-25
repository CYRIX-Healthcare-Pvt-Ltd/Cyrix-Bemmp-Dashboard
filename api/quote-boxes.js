import { caller, configured, json, readBody } from './_lib/server.js';

/**
 * AI helps read a quotation template at upload (the user, 25 Nov: "the field they should understand"). The rules in
 * yellowDoc.js read the Word first; this only renames each yellow box (or says it is fixed text), and lists text that
 * changes per quotation but was not marked yellow. Quotation-tracker people only; the keys never leave this function.
 *
 * Two jobs, run together (the user, 25 Nov: "delegate each task"):
 *   boxes — name the yellow boxes: small input, exact answers → GPT-4.1 (GitHub Models) first, Gemini if it fails.
 *   finds — read the whole document for unmarked changing text: long input → Gemini first, GPT-4.1 if it fails.
 * One job failing still keeps the other's answer. Both failing answers 502 and the upload goes on with the rules' names.
 */
// Google retires model names for new keys (2.5 refused on 25 Nov), so the newest Pro and Flash this key may use are
// looked up, not written in.
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
    const rank = (kind) => names.filter((n) => n.includes(`-${kind}`)).sort((a, b) => ver(b) - ver(a) || /preview/.test(a) - /preview/.test(b) || a.length - b.length);
    const out = [...rank('pro').slice(0, 2).map((n) => [n, 25000]), ...rank('flash').slice(0, 3).map((n) => [n, 25000])];
    return out.length ? out : FALLBACK;
  } catch { return FALLBACK; }
}
export const config = { maxDuration: 60 };

const ABOUT = 'You read a company quotation template (Word). People marked in yellow the parts that change in each quotation; a program turned each yellow part into a form box and guessed a label.';
const BOXES_PROMPT = `${ABOUT} For each box you get: key, kind, the guessed label, the yellow sample text, and the words around it (the yellow part is in [brackets]).
Your job is to decide what the person making a quotation must actually type. For each box decide:
- label: a short plain-English name a sales coordinator understands (2-4 words, Title case, no colon), e.g. "Doctor Name", "Hospital Address", "Contract Period", "Breakdown Response Time", "Number Of PM Visits". Keep the guessed label if it is already right. Never use the sample text itself, a number or an amount as the label.
- common: true when the text is a standard term that stays the same for most customers (number of visits, response or support times, payment terms wording); false for anything about this customer or this quotation (names, hospital, address, dates, numbers, prices, subject, signer).
- size: "short" when a typical value fits in about 25 characters (a time, a count, a code), "long" when it is a phrase or sentence.
- box: false only when the yellow text is a heading or fixed wording that never changes between quotations (e.g. "Annexure 1", "SIGNATURE", a section title, a table's column heading); otherwise true.
- calc: true when the value is worked out from other figures in the quotation (a GST amount, a total, a grand total, an amount that is a percentage of another, a sum of rows), so nobody should type it; otherwise false.
Answer JSON only: {"boxes":[{"key":"...","label":"...","box":true,"calc":false,"common":false,"size":"short"}]} with every box key given, in the same order.`;
const FINDS_PROMPT = `${ABOUT} You get the template's text and the yellow samples already made into boxes.
List up to 8 places in the text, not already yellow, that would change in each quotation: a customer or doctor name, hospital or address, a date, a quotation or reference number, a contract period, a price, a quantity, a person's name, designation or phone in the signature. Skip company boilerplate, terms and conditions, Cyrix's own address, and figures worked out from others (totals, GST, percentages). For each give the exact words (as written, max 60 characters), a short label (2-4 words, Title case), common (true only for standard terms the same for most customers) and size ("short" up to about 25 characters, else "long").
Answer JSON only: {"missed":[{"text":"...","label":"...","common":false,"size":"short"}]}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') { json(res, 405, { error: 'POST only.' }); return; }
  if (!configured()) { json(res, 503, { error: 'Not configured.' }); return; }
  const who = await caller(req);
  if (!who) { json(res, 401, { error: 'Sign in first.' }); return; }
  if (!(who.scope ?? []).includes('qt')) { json(res, 403, { error: 'Quotation tracker only.' }); return; }
  const key = process.env.GEMINI_API_KEY;
  const gh = process.env.GITHUB_MODELS_TOKEN;
  if (!key && !gh) { json(res, 503, { error: 'No AI key on this deployment.' }); return; }

  const { boxes, plain } = readBody(req) ?? {};
  if (!Array.isArray(boxes) || boxes.length > 80) { json(res, 400, { error: 'boxes: 0–80 needed.' }); return; }
  const slim = boxes.map((b) => ({
    key: String(b.key).slice(0, 80), kind: String(b.kind ?? '').slice(0, 20),
    label: String(b.label ?? '').slice(0, 60), sample: String(b.sample ?? '').slice(0, 200), around: String(b.around ?? '').slice(0, 300),
  }));
  const text = String(plain ?? '');

  // One model, one ask: JSON back or a short reason thrown.
  const gemini = (model, ms, system, input) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
    signal: AbortSignal.timeout(ms),
  }).then(async (r) => {
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error?.message ?? `${r.status}`);
    return JSON.parse(body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '');
  });
  const github = (model, ms, system, input) => fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${gh}` },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 4000, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
    }),
    signal: AbortSignal.timeout(ms),
  }).then(async (r) => {
    const raw = await r.text();
    let body = null; try { body = JSON.parse(raw); } catch { /* not JSON: shown below */ }
    if (!r.ok) throw new Error(body?.error?.message ?? body?.message ?? `${r.status} ${raw.slice(0, 60)}`);
    const c = body?.choices?.[0];
    const out = String(c?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!out) throw new Error(`empty answer (${c?.finish_reason ?? r.status} ${raw.slice(0, 60)})`);
    return JSON.parse(out);
  });

  const end = Date.now() + 54000; // the function may run 60 s
  const why = [];
  // Models in order; a busy one gets one more try after 2 s, a refusal (quota, bad model) none.
  async function run(plan, system, input) {
    for (const [model, ms, call] of plan) {
      for (let k = 0; k < 2; k++) {
        const left = end - Date.now(); if (left < 4000) return null;
        try { return { out: await call(model, Math.min(ms, left), system, input), model }; } catch (e) {
          why.push(`${model}: ${String(e.message).slice(0, 80)}`);
          if (/quota|billing/i.test(e.message) || !/demand|overload|busy|unavailable|429|503|exhaust|rate/i.test(e.message)) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    return null;
  }
  const gem = key ? (await pickModels(key)).map(([m, ms]) => [m, ms, gemini]) : [];
  const gpt = gh ? [['openai/gpt-4.1', 25000, github], ['openai/gpt-4.1-mini', 15000, github]] : [];
  const [b, f] = await Promise.all([
    slim.length ? run([...gpt, ...gem], BOXES_PROMPT, { boxes: slim }) : Promise.resolve(null),
    text ? run([...gem, ...gpt], FINDS_PROMPT, { yellow: slim.map((x) => x.sample), text: text.slice(0, 30000) }) : Promise.resolve(null),
  ]);
  if (!b && !f) { json(res, 502, { error: why.join(' · ') || 'No answer.' }); return; }

  const known = new Set(slim.map((x) => x.key));
  const answer = (b?.out?.boxes ?? [])
    .filter((x) => known.has(x.key))
    .map((x) => ({ key: x.key, label: String(x.label ?? '').trim().slice(0, 40), box: x.box !== false, calc: x.calc === true, common: x.common === true, size: x.size === 'long' ? 'long' : 'short' }));
  const missed = (f?.out?.missed ?? []).slice(0, 8)
    .map((m) => ({ text: String(m.text ?? '').slice(0, 60), label: String(m.label ?? '').slice(0, 40), common: m.common === true, size: m.size === 'long' ? 'long' : 'short' }))
    .filter((m) => m.text && text.includes(m.text));
  const model = `Boxes: ${b?.model ?? 'none'} · Finds: ${f?.model ?? 'none'}`;
  json(res, 200, { boxes: answer, missed, model: model + (why.length ? ` · tried ${why.join(' · ')}` : '') });
}
