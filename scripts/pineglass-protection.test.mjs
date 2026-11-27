import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { createMountainGround } from '../src/pineglass-greybox.ts';
import { addPineglassColliders } from '../src/pineglass-ground.ts';
import { addMountainProtectionColliders, mountainProtection, protectionSection } from '../src/pineglass-protection.ts';
import { mountainAlignment as route, mountainShoulderWidth } from '../src/pineglass-v2.ts';
import { compactedGravel } from '../src/track-surface.ts';
import { Vehicle, noInput, stepTime } from '../src/vehicle.ts';
import { rally, sport } from '../src/vehicle-spec.ts';

await RAPIER.init();
const ground = createMountainGround();
const up = new Vector3(0,1,0);
function prepareWorld() {
  const world = new RAPIER.World({x:0,y:-9.81,z:0});
  world.timestep = stepTime;
  addPineglassColliders(world,ground.parts);
  const protection = addMountainProtectionColliders(world);
  world.step();
  return {world,protection};
}

test('each protected side has a continuous physical face kept off the running surface', () => {
  const {world,protection} = prepareWorld();
  try {
    let rays=0;
    for (const {run,collider} of protection) {
      for (let d=run.start+.7; d<run.end-.4; d+=1.7) {
        const {edge,right,height} = protectionSection(run,d);
        const origin=edge.clone().addScaledVector(right,-.85).addScaledVector(up,height*.58);
        const ray = new RAPIER.Ray(origin,right);
        const hit=world.castRay(ray,1.22,true);
        assert.equal(hit?.collider.handle,collider.handle,run.name+' at '+d.toFixed(1)+' m');
        const station=route.sampleAt(d);
        assert.ok(run.side*route.project(edge.x,edge.z).lateral>station.halfWidth+.90);
        rays++;
      }
      for (const station of [run.start,run.end]) {
        const endpoint=protectionSection(run,station);
        const middle=protectionSection(run,(run.start+run.end)/2);
        const local=route.sampleAt(station), mid=route.sampleAt((run.start+run.end)/2);
        const flare=(section,s)=>section.edge.clone().sub(s.p).dot(section.right)-s.halfWidth-mountainShoulderWidth(s.distance);
        assert.ok(flare(endpoint,local)>flare(middle,mid)+.69,run.name+' endpoint @ '+station);
        assert.ok(endpoint.height<middle.height,run.name+' height at endpoint @ '+station);
      }
    }
    for (const [id,distance] of [[1,260],[10,210],[14,225],[18,240],[21,230],[25,100]]) {
      const start=route.bends[id-1].entry;
      const from=route.sampleAt(start-distance).p.addScaledVector(up,1.15);
      const to=route.sampleAt(start).p.addScaledVector(up,.60);
      const ray=to.sub(from),length=ray.length();
      const hit=world.castRay(new RAPIER.Ray(from,ray.normalize()),length,true);
      assert.ok(!hit,'Obstructed braking sightline C'+id+' at ray distance '+hit?.timeOfImpact);
    }
    console.log('Protected faces sampled',rays);
  } finally {
    world.free();
  }
});

test('F40 and R35 chassis are contained by rails in representative angled impacts', () => {
  const cases = [
    {d:520,side:-1,kph:165,angle:12},
    {d:642,side:-1,kph:76,angle:18},
    {d:752,side:1,kph:67,angle:20},
    {d:960,side:-1,kph:72,angle:18},
    {d:1580,side:-1,kph:135,angle:15},
    {d:2128,side:1,kph:94,angle:18},
    {d:2850,side:1,kph:125,angle:19},
    {d:3160,side:1,kph:118,angle:46},
    {d:3335,side:-1,kph:95,angle:17},
    {d:3717,side:-1,kph:102,angle:18},
    {d:3875,side:-1,kph:167,angle:12},
    {d:3875,side:1,kph:167,angle:12},
    {d:4034,side:1,kph:158,angle:12},
    {d:4208,side:-1,kph:102,angle:17},
    {d:4656,side:-1,kph:129,angle:15},
    {d:5551,side:1,kph:89,angle:25},
    {d:5720,side:-1,kph:76,angle:17},
    {d:5907,side:-1,kph:85,angle:21},
  ];
  const measurements=[];
  for (const [vehicle,spec] of [['F40',sport],['R35',rally]]) {
    for (const {d,side,kph,angle} of cases) {
      const station=route.sampleAt(d);
      const direction=station.forward.clone().setY(0).normalize();
      const right=station.right.clone().setY(0).normalize();
      const heading=direction.multiplyScalar(Math.cos(angle*Math.PI/180)).addScaledVector(right,side*Math.sin(angle*Math.PI/180));
      const rotation=new Quaternion().setFromAxisAngle(up,Math.atan2(-heading.x,-heading.z));
      const position=station.p.clone().addScaledVector(station.right,side*(station.halfWidth-1.95));
      const {world,protection}=prepareWorld();
      const {run,collider}=protection.find(({run})=>run.side===side&&run.start<d&&run.end>d);
      assert.ok(mountainProtection.includes(run));
      const car=new Vehicle(world,spec,{position,rotation,surface:compactedGravel});
      let hit=false, outerMargin=Infinity, lowest=Infinity, impactKph=0, roll=0;
      try {
        for (let i=0; i<90; i++) car.update(noInput);
        car.body.setLinvel(heading.multiplyScalar(kph/3.6),true);
        for (let i=0; i<162; i++) {
          car.update(noInput);
          const here=route.project(car.current.position.x,car.current.position.z);
          const road=route.sampleAt(here.station);
          const boundary=protectionSection(run,here.station);
          outerMargin=Math.min(outerMargin,boundary.edge.sub(car.current.position).dot(boundary.right));
          lowest=Math.min(lowest,car.current.position.y-road.p.y);
          roll=Math.max(roll,Math.acos(Math.min(1,Math.max(-1,up.clone().applyQuaternion(car.current.rotation).y))));
          for (let j=0; j<car.body.numColliders(); j++) {
            const close = collider.contactCollider(car.body.collider(j),.045);
            if (close && !hit) {
              hit=true;
              impactKph=car.speed*3.6;
            }
          }
        }
        measurements.push({vehicle,barrier:run.name,station:d,entryKph:kph,impactKph:+impactKph.toFixed(1),
          minCenterMarginM:+outerMargin.toFixed(2),maxTiltDeg:+(roll*180/Math.PI).toFixed(1)});
        assert.ok(hit,vehicle+' never contacted '+run.name);
        assert.ok(outerMargin>.1,vehicle+' crossed '+run.name+' (margin '+outerMargin+')');
        assert.ok(lowest>-.5,vehicle+' dropped below the road at '+run.name);
        assert.ok(roll<Math.PI/3,vehicle+' rolled at '+run.name);
      } finally {
        car.dispose();
        world.free();
      }
    }
  }
  console.log(JSON.stringify(measurements));
});
