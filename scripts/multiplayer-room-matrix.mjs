import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gameVersion, maxPlayers } from '../shared/game.ts';
import { defaultTrack, isTrackId, trackIdentities } from '../shared/tracks.ts';
import { launchTestBrowser } from './test-browser.mjs';

const [url = 'http://127.0.0.1:4181/', output = 'test-evidence/multiplayer-matrix'] = process.argv.slice(2);
const sizes = (process.env.APEX_ROOM_SIZES ?? '2,3,4,5,6').split(',').map(Number);
const soakSeconds = Number(process.env.APEX_SOAK_SECONDS ?? 0);
const forcedTrack = process.env.APEX_ROOM_TRACK;
assert.ok(sizes.every(size => Number.isInteger(size) && size >= 2 && size <= maxPlayers));
assert.ok(Number.isSafeInteger(soakSeconds) && soakSeconds >= 0);
assert.ok(forcedTrack === undefined || isTrackId(forcedTrack));
const pineglass = 'pineglass-run-v2';
const timeout = 30_000;
const report = { version: gameVersion, viewport: [960, 640], quality: 'performance', scenarios: [], errors: [] };
const range = (count) => Array.from({ length: count }, (_, index) => index);
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const round = (value) => Math.round(value * 10) / 10;

await mkdir(output, { recursive: true });
const browser = await launchTestBrowser();

function installNetworkProbe({ shaped }) {
  const Native = window.WebSocket;
  const probe = window.apexRoomTest = {
    shaped, holdProfile: false, heldProfiles: 0, pauseUploadUntil: 0, socket: null,
    last: {}, closeCodes: [], resumes: 0, seat: 0, room: undefined,
    clear() {
      this.uploads = this.downloads = this.uploadBytes = this.downloadBytes = 0;
      this.maxUploadBytes = this.maxDownloadBytes = this.sequenceGaps = this.longGaps = 0;
      this.pings = new Map();
      this.rtts = [];
      this.gaps = new Uint32Array(2001);
      this.gapCount = 0;
      this.last = {};
      this.dustSenders = new Set();
      this.measuredAt = performance.now();
    },
  };
  probe.clear();

  const jitter = [0, 28, 13, 52, 3, 26, 0, 17, 36];
  const receive = (data, bytes) => {
    const now = performance.now();
    if (data.type === 'welcome') {
      probe.resumes++;
      probe.seat = data.slot;
    }
    if (data.type === 'game') {
      if (data.session && probe.room?.session?.id !== data.session.id) {
        probe.startNoticeAt = performance.timeOrigin + now;
      }
      probe.room = data;
    }
    if (data.type === 'pong' && probe.pings.has(data.n)) {
      probe.rtts.push(now - probe.pings.get(data.n));
      probe.pings.delete(data.n);
    }
    if (data.type !== 'snapshot' || !data.live) return;
    if (data.live.dust?.some(rate => rate > 0)) probe.dustSenders.add(data.slot);
    const previous = probe.last[data.slot];
    if (previous?.generation === data.generation && previous.live.session === data.live.session) {
      const gap = now - previous.at;
      probe.gaps[Math.min(2000, Math.round(gap))]++;
      probe.gapCount++;
      probe.longGaps += Number(gap > 200);
      probe.sequenceGaps += Math.max(0, data.seq - previous.seq - 1);
    }
    probe.last[data.slot] = { ...data, at: now };
    probe.downloads++;
    probe.downloadBytes += bytes;
    probe.maxDownloadBytes = Math.max(probe.maxDownloadBytes, bytes);
  };

  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.relay = new URL(this.url).pathname.startsWith('/socket/');
      this.schedule = { in: { at: 0, index: 0, packets: [] }, out: { at: 0, index: 0, packets: [] } };
      if (this.relay) {
        probe.socket = this;
        super.addEventListener('close', event => probe.closeCodes.push(event.code));
      }
    }

    deliver(direction, fn) {
      const now = performance.now();
      const queue = this.schedule[direction];
      const extra = shaped ? 47 + jitter[queue.index++ % jitter.length] : 0;
      const hold = direction === 'out' ? probe.pauseUploadUntil : 0;
      const at = queue.at = Math.max(now + extra, queue.at, hold);
      if (at <= now && !queue.packets.length) {
        fn();
        return;
      }
      queue.packets.push({ at, fn });
      if (queue.packets.length > 1) return;
      const flush = () => {
        if (this.readyState !== Native.OPEN) {
          queue.packets.length = 0;
          return;
        }
        while (queue.packets[0]?.at <= performance.now()) queue.packets.shift().fn();
        if (queue.packets[0]) setTimeout(flush, queue.packets[0].at - performance.now());
      };
      setTimeout(flush, at - now);
    }

    addEventListener(type, listener, options) {
      if (!this.relay || type !== 'message') return super.addEventListener(type, listener, options);
      super.addEventListener(type, event => this.deliver('in', () => {
        receive(JSON.parse(event.data), event.data.length);
        listener.call(this, event);
      }), options);
    }

    send(raw) {
      if (!this.relay) return super.send(raw);
      const data = JSON.parse(raw);
      if (data.type === 'profile' && probe.holdProfile) {
        probe.heldProfiles++;
        return;
      }
      if (data.type === 'ping') probe.pings.set(data.n, performance.now());
      this.deliver('out', () => {
        if (data.type === 'snapshot') {
          probe.ownReset = data.live.reset;
          probe.uploads++;
          probe.uploadBytes += raw.length;
          probe.maxUploadBytes = Math.max(probe.maxUploadBytes, raw.length);
        }
        super.send(raw);
      });
    }
  };
}

