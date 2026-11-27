import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { createMountainGround } from '../src/pineglass-greybox.ts';
import { addPineglassColliders, pineglassFriction } from '../src/pineglass-ground.ts';
import { addMountainProtectionColliders } from '../src/pineglass-protection.ts';
import { mountainAlignment as route, mountainShoulderWidth } from '../src/pineglass-v2.ts';
import { StageTiming } from '../src/stage-timing.ts';
import { tracks } from '../src/tracks.ts';
import { Vehicle, noInput, stepTime } from '../src/vehicle.ts';
import { rally, sport } from '../src/vehicle-spec.ts';
import { pineglassDriver } from './pineglass-driver.mjs';

const track=tracks['pineglass-run-v2'];
const up=new Vector3(0,1,0);
const scenarios=[
  {name:'normal cornering', station:2090, speed:22, drive:true, seconds:2.2},
  {name:'drift on shoulder', station:298, offset:5.85, speed:21, yaw:-36, motion:0, drive:true, seconds:1.35},
  {name:'shoulder at checkpoint', station:168.3, offset:5.95, speed:23, seconds:.70},
  {name:'brief verge and return', station:246, verge:1.05, speed:23, motion:-7, yaw:-7, drive:true, seconds:1.3},
  {name:'viaduct guardrail', station:3875, offset:3.5, speed:44, motion:12, yaw:12, seconds:1.15},
  {name:'legal crest flight', station:1678, speed:33, lift:5.7, drive:true, seconds:1.65},
  {name:'sustained beyond shoulder', station:243, verge:1.05, speed:18, seconds:1.1},
  {name:'missed checkpoint outside apron', station:168.4, verge:1.05, speed:24, seconds:.55},
  {name:'Quarry shortcut attempt', station:627, aimStation:749, speed:29, seconds:1.6},
];

function prelude(timer, station, lateral=0) {
  timer.launch();
  for(let d=-4;d<station;d+=.45) {
    const s=route.sampleAt(d);
    const offset=lateral*Math.max(0,1-(station-d)/3.5);
    const p=s.p.addScaledVector(s.right,offset);
    p.y+=.36;
    timer.step(p,s.forward,54,stepTime);
  }
}

function runPhysics(world, protection, spec, scenario) {
  const {name,station,speed,seconds,drive,offset=0,verge,yaw=0,motion=yaw,lift=0,aimStation}=scenario;
  const s=route.sampleAt(station);
  const across=verge===undefined?offset:s.halfWidth+mountainShoulderWidth(station)+verge;
  const direction=s.forward.clone().setY(0).normalize();
  const toward=aimStation===undefined?null:route.sampleAt(aimStation).p.sub(s.p).setY(0).normalize();
  const heading=toward??direction.clone().applyAxisAngle(up,-yaw*Math.PI/180);
  const rotation=new Quaternion().setFromAxisAngle(up,Math.atan2(-heading.x,-heading.z));
  const position=s.p.clone().addScaledVector(s.right,across);
  const car=new Vehicle(world,spec,{...track.grid[0],position,rotation});
  const timed=new StageTiming(track);
  try {
    car.setIgnition();
    car.parkingBrake=true;
    for(let i=0;i<255;i++)car.update(noInput);
    car.parkingBrake=false;
    const v=(toward??direction.applyAxisAngle(up,-motion*Math.PI/180)).multiplyScalar(speed).setY(lift);
    car.body.setLinvel(v,true);
    const initial=car.current.position;
    const initialLocation=route.project(initial.x,initial.z);
    // Establish the preceding ordered gates before the measured window.
    // All motion through the feature itself comes from the vehicle solver.
    prelude(timed,initialLocation.station-.4,initialLocation.lateral);
    timed.step(initial,car.direction,speed,stepTime);
    assert.equal(timed.status,'running',name+' setup: '+timed.reason);
    const beforeGates=timed.passedGates;
    const driver=drive?pineglassDriver(car,{route}):null;
    let maxOutside=-Infinity, minOutside=Infinity, maxHeight=-Infinity, minHeight=Infinity;
    let maxSlip=0,maxBodyYaw=0, airborne=0, shoulderTicks=0, beyondTicks=0, warned=0, rail=false, invalidAt=null;
    let endStation=station,endOutside=0,endContacts=0;
    const trace=[];
    for(let i=0;i<Math.ceil(seconds/stepTime);i++){
      car.update(driver?.input()??noInput);
      const t=(i+1)*stepTime;
      timed.step(car.current.position,car.direction,car.signedSpeed,stepTime);
      const {station:along,lateral}=route.project(car.current.position.x,car.current.position.z);
      const road=route.sampleAt(along);
      const outside=Math.abs(lateral)-road.halfWidth-mountainShoulderWidth(along);
      const height=car.current.position.y-road.p.y-lateral*road.right.y;
      maxOutside=Math.max(maxOutside,outside);minOutside=Math.min(minOutside,outside);
      maxHeight=Math.max(maxHeight,height);minHeight=Math.min(minHeight,height);
      if(car.contacts===0)airborne+=stepTime;
      if(outside>0)beyondTicks++;
      if(timed.trackLimitWarning)warned++;
      if(car.spec.wheels.some((_,j)=>Math.abs((car.controller.wheelGroundObject(j)?.friction()??0)-pineglassFriction.shoulder)<1e-5))shoulderTicks++;
      maxSlip=Math.max(maxSlip,...car.tireTelemetry.map(w=>Math.abs(w.slipAngle)*180/Math.PI));
      maxBodyYaw=Math.max(maxBodyYaw,Math.acos(Math.min(1,Math.max(-1,car.direction.dot(road.forward))))*180/Math.PI);
      if(name==='viaduct guardrail'&&!rail)rail=protection.some(({collider})=>
        Array.from({length:car.body.numColliders()},(_,j)=>collider.contactCollider(car.body.collider(j),.015)).some(Boolean));
      if(timed.status==='invalid'&&invalidAt===null)invalidAt={t,station:along,reason:timed.reason};
      endStation=along;endOutside=outside;endContacts=car.contacts;
      if(i%4===0)trace.push([t,along,car.speed*3.6,lateral,outside,height,car.contacts,timed.trackLimitWarning??false]);
    }
    return {name,status:timed.status,reason:timed.reason,invalidAt,beforeGates,afterGates:timed.passedGates,rail,maxSlip,maxBodyYaw,
      airborne,shoulderSeconds:shoulderTicks*stepTime,beyondSeconds:beyondTicks*stepTime,warningSeconds:warned*stepTime,
      maxOutside,minOutside,maxHeight,minHeight,endStation,endOutside,endContacts,trace};
  } finally {
    car.dispose();
  }
}

const [output]=process.argv.slice(2);
await RAPIER.init();
const world=new RAPIER.World({x:0,y:-9.81,z:0});
let evidence;
try {
  addPineglassColliders(world,createMountainGround().parts);
  const barriers=addMountainProtectionColliders(world);
  const protection=barriers.filter(({run})=>run.name.includes('gorge'));
  evidence=Object.fromEntries([['F40',sport],['R35',rally]].map(([name,spec])=>
    [name,scenarios.map(scenario=>runPhysics(world,protection,spec,scenario))]));
} finally {
  world.free();
}
if(output)await writeFile(output,JSON.stringify(evidence,null,2));
for(const [vehicle,results] of Object.entries(evidence))
  for(const {trace,...result} of results)console.log(vehicle,JSON.stringify(result));
