import { MathUtils, Vector3 } from 'three';
import { AttemptTiming } from './lap-timing.ts';
import type { TimingGate, TrackDefinition } from './tracks.ts';

// Use the measured shoulder edge plus a small margin for the chassis centre.
// Gate capture has its own bounded margin, measured on the gate plane.
const vergeMargin=.25,gateMargin=.65;
const roadBelow=1.1,roadAbove=2.6,gateAbove=2.8;
const limitTime=.90,limitDistance=18;
const warningTime=.20,warningDistance=5;
const reentryTime=.25;

type Stage = Extract<TrackDefinition, {kind: 'stage'}>;

export class StageTiming extends AttemptTiming {
  private previous = new Vector3();
  private previousStation = 0;
  private initialized = false;
  private nextGate = 0;
  private peak = 0;
  private outside = 0;
  private outsideDistance = 0;
  private inside = 0;

  constructor(track: Stage) {
    super(track.timingLayout);
    this.track = track;
  }
  private readonly track: Stage;

  get passedGates(){return this.nextGate;}
  get trackLimitWarning(){
    return this.status==='running'&&this.inside<reentryTime&&
      (this.outside>=warningTime||this.outsideDistance>=warningDistance);
  }

  resumeAfterRecovery(){
    this.invalidate('Vehicle recovered');
    this.initialized=false;
  }

  launch(elapsedSinceStart = 0) {
    if (this.status !== 'waiting') return;
    this.beginAttempt(this.elapsed-elapsedSinceStart);
    this.nextGate=0;
    this.peak=-Infinity;
    this.outside=this.outsideDistance=this.inside=0;
  }

  override cancel() {
    super.cancel();
    this.initialized=false;
    this.nextGate=0;
  }

  private crossing(gate: TimingGate, position: Vector3) {
    const old=this.previous;
    const a=(old.x-gate.p.x)*gate.forward.x+(old.z-gate.p.z)*gate.forward.z;
    const b=(position.x-gate.p.x)*gate.forward.x+(position.z-gate.p.z)*gate.forward.z;
    if(a>=0||b<0)return;
    const t=-a/(b-a);
    const x=MathUtils.lerp(old.x,position.x,t)-gate.p.x;
    const z=MathUtils.lerp(old.z,position.z,t)-gate.p.z;
    const y=MathUtils.lerp(old.y,position.y,t)-gate.p.y;
    const across=x*gate.right.x+z*gate.right.z;
    const shoulder=this.track.timingShoulderWidth;
    const height=y-across*gate.right.y;
    const travel=Math.hypot(position.x-old.x,position.z-old.z);
    // A drifting car can cross the plane forward even when pointing sideways.
    if(b-a<travel*.15)return;
    // Passing the gate by 8 m without a legal crossing is handled by step().
    if(Math.abs(across)>gate.halfWidth+shoulder(gate.distance)+gateMargin||
       height< -roadBelow||height>gateAbove)return;
    return t;
  }

  private checkVerge(excess: number, height: number, advance: number, dt: number) {
    if(excess>0){
      // Wider/deeper departures spend the time budget faster. Distance bounds
      // how far a car can cut at speed, even inside the time window.
      this.outside+=dt*(1+excess/1.4);
      this.outsideDistance+=Math.max(0,advance);
      this.inside=0;
    }else if(excess<=-.15){
      this.inside+=dt;
      // A momentary touch of the boundary cannot reset an excursion.
      if(this.inside>=reentryTime){
        this.outside=Math.max(0,this.outside-2*dt);
        this.outsideDistance=Math.max(0,this.outsideDistance-36*dt);
      }
    }else this.inside=0;
    if(excess>=3.5||height< -3.5||this.outside>=limitTime||this.outsideDistance>=limitDistance)
      this.invalidate('Track limits');
  }

  step(position: Vector3, _heading: Vector3, _speed: number, dt: number) {
    const {startDistance,finishDistance,gates,sectors}=this.track;
    const {station,lateral,distance}=this.track.project(position.x,position.z);
    const road=this.track.sampleAt(station);
    this.elapsed+=dt;
    if(this.status!=='complete')this.progress=MathUtils.clamp((station-startDistance)/(finishDistance-startDistance),0,1);
    const height=position.y-road.p.y-lateral*road.right.y;
    const shoulder=this.track.timingShoulderWidth;
    const excess=Math.max(distance-road.halfWidth-shoulder(station)-vergeMargin,
      -roadBelow-height,height-roadAbove);
    const onCourse=excess<=0;
    const advance=this.initialized?station-this.previousStation:0;
    const movedTooFar=this.initialized&&this.previous.distanceToSquared(position)>4;
    const changedSection=Math.abs(advance)>3;
    const jump=movedTooFar||changedSection;
    if(this.status==='running'){
      this.peak=Math.max(this.peak,station);
      if(jump)this.invalidate(movedTooFar?'Position jump':'Route shortcut');
      else this.checkVerge(excess,height,advance,dt);
      if(this.peak-station>11)this.invalidate('Wrong direction');
    }
    const gate=gates[this.nextGate];
    if(gate&&this.initialized&&!jump){
      const scoring=this.status==='running';
      if(scoring&&station>gate.distance+8)this.invalidate('Checkpoint missed');
      else if((scoring||(this.status==='invalid'&&onCourse))&&Math.abs(station-gate.distance)<=5){
        const t=this.crossing(gate,position);
        if(t!==undefined){
          const when=this.elapsed-dt+t*dt;
          if(scoring&&this.nextGate===gates.length-1){
            if(this.sectors[0]!==null&&this.sectors[1]!==null){
              this.recordAttempt(when,Infinity);
              this.status='complete';
              this.progress=1;
            }else this.invalidate('Checkpoint missed');
          }else if(scoring&&(this.nextGate===sectors[0]||this.nextGate===sectors[1]))this.completeSector(when);
          this.nextGate++;
        }
      }
    }
    this.previous.copy(position);
    this.previousStation=station;
    this.initialized=true;
  }
}