async function visit(index, size) {
  const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push({ room: size, driver: index + 1, message: error.message }));
  await page.addInitScript(() => localStorage.setItem('apex.drive.settings', JSON.stringify({ quality: 'performance' })));
  // Shape two independent clients in the six-driver run. The relay and browser
  // still exchange real WebSocket frames, in order, through the regular app.
  await page.addInitScript(installNetworkProbe, { shaped: size === 6 && index >= 4 });
  await page.goto(new URL('?diagnostics&garage=1', url).href, { waitUntil: 'domcontentloaded' });
  await page.locator('#stage[data-ready=true]').waitFor({ timeout: 90_000 });
  await page.locator('#play-online').click({ timeout });
  await page.locator('#online-name').fill('Driver ' + (index + 1));
  return page;
}

async function until(page, predicate, value, wait = timeout) {
  const result = await page.waitForFunction(predicate, value, { timeout: wait });
  try { return await result.jsonValue(); } finally { await result.dispose(); }
}

async function joinRoom(page, code) {
  await page.locator('#online-code-input').fill(code);
  await page.locator('#online-join button').click();
  await page.locator('#online-room').waitFor({ timeout });
  await until(page, () => apexRoomTest.seat > 0 && apexDiagnostics.multiplayer().online);
}

async function disconnect(page) {
  const before = await page.evaluate(() => ({ seat: apexRoomTest.seat, resumes: apexRoomTest.resumes }));
  await page.context().setOffline(true);
  await page.evaluate(() => apexRoomTest.socket.close(4000, 'Test connection interrupted'));
  await until(page, () => !apexDiagnostics.multiplayer().online);
  return before;
}

async function reconnect(page, before) {
  const start = performance.now();
  await page.context().setOffline(false);
  await until(page, ({ seat, resumes }) =>
    apexRoomTest.seat === seat && apexRoomTest.resumes > resumes &&
    apexDiagnostics.multiplayer().online && apexRoomTest.room?.players.some(p => p.slot === seat && p.connected),
  before, 18_000);
  return Math.round(performance.now() - start);
}

