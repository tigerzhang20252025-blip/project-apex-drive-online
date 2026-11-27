import * as T from 'three';
import type { DustRates, LivePose } from '../shared/game.ts';
import type { Relay } from '../shared/protocol.ts';

const sendPeriodMs = 1000 / 15;
const minDelayMs = 150;
const maxDelayMs = 450;
const extrapolateMs = 160;
const staleMs = 1200;
const hardSnapDistance = 20;
const identityQuat = new T.Quaternion();

type Sample = {
  time: number;
  arrivalNow: number;
  packet: Relay;
  live: LivePose;
  position: T.Vector3;
  velocity: T.Vector3;
  orientation: T.Quaternion;
};

export class RemoteMotion {
  private frames: Sample[] = [];
  private previous?: Sample;
  private source?: Relay;
  private transitMs = 50;
  private jitterMs = 10;
  private currentDelayMs = minDelayMs;
  private playoutTime?: number;
  private hasRendered = false;
  private rawPos = new T.Vector3();
  private rawVel = new T.Vector3();
  private rawRot = new T.Quaternion();
  private lastTargetPos = new T.Vector3();
  private lastTargetVel = new T.Vector3();
  private posOffset = new T.Vector3();
  private rotOffset = new T.Quaternion();
  private tmpA = new T.Vector3();
  private tmpB = new T.Vector3();

  readonly position = new T.Vector3();
  readonly rotation = new T.Quaternion();
  readonly steering: [number, number] = [0, 0];
  readonly wheels: [number, number, number, number] = [0, 0, 0, 0];
  readonly suspension: [number, number, number, number] = [0, 0, 0, 0];
  flags = 0;
  dust?: DustRates;
  visible = false;

  get velocity() { return this.rawVel; }
  get received() { return this.source?.seq ?? 0; }
  get buffered() { return this.frames.length; }
  get progress() { return this.source?.live?.progress ?? 0; }
  get delayMs() { return this.currentDelayMs; }
  get jitter() { return this.jitterMs; }

  receive(packet: Relay, receiverServerNow?: number) {
    if (!packet.live) return;
    const last = this.previous;
    if (last?.packet.generation === packet.generation && packet.seq <= last.packet.seq) return;
    const resetOrGenChange = Boolean(
      last && (last.live.reset !== packet.live.reset || last.packet.generation !== packet.generation ||
        packet.receivedAt - last.packet.receivedAt > staleMs),
    );
    if (resetOrGenChange) this.resetBuffer(last!.packet.generation !== packet.generation);

    const position = new T.Vector3(...packet.position);
    if (this.previous && position.distanceToSquared(this.previous.position) > 60 ** 2) {
      this.resetBuffer(false);
    }
    const time = Math.min(packet.receivedAt + 15, Math.max(packet.receivedAt - 1_000, packet.t));
    const sampleTime = Math.max((this.previous?.time ?? -Infinity) + 1, time);
    const arrivalNow = receiverServerNow ?? packet.receivedAt;
    const observedTransit = T.MathUtils.clamp(arrivalNow - sampleTime, 0, 400);

    if (this.previous) {
      const sendDelta = sampleTime - this.previous.time;
      const arrivalDelta = arrivalNow - this.previous.arrivalNow;
      const instantJitter = Math.min(200, Math.abs(arrivalDelta - sendDelta));
      this.jitterMs += (instantJitter - this.jitterMs) * (instantJitter > this.jitterMs ? .28 : .08);
      this.transitMs += (observedTransit - this.transitMs) * (observedTransit > this.transitMs ? .30 : .08);
    } else {
      this.transitMs = observedTransit;
      const seeded = T.MathUtils.clamp(
        this.transitMs + sendPeriodMs * 2.1 + this.jitterMs * 2.5,
        minDelayMs,
        maxDelayMs,
      );
      this.currentDelayMs = Math.max(this.currentDelayMs, seeded);
    }

    const sample: Sample = {
      time: sampleTime,
      arrivalNow,
      packet,
      live: packet.live,
      position,
      velocity: new T.Vector3(...packet.velocity),
      orientation: new T.Quaternion(...packet.orientation).normalize(),
    };
    this.previous = sample;
    this.source = packet;
    this.frames.push(sample);
    if (this.frames.length > 48) this.frames.shift();
  }

