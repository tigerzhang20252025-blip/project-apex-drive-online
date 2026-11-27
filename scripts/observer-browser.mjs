import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';
import { trackIdentities } from '../shared/tracks.ts';

const base = process.argv[2] ?? 'http://127.0.0.1:4181/';
const output = process.argv[3] ?? 'test-evidence/observer';
await mkdir(output, {recursive: true});
const browser = await launchTestBrowser();
const report = {errors: [], vehicles: {}, visitedGates: 0};
const read = (page) => page.evaluate(() => {
  const {camera, car, laps, scene} = apexDiagnostics.inspect;
  return {
    eye: camera.position.toArray(), orientation: camera.quaternion.toArray(),
    optics: [camera.fov, camera.far, camera.layers.mask, scene.fog?.near, scene.fog?.far],
    view: apexDiagnostics.state().view,
    car: {
      position: car.current.position.toArray(), rotation: car.current.rotation.toArray(),
      speed: car.speed, rpm: car.rpm, gas: car.fuelLitres, gear: car.gear, lights: car.lights, turn: car.turn,
    },
    timing: {status: laps.status, reason: laps.reason, progress: laps.progress, elapsed: laps.elapsed, records: laps.records()},
  };
});
const gap = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
const shot = (page, name) => page.screenshot({path: join(output, name + '.jpg'), quality: 92});
const waitObserver = (page) => page.locator('#stage[data-observer=active]').waitFor();
const canvas = (page) => page.locator('#scene canvas');
async function hold(page, key, test, arg) {
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(test, arg, {timeout: 12_000});
  } finally {
    await page.keyboard.up(key);
  }
}
async function look(page, x, y) {
  await page.mouse.move(660, 380);
  await page.mouse.down({button: 'right'});
  await page.mouse.move(660 + x, 380 + y, {steps: 6});
  await page.mouse.up({button: 'right'});
}
async function drive(page, track) {
  await page.locator('[data-course=' + track + ']').click();
  await page.locator('#stage[data-track=' + track + ']').waitFor({timeout: 50_000});
  await page.locator('#garage-drive').click();
}
async function multiplayerGuard(page) {
  const track = trackIdentities['pineglass-run-v2'];
  const starts = Date.now();
  await page.route('**/api/create', route => route.fulfill({
    headers: {'Access-Control-Allow-Origin': '*'},
    json: {code: 'TESTONLY', roomId: 'observer-test', resume: 'local-only',
      ticket: 'local-only', expires: starts + 120_000},
  }));
  await page.routeWebSocket('**/socket/observer-test', socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'ping') socket.send(JSON.stringify({type: 'pong', n: message.n, time: Date.now()}));
    });
    socket.send(JSON.stringify({type: 'welcome', slot: 1}));
    socket.send(JSON.stringify({
      type: 'game', host: 1, mode: 'drive', track,
      players: [{slot: 1, name: 'Local driver', vehicle: 'r35', ready: true, connected: true}],
      session: {id: 'observer-test', track, starts, ends: null, results: []},
    }));
  });
  await page.locator('[data-course=pineglass-run-v2]').click();
  await page.locator('#stage[data-track=pineglass-run-v2]').waitFor({timeout:50_000});
  await page.locator('#play-online').click();
  await page.locator('#online-create').click();
  await page.locator('#online-hud').waitFor();
  await page.keyboard.press('F8');
  assert.equal(await page.locator('#stage').getAttribute('data-observer'), null);
  assert.match(await page.locator('#control-notification').textContent(), /single player/);
  await hold(page, 'w', () => apexDiagnostics.inspect.car.speed > 2);
  report.activeMultiplayerGuard = 'mocked local relay, normal live-session client path';
}