async function startRoom(pages, track, mode = 'drive') {
  const [host] = pages;
  const revision = trackIdentities[track].revision;
  await host.locator('#online-track').selectOption(track, { timeout });
  await Promise.all(pages.map(page => page.locator('#stage[data-track="' + track + '"]').waitFor({ timeout: 75_000 })));
  await host.locator('#online-mode').selectOption(mode, { timeout });
  await Promise.all(pages.map(page => until(page, ({ revision, mode }) =>
    apexRoomTest.room?.track.revision === revision && apexRoomTest.room?.mode === mode, { revision, mode })));
  for (const page of pages) await page.getByRole('button', { name: 'Ready', exact: true }).click({ timeout });
  for (const page of pages) {
    await page.getByRole('button', { name: 'Unready', exact: true }).waitFor({ timeout });
    assert.ok(await page.locator('#online-vehicle').isDisabled(), 'vehicle change while ready');
  }
  await Promise.all(pages.map(page => page.evaluate(() => {
    apexRoomTest.start = undefined;
    const stamp = () => {
      const { session, remaining, clock } = apexDiagnostics.multiplayer();
      if (session && remaining <= 0) {
        apexRoomTest.start = { id: session.id, starts: session.starts, detected: performance.timeOrigin + performance.now(),
          noticeAt: apexRoomTest.startNoticeAt, offset: clock?.offset ?? 0 };
      } else requestAnimationFrame(stamp);
    };
    requestAnimationFrame(stamp);
  })));
  await host.locator('#online-start').click({ timeout });
  await Promise.all(pages.map(page => page.locator('#online-hud').waitFor({ timeout })));
  const starts = await Promise.all(pages.map(page => until(page, () => apexRoomTest.start)));
  assert.ok(starts.every(start => start.id === starts[0].id && start.starts === starts[0].starts));
  const leadMs = Math.round(Math.min(...starts.map(s => s.starts - s.noticeAt - s.offset)));
  assert.ok(leadMs > 1000, 'A client received the countdown too late: ' + leadMs + ' ms');
  const skewMs = Math.round(Math.max(...starts.map(s => s.detected)) - Math.min(...starts.map(s => s.detected)));
  await waitPeers(pages, pages.length - 1);
  const startWork = await Promise.all(pages.map(async page => {
    await until(page, () => apexDiagnostics.onlineStart()?.firstRenderSubmittedAt !== undefined
      && apexDiagnostics.onlineStart()?.firstStepAt !== undefined);
    return page.evaluate(() => {
      const { starts, firstStepAt, firstStepTime, firstRenderSubmittedAt, maxFrameGapMs, maxRenderMs } = apexDiagnostics.onlineStart();
      return {
        stepLateMs: Math.round(firstStepAt - starts),
        stepTimeMs: Math.round(firstStepTime - starts),
        renderSubmittedLateMs: Math.round(firstRenderSubmittedAt - starts),
        maxFrameGapMs: Math.round(maxFrameGapMs),
        maxRenderMs: Math.round(maxRenderMs),
      };
    });
  }));
  assert.ok(startWork.every(client => client.stepTimeMs >= 0), 'Simulation began accepting inputs before GO');
  return { id: starts[0].id, leadMs, skewMs, firstFrameLateMs: starts.map(s => Math.round(s.detected - s.starts)), startWork };
}

async function waitPeers(pages, count) {
  await Promise.all(pages.map(page => until(page, count => {
    const { remotes } = apexDiagnostics.multiplayer();
    return remotes.filter(peer => peer.visible && peer.received >= 4).length === count;
  }, count)));
}

