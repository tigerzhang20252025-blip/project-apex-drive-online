import type { TrackId, TrackIdentity } from './tracks.ts';
import type { Pose } from './protocol.ts';

export const gameVersion = 'apex-drive-courses-3';
export const countdownMs = 5_000;
export const challengeMs = 600_000;
export const finishGraceMs = 1_500;
export const maxPlayers = 6;
export const seats = [1, 2, 3, 4, 5, 6] as const;

export type CarId = 'f40' | 'r35';
export type SessionMode = 'drive' | 'challenge';
export type Seat = typeof seats[number];
export const seatColors: Record<Seat, string> = {
  1: '#5fd4f4',
  2: '#73d7e9',
  3: '#9be564',
  4: '#ffd166',
  5: '#c792ea',
  6: '#ff7eb6',
};
export const isSeat = (value: unknown): value is Seat =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxPlayers;
export type Splits = [number, number, number];
export type PartialSplits = [number | null, number | null, number | null];
export type DriverProfile = { name: string; vehicle: CarId; ready: boolean };
export type Player = DriverProfile & { slot: Seat; connected: boolean };
export type Result = {
  slot: Seat; name: string; vehicle: CarId; laps: number;
  best: number | null; last: number | null; bestLap: Splits | null; sectors: PartialSplits;
};
export type Session = { id: string; starts: number; ends: number | null; track: TrackIdentity; results: Result[] };
export type LiveRoom = { type: 'game'; host: Seat; mode: SessionMode; track: TrackIdentity; players: Player[]; session: Session | null };
export type Progress = { sector: 0 | 1 | 2; ms: number | null; splits: PartialSplits; invalid: boolean; complete?: boolean };
export type DustRates = [number, number, number, number];
export const maxDustRate = 80;

export type LivePose = {
  session: string; reset: number; steering: [number, number]; wheels: [number, number, number, number];
  suspension: [number, number, number, number]; flags: number; progress: number;
  dust?: DustRates;
};
export type GameNotice =
  | LiveRoom
  | { type: 'timing'; session: string; slot: Seat; progress: Progress }
  | { type: 'game_error'; message: string };
export type GameCommand =
  | { type: 'profile'; name: string; vehicle: CarId }
  | { type: 'mode'; mode: SessionMode }
  | { type: 'track'; track: TrackId }
  | { type: 'ready'; ready: boolean; track: TrackId; revision: string }
  | { type: 'start' | 'lobby' }
  | { type: 'timing'; session: string; progress: Progress }
  | CompletionCommand;

export type CompletionCommand = {
  type: 'lap'|'stage'; session: string; revision: string; number: number; completedAt: number; splits: Splits;
};

export type VehicleSample = Omit<Pose, 'seq' | 't' | 'rate'> & Omit<LivePose, 'session'>;
export const lightFlags = { brake: 1, lights: 2, auxiliary: 4, reverse: 8, left: 16, right: 32 } as const;

export const isCar = (value: unknown): value is CarId => value === 'f40' || value === 'r35';
export const isMode = (value: unknown): value is SessionMode => value === 'drive' || value === 'challenge';

export function playerName(value: unknown, slot: Seat) {
  return (typeof value === 'string' ? value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, 20) : '') || 'Driver ' + slot;
}

const bounded = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

const tuple = (value: unknown, length: number, min: number, max: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(item => bounded(item, min, max));

export const validSplits = (value: unknown): value is Splits =>
  tuple(value, 3, 1, 3_600_000) && value.every(Number.isSafeInteger);

export function progressFrom(value: unknown): Progress | undefined {
  if (!value || typeof value !== 'object') return;
  const { sector, ms, splits, invalid, complete } = value as Partial<Progress>;
  if ((sector !== 0 && sector !== 1 && sector !== 2) || typeof invalid !== 'boolean' ||
      (complete !== undefined && typeof complete !== 'boolean') ||
      (ms !== null && !bounded(ms, 0, 3_600_000)) || !Array.isArray(splits) ||
      splits.length !== 3 || !splits.every(item => item === null || bounded(item, 0, 3_600_000))) return;
  return { sector, ms, splits: [...splits], invalid, complete };
}

export function livePoseFrom(value: unknown, session: string): LivePose | undefined {
  if (!value || typeof value !== 'object') return;
  const p = value as Partial<LivePose>;
  if (p.session !== session || !bounded(p.reset, 0, 1_000_000) || !Number.isSafeInteger(p.reset) ||
      !tuple(p.steering, 2, -1.5, 1.5) || !tuple(p.wheels, 4, -2_000_000, 2_000_000) ||
      !tuple(p.suspension, 4, 0, 2) || !bounded(p.flags, 0, 63) || !Number.isSafeInteger(p.flags) ||
      !bounded(p.progress, 0, 1)) return;
  const dust = p.dust;
  if (dust !== undefined && (!tuple(dust, 4, 0, maxDustRate) || !dust.every(Number.isInteger))) return;
  return { session, reset: p.reset, steering: p.steering!, wheels: p.wheels!, suspension: p.suspension!,
    flags: p.flags, progress: p.progress, ...(dust === undefined ? {} : { dust }) };
}
