import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { maxFrameSize } from '../src/protocol.ts';
import { launchTestBrowser } from '../../scripts/test-browser.mjs';

const base = 'http://127.0.0.1:8788';
const expiryBase = 'http://127.0.0.1:8789';
const secondsPerRate = Number(process.env.APEX_RELAY_SECONDS_PER_RATE ?? 8);
assert.ok(Number.isSafeInteger(secondsPerRate) && secondsPerRate >= 5 && secondsPerRate <= 1200);

async function visit(browser, url) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

async function contains(page, selector, text) {
  await page.locator(selector).filter({ hasText: text }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function enter(browser, url = base) {
  const page = await visit(browser, url);
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await contains(page, '#status', 'Connected as player 1');
  const code = (await page.locator('#invite').textContent()).replace('Code ', '');
  return { page, code };
}

async function download(page) {
  const received = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const file = await received;
  return JSON.parse(await readFile(await file.path(), 'utf8'));
}

test('isolated browser sessions relay poses in both directions and resume the same seat', {
  timeout: secondsPerRate * 3000 + 50_000,
}, async () => {
  const browser = await launchTestBrowser();
  try {
    const { page: first, code } = await enter(browser);
    const second = await visit(browser, base);
    await second.getByLabel('Invite code').fill('2222-2222');
    await second.getByRole('button', { name: 'Join room', exact: true }).click();
    await contains(second, '#status', 'Invalid or expired room code.');
    await second.getByLabel('Invite code').fill(code);
    await second.getByRole('button', { name: 'Join room', exact: true }).click();
    await contains(second, '#status', 'Connected as player 2');
    await contains(first, '#presence', '2 online');
    await contains(first, '#pose', 'Peer 2');
    await contains(second, '#pose', 'Peer 1');
    const extra = await visit(browser, base);
    await extra.getByLabel('Invite code').fill(code);
    await extra.getByRole('button', { name: 'Join room', exact: true }).click();
    await contains(extra, '#status', 'Room already has two players.');

    for (const page of [first, second]) await page.getByRole('button', { name: 'Reset measurements' }).click();
    const frameSizes = { upload: 0, relay: 0 };
    const maximumBytes = (event, field) => {
      const bytes = Buffer.byteLength(event.payload);
      if (event.payload.toString().includes('"type":"snapshot"')) frameSizes[field] = Math.max(bytes, frameSizes[field]);
    };
    first.on('websocket', ws => {
      ws.on('framesent', event => maximumBytes(event, 'upload'));
      ws.on('framereceived', event => maximumBytes(event, 'relay'));
    });
    await first.getByRole('button', { name: 'Test reconnect' }).click();
    await contains(first, '#status', 'Connected as player 1');
    await contains(second, '#presence', '2 online');

    for (const rate of [10, 15, 20]) {
      await Promise.all([first, second].map(page => page.getByLabel('Send rate').selectOption(String(rate))));
      await delay(secondsPerRate * 1000);
    }
    const reports = await Promise.all([download(first), download(second)]);
    for (const report of reports) {
      assert.ok(report.rtt.samples >= 3 && report.rtt.p95Ms < 250, JSON.stringify(report.rtt));
      assert.equal(report.skipped, 0);
      for (const row of report.byPeerRate) {
        assert.ok(row.received >= secondsPerRate * row.rate * 0.8, JSON.stringify(row));
        assert.ok(Math.abs(row.interval.p50Ms - 1000 / row.rate) < 15, JSON.stringify(row));
        assert.equal(row.missing, 0);
      }
      assert.ok(!JSON.stringify(report).includes(code.replaceAll('-', '')));
    }
    assert.ok(reports[0].offlineMs > 0 && reports[0].offlineMs < 5000, 'same seat recovered within five seconds');
    assert.ok(frameSizes.upload > 0 && frameSizes.relay > 0, 'captured frame sizes');

    if (process.env.APEX_RELAY_EVIDENCE) {
      await mkdir(process.env.APEX_RELAY_EVIDENCE, { recursive: true });
      await first.screenshot({
        path: join(process.env.APEX_RELAY_EVIDENCE, 'relay-local.png'),
        mask: [first.locator('#invite')],
      });
    }
    console.log(JSON.stringify({
      secondsPerRate, frameSizes,
      reports: reports.map(({ byPeerRate, rtt, offlineMs, sent, skipped }) => ({ byPeerRate, rtt, offlineMs, sent, skipped })),
    }));
    await second.getByRole('button', { name: 'Leave room' }).click();
    await contains(first, '#presence', '1 of 2 seats reserved');
    await first.getByRole('button', { name: 'Leave room' }).click();
    await extra.getByRole('button', { name: 'Join room', exact: true }).click();
    await contains(extra, '#status', 'Invalid or expired room code.');
  } finally {
    await browser.close();
  }
});

test('origin check, one-time WebSocket tickets, bounded frames and rate caps', { timeout: 20_000 }, async () => {
  const denied = await fetch(base + '/api/create', {
    method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(denied.status, 403);

  const browser = await launchTestBrowser();
  try {
    const page = await visit(browser, base);
    const result = await page.evaluate(async oversizeBytes => {
      const post = (path, data) => fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      }).then(response => response.json());
      const grant = await post('/api/create', {});
      const url = 'ws://' + location.host + '/socket/' + grant.roomId;
      const openSocket = ticket => {
        const socket = new WebSocket(url, ['apex-poc.v1', 'ticket.' + ticket]);
        const open = new Promise(resolve => {
          socket.addEventListener('open', () => resolve(true), { once: true });
          socket.addEventListener('error', () => resolve(false), { once: true });
        });
        const closeCode = new Promise(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
        return { socket, open, closeCode };
      };
      const initial = openSocket(grant.ticket);
      if (!await initial.open) throw new Error('Initial ticket failed');
      const replay = openSocket(grant.ticket);
      const replayOpened = await replay.open;
      initial.socket.send('x'.repeat(oversizeBytes));
      const oversize = await initial.closeCode;
      const renewed = await post('/api/resume', { roomId: grant.roomId, resume: grant.resume });
      const flood = openSocket(renewed.ticket);
      if (!await flood.open) throw new Error('Renewed ticket failed');
      for (let seq = 1; seq <= 25; seq++) flood.socket.send(JSON.stringify({
        type: 'snapshot', seq, rate: 20, t: Date.now(), position: [0, 0, 0],
        orientation: [0, 0, 0, 1], velocity: [1, 0, 0],
      }));
      const rateLimit = await flood.closeCode;
      const finalTicket = await post('/api/resume', { roomId: grant.roomId, resume: grant.resume });
      const last = openSocket(finalTicket.ticket);
      if (await last.open) {
        last.socket.send('{"type":"leave"}');
        await last.closeCode;
      }
      return { replayOpened, oversize, rateLimit };
    }, maxFrameSize+1);
    assert.deepEqual(result, { replayOpened: false, oversize: 1009, rateLimit: 1008 });
  } finally {
    await browser.close();
  }
});

test('room expiration closes its socket and retires the invite', { timeout: 45_000 }, async () => {
  const browser = await launchTestBrowser();
  try {
    const page = await visit(browser, expiryBase);
    const code = await page.evaluate(async () => {
      const response = await fetch('/api/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (response.status !== 201) throw new Error('Could not create expiry fixture');
      const grant = await response.json();
      if (grant.expires - Date.now() > 12_000) throw new Error('Start the expiry fixture in local-expiry mode');
      const socket = new WebSocket('ws://' + location.host + '/socket/' + grant.roomId,
        ['apex-poc.v1', 'ticket.' + grant.ticket]);
      const closed = await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
      if (closed.code !== 4001 || closed.reason !== 'Room expired') throw new Error('Room alarm did not close the idle socket');
      return grant.code;
    });
    const other = await visit(browser, expiryBase);
    await other.getByLabel('Invite code').fill(code);
    await other.getByRole('button', { name: 'Join room', exact: true }).click();
    await contains(other, '#status', 'Invalid or expired room code.');
  } finally {
    await browser.close();
  }
});