async function move(pages, observers = pages, automated = false) {
  const positions = await Promise.all(pages.map(page => page.evaluate(() => ({
    slot: apexDiagnostics.multiplayer().slot, position: apexDiagnostics.state().position,
  }))));
  if (automated) {
    await Promise.all(pages.map(page => page.evaluate(() => {
      apexDiagnostics.setTestDriver(() => ({ throttle: 1, brake: 0, steer: 0, handbrake: false }));
    })));
  } else {
    await Promise.all(pages.map(page => page.keyboard.down('w')));
  }
  try {
    await Promise.all(pages.map(page => until(page, () => apexDiagnostics.inspect.car.speed > 5, null, 20_000)));
    const render = await Promise.all(observers.map(page => until(page, sources => {
      const self = apexDiagnostics.multiplayer().slot;
      const objects = apexDiagnostics.inspect.scene.children;
      const peers = sources.filter(src => src.slot !== self).map(({ slot, position }) => {
        const object = objects.find(node => node.visible && node.userData.remoteSlot === slot);
        if (!object) return null;
        return object.position.distanceTo(new apexDiagnostics.inspect.T.Vector3(...position));
      });
      return peers.length && peers.every(value => value > 3) ? peers : false;
    }, positions, 12_000)));
    const distances = render.flat();
    return { renderedMovingLinks: distances.length, minRenderedMovementM: round(Math.min(...distances)) };
  } catch (error) {
    const drivers = await Promise.all(pages.map(page => page.evaluate(() => {
      const { car } = apexDiagnostics.inspect;
      const { slot, online, session } = apexDiagnostics.multiplayer();
      return { slot, online, inSession: !!session, speed: car.speed, running: car.running,
        fuel: car.fuelLitres, hidden: document.hidden, focused: document.hasFocus(),
        paused: apexDiagnostics.state().paused, closes: apexRoomTest.closeCodes };
    }).catch(() => null)));
    throw new Error('Drive pulse failed. Browser state: ' + JSON.stringify(drivers), { cause: error });
  } finally {
    const release = page => automated ? page.evaluate(() => {
      apexDiagnostics.setTestDriver(() => ({ throttle: 0, brake: 1, steer: 0, handbrake: false }));
    }) : page.keyboard.up('w');
    await Promise.all(pages.map(page => release(page).catch(() => {})));
  }
}

async function processMetrics(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const pids = processInfo.map(proc => proc.id).filter(pid => Number.isInteger(pid) && pid > 0);
  let rssMiB;
  try {
    const rows = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    rssMiB = Math.round(rows.trim().split(/\s+/).map(Number).reduce((sum, value) => sum + value, 0) / 1024);
  } catch {}
  return { processInfo, rssMiB, time: performance.now() };
}

async function beginMeasurement(pages, cdp) {
  await Promise.all(pages.map(page => page.evaluate(() => {
    apexDiagnostics.clearSamples();
    apexRoomTest.clear();
  })));
  return processMetrics(cdp);
}

async function measure(pages, cdp, before) {
  const results = await Promise.all(pages.map(page => page.evaluate(() => {
    const probe = apexRoomTest;
    const state = apexDiagnostics.state();
    const peers = apexDiagnostics.multiplayer().remotes;
    const percentile = (values, p) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10 : null;
    };
    let total = 0, intervalP95Ms = null;
    for (const [ms, count] of probe.gaps.entries()) {
      total += count;
      if (total >= Math.ceil(probe.gapCount * .95) && probe.gapCount) { intervalP95Ms = ms; break; }
    }
    const duration = (performance.now() - probe.measuredAt) / 1000;
    return {
      slot: probe.seat, shaped: probe.shaped, sampleSeconds: Math.round(duration),
      inputsSent: probe.uploads, snapshotsReceived: probe.downloads,
      uploadKbps: Math.round(probe.uploadBytes * 8 / duration / 100) / 10,
      downloadKbps: Math.round(probe.downloadBytes * 8 / duration / 100) / 10,
      maxUploadBytes: probe.maxUploadBytes, maxDownloadBytes: probe.maxDownloadBytes,
      inboundIntervals: probe.gapCount, intervalP95Ms, sequenceGaps: probe.sequenceGaps, longGaps: probe.longGaps,
      rttSamples: probe.rtts.length, rttP50Ms: percentile(probe.rtts, .5), rttP95Ms: percentile(probe.rtts, .95),
      visiblePeers: peers.filter(peer => peer.visible).length, delayMs: peers.map(peer => peer.delayMs),
      frameSamples: state.fpsSamples.length, frameP50Ms: percentile(state.fpsSamples, .5),
      frameP95Ms: percentile(state.fpsSamples, .95), physicsP95Ms: percentile(state.physicsSamples, .95),
      draws: state.draws, triangles: state.triangles, renderMemory: state.renderMemory,
      jsHeapMiB: Math.round(performance.memory?.usedJSHeapSize / 1024 ** 2) || null,
    };
  })));
  assert.ok(results.every(client => client.inputsSent > 45 && client.snapshotsReceived > 45 && client.rttSamples > 1));
  const after = await processMetrics(cdp);
  const prior = new Map(before.processInfo.map(proc => [proc.id, proc.cpuTime]));
  const cpuSeconds = after.processInfo.reduce((sum, proc) => sum + Math.max(0, proc.cpuTime - (prior.get(proc.id) ?? 0)), 0);
  return { browserCpuCores: round(cpuSeconds * 1000 / Math.max(after.time - before.time, 1)), browserRssMiB: after.rssMiB, clients: results };
}

