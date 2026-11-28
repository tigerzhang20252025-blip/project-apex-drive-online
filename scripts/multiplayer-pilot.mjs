import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { gameVersion } from '../shared/game.ts';
import { challengeName, trackIdentities } from '../shared/tracks.ts';
import { launchTestBrowser } from './test-browser.mjs';

const [url, output = 'test-evidence/multiplayer-pilot'] = process.argv.slice(2);
assert.ok(url, 'Pass the complete pilot URL');
const origin = new URL(url).origin;
const endpoint = process.env.APEX_TEST_RELAY_ORIGIN ?? origin;
const staticBuild = process.env.APEX_TEST_STATIC_DIR ? resolve(process.env.APEX_TEST_STATIC_DIR) : undefined;
const localTestCertificate = process.env.APEX_TEST_LOCAL_TLS === '1' && new URL(url).hostname === '127.0.0.1';
const timeout = 30_000;
const errors = [], clients = [], sessions = [];
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10 : null;
};

async function until(check, label, duration = timeout) {
  const deadline = performance.now() + duration;
  do {
    const value = check();
    if (value) return value;
    await delay(50);
  } while (performance.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

await mkdir(output, { recursive: true });
const browser = await launchTestBrowser();

async function open(name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: localTestCertificate });
  const metrics = { sent: 0, received: 0, rtt: [], intervals: [], framesMissed: 0 };
  const client = { page, metrics, snapshots: new Map(), welcomes: [] };
  clients.push(client);
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).pathname.startsWith('/socket/')) window.apexTestRelaySocket = this;
      }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    const address = new URL(socket.url());
    if (!address.pathname.startsWith('/socket/')) return;
    const protocol = new URL(endpoint).protocol === 'https:' ? 'wss:' : 'ws:';
    if (address.protocol !== protocol) errors.push('Unexpected WebSocket protocol: ' + address.protocol);
    const pings = new Map();
    socket.on('framesent', ({ payload }) => {
      const data = JSON.parse(payload.toString());
      if (data.type === 'ping') pings.set(data.n, performance.now());
      if (data.type === 'snapshot') metrics.sent++;
    });
    socket.on('framereceived', ({ payload }) => {
      const data = JSON.parse(payload.toString());
      const now = performance.now();
      if (data.type === 'welcome') client.welcomes.push(data);
      if (data.type === 'game') client.room = data;
      if (data.type === 'pong' && pings.has(data.n)) {
        metrics.rtt.push(now - pings.get(data.n));
        pings.delete(data.n);
      }
      if (data.type !== 'snapshot' || !data.live) return;
      const previous = client.snapshots.get(data.slot);
      if (previous?.live.session === data.live.session && previous.generation === data.generation) {
        metrics.intervals.push(now - previous.at);
        metrics.framesMissed += Math.max(0, data.seq - previous.seq - 1);
      }
      client.snapshots.set(data.slot, { ...data, at: now });
      metrics.received++;
    });
  });
  if (staticBuild) {
    await page.route(origin + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = resolve(staticBuild, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(staticBuild + sep)) return route.abort();
      try { await route.fulfill({ path: file }); } catch { await route.fulfill({ status: 404 }); }
    });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#stage[data-ready=true]').waitFor({ timeout: 90_000 });
  await page.locator('#play-online').click();
  await page.locator('#online-name').fill(name);
  return client;
}

async function start(host, guest, track, mode) {
  const pair = [host, guest];
  await host.page.locator('#online-track').selectOption(track.id, { timeout });
  await Promise.all(pair.map(({ page }) => page.locator('#stage[data-track="' + track.id + '"]').waitFor({ timeout: 60_000 })));
  await host.page.locator('#online-mode').selectOption(mode, { timeout });
  await until(() => pair.every(c => c.room?.mode === mode && c.room.track.revision === track.revision), 'shared mode and course revision');
  if (mode === 'challenge') {
    assert.equal(await guest.page.locator('#online-mode option[value=challenge]').textContent(), challengeName(track));
  }
  for (const { page } of pair) {
    await page.getByRole('button', { name: 'Ready', exact: true }).click({ timeout });
  }
  await host.page.locator('#online-start').click({ timeout });
  const session = await until(() => {
    const current = host.room?.session;
    return current && guest.room?.session?.id === current.id && current;
  }, 'shared session');
  assert.equal(session.track.revision, track.revision);
  assert.equal(session.ends === null ? null : session.ends - session.starts, mode === 'drive' ? null : 600_000);
  const clock = mode === 'drive' ? 'On track' : /9:\d\d remaining/;
  await Promise.all(pair.map(({ page }) => page.locator('#online-clock').filter({ hasText: clock }).waitFor({ timeout: 15_000 })));
  return session;
}

function snapshot(client, slot, session) {
  const pose = client.snapshots.get(slot);
  return pose?.live.session === session.id ? pose : undefined;
}

