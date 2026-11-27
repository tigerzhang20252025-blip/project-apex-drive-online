import type { Scene } from 'three';
import {
  finishGraceMs, gameVersion, isCar, isMode,
} from '../multiplayer-poc/src/game.ts';
import type {
  CarId, GameCommand, LiveRoom, Player, Progress, Result, Seat, Session, Splits, VehicleSample,
} from '../multiplayer-poc/src/game.ts';
import { protocol } from '../multiplayer-poc/src/protocol.ts';
import type { Ack, Grant, ServerMessage } from '../multiplayer-poc/src/protocol.ts';
import { lapTime, sectorTime } from './lap-timing.ts';
import { RemoteCar } from './remote-car.ts';
import { vehicles } from './vehicle-registry.ts';

const sendPeriod = 1000 / 15;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };
const dateAt = () => performance.timeOrigin + performance.now();

type Callbacks = {
  vehicle: () => CarId;
  changeVehicle: (car: CarId) => Promise<void>;
  enter: (session: Session, slot: Seat) => void;
  exit: () => void;
  interrupted: (reason: string) => void;
  unlockAudio: () => void;
};

type RequestError = Error & { status?: number };

function endpoint() {
  if (import.meta.env.VITE_MULTIPLAYER_URL) return new URL(import.meta.env.VITE_MULTIPLAYER_URL).origin;
  return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://127.0.0.1:8788' : location.origin;
}

const elapsedText = (ms: number | null | undefined) => lapTime(ms == null ? null : ms / 1000);
const splitText = (splits: ReadonlyArray<number | null> | undefined) =>
  [0, 1, 2].map((index) => 'S' + (index + 1) + ' ' + sectorTime(splits?.[index] == null ? null : splits[index]! / 1000)).join('  ·  ');
const theo = (result?: Result) =>
  result && result.sectors.every(n => n !== null)
    ? (result.sectors[0] ?? 0) + (result.sectors[1] ?? 0) + (result.sectors[2] ?? 0) : null;

export class Multiplayer {
  readonly remote: RemoteCar;
  private grant?: Grant;
  private socket?: WebSocket;
  private state?: LiveRoom;
  private seat?: Seat;
  private serial = 0;
  private seq = 0;
  private ack?: Ack;
  private retry = 0;
  private disconnectedAt = 0;
  private nextSend = 0;
  private nextTiming = 0;
  private connectTimer?: number;
  private pingTimer?: number;
  private retryTimer?: number;
  private ping?: { n: number; sent: number };
  private clock?: { offset: number; rtt: number };
  private clockTarget?: number;
  private minRtt = Infinity;
  private lastPong = 0;
  private opened = false;
  private connecting = false;
  private online = false;
  private selecting = false;
  private active?: string;
  private progress?: Progress;
  private laps: Array<Extract<GameCommand, { type: 'lap' }>> = [];
  private resultsKey = '';
  private lobby = byId('online-lobby');
  private status = byId('online-status');
  private connection = byId('online-connection');
  private stayOpen = false;
  private trackMessageUntil = 0;

  constructor(scene: Scene, private callbacks: Callbacks) {
    this.remote = new RemoteCar(scene, () => this.renderLobby());
    byId('play-online').addEventListener('click', () => this.toggle(true));
    byId('play-solo').addEventListener('click', () => { this.leave(); this.toggle(false); });
    byId('online-create').addEventListener('click', () => void this.admit('create'));
    byId('online-join').addEventListener('submit', event => { event.preventDefault(); void this.admit('join'); });
    byId('online-copy').addEventListener('click', () => {
      if (this.grant) void navigator.clipboard.writeText(this.code).then(
        () => this.notify('Room code copied.'), () => this.notify('Select the room code to copy it.'));
    });
    for (const id of ['online-leave', 'online-track-leave', 'online-result-leave']) {
      byId(id).addEventListener('click', () => this.leave());
    }
    for (const id of ['online-end', 'online-return']) byId(id).addEventListener('click', () => this.command({type:'lobby'}));
    byId('online-start').addEventListener('click', () => this.command({type:'start'}));
    byId('online-ready').addEventListener('click', () => {
      if (this.remote.failed && this.peer) {
        this.remote.select(this.peer.vehicle);
        this.renderLobby();
      } else if (this.self) {
        if(!this.self.ready)this.callbacks.unlockAudio();
        this.command({type:'ready', ready:!this.self.ready});
      }
    });
    byId<HTMLSelectElement>('online-mode').addEventListener('change', event => {
      const mode = (event.target as HTMLSelectElement).value;
      if (isMode(mode)) this.command({type:'mode', mode});
    });
    byId<HTMLSelectElement>('online-vehicle').addEventListener('change', event => {
      const id = (event.target as HTMLSelectElement).value;
      if (isCar(id)) void this.changeVehicle(id);
    });
  }

