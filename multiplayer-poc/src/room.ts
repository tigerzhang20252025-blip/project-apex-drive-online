import { defaultTrack, type TrackId } from '../../shared/tracks.ts';
import { DurableObject } from 'cloudflare:workers';
import { ackFrom, acksFrom, isSequence, jsonObject, maxFrameSize, poseFrom, protocol } from '../../shared/protocol.ts';
import { finishGraceMs, gameVersion, isCar, livePoseFrom, maxPlayers, playerName, seats } from '../../shared/game.ts';
import type { DriverProfile, Seat } from '../../shared/game.ts';
import { restoreGameCourse, updateGame, updateRoomMembership, viewGame } from './game-room.ts';
import type { GameState } from './game-room.ts';
import type { Grant, ServerMessage } from '../../shared/protocol.ts';

const ticketMs = 30_000;
const resumeMs = 45_000;
const maxPending = 32;
const encoder = new TextEncoder();

type Member = {
  slot: Seat;
  driver: DriverProfile;
  resume: string;
  ticket: string | null;
  ticketUntil: number;
  reservedUntil: number | null;
  generation: string | null;
};
type State = { code: string; expires: number; members: Member[]; game?: GameState; version?: string; gameTest?: boolean };
type Attachment = { slot: Seat; generation: string };
type Flow = {
  time: number;
  poses: number;
  controls: number;
  excessControls: number;
  excessPoses: number;
  lastControlWarning: number;
  lastSeq: number;
  pending: Map<string, number[]>;
};

const noRoom = () => Response.json({ error: 'Invalid or expired room code.' }, { status: 404 });

function matchesSecret(candidate: string, secret: string | null) {
  return secret !== null && candidate.length === secret.length &&
    crypto.subtle.timingSafeEqual(encoder.encode(candidate), encoder.encode(secret));
}

export class Room extends DurableObject<Cloudflare.Env> {
  private state = this.loadState();
  private flows = new Map<WebSocket, Flow>();

  private loadState() {
    const state = this.ctx.storage.kv.get<State>('room');
    if (state?.game && restoreGameCourse(state.game, state.members)) this.ctx.storage.kv.put('room', state);
    return state;
  }

  async initialize(code: string, expires: number, profile?: Partial<DriverProfile>, gameTest?: boolean, track:TrackId=defaultTrack): Promise<Grant> {
    if (this.state || expires <= Date.now()) throw new Error('Room unavailable');
    this.state = { code, expires, members: [], gameTest, version: profile ? gameVersion : undefined,
      game: profile ? { host: 1, mode: 'drive', session: null, track } : undefined };
    return this.addMember(1, Date.now(), profile);
  }

  async join(code: string, profile?: Partial<DriverProfile>): Promise<Response> {
    const now = Date.now();
    if (!this.state || this.state.code !== code || now >= this.state.expires) return noRoom();
    if (Boolean(profile) !== Boolean(this.state.game)) {
      return Response.json({ error: 'This code belongs to a different client. Open the same game build as your friend.' }, { status: 409 });
    }
    if (this.state.game && this.state.version !== gameVersion) {
      return Response.json({ error: 'This room was created on an earlier build. Ask the host to reload and create a new room.' }, { status: 409 });
    }
    if (this.state.game?.session) return Response.json({ error: 'A session is in progress. Ask the host to return to the lobby.' }, { status: 409 });
    this.state.members = this.state.members.filter(member => member.reservedUntil === null || member.reservedUntil > now);
    if (this.state.members.length === 0) {
      await this.end();
      return noRoom();
    }
    const limit = this.state.game ? maxPlayers : 2;
    const slot = seats.slice(0, limit).find(number => !this.state!.members.some(member => member.slot === number));
    if (!slot) {
      return Response.json({
        error: limit === 2 ? 'Room already has two players.' : `Room already has ${limit} players.`,
      }, { status: 409 });
    }
    return Response.json(await this.addMember(slot, now, profile));
  }

  async resume(token: string): Promise<Response> {
    const now = Date.now();
    const member = this.state?.members.find(item => matchesSecret(token, item.resume));
    if (!this.state || this.state.expires <= now || !member ||
        (member.reservedUntil !== null && member.reservedUntil <= now)) {
      return Response.json({ error: 'Reconnect window has closed.' }, { status: 410 });
    }
    this.issueTicket(member, now);
    // Preserve the original seat deadline if a client asks for several tickets.
    this.save();
    return Response.json(this.grant(this.state, member));
  }

  // The upgrade uses fetch so the WebSocket response keeps its attached socket.
  async fetch(request: Request): Promise<Response> {
    const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim());
    const token = offered?.[1]?.slice('ticket.'.length);
    const now = Date.now();
    const room = this.state;
    const member = room?.members.find(item => token && matchesSecret(token, item.ticket));
    if (!room || room.expires <= now || !member || member.ticketUntil <= now ||
        (member.reservedUntil !== null && member.reservedUntil <= now)) {
      return new Response('Invalid or expired WebSocket ticket.', { status: 401 });
    }

