import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as T from 'three';
import { RemoteMotion } from '../src/remote-motion.ts';

function makePacket(seq, t, arrivalDelayMs, pos, vel, yaw = 0, reset = 0) {
  const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw);
  return {
    type: 'snapshot',
    slot: 2,
    generation: '11111111-1111-4111-8111-111111111111',
    seq,
    t,
    rate: 15,
    receivedAt: Math.round(t + arrivalDelayMs * .5),
    position: pos,
    orientation: [q.x, q.y, q.z, q.w],
    velocity: vel,
    live: {
      session: 'sess-1',
      reset,
      steering: [0, 0],
      wheels: [seq * 4, seq * 4, seq * 4, seq * 4],
      suspension: [.18, .18, .18, .18],
      flags: 0,
      progress: .1,
    },
  };
}

test('RemoteMotion adapts buffer to 160 ms cross-network transit and eliminates single-frame teleports under jitter', () => {
  const motion = new RemoteMotion();
  const speed = 50; // 180 km/h along -Z
  const sendPeriod = 1000 / 15;
  const baseTransit = 160; // ~160 ms one-way peer-to-peer transit
  // Deterministic jitter pattern including a 130 ms TCP stall and burst catch-up
  const jitterFor = seq => (seq === 28 ? 130 : seq === 29 ? 85 : ((seq * 17) % 29) - 10);

  const schedule = [];
  for (let seq = 1; seq <= 60; seq++) {
    const sendTime = 10_000 + seq * sendPeriod;
    const transit = Math.max(90, baseTransit + jitterFor(seq));
    const arrival = sendTime + transit;
    const z = -speed * (seq * sendPeriod / 1000);
    schedule.push({ arrival, packet: makePacket(seq, Math.round(sendTime), transit, [0, .35, z], [0, 0, -speed]) });
  }
  schedule.sort((a, b) => a.arrival - b.arrival);

  let nextIdx = 0;
  let prevZ = null;
  let maxStepDeviation = 0;
  let backwardSteps = 0;
  let visibleFrames = 0;
  const dt = 1 / 60;

  for (let frame = 0; frame < 260; frame++) {
    const now = 10_150 + frame * (dt * 1000);
    while (nextIdx < schedule.length && schedule[nextIdx].arrival <= now) {
      motion.receive(schedule[nextIdx].packet, schedule[nextIdx].arrival);
      nextIdx++;
    }
    if (motion.step(now, dt)) {
      visibleFrames++;
      if (prevZ !== null) {
        const dz = prevZ - motion.position.z; // positive when moving forward along -Z
        if (dz < 0) backwardSteps++;
        const expectedDz = speed * dt;
        maxStepDeviation = Math.max(maxStepDeviation, Math.abs(dz - expectedDz));
      }
      prevZ = motion.position.z;
    }
  }

  assert.ok(visibleFrames > 180, `visibleFrames=${visibleFrames}`);
  assert.equal(backwardSteps, 0, 'remote car should never snap backward');
  assert.ok(motion.delayMs >= 250 && motion.delayMs <= 450, `adaptive delay=${motion.delayMs.toFixed(1)} ms`);
  // At 50 m/s, 60 Hz frame step is 0.833 m; max single-frame deviation should stay tiny (no multi-meter teleport)
  assert.ok(maxStepDeviation < .35, `maxStepDeviation=${maxStepDeviation.toFixed(3)} m`);
});

test('RemoteMotion follows curved path accurately with Cubic Hermite interpolation', () => {
  const motion = new RemoteMotion();
  const radius = 80;
  const omega = 0.4; // rad/s (~32 m/s)
  const sendPeriod = 1000 / 15;
  for (let seq = 1; seq <= 25; seq++) {
    const tSec = seq * sendPeriod / 1000;
    const angle = omega * tSec;
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    const vx = Math.cos(angle) * radius * omega;
    const vz = -Math.sin(angle) * radius * omega;
    const sendTime = 5000 + seq * sendPeriod;
    motion.receive(makePacket(seq, Math.round(sendTime), 40, [x, .35, z], [vx, 0, vz], angle), sendTime + 40);
  }
  let maxRadialError = 0;
  const dt = 1 / 60;
  for (let frame = 0; frame < 60; frame++) {
    const now = 5400 + frame * (dt * 1000);
    if (motion.step(now, dt)) {
      const r = Math.hypot(motion.position.x, motion.position.z);
      maxRadialError = Math.max(maxRadialError, Math.abs(r - radius));
    }
  }
  // Linear interpolation on an 80 m curve at 32 m/s @ 15 Hz has ~0.007 m sagitta; Hermite should be sub-millimeter
  assert.ok(maxRadialError < .002, `maxRadialError=${maxRadialError.toFixed(5)} m`);
});

test('RemoteMotion snaps immediately on genuine car reset without smearing across the track', () => {
  const motion = new RemoteMotion();
  const sendPeriod = 1000 / 15;
  for (let seq = 1; seq <= 5; seq++) {
    const t = 1000 + seq * sendPeriod;
    motion.receive(makePacket(seq, Math.round(t), 20, [0, .35, -100 - seq * 2], [0, 0, -30], 0, 0), t + 20);
  }
  assert.equal(motion.step(1400, 1 / 60), true);
  assert.ok(motion.position.z < -95);
  // Car resets back to grid at z = 0 with reset = 1
  for (let seq = 6; seq <= 8; seq++) {
    const t = 1000 + seq * sendPeriod;
    motion.receive(makePacket(seq, Math.round(t), 20, [0, .35, 0], [0, 0, 0], 0, 1), t + 20);
  }
  assert.equal(motion.step(1750, 1 / 60), true);
  assert.ok(Math.abs(motion.position.z) < .05, `expected snap to grid z=0, got ${motion.position.z}`);
});