async function drive(driver, observer, session) {
  const slot = driver.welcomes.at(-1).slot;
  const initial = await until(() => snapshot(observer, slot, session), 'first remote position');
  await driver.page.keyboard.down('w');
  try {
    await driver.page.waitForFunction(() => Number(document.querySelector('#speed').textContent) > 20, null, { timeout: 20_000 });
    return await until(() => {
      const pose = snapshot(observer, slot, session);
      const moved = pose && distance(initial.position, pose.position);
      return moved > 3 && moved;
    }, 'remote vehicle moving', 12_000);
  } finally {
    await driver.page.keyboard.up('w');
  }
}

async function recover(host, guest, track, session) {
  const user = guest.welcomes.at(-1).slot;
  const peer = host.welcomes.at(-1).slot;
  const before = await until(() => snapshot(host, user, session), 'pre-recovery position');
  const other = await until(() => snapshot(guest, peer, session), 'other car position');
  if (track.kind === 'stage') {
    await guest.page.locator('#recover-vehicle').click({ timeout });
    await guest.page.locator('#recovery-message').filter({ hasText: 'Vehicle recovered' }).waitFor({ timeout });
  } else {
    await guest.page.keyboard.press('r');
  }
  await until(() => snapshot(host, user, session)?.live.reset > before.live.reset, 'recovery synced to peer');
  const unaffected = await until(() => {
    const pose = snapshot(guest, peer, session);
    return pose?.seq > other.seq && pose;
  }, 'stationary peer update after recovery');
  assert.equal(unaffected.live.reset, other.live.reset);
  assert.ok(distance(unaffected.position, other.position) < 1, 'Other vehicle moved during recovery');
}

async function reconnect(host, guest, session) {
  const first = guest.welcomes.at(-1);
  const started = performance.now();
  await guest.page.evaluate(() => window.apexTestRelaySocket.close(4000, 'Connection verification'));
  const next = await until(() => guest.welcomes.length > 1 && guest.welcomes.at(-1) !== first && guest.welcomes.at(-1), 'new WebSocket welcome', 18_000);
  assert.equal(next.slot, first.slot);
  await until(() => guest.room?.session?.id === session.id &&
    snapshot(host, next.slot, session)?.generation === next.generation, 'same session with resumed snapshots', 18_000);
  return Math.round(performance.now() - started);
}

try {
  const health = await fetch(endpoint + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).gameVersion, gameVersion);
  const mismatch = await fetch(endpoint + '/api/create', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameVersion: 'obsolete-test-build' }),
  });
  assert.equal(mismatch.status, 409);
  const [host, guest] = await Promise.all([open('Apex Driver'), open('Guest Driver')]);
  await host.page.locator('#online-create').click();
  const code = host.page.locator('#online-code').filter({ hasText: /^[A-Z2-9]{4}-[A-Z2-9]{4}$/ });
  await code.waitFor({ timeout });
  if (!await host.page.evaluate(() => window.isSecureContext)) {
    await host.page.locator('#online-copy').click();
    assert.equal(await host.page.evaluate(() => String(window.getSelection())), await code.textContent());
  }
  await guest.page.locator('#online-code-input').fill(await code.textContent());
  await guest.page.locator('#online-join button').click();
  await guest.page.locator('#online-vehicle').selectOption('r35', { timeout });
  await guest.page.locator('#stage[data-vehicle=r35]').waitFor({ timeout });
  await until(() => [host, guest].every(c => c.room?.players.map(p => p.vehicle).join() === 'f40,r35'), 'independent vehicle selection');

  for (const track of Object.values(trackIdentities)) {
    for (const mode of ['drive', 'challenge']) {
      const session = await start(host, guest, track, mode);
      const guestMeters = await drive(guest, host, session);
      if (mode === 'drive') await recover(host, guest, track, session);
      const hostMeters = await drive(host, guest, session);
      const reconnectMs = track.kind === 'stage' && mode === 'drive' ? await reconnect(host, guest, session) : undefined;
      const result = { track: track.id, revision: track.revision, mode, guestMeters, hostMeters, reconnectMs };
      sessions.push(result);
      console.log(JSON.stringify(result));
      await host.page.screenshot({ path: join(output, track.id + '-' + mode + '.jpg'), quality: 91 });
      await host.page.locator('#online-end').click({ timeout });
      await Promise.all([host, guest].map(({ page }) => page.locator('#online-room').waitFor({ timeout })));
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(clients.every(({ metrics }) => metrics.sent > 150 && metrics.received > 150 && metrics.rtt.length > 8));
} finally {
  try {
    for (const { page } of clients.slice().reverse()) {
      await page.evaluate(() => {
        for (const id of ['online-track-leave', 'online-leave', 'online-result-leave']) {
          const button = document.getElementById(id);
          if (button?.getClientRects().length) { button.click(); break; }
        }
      }).catch(() => {});
    }
  } finally {
    await browser.close();
    const data = clients.map(({ metrics: { rtt, intervals, ...counts } }) => ({
      ...counts, rttSamples: rtt.length, rttMedianMs: percentile(rtt, .5), rttP95Ms: percentile(rtt, .95),
      intervalMedianMs: percentile(intervals, .5), intervalP95Ms: percentile(intervals, .95),
      longDeliveryGaps: intervals.filter(value => value > 200).length,
    }));
    const report = { data, sessions, errors };
    await writeFile(join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