    const previous = this.ctx.getWebSockets(String(member.slot));
    const pair = new WebSocketPair();
    const generation = crypto.randomUUID();
    member.ticket = null;
    member.reservedUntil = null;
    member.generation = generation;
    if (room.game) updateRoomMembership(room.game, room.members, now);
    this.save();
    this.ctx.acceptWebSocket(pair[1], [String(member.slot)]);
    pair[1].serializeAttachment({ slot: member.slot, generation } satisfies Attachment);
    this.send(pair[1], { type: 'welcome', slot: member.slot, generation, expires: room.expires });

    for (const socket of previous) this.disconnect(socket, 4002, 'Connection replaced');
    this.announce();
    await this.arm();
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': protocol },
    });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    const room = this.state;
    const session = socket.deserializeAttachment() as Attachment;
    const now = Date.now();
    if (!room || now >= room.expires) {
      await this.end();
      return;
    }
    if (!room.members.some(member => member.slot === session.slot && member.generation === session.generation)) {
      this.disconnect(socket, 4002, 'Connection replaced');
      return;
    }
    if (typeof raw !== 'string' || raw.length > maxFrameSize || encoder.encode(raw).length > maxFrameSize) {
      this.disconnect(socket, 1009, 'Message too large or unsupported');
      return;
    }

    const message = jsonObject(raw);
    if (!message) {
      this.disconnect(socket, 1008, 'Invalid message');
      return;
    }
    const flow = this.flow(socket, now);
    const elapsed = Math.max(0, now - flow.time) / 1000;
    flow.time = now;
    flow.poses = Math.min(12, flow.poses + elapsed * 20);
    flow.controls = Math.min(room.game ? 16 : 8, flow.controls + elapsed * (room.game ? 5 : 1));
    flow.excessControls = Math.max(0, flow.excessControls - elapsed * 6);
    flow.excessPoses = Math.max(0, flow.excessPoses - elapsed * 10);
    const bucket = message.type === 'snapshot' ? 'poses' : 'controls';
    if (flow[bucket] < 1) {
      if (room.game && bucket === 'poses' && ++flow.excessPoses < 32) {
        // A stalled TCP connection can deliver several old poses at once.
        return;
      }
      if (!room.game || bucket === 'poses' || ++flow.excessControls >= 64) {
        this.disconnect(socket, 1008, 'Message rate exceeded');
      } else if (now - flow.lastControlWarning >= 1000) {
        flow.lastControlWarning = now;
        this.send(socket, {type:'game_error',message:'Slow down a moment.'});
      }
      return;
    }
    flow[bucket]--;

    const ack = ackFrom(message.ack);
    if (ack) this.prunePending(flow, ack.generation, ack.seq);
    const acks = acksFrom(message.acks);
    if (acks) {
      for (const [slotKey, seq] of Object.entries(acks)) {
        const senderMember = room.members.find(member => member.slot === Number(slotKey) && member.generation);
        if (senderMember?.generation) this.prunePending(flow, senderMember.generation, seq);
      }
    }

    if (message.type === 'ping' && isSequence(message.n)) {
      this.send(socket, { type: 'pong', n: message.n, time: now });
      return;
    }
    if (message.type === 'leave') {
      await this.leave(socket, session);
      return;
    }
    if (room.game && message.type !== 'snapshot') {
      const sender = room.members.find(member => member.generation === session.generation)!;
      const change = updateGame(room.game, room.members, sender, message, now, room.expires, Boolean(room.gameTest));
      if (change.error) this.send(socket, { type: 'game_error', message: change.error });
      if (change.notice) {
        const encoded = JSON.stringify(change.notice);
        for (const peer of this.openSockets()) if (peer !== socket) this.sendRaw(peer, encoded);
      }
      if (change.persist) {
        if (message.type !== 'lap' && message.type !== 'stage') room.game.lobbyChanges = (room.game.lobbyChanges ?? 0) + 1;
        this.save();
        this.announce();
      }
      if (change.alarm) await this.arm();
      return;
    }
    const pose = message.type === 'snapshot' ? poseFrom(message) : undefined;
    if (!pose || pose.seq <= flow.lastSeq) {
      this.disconnect(socket, 1008, 'Invalid snapshot');
      return;
    }
    flow.lastSeq = pose.seq;
    const running = room.game?.session;
    const live = running ? livePoseFrom(message.live, running.id) : undefined;
    if (room.game && (!running || !live || (running.ends !== null && now >= running.ends))) return;
    const relay = { type: 'snapshot', ...session, ...pose, receivedAt: now, live } satisfies ServerMessage;
    const encoded = JSON.stringify(relay);
    for (const peer of this.openSockets()) {
      if (peer === socket) continue;
      const peerFlow = this.flow(peer, now);
      let queue = peerFlow.pending.get(session.generation);
      if (!queue) {
        queue = [];
        peerFlow.pending.set(session.generation, queue);
      }
      if (queue.length >= maxPending) continue;
      if (this.sendRaw(peer, encoded)) queue.push(pose.seq);
    }
  }

  async webSocketClose(socket: WebSocket) {
    this.forget(socket);
    const session = socket.deserializeAttachment() as Attachment;
    const member = this.state?.members.find(item => item.generation === session.generation);
    if (!member) return;
    member.reservedUntil = Date.now() + resumeMs;
    member.generation = null;
    if (member.driver) member.driver.ready = false;
    const game = this.state?.game;
    if (game) updateRoomMembership(game, this.state!.members, Date.now());
    this.save();
    this.announce();
    await this.arm();
  }

  async webSocketError(socket: WebSocket) {
    this.disconnect(socket, 1011, 'Connection error');
    await this.webSocketClose(socket);
  }

  async alarm() {
    const now = Date.now();
    const room = this.state;
    if (!room) return;
    if (room.expires <= now) {
      await this.end();
      return;
    }
    room.members = room.members.filter(member => member.reservedUntil === null || member.reservedUntil > now);
    if (room.members.length === 0) {
      await this.end();
      return;
    }
    if (room.game) updateRoomMembership(room.game, room.members, now);
    this.save();
    this.announce();
    await this.arm();
  }

  private issueTicket(member: Member, now: number) {
    member.ticket = crypto.randomUUID();
    member.ticketUntil = now + ticketMs;
  }

  private async addMember(slot: Seat, now: number, profile?: Partial<DriverProfile>) {
    const room = this.state!;
    const member: Member = {
      slot, resume: crypto.randomUUID(), generation: null,
      driver: { name: playerName(profile?.name, slot), vehicle: isCar(profile?.vehicle) ? profile.vehicle : 'f40', ready: false },
      ticket: null, ticketUntil: 0, reservedUntil: now + ticketMs,
    };
    this.issueTicket(member, now);
    if (room.game && !room.game.session) {
      for (const existing of room.members) existing.driver.ready = false;
    }
    room.members.push(member);
    if (room.game) updateRoomMembership(room.game, room.members, now);
    this.save();
    this.announce();
    await this.arm();
    return this.grant(room, member);
  }

  private grant(room: State, member: Member): Grant {
    return {
      code: room.code, roomId: this.ctx.id.toString(), resume: member.resume,
      ticket: member.ticket!, expires: room.expires,
    };
  }

  private save() {
    this.ctx.storage.kv.put('room', this.state);
  }

  private async arm() {
    if (!this.state) return;
    const ends = this.state.game?.session?.ends;
    const resultAt = ends == null ? Infinity : ends + finishGraceMs;
    const expiry = Math.min(this.state.expires, resultAt > Date.now() ? resultAt : Infinity,
      ...this.state.members.map(member => member.reservedUntil ?? Infinity));
    await this.ctx.storage.setAlarm(expiry);
  }

  private async leave(socket: WebSocket, session: Attachment) {
    const room = this.state!;
    room.members = room.members.filter(member => member.generation !== session.generation);
    this.disconnect(socket, 1000, 'Left room');
    if (room.game) updateRoomMembership(room.game, room.members, Date.now());
    if (room.members.length === 0) {
      await this.end();
      return;
    }
    this.save();
    this.announce();
    await this.arm();
  }

  private async end() {
    if (!this.state) return;
    this.state = undefined;
    this.ctx.storage.kv.delete('room');
    for (const socket of this.ctx.getWebSockets()) this.disconnect(socket, 4001, 'Room expired');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.exports.Directory.getByName('phase-1-admission').release(this.ctx.id.toString());
  }

  private openSockets() {
    return this.ctx.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN);
  }

  private announce() {
    const sockets = this.openSockets();
    const presence = JSON.stringify({ type: 'presence', online: sockets.length, seats: this.state?.members.length ?? 0 } satisfies ServerMessage);
    const room = this.state;
    const game = room?.game ? JSON.stringify(viewGame(room.game, room.members)) : undefined;
    for (const socket of sockets) {
      this.sendRaw(socket, presence);
      if (game) this.sendRaw(socket, game);
    }
  }

  private send(socket: WebSocket, message: ServerMessage) {
    return this.sendRaw(socket, JSON.stringify(message));
  }

  private sendRaw(socket: WebSocket, payload: string) {
    try {
      socket.send(payload);
      return true;
    } catch {
      this.disconnect(socket, 1011, 'Connection error');
      return false;
    }
  }

  private prunePending(flow: Flow, generation: string, seq: number) {
    const queue = flow.pending.get(generation);
    if (!queue?.length) return;
    let drop = 0;
    while (drop < queue.length && queue[drop] <= seq) drop++;
    if (drop > 0) queue.splice(0, drop);
  }

  private disconnect(socket: WebSocket, code: number, reason: string) {
    this.forget(socket);
    try { socket.close(code, reason); } catch {}
  }

  private forget(socket: WebSocket) {
    this.flows.delete(socket);
    const session = socket.deserializeAttachment() as Attachment;
    for (const flow of this.flows.values()) {
      flow.pending.delete(session.generation);
    }
  }

  private flow(socket: WebSocket, now: number) {
    let flow = this.flows.get(socket);
    if (!flow) {
      flow = { time: now, poses: 12, controls: this.state?.game ? 8 : 4, excessControls: 0, excessPoses: 0,
        lastControlWarning: 0, lastSeq: 0, pending: new Map() };
      this.flows.set(socket, flow);
    }
    return flow;
  }
}
