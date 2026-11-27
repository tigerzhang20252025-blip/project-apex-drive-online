import { attemptName, defaultTrack, isTrackId, trackIdentities, type TrackId } from '../../shared/tracks.ts';
import {
  challengeMs, countdownMs, finishGraceMs, isCar, isMode, playerName, progressFrom, validSplits,
} from '../../shared/game.ts';
import type { DriverProfile, GameNotice, LiveRoom, Result, Seat, Session, SessionMode } from '../../shared/game.ts';

export type GameMember = { slot: Seat; generation: string | null; driver: DriverProfile };
export type GameState = { host: Seat; mode: SessionMode; session: Session | null; track?: TrackId; lobbyChanges?: number; lastFinish?: Partial<Record<Seat, number>> };

const blankResult = (member: GameMember): Result => ({
  slot: member.slot, name: member.driver.name, vehicle: member.driver.vehicle, laps: 0,
  best: null, last: null, bestLap: null, sectors: [null, null, null],
});

export function viewGame(game: GameState, members: GameMember[]): LiveRoom {
  return {
    type: 'game', host:game.host, mode:game.mode, track:trackIdentities[game.track??defaultTrack], session:game.session,
    players: members.map(member => ({ slot: member.slot, connected: member.generation !== null, ...member.driver })),
  };
}

export function restoreGameCourse(game: GameState, members: GameMember[]) {
  const selected = game.track ?? defaultTrack;
  const known = isTrackId(selected);
  const active = game.session?.track;
  if (known && (!game.session || (active?.id === selected && active.revision === trackIdentities[selected].revision))) return false;
  game.track = known ? selected : defaultTrack;
  game.session = null;
  delete game.lastFinish;
  for (const member of members) member.driver.ready = false;
  return true;
}

export function losePlayer(game: GameState, members: GameMember[], now: number) {
  if (!members.some(member => member.slot === game.host) && members[0]) game.host = members[0].slot;
  if (game.session && now < game.session.starts && members.filter(member => member.generation).length < 2) {
    game.session = null;
    for (const member of members) member.driver.ready = false;
  }
}

type Change = { persist?: boolean; alarm?: boolean; notice?: GameNotice; error?: string };

export function updateGame(game: GameState, members: GameMember[], sender: GameMember, msg: Record<string, unknown>,
  now: number, roomEnds: number, gameTest: boolean): Change {
  const session = game.session;
  const track = trackIdentities[game.track??defaultTrack];
  const host = sender.slot === game.host;
  const locked = { error: 'Return to the lobby to change session settings.' };
  if (['profile','mode','track','ready','start','lobby'].includes(String(msg.type)) && (game.lobbyChanges ?? 0) >= 120) {
    return { error: 'This room has reached its session limit. Create another room.' };
  }
  switch (msg.type) {
    case 'profile': {
      if (session) return locked;
      if (!isCar(msg.vehicle)) return { error: 'Choose an available vehicle.' };
      const name = playerName(msg.name, sender.slot);
      if (name === sender.driver.name && msg.vehicle === sender.driver.vehicle) return {};
      sender.driver = { name, vehicle: msg.vehicle, ready: false };
      for (const player of members) player.driver.ready = false;
      return { persist: true };
    }
    case 'mode':
      if (!host || !isMode(msg.mode)) return { error: 'Only the host can choose the mode.' };
      if (session) return locked;
      if (game.mode === msg.mode) return {};
      game.mode = msg.mode;
      for (const player of members) player.driver.ready = false;
      return { persist: true };
    case 'track':
      if (!host || !isTrackId(msg.track)) return { error: 'Only the host can choose an available course.' };
      if (session) return locked;
      if (track.id === msg.track) return {};
      game.track = msg.track;
      for (const player of members) player.driver.ready = false;
      return { persist: true };
    case 'ready':
      if (session) return locked;
      if (typeof msg.ready !== 'boolean' || sender.driver.ready === msg.ready) return {};
      if (msg.ready && (msg.track !== track.id || msg.revision !== track.revision)) {
        return { error: 'The room course changed. Load its current revision before readying up.' };
      }
      sender.driver.ready = msg.ready;
      return { persist: true };
    case 'start': {
      if (!host) return { error: 'Only the host can start the session.' };
      if (session) return { error: 'A session is already open.' };
      if (members.length !== 2 || members.some(member => !member.generation || !member.driver.ready)) {
        return { error: 'Both drivers must be connected and ready.' };
      }
      const starts = now + (gameTest ? 2_000 : countdownMs);
      const ends = game.mode === 'challenge' ? starts + (gameTest ? 38_000 : challengeMs) : null;
      if ((ends ?? starts) + finishGraceMs >= roomEnds) return { error: 'This room expires soon. Create a new room.' };
      game.lastFinish = {};
      game.session = { id: crypto.randomUUID(), starts, ends, track, results: members.map(blankResult) };
      for (const member of members) member.driver.ready = false;
      return { persist: true, alarm: ends !== null };
    }
    case 'lobby':
      if (!session) return {};
      if (!host && (session.ends === null || now < session.ends + finishGraceMs)) {
        return { error: 'The host can end an active session.' };
      }
      game.session = null;
      for (const player of members) player.driver.ready = false;
      return { persist: true, alarm: true };
    case 'timing': {
      const progress = progressFrom(msg.progress);
      if (!session || msg.session !== session.id || now < session.starts ||
          (session.ends !== null && now >= session.ends) || !progress) return {};
      return { notice: { type: 'timing', slot: sender.slot, session: session.id, progress } };
    }
    case 'lap':
    case 'stage': {
      if (!session || msg.session !== session.id || msg.revision !== track.revision ||
          msg.type !== attemptName(track) || now < session.starts ||
          (session.ends !== null && now > session.ends + finishGraceMs)) return {};
      if (!validSplits(msg.splits) || typeof msg.completedAt !== 'number' || !Number.isSafeInteger(msg.completedAt) ||
          msg.completedAt < session.starts || msg.completedAt > now + 750 ||
          (session.ends !== null && msg.completedAt > session.ends)) return {};
      const result = session.results.find(row => row.slot === sender.slot);
      const duration = msg.splits.reduce((a, b) => a + b, 0);
      const previous = game.lastFinish?.[sender.slot] ?? session.starts;
      if (!result || msg.number !== result.laps + 1 || duration < 25_000 || duration > msg.completedAt - previous + 1_000) return {};
      (game.lastFinish ??= {})[sender.slot] = msg.completedAt;
      result.laps++;
      result.last = duration;
      if (result.best === null || duration < result.best) {
        result.best = duration;
        result.bestLap = msg.splits;
      }
      result.sectors = msg.splits.map((split, i) => Math.min(split, result.sectors[i] ?? Infinity)) as Result['sectors'];
      return { persist: true };
    }
    default:
      return { error: 'This client sent an unsupported session command. Reload the game.' };
  }
}