try {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1});
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(new URL('?diagnostics&garage=1', base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout: 90_000});
  await drive(page, 'pineglass-run-v2');
  await page.locator('[data-camera=cockpit]').click();
  await page.locator('#pause').click();
  await page.waitForFunction(() => apexDiagnostics.state().eyeError < .02);
  const baseline = await read(page);
  await page.keyboard.press('F8');
  await waitObserver(page);
  const entered = await read(page);
  assert.deepEqual(entered.eye, baseline.eye);
  assert.deepEqual(entered.orientation, baseline.orientation);
  assert.deepEqual(entered.car, baseline.car);
  assert.deepEqual(entered.timing, baseline.timing);

  await page.keyboard.press('i');
  assert.ok(await page.locator('#observer-readout').isHidden());
  await page.keyboard.press('i');
  assert.ok(await page.locator('#observer-readout').isVisible());
  await page.keyboard.press('h');
  assert.ok(await page.locator('#observer-hud').isHidden());
  await page.keyboard.press('h');
  assert.ok(await page.locator('#observer-hud').isVisible());
  await page.keyboard.press('r');
  await page.keyboard.press('c');

  const bounds = await canvas(page).boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .65);
  await page.waitForFunction(() => document.querySelector('#observer-speed').textContent.includes('m/s'));
  const baseSpeed = await page.locator('#observer-speed').evaluate(el => parseFloat(el.textContent.split('/')[1]));
  await page.mouse.wheel(0, -360);
  await page.waitForFunction(speed => parseFloat(document.querySelector('#observer-speed').textContent.split('/')[1]) > speed, baseSpeed);
  await look(page, 160, -160);
  assert.ok(gap((await read(page)).orientation, entered.orientation) > .15);
  await hold(page, 'e', (y) => apexDiagnostics.inspect.camera.position.y > y + 24, entered.eye[1]);
  const elevated = await read(page);
  await page.keyboard.down('Control');
  try {
    await hold(page, 'a', (eye) => apexDiagnostics.inspect.camera.position.distanceTo(new apexDiagnostics.inspect.T.Vector3(...eye)) > 6, elevated.eye);
  } finally {
    await page.keyboard.up('Control');
  }
  await page.keyboard.down('Shift');
  try {
    await hold(page, 'w', (eye) => apexDiagnostics.inspect.camera.position.distanceTo(new apexDiagnostics.inspect.T.Vector3(...eye)) > 340, elevated.eye);
  } finally {
    await page.keyboard.up('Shift');
  }
  await look(page, 0, 235);
  await shot(page, 'forest-sprint-aerial');
  assert.deepEqual((await read(page)).car, baseline.car);
  await page.mouse.click(730, 410);
  await page.waitForFunction(() => document.pointerLockElement === document.querySelector('#scene canvas'), null, {timeout: 5_000});
  const beforeMouseLook = await read(page);
  await page.mouse.move(860, 440);
  await page.waitForFunction(orientation => {
    const current = apexDiagnostics.inspect.camera.quaternion.toArray();
    return current.some((value, i) => Math.abs(value - orientation[i]) > .03);
  }, beforeMouseLook.orientation);
  await page.keyboard.press('F8');
  await page.waitForFunction(() => document.pointerLockElement === null);
  report.pointerLock = 'capture, mouse rotation and release on exit verified';
  await page.locator('#observer-hud').waitFor({state: 'hidden'});
  await page.waitForFunction(() => apexDiagnostics.state().eyeError < .02);
  assert.equal(await page.locator('#stage').getAttribute('data-paused'), 'true');
  const restored = await read(page);
  assert.deepEqual(restored.optics, baseline.optics);
  assert.equal(restored.view, 'cockpit');

  await page.evaluate(() => apexDiagnostics.placeAtTrack(-15));
  await page.keyboard.press('F8');
  await waitObserver(page);
  const gates = await page.evaluate(() => apexDiagnostics.gates);
  const stops = new Map([[12,'cliffside-shelf'], [22,'glass-gorge-bridge'], [26,'ridge-attack'], [35,'valley-descent'], [38,'finish']]);
  await page.keyboard.press('[');
  for (const [i, gate] of gates.entries()) {
    if (i) await page.keyboard.press(']');
    assert.ok(gap((await read(page)).eye, gate.p) < 12, 'observer reached checkpoint ' + i);
    report.visitedGates++;
    if (stops.has(i)) {
      await page.waitForFunction(y => Math.abs(parseFloat(document.querySelector('#observer-elevation').textContent) - y) < 1, (await read(page)).eye[1]);
      await shot(page, stops.get(i));
    }
  }
  await page.keyboard.press('[');
  assert.ok(gap((await read(page)).eye, gates.at(-2).p) < 12);
  for (let i = gates.length - 2; i > 22; i--) await page.keyboard.press('[');
  const bridge = await read(page);
  await hold(page, 'q', (y) => apexDiagnostics.inspect.camera.position.y < y - 23, bridge.eye[1]);
  await page.locator('#observer-warning').filter({hasText:'above the camera'}).waitFor();
  await look(page, 0, -190);
  await shot(page, 'bridge-from-below');
  await page.keyboard.press('F8');
  await page.locator('#resume').click();
  await page.locator('#open-garage').click();
  report.vehicles.f40 = 'pose, inputs, movement, optics, pause and all checkpoint locations verified';

  await page.locator('[data-vehicle=r35]').click();
  await page.locator('#stage[data-vehicle=r35]').waitFor({timeout: 30_000});
  await page.locator('#garage-drive').click();
  await page.locator('#ignition').click();
  await page.waitForFunction(() => apexDiagnostics.inspect.car.running);
  await page.locator('[data-camera=chase]').click();
  await page.evaluate(() => apexDiagnostics.inspect.laps.launch());
  await hold(page, 'w', () => apexDiagnostics.inspect.car.speed > 2);
  await page.keyboard.press('F8');
  await waitObserver(page);
  const running = await read(page);
  assert.equal(running.timing.status, 'invalid');
  assert.equal(running.timing.reason, 'Observer used');
  assert.ok(running.car.speed > 1);
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  await page.keyboard.press('[');
  const beforeStrafe = await read(page);
  await hold(page, 'd', (eye) => apexDiagnostics.inspect.camera.position.distanceTo(new apexDiagnostics.inspect.T.Vector3(...eye)) > 8, beforeStrafe.eye);
  const beforeReverse = await read(page);
  await hold(page, 's', (eye) => apexDiagnostics.inspect.camera.position.distanceTo(new apexDiagnostics.inspect.T.Vector3(...eye)) > 8, beforeReverse.eye);
  assert.deepEqual((await read(page)).car, running.car);
  assert.deepEqual((await read(page)).timing, running.timing);
  await page.keyboard.press('F8');
  await page.locator('#observer-hud').waitFor({state:'hidden'});
  await page.waitForFunction(travel => apexDiagnostics.inspect.car.current.position.distanceTo(new apexDiagnostics.inspect.T.Vector3(...travel)) > 1, running.car.position);
  assert.equal((await read(page)).timing.status, 'invalid');
  assert.equal((await read(page)).view, 'chase');
  await page.keyboard.press('r');
  assert.equal((await read(page)).timing.status, 'waiting');
  report.vehicles.r35 = 'moving car frozen, attempt invalidated, position and timer frozen during checkpoint jumps, driving restored';

  await page.locator('#open-garage').click();
  await drive(page, 'alpine-proving-ground');
  await page.keyboard.press('F8');
  assert.equal(await page.locator('#stage').getAttribute('data-observer'), null);
  for (const view of ['hood', 'orbit', 'cockpit', 'chase']) {
    await page.locator('[data-camera=' + view + ']').click();
    assert.equal((await read(page)).view, view);
  }
  assert.match(await page.locator('#minimap').getAttribute('aria-label'), /^Alpine/);
  assert.equal(await page.locator('#timer-best-label').textContent(), 'Best lap');
  report.alpine = true;
  await page.locator('#open-garage').click();
  await multiplayerGuard(page);
  assert.deepEqual(report.errors, []);
} finally {
  try {
    await writeFile(join(output, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  } finally {
    await browser.close();
  }
}
