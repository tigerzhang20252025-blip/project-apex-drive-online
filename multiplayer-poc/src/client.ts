import { Measurements } from './measurements.ts';
import { isRate, protocol } from '../../shared/protocol.ts';
import type { Ack, Grant, Pose, Rate, Relay, ServerMessage } from '../../shared/protocol.ts';

function byId<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

const status = byId('status');
const lobby = byId('lobby');
const room = byId('room');
const create = byId<HTMLButtonElement>('create');
const join = byId<HTMLButtonElement>('join-button');
const code = byId<HTMLInputElement>('code');
const rateField = byId<HTMLSelectElement>('rate');

let metrics = new Measurements();
let grant: Grant | undefined;
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let sendTimer: number | undefined;
let pingTimer: number | undefined;
let joinPending = false;
let attempt = 0;
let seq = 0;
let nextPoseAt = 0;
let ack: Ack | undefined;
let pendingPing: { at: number; id: number } | undefined;
let lastPeer: Relay | undefined;
let lastPong = 0;
let connected = false;
let slot = 0;
let rate: Rate = 15;

function notify(message: string) {
  status.textContent = message;
}

async function request<T>(path: string, body?: object): Promise<T> {
  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    metrics.event(path + ' network error');
    throw new Error('Request could not reach the relay.');
  }
  metrics.event(path + ' HTTP ' + response.status, Math.round(performance.now() - start));
  let data: T & { error?: string };
  try { data = await response.json(); }
  catch { throw new Error('Relay did not return a response you can use.'); }
  if (!response.ok) {
    const error = new Error(data.error ?? 'Relay temporarily unavailable.');
    Object.assign(error, { status: response.status });
    throw error;
  }
  return data;
}

async function enter(path: string, body: object) {
  if (joinPending || grant) return;
  joinPending = create.disabled = join.disabled = true;
  notify('Contacting relay…');
  try {
    grant = await request<Grant>(path, body);
    attempt = 0;
    byId('invite').textContent = 'Code ' + inviteCode(grant.code);
    room.hidden = false;
    lobby.hidden = true;
    open();
  } catch (error) {
    notify((error as Error).message);
  } finally {
    joinPending = create.disabled = join.disabled = false;
  }
}

function inviteCode(raw: string) {
  return raw.slice(0, 4) + '-' + raw.slice(4);
}

function stopTimers() {
  window.clearTimeout(sendTimer);
  window.clearTimeout(pingTimer);
  window.clearTimeout(reconnectTimer);
}

function open() {
  if (!grant) return;
  const started = performance.now();
  const url = new URL('/socket/' + grant.roomId, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, [protocol, 'ticket.' + grant.ticket]);
  socket = ws;
  metrics.event('WebSocket attempt');
  notify(attempt ? 'Reconnecting…' : 'Opening WebSocket…');

  const timeout = window.setTimeout(() => {
    if (socket === ws && !connected) reconnect('Socket handshake timed out', 0);
  }, 8000);

  ws.addEventListener('open', () => {
    if (socket === ws) metrics.event('WebSocket upgraded', Math.round(performance.now() - started));
  });
  ws.addEventListener('message', event => {
    if (socket !== ws) return;
    const message = JSON.parse(event.data) as ServerMessage;
    switch (message.type) {
      case 'welcome':
        window.clearTimeout(timeout);
        connected = true;
        attempt = 0;
        seq = 0;
        nextPoseAt = 0;
        ack = undefined;
        slot = message.slot;
        lastPong = performance.now();
        metrics.connected();
        metrics.event('Room connected', Math.round(lastPong - started));
        notify('Connected as player ' + slot + '.');
        sendPose();
        ping();
        break;
      case 'presence':
        byId('presence').textContent = message.online + ' online · ' + message.seats + ' of 2 seats reserved';
        if (message.online < 2) {
          lastPeer = undefined;
          metrics.noPeer();
        }
        break;
      case 'snapshot':
        lastPeer = message;
        ack = { generation: message.generation, seq: message.seq };
        metrics.receive(message, performance.now());
        break;
      case 'pong':
        if (pendingPing?.id === message.n) {
          lastPong = performance.now();
          metrics.pong(lastPong - pendingPing.at);
          pendingPing = undefined;
        }
        break;
    }
  });
  ws.addEventListener('error', () => {
    if (socket === ws) metrics.event('WebSocket error');
  });
  ws.addEventListener('close', event => {
    window.clearTimeout(timeout);
    if (socket !== ws) return;
    if (event.code === 4001 || event.code === 4002 || event.code === 1008 || event.code === 1009) {
      metrics.event('WebSocket closed', event.code);
      clearRoom(event.reason || 'Room connection closed.');
      return;
    }
    reconnect('WebSocket closed', event.code);
  });
}

function reconnect(reason: string, detail?: number) {
  const previous = socket;
  socket = undefined;
  connected = false;
  previous?.close();
  stopTimers();
  lastPeer = undefined;
  pendingPing = undefined;
  metrics.event(reason, detail);
  metrics.disconnected();
  if (grant) resume(grant);
}

