import { writeFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vehicle, noInput, stepTime } from '../src/vehicle.ts';
import { rally, sport } from '../src/vehicle-spec.ts';
import { addPineglassColliders } from '../src/pineglass-ground.ts';
import { mountainAlignment } from '../src/pineglass-v2.ts';
import { createMountainGround } from '../src/pineglass-greybox.ts';
import { addMountainProtectionColliders } from '../src/pineglass-protection.ts';
import { StageTiming } from '../src/stage-timing.ts';
import { tracks } from '../src/tracks.ts';
import { pineglassDriver, sweepWindows } from './pineglass-driver.mjs';

const route=mountainAlignment;
const {sampleAt:pineglassAt,end:pineglassEnd,finish:pineglassFinish,project:pineglassNearest}=route;
const track=tracks['pineglass-run-v2'];
const sweeps=sweepWindows(route);
const recordTerrain=process.env.APEX_PINEGLASS_TERRAIN_TELEMETRY==='1';
const checked = new Map(sweeps.map(b=>[b.id,b]));
const bodyPoint=new Vector3();

function drive(model, parts, assist, gain, braking, lookahead, initialOffset, lineOffset) {
  const spec = model==='f40'?sport:rally;
  const world = new RAPIER.World({x:0,y:-9.81,z:0});
  addPineglassColliders(world,parts);
  addMountainProtectionColliders(world);
  const spawn={...track.grid[0],position:track.grid[0].position.clone()};
  spawn.position.addScaledVector(pineglassAt(-5).right,initialOffset);
  const car = new Vehicle(world,spec,spawn);
  const timer = new StageTiming(track);
  const driver=pineglassDriver(car,{gain,braking,lookahead,lineOffset,route});
  const half=spec.awd?.95:.94, nose=spec.awd?-2.29:-2.18, tail=spec.awd?2.30:2.12;
  const metrics = sweeps.map(b=>({corner:b.id,entry:null,exit:null,minimumEdge:Infinity,flywheelSpeed:0,
    fullThrottle:true,brake:false,minContacts:4,peakSlip:0,rackReserve:1,ticks:0,approach:null}));
  const trace=[],terrainTelemetry=[];
  let previous=-5, peak=previous, tightest=Infinity, lowContacts=0, traceIdx=0;
  let lastTick=0, invalidAt=null, finishedTick=null, arrival=null, stop=null;
  try {
    if (spec.awd) car.setAssist(assist);
    for(let i=0;i<120;i++)car.update(noInput);
    car.setIgnition();
    for(let i=0;i<150;i++)car.update(noInput);
    timer.step(car.current.position,car.direction,car.signedSpeed,stepTime);
    timer.launch();
    for (let tick=0; tick<120*400; tick++) {
      const speed=car.speed;
      const steerLimit=driver.rackLimit(speed);
      const command=driver.input();
      const input=finishedTick===null?command:{...command,throttle:0,brake:tick-finishedTick>96?.82:0};
      const {throttle,brake,steer}=input;
      car.update(input);
      timer.step(car.current.position,car.direction,car.signedSpeed,stepTime);
      const actual = pineglassNearest(car.current.position.x,car.current.position.z);
      const edge = pineglassAt(actual.station).halfWidth-Math.abs(actual.lateral)-half;
      if(actual.station>45)tightest=Math.min(tightest,edge);
      if(timer.status==='invalid'&&invalidAt===null)invalidAt={station:actual.station,reason:timer.reason,edge,speed};
      if(car.contacts<3)lowContacts++;
      if(recordTerrain&&tick%4===0)terrainTelemetry.push([
        actual.station,car.speed*3.6,car.contacts,
        ...car.wheelState.map(wheel=>wheel.length),
        ...car.spec.wheels.map((_,i)=>car.controller.wheelSuspensionForce(i)??0),
      ]);
      if(tick%12===0)trace[traceIdx++]=[
        Number((tick*stepTime).toFixed(2)),actual.station,car.speed*3.6,actual.lateral,car.contacts,throttle,brake,steer,
      ];
      for (const row of metrics) {
        const b=checked.get(row.corner);
        if(row.approach===null && actual.station>=b.start)row.approach=car.speed*3.6;
        if(previous<b.entry&&actual.station>=b.entry)row.entry=car.speed*3.6;
        if(actual.station>=b.entry&&previous<b.exit){
          row.fullThrottle&&=throttle===1;
          row.brake||=brake>0;
          for(const side of [-1,1])for(const end of [nose,tail]){
            bodyPoint.set(side*half,0,end).applyQuaternion(car.current.rotation).add(car.current.position);
            const body=pineglassNearest(bodyPoint.x,bodyPoint.z);
            row.minimumEdge=Math.min(row.minimumEdge,pineglassAt(body.station).halfWidth-Math.abs(body.lateral));
          }
          row.minContacts=Math.min(row.minContacts,car.contacts);
          row.peakSlip=Math.max(row.peakSlip,...car.tireTelemetry.map(w=>w.slipAngle*180/Math.PI));
          row.rackReserve=Math.min(row.rackReserve,1-Math.abs(car.steer)/steerLimit);
          row.flywheelSpeed=Math.max(row.flywheelSpeed,car.speed*3.6);
          row.ticks++;
        }
        if(previous<b.exit&&actual.station>=b.exit)row.exit=car.speed*3.6;
      }
      lastTick=tick;
      previous=actual.station;
      peak=Math.max(peak,actual.station);
      if(timer.status==='complete'&&finishedTick===null){
        finishedTick=tick;arrival=car.speed*3.6;
      }
      if(finishedTick!==null&&car.speed<=1){stop=actual.station-pineglassFinish;break;}
      if(actual.station>=pineglassEnd-.5||actual.distance>50||(timer.status==='invalid'&&actual.station>pineglassFinish+2))break;
    }
    return {model,assist,peak,outcome:timer.status,invalidAt,seconds:timer.last, splits:timer.lastLapSectors,
      wallSeconds:(lastTick+1)*stepTime,arrival,stop, tightest,lowContacts,metrics, trace,...(recordTerrain?{terrainTelemetry}:{})};
  } finally { car.dispose();world.free(); }
}

const [model, evidence, assist='sport', gain='1.28', brake='4.25', look='6', offset='-1.85', lineOffset='0'] = process.argv.slice(2);
await RAPIER.init();
const {parts}=createMountainGround();
const modes=model&&model!=='both'?[model]:['f40','r35'];
const results=modes.map(id=>drive(id,parts,assist,Number(gain),Number(brake),Number(look),Number(offset),Number(lineOffset)));
if(evidence)await writeFile(evidence,JSON.stringify(results));
for(const {trace,terrainTelemetry,...result} of results)console.log(JSON.stringify(result));
