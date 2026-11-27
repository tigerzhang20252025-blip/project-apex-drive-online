import type { GameNotice, LivePose } from './game.ts';

export const protocol = 'apex-poc.v1';
export const rates = [10, 15, 20] as const;
export type Rate = typeof rates[number];
export const roomCodePattern = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
export const tokenPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
export const objectIdPattern = /^[a-f\d]{64}$/;
export const maxFrameSize = 1024;

export type Vector = [number, number, number];
export type Quaternion = [number, number, number, number];
export type Ack = { generation: string; seq: number };
export type Pose = {
  seq: number;
  t: number;
  rate: Rate;
  position: Vector;
  orientation: Quaternion;
  velocity: Vector;
};
export type Relay = Pose & Ack & { type: 'snapshot'; slot: number; receivedAt: number; live?: LivePose };
export type Grant = { code: string; roomId: string; resume: string; ticket: string; expires: number };
export type Presence = { type: 'presence'; online: number; seats: number };
export type ServerMessage = Relay | Presence | GameNotice |
  { type: 'welcome'; slot: number; generation: string; expires: number } |
  { type: 'pong'; n: number; time: number };

export function isRate(value: unknown): value is Rate {
  return value === 10 || value === 15 || value === 20;
}

export function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function jsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
}

export function ackFrom(value: unknown): Ack | undefined {
  if (!value || typeof value !== 'object') return;
  const { generation, seq } = value as Partial<Ack>;
  if (typeof generation === 'string' && tokenPattern.test(generation) && isSequence(seq)) {
    return { generation, seq };
  }
}

function finiteTuple(value: unknown, count: number, bound: number): value is number[] {
  return Array.isArray(value) && value.length === count &&
    value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= bound);
}

export function poseFrom(message: Record<string, unknown>): Pose | undefined {
  const { seq, t, rate, position, orientation, velocity } = message;
  if (!isSequence(seq) || typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0 ||
      !isRate(rate) || !finiteTuple(position, 3, 100000) || !finiteTuple(velocity, 3, 1000) ||
      !finiteTuple(orientation, 4, 1.001)) return;
  if (Math.abs(Math.hypot(...orientation) - 1) > 0.01) return;
  return { seq, t, rate, position: position as Vector, orientation: orientation as Quaternion, velocity: velocity as Vector };
}
