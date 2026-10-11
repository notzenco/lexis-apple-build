import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { context, createClient, distribute, preflight } from './testflight-distribution.mjs';

const env = { IOS_BUNDLE_ID: 'pw.example.lexis', BUILD_NUMBER: '33', TESTFLIGHT_WHAT_TO_TEST: 'Check offline widgets and sync.' };
const app = { id: 'app', attributes: { bundleId: env.IOS_BUNDLE_ID } };
const group = { id: 'internal', attributes: { name: 'Personal Testing', isInternalGroup: true } };

function fixture({ builds = [], internal = true, pages = false } = {}) {
  const requests = [];
  let assigned = false, notes;
  const api = async (path, method = 'GET', body) => {
    requests.push({ path, method, body });
    if (path.startsWith('/v1/apps?')) return { data: [app] };
    if (path.startsWith('/v1/apps/app/betaGroups')) return { data: [{ ...group, attributes: { ...group.attributes, isInternalGroup: internal } }] };
    if (path === '/next') return { data: [{ attributes: { version: '34' } }] };
    if (path.startsWith('/v1/builds?')) return { data: builds, links: pages ? { next: '/next' } : {} };
    if (path === '/v1/betaBuildLocalizations' && method === 'POST') { notes = { id: 'notes', attributes: body.data.attributes }; return { data: notes }; }
    if (path.startsWith('/v1/builds/build/betaBuildLocalizations')) return { data: notes ? [notes] : [] };
    if (path.startsWith('/v1/betaGroups/internal/relationships/builds?')) return { data: assigned ? [{ type: 'builds', id: 'build' }] : [] };
    if (path === '/v1/betaGroups/internal/relationships/builds' && method === 'POST') { assigned = true; return; }
    if (path === '/v1/builds/build/buildBetaDetail') return { data: { attributes: { internalBuildState: assigned ? 'IN_BETA_TESTING' : 'READY_FOR_BETA_TESTING' } } };
    throw new Error(`Unexpected test request: ${path}`);
  };
  return { api, requests };
}

test('preflight checks all pages and all historical marketing versions', async () => {
  const f = fixture({ builds: [{ attributes: { version: '1.0' } }, { attributes: { version: '32' } }], pages: true });
  await assert.rejects(preflight(f.api, env), /existing build 34/);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('a matching external group is never used or modified', async () => {
  const f = fixture({ internal: false });
  await assert.rejects(context(f.api, env.IOS_BUNDLE_ID), /existing internal/);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('valid build gets notes and existing internal access, verified by readback', async () => {
  const f = fixture({ builds: [{ id: 'build', attributes: { version: '33', processingState: 'VALID', expired: false } }] });
  assert.match(await distribute(f.api, env), /IN_BETA_TESTING/);
  const changes = f.requests.filter(request => request.method !== 'GET');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].body, { data: [{ type: 'builds', id: 'build' }] });
  assert.equal(changes[1].path, '/v1/betaGroups/internal/relationships/builds');
});

test('failed processing cannot publish notes or assign testers', async () => {
  const f = fixture({ builds: [{ id: 'build', attributes: { version: '33', processingState: 'INVALID' } }] });
  await assert.rejects(distribute(f.api, env), /rejected build processing/);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('processing timeout leaves the existing upload untouched', async () => {
  const f = fixture();
  let time = 0;
  await assert.rejects(distribute(f.api, env, { now: () => time, timeoutMs: 1, sleep: async () => { time = 2; } }), /inspect this upload before retrying/);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

test('JWT signature is ES256 and API credentials cannot follow pagination off-origin', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let calls = 0;
  const api = createClient({ APP_STORE_CONNECT_API_KEY: privateKey, APP_STORE_CONNECT_API_KEY_ID: 'test-key', APP_STORE_CONNECT_ISSUER_ID: 'test-issuer' }, async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
    const [header, payload, signature] = options.headers.Authorization.slice(7).split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).aud, 'appstoreconnect-v1');
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ data: [] }));
  });
  await api('/v1/apps');
  await assert.rejects(api('https://untrusted.example/next'), /unexpected API origin/);
  assert.equal(calls, 1);
});

test('provider diagnostics are suppressed even when an API error contains secrets', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const api = createClient({ APP_STORE_CONNECT_API_KEY: privateKey, APP_STORE_CONNECT_API_KEY_ID: 'test-key', APP_STORE_CONNECT_ISSUER_ID: 'test-issuer' }, async () => new Response('secret-provider-diagnostic', { status: 403 }));
  await assert.rejects(api('/v1/apps'), error => error.message === 'App Store Connect returned HTTP 403 for GET /v1/resource.');
});