async function resetAll(pages) {
  const counts = await Promise.all(pages.map(page => page.evaluate(() => apexRoomTest.ownReset ?? -1)));
  await Promise.all(pages.map(page => page.evaluate(() => { apexDiagnostics.setTestDriver(undefined); })));
  await Promise.all(pages.map(page => page.keyboard.press('r')));
  await Promise.all(pages.map((page, i) =>
    until(page, prior => apexRoomTest.ownReset > prior && apexDiagnostics.inspect.car.speed < .5, counts[i])));
}

async function recoverTogether(pages) {
  const [host, first, second] = pages;
  await resetAll(pages);
  const dustBefore = await host.evaluate(() => apexDiagnostics.dust().remoteEmitted);
  await move([first, second], [host]);
  const dustAfter = await until(host, before => {
    const dust = apexDiagnostics.dust();
    return dust.visible && dust.remoteEmitted - before > 6 &&
      [2, 3].every(slot => apexRoomTest.dustSenders.has(slot)) && dust.remoteEmitted;
  }, dustBefore);
  const before = await host.evaluate(() => ({
    car: apexDiagnostics.state().position, gates: apexDiagnostics.inspect.laps.passedGates,
    resets: Object.fromEntries(Object.entries(apexRoomTest.last).map(([slot, pose]) => [slot, pose.live.reset])),
  }));
  await Promise.all([first, second].map(page => page.locator('#recover-vehicle').click({ timeout })));
  await Promise.all([first, second].map(page =>
    page.locator('#recovery-message').filter({ hasText: 'Vehicle recovered' }).waitFor({ timeout })));
  const after = await until(host, resets => {
    const { last } = apexRoomTest;
    if (last[2]?.live.reset <= resets[2] || last[3]?.live.reset <= resets[3] || !last[2] || !last[3]) return false;
    return { car: apexDiagnostics.state().position, gates: apexDiagnostics.inspect.laps.passedGates,
      resets: Object.fromEntries(Object.entries(last).map(([slot, pose]) => [slot, pose.live.reset])) };
  }, before.resets);
  assert.equal(after.gates, before.gates);
  assert.ok(distance(before.car, after.car) < .5);
  for (const slot of Object.keys(before.resets).filter(slot => !['2', '3'].includes(slot))) {
    assert.equal(after.resets[slot], before.resets[slot]);
  }
  return { recoveredSeats: [2, 3], dustParticlesFromPeers: dustAfter - dustBefore };
}

async function leave(page) {
  await page.evaluate(() => {
    const button = ['online-track-leave', 'online-leave', 'online-result-leave']
      .map(id => document.getElementById(id)).find(node => node?.getClientRects().length);
    button?.click();
  }).catch(() => {});
}