function resume(session: Grant) {
  const delay = Math.min(500 * 2 ** attempt++, 5000);
  notify('Connection interrupted. Reconnecting…');
  reconnectTimer = window.setTimeout(async () => {
    if (grant !== session) return;
    if (Date.now() >= session.expires || attempt > 12) {
      clearRoom('Reconnect window closed. Create or join a room again.');
      return;
    }
    try {
      const next = await request<Grant>('/api/resume', { roomId: session.roomId, resume: session.resume });
      if (grant !== session) return;
      grant = next;
      open();
    } catch (error) {
      if (grant !== session) return;
      if ((error as { status?: number }).status === 410) clearRoom((error as Error).message);
      else resume(session);
    }
  }, delay + Math.random() * 150);
}

function clearRoom(message: string) {
  stopTimers();
  grant = undefined;
  const current = socket;
  socket = undefined;
  current?.close();
  connected = false;
  lastPeer = undefined;
  pendingPing = undefined;
  metrics.connected();
  metrics.noPeer();
  room.hidden = true;
  lobby.hidden = false;
  byId('presence').textContent = '';
  notify(message);
}

function syntheticPose(): Pose {
  const now = Date.now();
  const angle = (now % 20_000) * Math.PI / 10_000 + slot * 0.5;
  const quantize = (value: number) => Math.round(value * 1e4) / 1e4;
  return {
    seq: ++seq, rate, t: now,
    position: [quantize(35 * Math.cos(angle)), 0, quantize(35 * Math.sin(angle))],
    orientation: [0, quantize(Math.sin(angle / 2)), 0, quantize(Math.cos(angle / 2))],
    velocity: [quantize(-11 * Math.sin(angle)), 0, quantize(11 * Math.cos(angle))],
  };
}

function sendPose() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  const period = 1000 / rate;
  if (nextPoseAt < now - period) nextPoseAt = now;
  if (socket.bufferedAmount < 2048) {
    socket.send(JSON.stringify({ type: 'snapshot', ...syntheticPose(), ack }));
    metrics.sent++;
  } else {
    metrics.skipped++;
  }
  nextPoseAt += period;
  sendTimer = window.setTimeout(sendPose, Math.max(0, nextPoseAt - performance.now()));
}

function ping() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const now = performance.now();
  if (now - lastPong > 9000) {
    reconnect('Heartbeat timeout');
    return;
  }
  if (!pendingPing || now - pendingPing.at >= 4000) {
    pendingPing = { at: now, id: Date.now() };
    socket.send(JSON.stringify({ type: 'ping', n: pendingPing.id, ack }));
  }
  pingTimer = window.setTimeout(ping, 2000);
}

function showMetrics() {
  const data = metrics.summary();
  const display = (number: number | null | undefined) => number ?? '—';
  byId('summary').textContent =
    Math.floor(data.elapsedMs / 1000) + ' s elapsed · RTT p50 / p95 ' +
    display(data.rtt.p50Ms) + ' / ' + display(data.rtt.p95Ms) + ' ms · ' +
    data.sent + ' sent · ' + data.skipped + ' skipped · ' + (data.offlineMs / 1000).toFixed(1) + ' s reconnecting';
  const rows = data.byPeerRate.map(entry => {
    const row = document.createElement('tr');
    const values = [
      entry.rate + ' Hz', entry.received,
      display(entry.interval?.p50Ms) + ' / ' + display(entry.interval?.p95Ms) + ' ms',
      display(entry.jitter?.p95Ms) + ' ms', entry.gaps, entry.missing,
      display(entry.stalePercent) + '%',
    ];
    for (const value of values) {
      const cell = row.insertCell();
      cell.textContent = String(value);
    }
    return row;
  });
  byId('rate-rows').replaceChildren(...rows);
  byId('pose').textContent = lastPeer ?
    'Peer ' + lastPeer.slot + ' · snapshot ' + lastPeer.seq + '\nposition ' + lastPeer.position.join(', ') +
    '\norientation ' + lastPeer.orientation.join(', ') + '\nvelocity ' + lastPeer.velocity.join(', ') :
    'Waiting for peer snapshots';
}

create.addEventListener('click', () => void enter('/api/create', {}));
byId('join').addEventListener('submit', event => {
  event.preventDefault();
  void enter('/api/join', { code: code.value.trim() });
});
rateField.addEventListener('change', () => {
  const selected = Number(rateField.value);
  if (isRate(selected)) {
    rate = selected;
    nextPoseAt = performance.now();
    metrics.event('Send rate changed', rate);
  }
});
byId('copy').addEventListener('click', async () => {
  if (!grant) return;
  try { await navigator.clipboard.writeText(inviteCode(grant.code)); notify('Invite code copied.'); }
  catch { notify('Clipboard unavailable. Select the invite code to copy it.'); }
});
byId('reconnect').addEventListener('click', () => {
  if (connected) reconnect('Reconnect test');
});
byId('leave').addEventListener('click', () => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }));
  metrics.event('Left room');
  clearRoom('You left the room.');
});
byId('probe').addEventListener('click', async () => {
  try {
    await request('/api/health');
    notify('Relay health check passed (HTTP 200).');
  } catch (error) { notify((error as Error).message); }
});
byId('reset').addEventListener('click', () => {
  metrics = new Measurements();
  if (grant && !connected) metrics.disconnected();
  metrics.event('Measurements reset');
  showMetrics();
});
byId('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ protocol, exportedAt: new Date().toISOString(), ...metrics.summary() }, null, 2)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = 'apex-relay-measurements.json';
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});
showMetrics();
window.setInterval(showMetrics, 1000);
