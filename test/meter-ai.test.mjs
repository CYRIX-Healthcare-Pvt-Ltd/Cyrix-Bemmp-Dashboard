// The assistant's token use to the shared database's ops_report_ai() (KPI 0236): counts and the model only,
// as the person who asked, and never a reason for the answer to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://db.example';
process.env.SUPABASE_SERVICE_KEY = 'service';
const { meterAi } = await import('../api/_lib/server.js');

const req = { headers: { authorization: 'Bearer user-token' } };
const answer = JSON.stringify({
  model: 'gpt-4o-mini-2024-07-18',
  choices: [{ message: { content: 'the answer text' } }],
  usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 128 } },
});

test('sends model and counts as the caller, nothing of the answer', async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, init }); return new Response('', { status: 204 }); };
  await meterAi(req, 'assistant', answer);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://db.example/rest/v1/rpc/ops_report_ai');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer user-token');
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body, { p_app: 'bemmp', p_feature: 'assistant', p_model: 'gpt-4o-mini-2024-07-18',
                           p_input: 900, p_cached: 128, p_output: 40 });
  assert.ok(!sent[0].init.body.includes('the answer text'));
});

test('no session, no usage block or a failing database: nothing thrown', async () => {
  const sent = [];
  globalThis.fetch = async () => { sent.push(1); throw new Error('down'); };
  await meterAi({ headers: {} }, 'assistant', answer);
  await meterAi(req, 'assistant', JSON.stringify({ model: 'x' }));
  await meterAi(req, 'assistant', 'not json');
  assert.equal(sent.length, 0);
  await meterAi(req, 'assistant', answer);
  assert.equal(sent.length, 1);
});
