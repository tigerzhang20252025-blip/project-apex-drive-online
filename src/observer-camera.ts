import { Euler, MathUtils, Vector3, type PerspectiveCamera } from 'three';
import type { TrackDefinition } from './tracks.ts';

const { clamp, euclideanModulo, lerp } = MathUtils;
const pitchLimit = Math.PI / 2 - .001;
const movementKeys = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
]);

export class ObserverCamera {
  private readonly keys = new Set<string>();
  private readonly angles = new Euler(0, 0, 0, 'YXZ');
  private readonly velocity = new Vector3();
  private readonly desired = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private gateIndex: number | undefined;
  baseSpeed = 32;

  private readonly camera: PerspectiveCamera;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
  }

  get speed() { return this.velocity.length(); }

  begin() {
    this.clearInput();
    this.gateIndex = undefined;
    this.angles.setFromQuaternion(this.camera.quaternion);
  }

  keydown(code: string) {
    if (movementKeys.has(code)) this.keys.add(code);
  }

  keyup(code: string) {
    this.keys.delete(code);
  }

  clearInput() {
    this.keys.clear();
    this.velocity.set(0, 0, 0);
  }

  look(dx: number, dy: number, sensitivity: number) {
    const factor = .0028 * sensitivity;
    this.angles.y = euclideanModulo(this.angles.y - dx * factor + Math.PI, Math.PI * 2) - Math.PI;
    this.angles.x = clamp(this.angles.x - dy * factor, -pitchLimit, pitchLimit);
    this.camera.quaternion.setFromEuler(this.angles);
  }

  adjustSpeed(deltaY: number, deltaMode: number) {
    const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 160 : 1);
    this.baseSpeed = clamp(this.baseSpeed * Math.exp(clamp(-pixels * .002, -.65, .65)), .5, 160);
  }

  step(dt: number) {
    const axis = (positive: string, negative: string) => Number(this.keys.has(positive)) - Number(this.keys.has(negative));
    const slow = this.keys.has('ControlLeft') || this.keys.has('ControlRight');
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(Math.cos(this.angles.y), 0, -Math.sin(this.angles.y));
    this.desired.copy(this.forward).multiplyScalar(axis('KeyW', 'KeyS'))
      .addScaledVector(this.right, axis('KeyD', 'KeyA'));
    this.desired.y += axis('KeyE', 'KeyQ');
    // Cap diagonal movement while allowing a pitch-aligned W and E to combine.
    if (this.desired.lengthSq() > 1) this.desired.normalize();
    this.desired.multiplyScalar(this.baseSpeed * (slow ? .2 : fast ? 4 : 1));

    // Integrate the exponential velocity response over the elapsed frame.
    const response = 1 - Math.exp(-15 * dt);
    this.camera.position.addScaledVector(this.desired, dt - response / 15)
      .addScaledVector(this.velocity, response / 15);
    this.velocity.lerp(this.desired, response);
    if (this.velocity.lengthSq() > .0001) this.gateIndex = undefined;
  }

  jump(track: TrackDefinition, direction: -1 | 1) {
    const { gates } = track;
    if (this.gateIndex === undefined) {
      const { station } = inspectObserverRoad(track, this.camera.position);
      const next = gates.findIndex(gate => gate.distance > station + 2);
      const previous = gates.findLastIndex(gate => gate.distance < station - 2);
      const index = direction > 0 ? next : previous;
      this.gateIndex = index >= 0 ? index : direction > 0 ? gates.length - 1 : 0;
    } else {
      this.gateIndex = clamp(this.gateIndex + direction, 0, gates.length - 1);
    }
    const gate = gates[this.gateIndex];
    this.clearInput();
    this.camera.position.copy(gate.p).addScaledVector(gate.forward, -8).addScaledVector(gate.right, 3);
    this.camera.position.y += 6;
    this.camera.lookAt(gate.p.clone().addScaledVector(gate.forward, 12));
    this.angles.setFromQuaternion(this.camera.quaternion);
    return this.gateIndex;
  }
}

export function inspectObserverRoad(track: TrackDefinition, eye: Vector3) {
  const points = track.minimap;
  // A horizontal segment projection yields approximate chainage. Ranking those
  // projections in 3D distinguishes nearby shelves at different elevations.
  let nearestPlan = Infinity;
  let best = { station: 0, planar: Infinity, distance: Infinity };
  const candidates: (typeof best)[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.p.x - a.p.x, dz = b.p.z - a.p.z;
    const t = clamp(((eye.x - a.p.x) * dx + (eye.z - a.p.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    const planar = Math.hypot(a.p.x + t * dx - eye.x, a.p.z + t * dz - eye.z);
    const dy = b.p.y - a.p.y;
    const t3d = clamp(((eye.x - a.p.x) * dx + (eye.y - a.p.y) * dy + (eye.z - a.p.z) * dz) /
      (dx * dx + dy * dy + dz * dz || 1), 0, 1);
    const candidate = {
      station: lerp(a.distance, b.distance, t),
      planar,
      distance: Math.hypot(a.p.x + t3d * dx - eye.x, a.p.y + t3d * dy - eye.y, a.p.z + t3d * dz - eye.z),
    };
    candidates.push(candidate);
    if (candidate.distance < best.distance) best = candidate;
    nearestPlan = Math.min(nearestPlan, planar);
  }

  const ambiguous = candidates.some((p, index) => p.planar <= Math.min(55, nearestPlan + 15) &&
    p.planar <= (candidates[index - 1]?.planar ?? Infinity) &&
    p.planar <= (candidates[index + 1]?.planar ?? Infinity) &&
    Math.abs(p.station - best.station) > 35);
  const sample = track.sampleAt(best.station);
  const grade = 100 * sample.forward.y / Math.hypot(sample.forward.x, sample.forward.z);
  return {
    station: best.station,
    distance: best.station - track.startDistance,
    sample,
    grade,
    ambiguous,
    overhead: best.planar <= sample.halfWidth + 4 && eye.y < sample.p.y - 3,
  };
}
