import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Quaternion,Vector3} from 'three';
import {StageRecovery} from '../src/stage-recovery.ts';
import {StageTiming} from '../src/stage-timing.ts';
import {tracks} from '../src/tracks.ts';
import {noInput,stepTime} from '../src/vehicle.ts';

const track=tracks['pineglass-run-v2'];
const up=new Vector3(0,1,0);
function pose(station,{lateral=0,height=.34,speed=22,contacts=4,rolled=false,parkingBrake=false}={}){
  const road=track.sampleAt(station);
  const rotation=rolled ? new Quaternion().setFromAxisAngle(road.forward,Math.PI) : new Quaternion();
  return {running:true,parkingBrake,contacts,direction:road.forward,speed,
    current:{position:road.p.addScaledVector(road.right,lateral).addScaledVector(up,height),rotation}};
}
function tick(recovery,car,seconds,gates=0,input=noInput){
  let result=false;
  for(let elapsed=0;elapsed<seconds;elapsed+=stepTime){
    if(recovery.step(car,input,gates,stepTime)) {result=true;break;}
  }
  return result;
}

test('recovery detects sustained falls, rollovers, entrapment and severe deviation with a countdown',()=>{
  const checks=[
    [pose(3180,{height:-14,contacts:0}),.75,'Below the road',noInput],
    [pose(930,{height:.52,rolled:true,speed:0,contacts:0}),1.3,'Vehicle overturned',noInput],
    [pose(920,{lateral:-9,height:-.7,speed:0}),3.4,'Vehicle stuck',{...noInput,throttle:1}],
    [pose(980,{lateral:17,height:-4.8,speed:1,contacts:3}),2.8,'Stranded below the verge',noInput],
    [pose(1020,{lateral:80}),1.7,'Far from the road',noInput],
  ];
  for(const [car,delay,reason,input] of checks){
    const recovery=new StageRecovery(track);
    assert.equal(tick(recovery,car,delay+.04,0,input),false);
    assert.equal(recovery.pending?.reason,reason);
    assert.ok(recovery.pending.seconds>.95);
    assert.equal(tick(recovery,car,1.2,0,input),true);
    recovery.recover(0);
    assert.equal(recovery.ready,false);
    assert.equal(tick(recovery,car,1,0,input),false,'cooldown suppresses repeats');
  }
});

test('controlled drift, legal brief flight and a roadside stop leave the driver in control',()=>{
  const recovery=new StageRecovery(track);
  const throttle={...noInput,throttle:1};
  assert.equal(tick(recovery,pose(1680,{height:1.1,speed:47,contacts:0}),.53),false);
  assert.equal(tick(recovery,pose(835,{lateral:-8,height:-.5,speed:9,contacts:3}),1.2,0,throttle),false);
  assert.equal(tick(recovery,pose(904,{lateral:-10,height:-.75,speed:0}),8),false);
  assert.equal(tick(recovery,pose(904,{lateral:-10,height:-.75,speed:0,parkingBrake:true}),8,0,throttle),false);
  assert.equal(tick(recovery,pose(980,{lateral:17,height:-4.8,speed:3,contacts:4}),5),false);
  assert.equal(recovery.pending,undefined);
  assert.equal(tick(recovery,pose(980,{lateral:17,height:-4.8,speed:1,contacts:4}),2.9),false);
  assert.equal(recovery.pending?.reason,'Stranded below the verge');
  assert.equal(tick(recovery,pose(980,{lateral:16,height:-4.6,speed:3,contacts:4}),1.2),false);
  assert.equal(recovery.pending,undefined,'The warning clears as soon as the car is moving again');
});

test('off-course shortcut cannot move the saved target ahead of ordered progress',()=>{
  const recovery=new StageRecovery(track);
  for(let station=-5;station<70;station+=.25) recovery.step(pose(station),noInput,Number(station>=0),stepTime);
  const skip=pose(1395,{lateral:26,height:-4});
  assert.equal(tick(recovery,skip,.6,1),false);
  // A stationary car on the other road branch cannot "wait in" new history.
  assert.equal(tick(recovery,pose(1395,{speed:0}),6,1),false);
  const target=recovery.recover(1);
  assert.ok(target>=60&&target<65,target);
  assert.equal(new StageRecovery(track).recover(0),null);
  for(let station=target;station>45;station-=.25) {
    const reversing=pose(station);
    reversing.direction.negate();
    recovery.step(reversing,noInput,1,stepTime);
  }
  assert.ok(recovery.recover(1)<46,'recovery after reversing would move the car forward');
});

test('A continuous drive back from the broader quarry verge retains a nearby verified recovery point',()=>{
  const recovery=new StageRecovery(track);
  for(let station=-5;station<105;station+=.25){
    const excursion=Math.max(0,Math.min(1,(station-48)/16,(84-station)/14));
    const lateral=excursion*(track.sampleAt(station).halfWidth+6.5);
    const height=.34-.94*excursion;
    recovery.step(pose(station,{lateral,height,speed:30}),noInput,Number(station>=0),stepTime);
    assert.equal(recovery.pending,undefined);
  }
  const target=recovery.recover(1);
  assert.ok(target>=98&&target<100,target);
});

test('an invalidated attempt keeps its ordered gates and can drive to the finish without creating a record',()=>{
  const timer=new StageTiming(track);
  timer.launch();
  const go=(station)=>{
    const car=pose(station);
    timer.step(car.current.position,car.direction,22,stepTime);
  };
  const checkpoint=track.gates[3].distance;
  for(let station=-4;station<checkpoint+2;station+=.5) go(station);
  assert.equal(timer.passedGates,4);
  timer.resumeAfterRecovery();
  assert.equal(timer.status,'invalid');
  assert.equal(timer.passedGates,4);
  go(6320);
  go(6350.1);
  assert.equal(timer.passedGates,4,'far-ahead landing advanced a gate');
  for(let station=checkpoint-11;station<track.finishDistance+3;station+=.5) go(station);
  assert.equal(timer.passedGates,track.gates.length);
  assert.equal(timer.count,0);
  assert.equal(timer.best,null);
  timer.cancel();
  assert.equal(timer.passedGates,0);
});

test('recovering after a recorded finish leaves the legitimate result intact',()=>{
  const timer=new StageTiming(track);
  timer.launch();
  for(let station=-4;station<track.finishDistance+2;station+=.5){
    const car=pose(station);
    timer.step(car.current.position,car.direction,43,stepTime);
  }
  assert.equal(timer.status,'complete');
  const result=timer.records();
  timer.resumeAfterRecovery();
  assert.deepEqual(timer.records(),result);
  assert.equal(timer.passedGates,track.gates.length);
});