  get isOpen() { return this.opened; }
  get session() { return this.state?.session ?? null; }
  get mode() { return this.state?.mode; }
  get slot() { return this.seat; }
  get connected() { return this.online; }
  get prestart() { return !!this.session && this.serverNow() < this.session.starts; }
  get finished() { return this.session?.ends != null && this.serverNow() >= this.session.ends; }
  get diagnostics() {
    return { slot:this.seat, session:this.session, online:this.online, clock:this.clock,
      remaining:this.session ? this.session.starts-this.serverNow() : null, remote:this.remote.stats };
  }
  private get self() { return this.state?.players.find(player => player.slot === this.seat); }
  private get peer() { return this.state?.players.find(player => player.slot !== this.seat); }
  private get code() { return this.grant?.code.replace(/^(....)/, '$1-') ?? ''; }
  private get isHost() { return this.seat !== undefined && this.seat === this.state?.host; }

  serverNow() { return dateAt() + (this.clock?.offset ?? 0); }

  private toggle(open: boolean) {
    this.opened = open;
    this.lobby.hidden = !open;
    byId('garage-solo').hidden = open;
    byId('play-online').setAttribute('aria-pressed', String(open));
    byId('play-solo').setAttribute('aria-pressed', String(!open));
    if (open) this.renderLobby();
  }

  private notify(value: string) { text(this.status, value); }
  private trackMessage(value: string) {
    this.trackMessageUntil = performance.now() + 5_000;
    const notice = byId('online-track-message');
    text(notice,value);
    notice.hidden = false;
  }

