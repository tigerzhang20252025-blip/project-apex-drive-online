import {rallyModes,surfaceFor,surfaces,wheelTelemetry} from './rally-dynamics.ts';
import {WiperMotor} from './wiper.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { grid, gridRotation } from './track.ts';
import type { TrackSpawn } from './tracks.ts';

import { sport, interpolate, drivingAssists, type AssistMode, type VehicleSpec } from './vehicle-spec.ts';
export { sport } from './vehicle-spec.ts';
export const stepTime = 1 / 120;
export type DriverInput = { throttle: number; brake: number; steer: number; handbrake: boolean };
export const noInput: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
export type VehiclePose = { position: Vector3; rotation: Quaternion };

const ramp = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));

export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly previous: VehiclePose = { position: new Vector3(), rotation: new Quaternion() };
  readonly current: VehiclePose = { position: new Vector3(), rotation: new Quaternion() };
  readonly velocity = new Vector3();
  readonly direction = new Vector3();
  rpm = 0;
  gear = 0;
  automatic = true;
  running = false;
  ignition: 'OUT'|'OFF'|'ACC'|'ON'|'START' = 'OUT';
  boostBar = 0;
  oilTemp = 22;
  waterTemp = 22;
  oilPressure = 0;
  private starterTime = 0;
  get clutchEngagement() { return this.shiftTime ? 0 : Math.min(1, .25 + Math.abs(this.signedSpeed) / 7); }
  get throttleLoad(){return this.pedal;}
  get isShifting(){return this.shiftTime>0;}
  private previousManualGear=0;
  get pendingManualGear(){
    return this.spec.transmission.electronic&&this.running&&!this.automatic&&this.isShifting&&this.previousManualGear!==this.gear?this.gear:null;
  }
  get indicatedGear(){return this.pendingManualGear===null?this.gear:this.previousManualGear;}
  get shiftProgress() { return Math.max(0,1-this.shiftTime / this.spec.shiftCut); }
  readonly wiper = new WiperMotor();
  lights = false;
  turn: -1 | 0 | 1 | 2 = 0;
  blink = false;
  brakeLight = false;
  travelled = 0;
  contacts = 0;
  readonly tireTelemetry=Array.from({length:4},()=>({contact:false,surface:'asphalt' as keyof typeof surfaces,slipAngle:0,load:0,use:0}));
  private readonly tireGrip=[1,1,1,1];
  steer = 0;
  speed = 0;
  signedSpeed = 0;
  fuelLitres: number;
  parkingBrake = false;
  tractionControl = true;
  tcActive = false;
  assistMode: AssistMode = 'sport';
  frontTorqueShare = 0;
  deliveredFrontShare = 0;
  absActive = false;
  absEnabled = true;
  readonly wheelState = Array.from({length: 4}, () => ({length:0, previousLength:0, spin:0, previousSpin:0, steer:0, previousSteer:0}));
  private readonly dragImpulse = new Vector3();
  private readonly up = new Vector3();
  private readonly tireAxle = new Vector3();
  private readonly surfaceNormal = new Vector3();
  private readonly rollImpulse = new Vector3();
  private rackVelocity = 0;
  private pedal = 0;
  private brakeHold = 0;
  private shiftTime = 0;
  private time = 0;

  readonly world: RAPIER.World;
  readonly spec: VehicleSpec;
  private readonly spawn: TrackSpawn;
  constructor(world: RAPIER.World, spec: VehicleSpec = sport, spawn: TrackSpawn = { position:grid, rotation:gridRotation }) {
    this.world = world;
    this.spec = spec;
    this.spawn = spawn;
    this.fuelLitres = spec.fuel.capacityLitres;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setLinearDamping(.018).setAngularDamping(.32).setCanSleep(false).setCcdEnabled(true));
    // A tapered undertray follows the overhangs, leaving the tire contact patches clear.
    const corners: number[] = [];
    for (const [z, halfWidth, floor, top] of spec.chassisSections ?? [[-2.18,.77,-.14,.13],[-1.24,.92,-.21,.30],[1.24,.94,-.21,.36],[2.12,.86,-.12,.35]]) {
      for (const sign of [-1,1]) corners.push(sign*halfWidth,floor,z,sign*halfWidth,top,z);
    }
    world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(corners))!
      .setMassProperties(spec.mass,spec.centerOfMass,spec.inertia,{x:0,y:0,z:0,w:1})
      .setFriction(.34).setRestitution(.04), this.body);
    world.createCollider(RAPIER.ColliderDesc.roundCuboid(.65,.12,.61,.06)
      .setTranslation(0, .61, .10).setDensity(0).setFriction(.28), this.body);
    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    spec.wheels.forEach((wheel, i) => {
      this.controller.addWheel({ x: wheel.x, y: spec.mountHeight, z: wheel.z },
        { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, spec.suspensionRest, spec.radius);
      this.controller.setWheelSuspensionStiffness(i, wheel.front ? spec.suspension.front : spec.suspension.rear);
      this.controller.setWheelSuspensionCompression(i, spec.suspension.bump);
      this.controller.setWheelSuspensionRelaxation(i, spec.suspension.rebound);
      this.controller.setWheelMaxSuspensionTravel(i, spec.suspension.travel);
      this.controller.setWheelMaxSuspensionForce(i, spec.suspension.maxForce);
      this.controller.setWheelFrictionSlip(i, wheel.front ? spec.tires.frontGrip : spec.tires.rearGrip);
      this.controller.setWheelSideFrictionStiffness(i, wheel.front ? spec.tires.frontSide : spec.tires.rearSide);
    });
    this.reset(true);
  }

  operateKey(back = false) {
    if (back) {
      if (this.ignition === 'START' || this.running) {
        this.running = false; this.ignition = 'ON'; this.gear = 0; this.starterTime = 0;
      } else if (this.ignition === 'ON') this.ignition = 'ACC';
      else if (this.ignition === 'ACC') this.ignition = 'OFF';
      else if (this.ignition === 'OFF' && this.speed < .45) this.ignition = 'OUT';
    } else if (!this.running) {
      if (this.ignition === 'OUT') this.ignition = 'OFF';
      else if (this.ignition === 'OFF') this.ignition = 'ACC';
      else if (this.ignition === 'ACC') this.ignition = 'ON';
      else if (this.ignition === 'ON' && this.fuelLitres > 0) {
        this.ignition = 'START'; this.starterTime = .75;
      }
    }
  }

  setIgnition() {
    if (this.running || this.ignition === 'START') { this.operateKey(true); return; }
    while (this.ignition !== 'ON') this.operateKey();
    this.operateKey();
  }

  toggleTransmission() {
    if (this.speed > .6) return;
    this.automatic = !this.automatic;
    this.gear = this.automatic && this.running ? 1 : 0;
    this.brakeHold = 0;
    this.previousManualGear=this.gear;
  }

  setAssist(mode:AssistMode) {
    this.assistMode=mode;
    this.tractionControl=drivingAssists[mode].traction;
    this.absEnabled=drivingAssists[mode].abs;
  }

  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
  }

  shift(change: number) {
    if (this.automatic) return 'automatic';
    if (!this.running) return 'engine';
    let target = Math.max(-1, Math.min(this.spec.gears.length, this.gear + change));
    if (target === this.gear) return 'limit';
    if ((target < 0 && this.speed > .45) || (target > 0 && this.signedSpeed < -.45)) return 'direction';
    const estimatedRpm = (gear: number) =>
      Math.abs(this.signedSpeed) * 60 / (2 * Math.PI * this.spec.radius)
      * this.spec.gears[gear - 1] * this.spec.finalDrive;
    if (target > 0 && (this.gear === 0 || target < this.gear)) {
      if (!this.spec.transmission.electronic && this.gear === 0 && change > 0) {
        while (target < this.spec.gears.length && estimatedRpm(target) > this.spec.transmission.downshiftRpm) target++;
      }
      if (estimatedRpm(target) > this.spec.transmission.downshiftRpm) {
        return this.spec.transmission.electronic ? 'rpm' : 'synchro';
      }
    }
    this.previousManualGear=this.gear;
    this.requestGear(target);
    return 'accepted';
  }

  private requestGear(target: number) {
    if (this.gear === target) return;
    this.gear = target;
    this.shiftTime = target > 0 ? this.spec.shiftCut : .10;
  }

  reset(restart = false, spawn = this.spawn.position, rotation = this.spawn.rotation) {
    this.body.setTranslation({ x: spawn.x, y: spawn.y + this.spec.bodyOrigin + .035, z: spawn.z }, true);
    this.body.setRotation(rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.parkingBrake = this.tcActive = false;
    if (restart) {
      this.wiper.reset();
      this.tractionControl = true;
      this.fuelLitres = this.spec.fuel.capacityLitres;
      this.running = this.lights = false;
      this.ignition = 'OUT'; this.starterTime = this.boostBar = this.oilPressure = 0;
      this.oilTemp = this.waterTemp = 22;
      this.turn = 0;
      this.automatic = true;
      this.travelled = 0;
      this.time = 0;
    }
    this.speed = this.signedSpeed = this.pedal = this.steer = this.brakeHold = this.shiftTime = 0;
    this.frontTorqueShare=this.spec.awd?.baseFront ?? 0;
    this.deliveredFrontShare=0;
    this.absActive=false;
    this.rackVelocity = 0;
    this.tireGrip.fill(1);
    for (const w of this.wheelState) {
      w.length = w.previousLength = this.spec.suspensionRest;
      w.steer = w.previousSteer = w.spin = w.previousSpin = 0;
    }
    this.contacts = 0;
    this.blink = this.brakeLight = false;
    this.rpm = this.running ? this.spec.idle : 0;
    this.gear = this.running && this.automatic ? 1 : 0;
    this.readPose();
    this.previous.position.copy(this.current.position);
    this.previous.rotation.copy(this.current.rotation);
  }

  private readPose() {
    const p = this.body.translation(), q = this.body.rotation();
    this.current.position.set(p.x, p.y, p.z);
    this.current.rotation.set(q.x, q.y, q.z, q.w);
    const v = this.body.linvel();
    this.velocity.set(v.x, v.y, v.z);
    this.direction.set(0, 0, -1).applyQuaternion(this.current.rotation);
    this.speed = Math.hypot(v.x, v.z);
    this.signedSpeed = this.velocity.dot(this.direction);
  }

  private restoreLateralLoadTransfer() {
    // Rapier applies lateral impulse at 0.1 of the contact-to-CG height (Wheel.roll_influence).
    // Restore the missing moment only; the solver already applied the linear tire impulse.
    const {controller,spec} = this;
    this.up.set(0,1,0).applyQuaternion(this.current.rotation);
    this.rollImpulse.set(0,0,0);
    for(let i=0;i<spec.wheels.length;i++) {
      if(!controller.wheelIsInContact(i))continue;
      const impulse=controller.wheelSideImpulse(i) ?? 0;
      const normal=controller.wheelContactNormal(i,this.surfaceNormal);
      if(!normal || !impulse)continue;
      const angle=controller.wheelSteering(i) ?? 0;
      this.tireAxle.set(Math.cos(angle),0,-Math.sin(angle)).applyQuaternion(this.current.rotation);
      this.tireAxle.addScaledVector(this.surfaceNormal,-this.tireAxle.dot(this.surfaceNormal)).normalize();
      const rayLength=(controller.wheelSuspensionLength(i) ?? spec.suspensionRest)+spec.radius;
      const height=spec.centerOfMass.y - spec.mountHeight + rayLength;
      const correction=impulse*height*(spec.suspension.lateralLeverFraction-.1);
      this.rollImpulse.addScaledVector(this.tireAxle.cross(this.up),correction);
    }
    this.body.applyTorqueImpulse(this.rollImpulse,true);
  }

  update(input: DriverInput) {
    const dt = stepTime, { spec, controller } = this;
    this.previous.position.copy(this.current.position);
    this.previous.rotation.copy(this.current.rotation);
    this.time += dt;
    this.wiper.tick(dt);
    if (this.ignition === 'START') {
      this.starterTime -= dt;
      if (this.starterTime <= 0) {
        this.ignition = 'ON'; this.running = this.fuelLitres > 0;
        this.gear = this.running && this.automatic ? 1 : 0;
      }
    }
    this.oilTemp = ramp(this.oilTemp, this.running ? 87+20*this.pedal : 22, this.running?.006:.002, dt);
    this.waterTemp = ramp(this.waterTemp, this.running ? 85+7*this.pedal : 22, this.running?.012:.003, dt);
    this.oilPressure = ramp(this.oilPressure,this.running ? Math.min(7.5,1.55+this.rpm*.00095) : 0,4,dt);
    this.shiftTime = Math.max(0, this.shiftTime - dt);

    const handbrake = input.handbrake || this.parkingBrake;
    let gas = this.running ? input.throttle : 0;
    let brake = input.brake;
    if (this.running && this.automatic && gas <= .001 && brake > .01) {
      if (this.gear === -1 && this.signedSpeed < .45) {
        gas = brake;
        brake = 0;
      } else if (this.speed < .42 && !handbrake) {
        this.brakeHold += dt;
        if (this.brakeHold >= .40) this.requestGear(-1);
      } else this.brakeHold = 0;
    } else {
      this.brakeHold = 0;
      if (this.running && gas > 0 && this.gear <= 0 && this.automatic) {
        if (this.speed < .42) this.requestGear(1);
        if (this.gear <= 0) { brake = Math.max(brake, gas); gas = 0; }
      }
    }
    if (handbrake || brake > .02) gas = 0;
    if (this.gear > 0 && this.signedSpeed < -.7 && gas > 0) { brake = gas; gas = 0; }
    this.pedal = ramp(this.pedal, gas, gas > this.pedal ? spec.throttleRise : spec.throttleRelease, dt);
    const stableSpeed = Math.max(0, Math.abs(this.signedSpeed));
    const ratio = this.gear < 0 ? spec.reverse : spec.gears[this.gear - 1] ?? 0;
    const wheelRPM = stableSpeed / (2 * Math.PI * spec.radius) * 60;
    const coupledRPM = wheelRPM * ratio * spec.finalDrive;
    const clutch = ratio ? Math.min(1, stableSpeed / 6.5) : 0;
    const freeRPM = spec.idle + Math.pow(this.pedal, .67) * (spec.redline - spec.idle) * (ratio ? .27 : .92);
    const rpmCap = Math.max(spec.redline + 150, spec.transmission.downshiftRpm);
    this.rpm = this.running ? ramp(this.rpm, Math.max(spec.idle,
      Math.min(rpmCap, Math.max(coupledRPM, freeRPM * (1 - clutch)))), this.shiftTime > 0 ? 15 : 9, dt) : ramp(this.rpm,this.ignition === 'START' ? 220 : 0,10,dt);
    const potential = Math.max(0,Math.min(1,(this.rpm-1900)/2200))*spec.turbo.maxBar;
    const targetBoost = this.running && ratio && !this.shiftTime ? potential*this.pedal : 0;
    this.boostBar = ramp(this.boostBar,targetBoost,targetBoost>this.boostBar?spec.turbo.spoolRate:spec.turbo.releaseRate,dt);

    if (this.running && this.automatic && this.gear > 0 && this.shiftTime === 0) {
      const upAt = spec.transmission.upshiftRpm + this.pedal * 1980;
      if (this.rpm > upAt && this.gear < spec.gears.length && this.pedal > .2) this.requestGear(this.gear + 1);
      else if (this.gear > 1 && coupledRPM < 2100 + this.pedal * 580) this.requestGear(this.gear - 1);
    }
    const revCut = Math.max(0, Math.min(1, (spec.redline + 100 - this.rpm) / 260));
    const torque = this.running && !this.shiftTime && brake < .03 && !handbrake
      ? (spec.peakTorque * interpolate(spec.torqueCurve, this.rpm)) * this.pedal * revCut * (1+this.boostBar)/(1+potential) : 0;
    const reverseLimit = this.gear < 0 ? Math.min(1, Math.max(0, (spec.transmission.reverseSpeed - stableSpeed) / 3)) : 1;
    const engineForce = torque * ratio * spec.finalDrive * spec.drivelineEfficiency / spec.radius * reverseLimit * Math.sign(this.gear);
    const parking = !this.running && this.speed < .4;
    const coast = this.running && this.gear !== 0 && this.speed > .75 && gas === 0 && spec.transmission.electronic ? .75 + stableSpeed * .017 : 0;
    let engineBrake = 0;
    if (!spec.transmission.electronic && this.running && ratio > 0 && !this.shiftTime && this.speed > .75) {
      const rpmFraction = Math.max(0, (Math.max(this.rpm, coupledRPM) - spec.idle) / (spec.redline - spec.idle));
      const compressionTorque = gas === 0 ? 16 + 88 * Math.min(1.2, rpmFraction) : 0;
      const overRev = Math.max(0, coupledRPM - spec.redline) / 500;
      const overRevTorque = overRev > 0 ? 190 * Math.min(1.5, overRev) : 0;
      engineBrake = (compressionTorque + overRevTorque) * ratio * spec.finalDrive / spec.radius * dt * .5;
    }

    const steerLimit = interpolate(spec.steering.lock, this.speed * 3.6) * Math.PI / 180;
    const wheelbase = Math.abs(spec.wheels[0].z - spec.wheels[2].z);
    // Limit the physical rack, so the front wheels and the driver share the same attainable motion.
    const assists=drivingAssists[this.assistMode];
    const steeringScale=spec.awd ? assists.steering : 1;
    const error=-input.steer*steerLimit*steeringScale-this.steer;
    const toRoadWheel=Math.PI/(180*spec.steering.ratio);
    const maxRate=spec.steering.columnRateDeg*toRoadWheel,acceleration=spec.steering.columnAccelDeg*toRoadWheel;
    const wanted=Math.sign(error)*Math.min(maxRate, Math.sqrt(2*acceleration*Math.abs(error)),Math.abs(error)*(input.steer?spec.steering.response:spec.steering.returnRate));
    this.rackVelocity+=Math.max(-acceleration*dt,Math.min(acceleration*dt,wanted-this.rackVelocity));
    const step=this.rackVelocity*dt;
    if(step*error>=0&&Math.abs(step)>=Math.abs(error)){this.steer+=error;this.rackVelocity=0;}
    else this.steer+=step;
    const radius = Math.abs(this.steer) > .002 ? wheelbase / Math.tan(Math.abs(this.steer)) : Infinity;
    const direction = Math.sign(this.steer);
    this.tcActive = false;
    this.absActive = false;
    if(spec.awd || this.spawn.surface)this.tireTelemetry.forEach((_,i)=>{this.tireTelemetry[i]=wheelTelemetry(this,i);});
    if (spec.awd) {
      // A rear-biased virtual clutch transfers torque when the rear tires are loaded
      // laterally, have reduced surface grip or lose contact. Torque is conserved.
      let rearUse=0, rearLoose=0;
      for (let i=2;i<4;i++) {
        const ground=controller.wheelGroundObject(i);
        if (!ground || ground.friction()<.5) rearLoose+=.5;
        const load=controller.wheelSuspensionForce(i) ?? 0;
        rearUse+=.5*Math.min(1,Math.abs(controller.wheelSideImpulse(i) ?? 0)/Math.max(1,load*dt*spec.tires.rearGrip));
      }
      const rearSlip=(this.tireTelemetry[2].slipAngle+this.tireTelemetry[3].slipAngle)/2;
      const yawDemand=stableSpeed*Math.tan(this.steer)/wheelbase;
      const yawError=Math.min(1,Math.abs(yawDemand-this.body.angvel().y)/1.5);
      const frontContact=(Number(this.tireTelemetry[0].contact)+Number(this.tireTelemetry[1].contact))/2;
      const transfer=Math.min(1,this.pedal*.55*(1-Math.min(1,stableSpeed/31))+(rearLoose*.76+rearUse*.64+rearSlip*.7+yawError*.12)*this.pedal)*frontContact;
      this.frontTorqueShare=ramp(this.frontTorqueShare,spec.awd.baseFront+(spec.awd.maxFront-spec.awd.baseFront)*transfer*rallyModes[this.assistMode].transfer,spec.awd.transferRate,dt);
    }
    let frontDrive=0,rearDrive=0,extraRolling=0;
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i];
      const ground=controller.wheelGroundObject(i);
      const friction=ground?.friction() ?? 1;
      const surface=this.spawn.surface?.[surfaceFor(friction)];
      const baseGrip=wheel.front?spec.tires.frontGrip:spec.tires.rearGrip;
      let effectiveGrip=surface?baseGrip*surface.rwdGrip:friction<.5?spec.tires.grassGrip:baseGrip;
      if(this.spawn.surface){
        controller.setWheelSideFrictionStiffness(i,(wheel.front?spec.tires.frontSide:spec.tires.rearSide)*(surface?.lateral??1));
        if(ground&&surface)extraRolling+=surface.rolling/spec.wheels.length;
      }
      if(spec.awd){
        const state=this.tireTelemetry[i],mode=rallyModes[this.assistMode];
        // Continuous post-peak envelope, with Rapier retaining all tire impulse solving.
        const sliding=1-Math.exp(-Math.max(0,state.slipAngle-.075)*3.2);
        const loadFactor=Math.max(.91,Math.min(1.04,1-.045*(state.load/(spec.mass*9.81/4)-1)));
        const target=baseGrip*(surface?.awdGrip??surfaces[state.surface].grip)*(1-(1-mode.slide)*sliding)*loadFactor;
        this.tireGrip[i]=ramp(this.tireGrip[i],target,14,dt);effectiveGrip=this.tireGrip[i];
      }
      controller.setWheelFrictionSlip(i,effectiveGrip);
      const frontSteering = direction * Math.atan(wheelbase / (radius + direction * wheel.x));
      controller.setWheelSteering(i, wheel.front ? frontSteering : 0);
      // Rapier's tangential brake value is a per-step impulse cap, in N·s.
      let wheelBrake = brake * (surface?.braking??1) * (wheel.front ? spec.brakes.frontTorque : spec.brakes.rearTorque) / spec.radius * dt;
      const normalLoad=controller.wheelSuspensionForce(i) ?? 0;
      const grip = normalLoad * effectiveGrip;
      const lateral = Math.min(grip, Math.abs(controller.wheelSideImpulse(i) ?? 0) / dt);
      const available = Math.sqrt(Math.max(0, grip * grip - lateral * lateral));
      if (spec.awd && this.absEnabled && this.speed>3 && controller.wheelIsInContact(i)) {
        const limit=available*dt*1.08;
        this.absActive ||= wheelBrake>limit;
        wheelBrake=Math.min(wheelBrake,limit);
      }
      controller.setWheelBrake(i, wheelBrake + coast + (wheel.front ? 0 : engineBrake + (handbrake || parking ? spec.brakes.handbrakeTorque / spec.radius * dt : 0)));
      let drive = engineForce * (surface?.drive??1) * .5 * (wheel.front ? this.frontTorqueShare : 1-this.frontTorqueShare);
      if (this.tractionControl && (wheel.front ? Boolean(spec.awd) : true) && controller.wheelIsInContact(i)) {
        this.tcActive ||= Math.abs(drive) > available + 30;
        drive = Math.sign(drive) * Math.min(Math.abs(drive), available);
      }
      controller.setWheelEngineForce(i, drive);
      if(wheel.front)frontDrive+=Math.abs(drive);else rearDrive+=Math.abs(drive);
    }
    this.deliveredFrontShare=frontDrive+rearDrive>1?frontDrive/(frontDrive+rearDrive):this.frontTorqueShare;
    this.brakeLight = brake > .08 || handbrake;
    this.blink = Math.floor(this.time / .37) % 2 === 0;
    // Drag force acceleration is applied through an impulse, avoiding accumulated user forces.
    const drag = .5 * spec.aero.airDensity * spec.aero.dragArea * this.speed;
    const rolling = (spec.aero.rollingCoefficient + extraRolling) * spec.mass * 9.81 / Math.max(2, this.speed);
    this.body.applyImpulse(this.dragImpulse.set(this.velocity.x, 0, this.velocity.z).multiplyScalar(-(drag + rolling) * dt), true);
    if (this.running) {
      const kW = torque * this.rpm * Math.PI / 30000;
      const litresHour = spec.fuel.idleLitresPerHour + kW * spec.fuel.gramsPerKwh / (1000 * spec.fuel.kgPerLitre);
      this.fuelLitres = Math.max(0, this.fuelLitres - litresHour * dt / 3600);
      if (this.fuelLitres === 0) this.setIgnition();
    }
    controller.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    this.restoreLateralLoadTransfer();
    this.wheelState.forEach((wheel,i) => {
      wheel.previousLength = wheel.length; wheel.previousSpin = wheel.spin; wheel.previousSteer = wheel.steer;
      wheel.length = controller.wheelSuspensionLength(i) ?? spec.suspensionRest;
      wheel.spin = controller.wheelRotation(i) ?? 0;
      wheel.steer = controller.wheelSteering(i) ?? 0;
    });
    this.world.timestep = dt;
    this.world.step();
    this.readPose();
    this.travelled += this.speed * dt;
    this.contacts = spec.wheels.reduce((count, _, i) => count + Number(controller.wheelIsInContact(i)), 0);
  }
}