async function hostDeparture(pages, session, code) {
  const [host, guest, nextHost] = pages;
  const before = await disconnect(guest);
  await until(nextHost, () => apexRoomTest.room?.players.find(p => p.slot === 2)?.connected === false);
  await host.locator('#online-track-leave').click({ timeout });
  await until(nextHost, id => apexRoomTest.room?.host === 3 && apexRoomTest.room.session?.id === id, session.id);
  const reconnectMs = await reconnect(guest, before);
  assert.equal(await guest.evaluate(() => apexRoomTest.room.session.id), session.id);
  await waitPeers([guest, nextHost], 1);
  await nextHost.locator('#online-end').click({ timeout });
  await guest.locator('#online-room').waitFor({ timeout });
  await host.locator('#online-entry').waitFor({ timeout });
  await joinRoom(host, code);
  await until(host, () => apexRoomTest.seat === 1 && apexRoomTest.room?.host === 3);
  return { newHost: 3, reconnectMs, reusedSeat: 1 };
}

async function verifyLostSelection(page) {
  await page.evaluate(() => { apexRoomTest.holdProfile = true; });
  await page.locator('#online-vehicle').selectOption('r35', { timeout });
  await until(page, () => apexRoomTest.heldProfiles > 0);
  const before = await disconnect(page);
  await page.evaluate(() => { apexRoomTest.holdProfile = false; });
  const reconnectMs = await reconnect(page, before);
  assert.equal(await page.locator('#online-vehicle').inputValue(), 'f40');
  assert.ok(await page.locator('#stage[data-vehicle=f40]').count());
  return reconnectMs;
}

async function scoreChallenge(pages, output) {
  const [host, first, second, invalid] = pages;
  await host.locator('#online-end').click({ timeout });
  await Promise.all(pages.map(page => page.locator('#online-room').waitFor({ timeout })));
  const session = await startRoom(pages, pineglass, 'challenge');
  const duration = await host.evaluate(() => apexRoomTest.room.session.ends - apexRoomTest.room.session.starts);
  assert.equal(duration, 38_000, 'Run the scoring matrix with cf dev --mode local-game-test');
  const cut = await invalid.evaluate(() => apexDiagnostics.timeLapPath(190, true));
  assert.equal(cut.count, 0);
  await until(host, () => apexDiagnostics.multiplayer().remaining <= -36_000, null, 42_000);
  const valid = await Promise.all([first, second].map((page, i) =>
    page.evaluate(speed => apexDiagnostics.timeLapPath(speed), i === 0 ? 190 : 200)));
  assert.ok(valid.every(entry => entry.count === 1));
  await Promise.all(pages.map(page => page.locator('#online-finish').waitFor({ timeout })));
  const results = await host.evaluate(() => apexRoomTest.room.session.results);
  assert.equal(results.length, pages.length);
  assert.ok(results[2].best < results[1].best);
  assert.ok(results[1].best > 0 && results[2].best > 0);
  assert.ok(results[1].bestLap.every(Number.isFinite) && results[2].bestLap.every(Number.isFinite));
  assert.ok(results.filter(row => ![2, 3].includes(row.slot)).every(row => row.best === null));
  await host.screenshot({ path: join(output, '6-players-challenge.jpg'), quality: 90 });
  return { skewMs: session.skewMs, startWork: session.startWork, timedSeats: [2, 3], invalidSeat: 4, results };
}

async function soak(pages, scenario, cdp, seconds) {
  const settle = await beginMeasurement(pages, cdp);
  const start = performance.now(), finish = start + seconds * 1000;
  const before = await Promise.all(pages.map(page => page.evaluate(() => apexRoomTest.resumes)));
  const checkpoints = [];
  scenario.soak = { checkpoints };
  let nextReport = 0;
  while (performance.now() < finish) {
    await resetAll(pages);
    await move(pages, [pages.at(-1)], true);
    const elapsed = Math.round((performance.now() - start) / 1000);
    if (elapsed >= nextReport) {
      await waitPeers(pages, pages.length - 1);
      const current = await measure(pages, cdp, settle).catch(error => {
        if (elapsed < 7 && error instanceof assert.AssertionError) return undefined;
        throw error;
      });
      if (current) {
        checkpoints.push({ elapsed, browserRssMiB: current.browserRssMiB,
          jsHeapMiB: current.clients.map(c => c.jsHeapMiB) });
        console.log('Soak', elapsed + 's', JSON.stringify(checkpoints.at(-1)));
        await Promise.all(pages.map(page => page.evaluate(() => apexDiagnostics.clearSamples())));
      }
      nextReport = elapsed < 7 ? 7 : elapsed + 300;
    }
    await delay(Math.min(Math.max(finish - performance.now(), 0), 35_000));
  }
  const measurement = await measure(pages, cdp, settle);
  assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => apexRoomTest.resumes))), before);
  assert.ok(measurement.clients.every(c => c.visiblePeers === pages.length - 1));
  scenario.soak = { seconds: Math.round((performance.now() - start) / 1000), checkpoints, ...measurement };
}