  private async request(path: string, body: object): Promise<Grant> {
    let response: Response;
    try {
      response = await fetch(endpoint() + '/api/' + path, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(7_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Cannot reach multiplayer. Check your connection and try again.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      const error: RequestError = new Error(result?.error ?? 'Multiplayer is temporarily unavailable. Try again later.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  private async admit(path: 'create' | 'join') {
    if (this.connecting || this.grant) return;
    this.connecting = true;
    const serial = ++this.serial;
    this.notify(path === 'create' ? 'Creating private room…' : 'Joining room…');
    this.renderLobby();
    try {
      const grant = await this.request(path, { gameVersion, vehicle: this.callbacks.vehicle(),
        name: byId<HTMLInputElement>('online-name').value, code: byId<HTMLInputElement>('online-code-input').value });
      if (this.serial !== serial) return;
      this.grant = grant;
      this.retry = this.disconnectedAt = 0;
      this.stayOpen = true;
      this.notify('Connecting to room…');
      this.open(grant);
    } catch (error) {
      if (this.serial === serial) this.notify((error as Error).message);
    } finally {
      if (this.serial === serial) {
        this.connecting = false;
        this.renderLobby();
      }
    }
  }

  private open(grant: Grant) {
    const address = new URL('/socket/' + grant.roomId, endpoint());
    address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(address, [protocol, 'ticket.' + grant.ticket]);
    this.socket = socket;
    this.connectTimer = window.setTimeout(() => {
      if (socket === this.socket && !this.online) this.reconnect();
    }, 6_000);
    socket.addEventListener('message', event => {
      if (socket === this.socket) this.message(JSON.parse(event.data) as ServerMessage);
    });
    socket.addEventListener('close', event => {
      if (socket !== this.socket) return;
      if ([4001,4002,1008,1009].includes(event.code)) {
        this.clear(event.code === 4001 ? 'This room expired. Create or join another room.' :
          event.code === 4002 ? 'The seat was opened in another connection.' : 'The connection was closed. Rejoin the room.');
      } else this.reconnect();
    });
  }

  private message(message: ServerMessage) {
    switch (message.type) {
      case 'welcome':
        this.online = true;
        this.retry = this.disconnectedAt = 0;
        this.seat = message.slot as Seat;
        this.seq = 0;
        this.nextSend = this.nextTiming = 0;
        this.ack = undefined;
        this.ping = undefined;
        this.lastPong = dateAt();
        window.clearTimeout(this.connectTimer);
        this.notify('');
        this.pollClock();
        this.renderLobby();
        break;
      case 'pong': {
        if (!this.ping || message.n !== this.ping.n) return;
        const now = dateAt();
        const rtt = now - this.ping.sent;
        const offset = message.time + rtt / 2 - now;
        const firstClock = this.clock === undefined;
        if (!this.clock) {
          this.clock = { offset, rtt };
          this.clockTarget = offset;
          this.minRtt = rtt;
        } else {
          this.minRtt = Math.min(rtt, this.minRtt + 1.5);
          this.clock.rtt = rtt;
          const target = this.clockTarget ?? this.clock.offset;
          if (Math.abs(offset - target) > 500) {
            this.clockTarget = offset;
            this.clock.offset = offset;
          } else if (rtt <= this.minRtt + 35 || Math.abs(offset - target) < 25) {
            const weight = rtt <= this.minRtt + 10 ? .35 : .15;
            this.clockTarget = target + (offset - target) * weight;
          }
        }
        this.lastPong = now;
        this.ping = undefined;
        this.updateConnection(rtt);
        if(firstClock)this.renderLobby();
        break;
      }
      case 'game':
        this.updateRoom(message);
        break;
      case 'snapshot':
        if (!message.live || message.live.session !== this.active || message.slot !== this.peer?.slot) return;
        this.ack = {generation:message.generation, seq:message.seq};
        this.remote.receive(message, this.serverNow());
        break;
      case 'timing':
        if (message.session === this.active && message.slot === this.peer?.slot) this.progress = message.progress;
        break;
      case 'game_error':
        this.notify(message.message);
        if (this.active) this.trackMessage(message.message);
        break;
    }
  }

  private updateRoom(state: LiveRoom) {
    const previous = this.peer;
    this.state = state;
    const peer = this.peer;
    if (!peer?.connected && previous?.connected) {
      this.remote.clear();
      this.progress = undefined;
    }
    if (peer?.vehicle !== previous?.vehicle) this.remote.select(peer?.vehicle);
    const session = state.session;
    if (session && session.id !== this.active && this.seat) {
      this.active = session.id;
      this.laps = [];
      this.progress = undefined;
      this.remote.clear();
      this.callbacks.enter(session, this.seat);
      this.resultsKey = '';
      this.trackMessageUntil = 0;
    } else if (!session && this.active) {
      this.active = undefined;
      this.laps = [];
      this.remote.clear();
      this.callbacks.exit();
    }
    if (this.self && session) {
      const own = session.results.find(result => result.slot === this.seat)?.laps ?? 0;
      this.laps = this.laps.filter(lap => lap.number > own);
    }
    this.renderLobby();
    this.renderTrack();
  }

  private closeSocket() {
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.pingTimer);
    window.clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.online = false;
    socket?.close();
  }

  private reconnect() {
    this.closeSocket();
    if (!this.stayOpen || !this.grant) return;
    if (!this.disconnectedAt) {
      this.disconnectedAt = dateAt();
      this.callbacks.interrupted('Connection interrupted');
    }
    this.remote.clear();
    this.notify('Connection interrupted. Reconnecting…');
    this.updateConnection();
    this.renderLobby();
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const grant = this.grant;
    if (!grant || !this.stayOpen) return;
    if (dateAt() - this.disconnectedAt >= 43_000 || this.serverNow() >= grant.expires) {
      this.clear('Reconnect window closed. Create or join another room.');
      return;
    }
    this.retryTimer = window.setTimeout(async () => {
      if (grant !== this.grant) return;
      try {
        const next = await this.request('resume', {roomId:grant.roomId, resume:grant.resume});
        if (grant !== this.grant) return;
        this.grant = next;
        this.open(next);
      } catch (error) {
        if (grant !== this.grant) return;
        if ((error as RequestError).status === 410) this.clear((error as Error).message);
        else this.scheduleReconnect();
      }
    }, Math.min(400 * 2 ** this.retry++, 3500) + Math.random() * 125);
  }

  private pollClock() {
    if (!this.online) return;
    const now = dateAt();
    if (now - this.lastPong > 9500) {
      this.reconnect();
      return;
    }
    this.ping = {n:Math.round(now), sent:now};
    this.send({type:'ping', n:this.ping.n, ack:this.ack});
    this.pingTimer = window.setTimeout(() => this.pollClock(), 2000);
  }

  private updateConnection(rtt = this.clock?.rtt) {
    const label = this.online ? (rtt === undefined ? 'Connected' : Math.round(rtt) + ' ms RTT') : 'Reconnecting…';
    text(this.connection,label);
    if (this.grant && this.online && !this.status.textContent?.includes('copied')) {
      if (!this.status.textContent || this.status.textContent === 'Connected' || / ms RTT$/.test(this.status.textContent)) this.notify(label);
    }
  }

  private send(message: object): boolean {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 8192) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  private command(message: GameCommand) {
    if (!this.online || !this.send(message)) {
      const error = 'The room is reconnecting. Try again shortly.';
      this.notify(error);
      if(this.active)this.trackMessage(error);
    }
  }

  async changeVehicle(id: CarId) {
    if (this.selecting || !this.online || this.session) return;
    this.selecting = true;
    this.renderLobby();
    try {
      await this.callbacks.changeVehicle(id);
      if (this.callbacks.vehicle() === id) this.command({type:'profile', name:this.self?.name ?? '', vehicle:id});
      else this.notify('Could not load the selected vehicle.');
    } finally {
      this.selecting = false;
      this.renderLobby();
    }
  }

  submitLap(number: number, splits: Splits) {
    const session = this.session;
    if (!session || this.finished || !this.online) return;
    this.laps.push({type:'lap', session:session.id, completedAt:Math.round(this.serverNow()), number, splits});
    this.send(this.laps.at(-1)!);
  }

  tick(now: number, dt: number, sample: () => VehicleSample, timing: () => Progress) {
    const session = this.session;
    if (!session || !this.active) return;
    if (this.clock && this.clockTarget !== undefined) {
      const diff = this.clockTarget - this.clock.offset;
      const maxStep = Math.min(Math.abs(diff), 25 * Math.min(Math.max(dt, 0), .1));
      this.clock.offset += Math.sign(diff) * maxStep;
    }
    const serverNow = this.serverNow();
    this.remote.draw(serverNow, dt);
    if (!this.online || (session.ends !== null && serverNow >= session.ends)) return;
    if (now >= this.nextSend) {
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2048) {
        const {position,orientation,velocity,...visual} = sample();
        this.send({ type:'snapshot', seq:++this.seq, t:Math.round(serverNow), rate:15, position, orientation, velocity,
          live:{...visual,session:session.id}, ack:this.ack });
      }
      this.nextSend = this.nextSend < now - sendPeriod ? now + sendPeriod : this.nextSend + sendPeriod;
    }
    if (serverNow >= session.starts && now >= this.nextTiming) {
      if (this.laps[0]) this.send(this.laps[0]);
      this.send({type:'timing',session:session.id,progress:timing()});
      this.nextTiming = now + 1000;
    }
  }

  leave() {
    if (this.online) this.send({type:'leave'});
    this.clear(this.grant ? 'You left the room.' : '');
  }

  private clear(message: string) {
    const wasPlaying = Boolean(this.active);
    this.serial++;
    this.stayOpen = this.connecting = false;
    this.closeSocket();
    this.grant = this.state = this.clock = this.clockTarget = this.seat = this.progress = this.active = undefined;
    this.minRtt = Infinity;
    this.laps = [];
    this.remote.dispose();
    if (wasPlaying) this.callbacks.exit();
    this.notify(message);
    this.renderLobby();
    this.renderTrack();
  }

  private rosterRow(player: Player) {
    const row = document.createElement('li');
    row.dataset.ready = String(player.ready);
    const body = document.createElement('div');
    const name = document.createElement('b');
    const car = document.createElement('small');
    const marker = document.createElement('strong');
    name.textContent = player.name + (player.slot === this.seat ? ' · You' : '') + (player.slot === this.state?.host ? ' · Host' : '');
    car.textContent = vehicles[player.vehicle].name;
    marker.textContent = !player.connected ? 'Reconnecting' : player.ready ? 'Ready' : 'Not ready';
    body.append(name,car);
    row.append(body,marker);
    return row;
  }

  private renderLobby() {
    byId('online-entry').hidden = Boolean(this.grant);
    byId('online-room').hidden = !this.grant;
    byId<HTMLButtonElement>('online-create').disabled = this.connecting;
    byId<HTMLFormElement>('online-join').querySelector('button')!.disabled = this.connecting;
    if (!this.grant) return;
    text(byId('online-code'),this.code);
    const players = this.state?.players ?? [];
    const rows = players.map(player => this.rosterRow(player));
    if (players.length === 1) {
      const waiting = document.createElement('li');
      waiting.textContent = 'Waiting for a second driver';
      rows.push(waiting);
    }
    byId('online-drivers').replaceChildren(...rows);
    const field = byId<HTMLSelectElement>('online-vehicle');
    field.value = this.selecting ? this.callbacks.vehicle() : this.self?.vehicle ?? this.callbacks.vehicle();
    field.disabled = !this.online || this.selecting || Boolean(this.session);
    const mode = byId<HTMLSelectElement>('online-mode');
    mode.value = this.mode ?? 'drive';
    mode.disabled = !this.online || !this.isHost || Boolean(this.session);
    const ready = byId<HTMLButtonElement>('online-ready');
    text(ready,this.remote.failed ? 'Retry model' : this.self?.ready ? 'Unready' : this.peer && !this.remote.ready ? 'Loading car…' : 'Ready');
    ready.disabled = !this.online || !this.clock || this.selecting || Boolean(this.session) || !this.peer?.connected ||
      (!this.remote.ready && !this.remote.failed);
    const start = byId<HTMLButtonElement>('online-start');
    start.hidden = !this.isHost;
    start.disabled = !this.online || players.length !== 2 || players.some(player => !player.ready || !player.connected) || Boolean(this.session);
  }

  renderTrack() {
    const session = this.session;
    byId('online-hud').hidden = !session || !this.active;
    const end = byId('online-finish');
    byId('online-track-message').hidden = !this.active || performance.now() >= this.trackMessageUntil;
    const wasHidden = end.hidden;
    const now = this.serverNow();
    end.hidden = !this.active || !session || session.ends === null || now < session.ends + finishGraceMs;
    if (!session || !this.active) return;
    this.updateConnection();
    text(byId('online-mode-label'),this.mode === 'challenge' ? 'Best Lap Challenge' : 'Free Drive');
    text(byId('online-clock'),now < session.starts ? 'Starts in ' + Math.max(1,Math.ceil((session.starts - now)/1000)) :
      session.ends === null ? 'On track' : now >= session.ends ? 'Session complete' :
        Math.floor(Math.ceil((session.ends-now)/1000)/60) + ':' + String(Math.ceil((session.ends-now)/1000)%60).padStart(2,'0') + ' remaining');
    byId('online-end').hidden = !this.isHost || this.mode !== 'drive';
    byId<HTMLButtonElement>('online-return').disabled = !this.online;
    const other = session.results.find(result => result.slot !== this.seat);
    const own = session.results.find(result => result.slot === this.seat);
    const timing = this.progress;
    const delta = own?.best != null && other?.best != null ? ' · Δ ' + (other.best > own.best ? '+' : other.best < own.best ? '−' : '') +
      elapsedText(Math.abs(other.best-own.best)) : '';
    text(byId('online-opponent'), other ?
      other.name + (this.peer?.connected ? '' : this.peer ? ' · Reconnecting' : ' · Left room') + ' · Best ' + elapsedText(other.best) + delta +
      '\n' + (timing?.invalid ? 'Invalid lap' : timing?.ms == null ? 'Awaiting a timed lap' :
        'Sector ' + (timing.sector+1) + ' · ' + elapsedText(timing.ms)) +
      '\n' + splitText(timing?.splits ?? other.bestLap ?? undefined) : 'Waiting for an opponent');
    if (!end.hidden) {
      this.renderResults(session);
      if(wasHidden)byId('online-results-heading').focus({preventScroll:true});
    }
  }

  private renderResults(session: Session) {
    const key = JSON.stringify(session.results);
    if (key === this.resultsKey) return;
    this.resultsKey = key;
    const results = [...session.results].sort((a,b) => (a.best ?? Infinity) - (b.best ?? Infinity));
    const winning = results[0]?.best;
    byId('online-results').replaceChildren(...results.map((result,index) => {
      const row = document.createElement('div');
      row.className = 'online-result-row';
      const head = document.createElement('b');
      const times = document.createElement('small');
      const splits = document.createElement('small');
      const rank = result.best === null ? '—' : result.best === winning ? '1' : String(index+1);
      head.textContent = rank + ' · ' + result.name + ' · ' + elapsedText(result.best) +
        (winning != null && result.best != null && result.best > winning ? ' (+' + elapsedText(result.best - winning) + ')' : '');
      times.textContent = vehicles[result.vehicle].name + ' · ' + result.laps + (result.laps===1?' valid lap':' valid laps') +
        ' · Theoretical ' + elapsedText(theo(result));
      splits.textContent = 'Best lap  ' + splitText(result.bestLap ?? undefined);
      const sectors = document.createElement('small');
      sectors.textContent = 'Best sectors  ' + splitText(result.sectors);
      row.append(head,times,splits,sectors);
      return row;
    }));
  }
}
