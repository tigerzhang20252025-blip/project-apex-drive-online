import { MathUtils, Vector3 } from 'three';
import type { TrackDefinition } from './tracks.ts';
import type { DriverInput, Vehicle } from './vehicle.ts';

type VehicleSample = Pick<Vehicle, 'current' | 'contacts' | 'direction' | 'speed' | 'running' | 'parkingBrake'>;
type RecoveryReason = 'Below the road' | 'Far from the road' | 'Vehicle overturned' | 'Vehicle stuck' | 'Stranded below the verge';

const grace: Record<RecoveryReason,number> = {
  'Below the road': .75,
  'Far from the road': 1.7,
  'Vehicle overturned': 1.3,
  'Vehicle stuck': 3.4,
  'Stranded below the verge': 2.8,
};
const countdown = 1.1;

export class StageRecovery {
  private readonly up = new Vector3();
  private readonly gridStation: number;
  private anchor: number;
  private trusted: number;
  private supported = 0;
  private checkedGates = 0;
  private reason?: RecoveryReason;
  private duration = 0;
  private cooldown = 0;
  private feedback = 0;
  hasRecovered = false;

  private readonly track: TrackDefinition;
  constructor(track: TrackDefinition) {
    this.track = track;
    const {x,z} = track.grid[0].position;
    this.gridStation = track.project(x,z).station;
    this.anchor = this.trusted = this.gridStation;
  }

  get pending() {
    if (!this.reason || this.duration < grace[this.reason]) return undefined;
    return {reason:this.reason, seconds:Math.max(0,countdown+grace[this.reason]-this.duration)};
  }
  get ready() { return this.cooldown <= 0; }
  get recentlyRecovered() { return this.feedback > 0; }

  reset() {
    this.anchor = this.trusted = this.gridStation;
    this.checkedGates = 0;
    this.supported = this.duration = this.cooldown = this.feedback = 0;
    this.reason = undefined;
    this.hasRecovered = false;
  }

  step(car: VehicleSample, input: DriverInput, passedGates: number, dt: number) {
    this.cooldown -= dt;
    this.feedback -= dt;

    const {position,rotation} = car.current;
    const {station,lateral,distance} = this.track.project(position.x,position.z);
    const road = this.track.sampleAt(station);
    const relativeHeight = position.y-road.p.y-lateral*road.right.y;
    const upright = this.up.set(0,1,0).applyQuaternion(rotation).y;
    // Only an ordered gate crossing can reseed the anchor after an interrupted line.
    const lastGate = this.track.gates[passedGates-1]?.distance ?? this.gridStation;
    if (passedGates !== this.checkedGates) {
      this.checkedGates = passedGates;
      this.anchor = this.trusted = lastGate;
      this.supported = 0;
    }
    const nextGate = this.track.gates[passedGates]?.distance ?? this.track.finishDistance;
    const continuous = distance <= road.halfWidth+7.5 && Math.abs(relativeHeight)<2.4 &&
      Math.abs(station-this.trusted) <= Math.max(1.7,car.speed*dt+1);
    if (continuous) this.trusted = station;
    const supported = continuous && distance < road.halfWidth-.85 && relativeHeight >= .12 && relativeHeight < 1.15 &&
      upright > .83 && car.contacts >= 3 && car.direction.dot(road.forward) > .40;
    this.supported = supported ? this.supported+dt : 0;
    if (this.supported >= .32) this.anchor = MathUtils.clamp(station,lastGate,nextGate);

    const trying = car.running && !car.parkingBrake && !input.handbrake && input.brake < .3 && input.throttle > .25;
    const below = relativeHeight < -11 || (relativeHeight < -7 && distance > road.halfWidth+3);
    const stuck = trying && car.speed < 1.2 && (distance > road.halfWidth-1 || car.contacts < 3);
    const stranded = relativeHeight < -4.2 && distance > road.halfWidth+6 &&
      car.speed < 2.4 && car.contacts >= 2;
    const reason = below ? 'Below the road' : distance > 56 ? 'Far from the road' :
      upright < .40 && car.speed < 9 ? 'Vehicle overturned' : stranded ? 'Stranded below the verge' : stuck ? 'Vehicle stuck' : undefined;
    if (!this.ready || reason !== this.reason) this.duration = 0;
    this.reason = reason;
    if (this.ready && reason) this.duration += dt;
    return this.pending?.seconds === 0;
  }

  // Grid fallback keeps the player's existing seat offset. Thereafter a
  // centreline spawn sits behind the last verified foothold or at a passed gate.
  recover(passedGates: number) {
    const lastGate = this.track.gates[passedGates-1]?.distance ?? this.gridStation;
    const safe = Math.max(lastGate,this.anchor-6);
    const station = Math.min(safe,Math.max(this.gridStation,this.trusted));
    this.anchor = this.trusted = station;
    this.checkedGates = passedGates;
    this.supported = this.duration = 0;
    this.feedback = 3.3;
    this.hasRecovered = true;
    this.cooldown = 1.45;
    this.reason = undefined;
    return station > this.gridStation+.25 ? station : null;
  }
}