try {
  const cdp = await browser.newBrowserCDPSession();
  for (const size of sizes) {
    const pages = [];
    const scenario = { size, track: forcedTrack ?? (size === 2 || size === 4 ? defaultTrack : pineglass) };
    report.scenarios.push(scenario);
    try {
      for (const index of range(size)) {
        const page = await visit(index, size);
        pages.push(page);
        if (!index) {
          await page.locator('#online-create').click({ timeout });
          await until(page, () => apexRoomTest.seat === 1 && apexDiagnostics.multiplayer().online);
        } else {
          await joinRoom(page, await pages[0].locator('#online-code').textContent());
        }
      }
      const [host] = pages;
      const code = await host.locator('#online-code').textContent();
      console.log('Lobby connected', size, scenario.track);
      await Promise.all(pages.map(page => until(page, size => apexRoomTest.room?.players.filter(player => player.connected).length === size, size)));
      if (size === maxPlayers) {
        const full = await host.evaluate(async ({ code, gameVersion }) => {
          const response = await fetch('/api/join', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, gameVersion }),
          });
          return { status: response.status, message: (await response.json()).error };
        }, { code, gameVersion });
        assert.equal(full.status, 409);
        assert.match(full.message, /6 players/);
        scenario.seventhSeatRejected = true;
      }
      if (size === 4) scenario.selectionReconnectMs = await verifyLostSelection(pages[1]);
      for (const index of range(size).filter(index => index % 2)) {
        const page = pages[index];
        await page.locator('#online-vehicle').selectOption('r35', { timeout });
        await page.locator('#stage[data-vehicle=r35]').waitFor({ timeout: 45_000 });
      }
      const session = await startRoom(pages, scenario.track);
      scenario.skewMs = session.skewMs;
      scenario.countdownLeadMs = session.leadMs;
      scenario.firstFrameLateMs = session.firstFrameLateMs;
      scenario.startWork = session.startWork;
      const before = await beginMeasurement(pages, cdp);
      scenario.movement = await move(pages);
      assert.equal(scenario.movement.renderedMovingLinks, size * (size - 1));
      await pages.at(-1).screenshot({ path: join(output, size + '-players.jpg'), quality: 90 });
      if (size === 6) {
        if (scenario.track === pineglass) scenario.recovery = await recoverTogether(pages);
        await pages[4].evaluate(() => { apexRoomTest.pauseUploadUntil = performance.now() + 1450; });
        await delay(2200);
        assert.equal(await pages[4].evaluate(() => apexRoomTest.resumes), 1, 'WebSocket closed during short burst');
        await waitPeers(pages, size - 1);
        scenario.burstRecovery = true;
      }
      await delay(6500);
      scenario.performance = await measure(pages, cdp, before);
      if (size === 3) scenario.hostDeparture = await hostDeparture(pages, session, code);
      if (size === 6 && soakSeconds) await soak(pages, scenario, cdp, soakSeconds);
      if (size === 6 && !soakSeconds) scenario.challenge = await scoreChallenge(pages, output);
      console.log('Verified', size, 'players,', scenario.movement.renderedMovingLinks, 'moving vehicle views');
    } finally {
      for (const page of pages.slice().reverse()) await leave(page);
      for (const page of pages) await page.context().close().catch(() => {});
      await delay(350);
      await writeFile(join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
}