  step(serverNow: number, dt: number): boolean {
    const stepDt = T.MathUtils.clamp(dt, 0, .1);
    const last = this.frames.at(-1);
    if (!last || this.frames.length < 2 || serverNow - last.arrivalNow > staleMs) {
      this.visible = false;
      this.hasRendered = false;
      this.dust = undefined;
      return false;
    }

    const desiredDelayMs = T.MathUtils.clamp(
      this.transitMs + sendPeriodMs * 2.1 + this.jitterMs * 2.5,
      minDelayMs,
      maxDelayMs,
    );
    const delayRate = desiredDelayMs > this.currentDelayMs ? 2.8 : .45;
    this.currentDelayMs += (desiredDelayMs - this.currentDelayMs) * (1 - Math.exp(-delayRate * stepDt));
    const desiredPlayout = serverNow - this.currentDelayMs;

    if (this.playoutTime === undefined || !this.hasRendered) {
      this.playoutTime = T.MathUtils.clamp(desiredPlayout, this.frames[0].time, last.time);
    } else {
      const drift = desiredPlayout - this.playoutTime;
      if (Math.abs(drift) > 350) {
        this.playoutTime = desiredPlayout;
      } else {
        const rate = T.MathUtils.clamp(1 + drift * .0025, .90, 1.10);
        this.playoutTime += stepDt * 1000 * rate;
      }
    }

    while (this.frames.length > 2 && this.frames[1].time <= this.playoutTime) this.frames.shift();
    const a = this.frames[0], b = this.frames[1];
    const spanMs = Math.max(1, b.time - a.time);
    const spanSec = spanMs / 1000;
    const u = T.MathUtils.clamp((this.playoutTime - a.time) / spanMs, 0, 1);

    const chordLen = this.tmpA.subVectors(b.position, a.position).length();
    const avgSpeed = (a.velocity.length() + b.velocity.length()) * .5;
    const useHermite = spanSec >= .005 && spanSec <= .35 &&
      (chordLen < .05 || avgSpeed * spanSec <= Math.max(2, chordLen * 2.5));

    if (useHermite) {
      const u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      this.rawPos.set(
        h00 * a.position.x + h10 * a.velocity.x * spanSec + h01 * b.position.x + h11 * b.velocity.x * spanSec,
        h00 * a.position.y + h10 * a.velocity.y * spanSec + h01 * b.position.y + h11 * b.velocity.y * spanSec,
        h00 * a.position.z + h10 * a.velocity.z * spanSec + h01 * b.position.z + h11 * b.velocity.z * spanSec,
      );
      const d00 = 6 * u2 - 6 * u;
      const d10 = 3 * u2 - 4 * u + 1;
      const d01 = -6 * u2 + 6 * u;
      const d11 = 3 * u2 - 2 * u;
      this.rawVel.set(
        (d00 * a.position.x + d01 * b.position.x) / spanSec + d10 * a.velocity.x + d11 * b.velocity.x,
        (d00 * a.position.y + d01 * b.position.y) / spanSec + d10 * a.velocity.y + d11 * b.velocity.y,
        (d00 * a.position.z + d01 * b.position.z) / spanSec + d10 * a.velocity.z + d11 * b.velocity.z,
      );
    } else {
      this.rawPos.lerpVectors(a.position, b.position, u);
      this.rawVel.lerpVectors(a.velocity, b.velocity, u);
    }
    this.rawRot.slerpQuaternions(a.orientation, b.orientation, u);

    let extrapSec = 0;
    if (this.playoutTime > b.time) {
      const rawExtrap = Math.min(this.playoutTime - b.time, extrapolateMs) / 1000;
      const fraction = rawExtrap / (extrapolateMs / 1000);
      extrapSec = rawExtrap * (1 - .3 * fraction);
      this.tmpB.copy(b.velocity).multiplyScalar(extrapSec).clampLength(0, 8);
      this.rawPos.add(this.tmpB);
      this.rawVel.copy(b.velocity).multiplyScalar(1 - .6 * fraction);
    }

    if (!this.hasRendered) {
      this.posOffset.set(0, 0, 0);
      this.rotOffset.identity();
      this.position.copy(this.rawPos);
      this.rotation.copy(this.rawRot);
      this.hasRendered = true;
    } else {
      const jumpDist = this.tmpA.copy(this.lastTargetPos).addScaledVector(this.lastTargetVel, stepDt).distanceTo(this.rawPos);
      if (jumpDist > hardSnapDistance) {
        this.posOffset.set(0, 0, 0);
        this.rotOffset.identity();
      } else if (jumpDist > .08) {
        this.posOffset.copy(this.position).addScaledVector(this.lastTargetVel, stepDt).sub(this.rawPos).clampLength(0, 8);
        this.rotOffset.copy(this.rawRot).invert().premultiply(this.rotation);
      }
      this.posOffset.multiplyScalar(Math.exp(-9 * stepDt));
      if (this.posOffset.lengthSq() < 1e-6) this.posOffset.set(0, 0, 0);
      this.rotOffset.slerp(identityQuat, 1 - Math.exp(-11 * stepDt));
      this.position.copy(this.rawPos).add(this.posOffset);
      this.rotation.copy(this.rotOffset).multiply(this.rawRot).normalize();
    }

    this.lastTargetPos.copy(this.rawPos);
    this.lastTargetVel.copy(this.rawVel);
    this.steering[0] = T.MathUtils.lerp(a.live.steering[0], b.live.steering[0], u);
    this.steering[1] = T.MathUtils.lerp(a.live.steering[1], b.live.steering[1], u);
    for (let i = 0; i < 4; i++) {
      this.suspension[i] = T.MathUtils.lerp(a.live.suspension[i], b.live.suspension[i], u);
      const wheelRate = T.MathUtils.clamp((b.live.wheels[i] - a.live.wheels[i]) / spanSec, -400, 400);
      this.wheels[i] = T.MathUtils.lerp(a.live.wheels[i], b.live.wheels[i], u) + wheelRate * extrapSec;
    }
    const live = u < .5 ? a.live : b.live;
    this.flags = live.flags;
    this.dust = this.playoutTime - b.time <= extrapolateMs ? live.dust : undefined;
    this.visible = true;
    return true;
  }

  private resetBuffer(resetNetworkEstimate: boolean) {
    this.frames.length = 0;
    this.previous = undefined;
    this.playoutTime = undefined;
    this.hasRendered = false;
    this.posOffset.set(0, 0, 0);
    this.rotOffset.identity();
    this.visible = false;
    this.dust = undefined;
    if (resetNetworkEstimate) {
      this.transitMs = 50;
      this.jitterMs = 10;
      this.currentDelayMs = minDelayMs;
    }
  }

  clear() {
    this.source = undefined;
    this.resetBuffer(true);
  }
}
