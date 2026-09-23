/**
 * Cyra's endpoints answer only the people it is turned on for.
 *
 * The button is hidden from everybody else, but a hidden button is no lock on
 * a known URL, and every question is billed. So the endpoint asks the same
 * question of the caller's own profile — read from their token, never from
 * anything the request says about itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Read when the module loads, so set before it does.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_KEY = 'service-key-for-tests';
const { requireCyra } = await import('../api/_lib/server.js');

function fakeRes() {
  const res = { statusCode: 0, body: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.setHeader = () => res;
  res.send = (b) => { res.body = JSON.parse(b); return res; };
  return res;
}

/** Answers GoTrue and PostgREST as the given profile row would; records what was asked. */
async function asCaller(row, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'e1@x' }), { status: 200 });
    if (u.includes('/rest/v1/profile')) return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    return await fn(asked);
  } finally {
    globalThis.fetch = real;
  }
}

const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

test('no session: 401, and nothing is looked up', async () => {
  await asCaller(null, async (asked) => {
    const res = fakeRes();
    assert.equal(await requireCyra(req(null), res), null);
    assert.equal(res.statusCode, 401);
    assert.equal(asked.length, 0);
  });
});

test('signed in without Cyra: 403, with what to do about it', async () => {
  await asCaller({ id: 'u1', code: 'E1', role: 'coordinator', scope: ['kl'], cyra: false }, async () => {
    const res = fakeRes();
    assert.equal(await requireCyra(req('t'), res), null);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /SW admin/);
  });
});

test('signed in with no BEMMP profile at all: 403', async () => {
  await asCaller(null, async () => {
    const res = fakeRes();
    assert.equal(await requireCyra(req('t'), res), null);
    assert.equal(res.statusCode, 403);
  });
});

test('Cyra turned on: through, as that person', async () => {
  await asCaller({ id: 'u1', code: 'E1', role: 'coordinator', scope: ['kl'], cyra: true }, async (asked) => {
    const res = fakeRes();
    const who = await requireCyra(req('t'), res);
    assert.equal(who?.code, 'E1');
    assert.equal(res.statusCode, 0, 'nothing was sent back');
    // The switch is read with the rest of the profile, not assumed.
    assert.ok(asked.some((u) => u.includes('/rest/v1/profile') && u.includes('cyra')));
  });
});

test('an admin is not let through on the role alone', async () => {
  await asCaller({ id: 'u1', code: 'SW', role: 'admin', scope: [], cyra: false }, async () => {
    const res = fakeRes();
    assert.equal(await requireCyra(req('t'), res), null);
    assert.equal(res.statusCode, 403);
  });
});
