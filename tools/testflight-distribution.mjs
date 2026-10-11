import { sign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const origin = 'https://api.appstoreconnect.apple.com';
const groupName = 'Personal Testing';

export class ReleaseError extends Error {}

export function createClient(env, fetchImpl = fetch) {
  for (const name of ['APP_STORE_CONNECT_API_KEY', 'APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID']) {
    if (!env[name]) throw new ReleaseError(`Missing ${name}.`);
  }
  return async (path, method = 'GET', body) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new ReleaseError('Refusing an unexpected API origin.');
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: env.APP_STORE_CONNECT_API_KEY_ID, typ: 'JWT' })}.${encode({ iss: env.APP_STORE_CONNECT_ISSUER_ID, iat: now - 20, exp: now + 300, aud: 'appstoreconnect-v1' })}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: env.APP_STORE_CONNECT_API_KEY,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${unsigned}.${signature}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok) {
      const errors = await response.json().catch(() => ({}));
      const codes = (errors.errors ?? []).map(error => error.code).filter(code => typeof code === 'string' && /^[A-Z][A-Z0-9_.-]{0,100}$/.test(code));
      const operation = url.pathname.replace(/\/[a-f0-9-]{8,}(?=\/|$)/ig, '/resource');
      throw new ReleaseError(`App Store Connect returned HTTP ${response.status} for ${method} ${operation}${codes.length ? ` (${codes.join(', ')})` : ''}.`);
    }
    return response.status === 204 ? undefined : response.json();
  };
}

async function list(api, path) {
  const items = [];
  for (let page = 0; path && page < 100; page++) {
    const response = await api(path);
    if (!Array.isArray(response.data)) throw new ReleaseError('Unexpected API list response.');
    items.push(...response.data);
    path = response.links?.next;
  }
  if (path) throw new ReleaseError('API pagination exceeded the release bound.');
  return items;
}

function versionParts(version) {
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) throw new ReleaseError('Unexpected existing build number.');
  return version.split('.').map(BigInt);
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0n) !== (b[i] ?? 0n)) return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
  }
  return 0;
}

export async function context(api, bundleID) {
  if (!bundleID) throw new ReleaseError('Missing IOS_BUNDLE_ID.');
  const apps = await list(api, `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleID)}&limit=200`);
  if (apps.length !== 1 || apps[0].attributes.bundleId !== bundleID) throw new ReleaseError('Expected exactly one matching app.');
  const app = apps[0];
  const groups = await list(api, `/v1/apps/${app.id}/betaGroups?limit=200`);
  const matches = groups.filter(group => group.attributes.name === groupName && group.attributes.isInternalGroup === true);
  if (matches.length !== 1) throw new ReleaseError('Expected the existing internal Personal Testing group.');
  return { appID: app.id, groupID: matches[0].id, hasAccessToAllBuilds: matches[0].attributes.hasAccessToAllBuilds === true };
}

export async function preflight(api, env) {
  const number = env.BUILD_NUMBER;
  if (!/^[1-9]\d*$/.test(number ?? '')) throw new ReleaseError('Expected a positive integer BUILD_NUMBER.');
  const { appID } = await context(api, env.IOS_BUNDLE_ID);
  const builds = await list(api, `/v1/builds?filter[app]=${appID}&limit=200`);
  const highest = builds.reduce((max, build) => compareVersions(build.attributes.version, max) > 0 ? build.attributes.version : max, '0');
  if (compareVersions(number, highest) <= 0) throw new ReleaseError(`Build ${number} must be greater than existing build ${highest}.`);
  return `Build ${number} is greater than every existing build (latest ${highest}).`;
}

export async function distribute(api, env, options = {}) {
  if (!/^[1-9]\d*$/.test(env.BUILD_NUMBER ?? '')) throw new ReleaseError('Expected a positive integer BUILD_NUMBER.');
  if (!env.TESTFLIGHT_WHAT_TO_TEST?.trim() || env.TESTFLIGHT_WHAT_TO_TEST.length > 4000) throw new ReleaseError('Expected bounded public TestFlight notes.');
  const { appID, groupID, hasAccessToAllBuilds } = await context(api, env.IOS_BUNDLE_ID);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 25 * 60 * 1000);
  let build;
  while (now() < deadline) {
    const builds = await list(api, `/v1/builds?filter[app]=${appID}&filter[version]=${env.BUILD_NUMBER}&limit=200`);
    if (builds.length > 1) throw new ReleaseError('Expected one uploaded build.');
    build = builds[0];
    if (build?.attributes.version !== undefined && build.attributes.version !== env.BUILD_NUMBER) throw new ReleaseError('Unexpected uploaded build number.');
    const state = build?.attributes.processingState;
    if (state === 'VALID') break;
    if (state === 'FAILED' || state === 'INVALID') throw new ReleaseError('Apple rejected build processing.');
    console.log('Waiting for Apple build processing.');
    await sleep(15000);
  }
  if (build?.attributes.processingState !== 'VALID') throw new ReleaseError('Apple processing did not finish within the release bound; inspect this upload before retrying.');
  if (build.attributes.expired) throw new ReleaseError('The uploaded build is expired.');
  const locales = await list(api, `/v1/builds/${build.id}/betaBuildLocalizations?limit=200`);
  const existing = locales.find(locale => locale.attributes.locale === 'en-US');
  const attributes = { whatsNew: env.TESTFLIGHT_WHAT_TO_TEST };
  if (existing) {
    await api(`/v1/betaBuildLocalizations/${existing.id}`, 'PATCH', { data: { type: 'betaBuildLocalizations', id: existing.id, attributes } });
  } else {
    await api('/v1/betaBuildLocalizations', 'POST', { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', ...attributes }, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
  }
  let groupBuilds = await list(api, `/v1/betaGroups/${groupID}/relationships/builds?limit=200`);
  if (!hasAccessToAllBuilds && !groupBuilds.some(item => item.id === build.id)) {
    await api(`/v1/betaGroups/${groupID}/relationships/builds`, 'POST', { data: [{ type: 'builds', id: build.id }] });
  }
  while (now() < deadline) {
    groupBuilds = await list(api, `/v1/betaGroups/${groupID}/relationships/builds?limit=200`);
    const detail = await api(`/v1/builds/${build.id}/buildBetaDetail`);
    if (groupBuilds.some(item => item.id === build.id) && detail.data.attributes.internalBuildState === 'IN_BETA_TESTING') {
      const notes = await list(api, `/v1/builds/${build.id}/betaBuildLocalizations?limit=200`);
      if (!notes.some(locale => locale.attributes.locale === 'en-US' && locale.attributes.whatsNew === env.TESTFLIGHT_WHAT_TO_TEST)) throw new ReleaseError('TestFlight notes did not match after publication.');
      return `Build ${env.BUILD_NUMBER}: processing VALID, Personal Testing assigned, internal state IN_BETA_TESTING, test notes verified.`;
    }
    console.log('Waiting for internal TestFlight availability.');
    await sleep(15000);
  }
  throw new ReleaseError('Internal availability did not finish within the release bound; inspect this build before retrying.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const api = createClient(process.env);
    const command = process.argv[2];
    if (command !== 'preflight' && command !== 'distribute') throw new ReleaseError('Expected preflight or distribute.');
    const result = await (command === 'preflight' ? preflight(api, process.env) : distribute(api, process.env));
    console.log(result);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result}\n`);
  } catch (error) {
    console.error(error instanceof ReleaseError ? error.message : 'TestFlight automation failed; private credentials and provider diagnostics are suppressed.');
    process.exitCode = 1;
  }
}
