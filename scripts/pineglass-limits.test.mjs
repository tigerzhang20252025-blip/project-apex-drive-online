import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountainAlignment as route, mountainGorge, mountainShoulderWidth } from '../src/pineglass-v2.ts';
import { StageTiming } from '../src/stage-timing.ts';
import { tracks } from '../src/tracks.ts';
import { stepTime } from '../src/vehicle.ts';

const track=tracks['pineglass-run-v2'];
const edge=d=>route.sampleAt(d).halfWidth+mountainShoulderWidth(d);

function feed(timer, from, to, {offset=()=>0,height=()=>.36,sideways=false,speed=30}={}) {
  for(let station=from;station<=to;station+=speed*stepTime){
    const road=route.sampleAt(station);
    road.p.addScaledVector(road.right,offset(station));
    road.p.y+=height(station);
    timer.step(road.p,sideways?road.right:road.forward,speed,stepTime);
  }
}

test('a shoulder drift and a brief verge excursion can still record a full stage',()=>{
  const timer=new StageTiming(track);
  timer.launch();
  const drift=d=>Math.min(1,Math.max(0,(d-155)/8))*(edge(d)-.45);
  feed(timer,-4,169.75,{offset:drift});
  feed(timer,170,170.5,{offset:drift,sideways:true});
  assert.equal(timer.passedGates,2);
  assert.equal(timer.status,'running');
  feed(timer,170.75,186,{offset:d=>edge(d)-.45+1.25*Math.max(0,Math.min(1,(d-170)/4,(187-d)/4))});
  assert.equal(timer.trackLimitWarning,true);
  feed(timer,186.25,219,{offset:d=>Math.max(0,edge(d)-.22-(d-186)*.48)});
  assert.equal(timer.trackLimitWarning,false);
  assert.equal(timer.status,'running');
  feed(timer,219.25,track.finishDistance+3);
  assert.equal(timer.status,'complete');
  assert.equal(timer.passedGates,track.gates.length);
  assert.equal(timer.count,1);
});

test('a missed gate stays missed when the car rejoins further down the route',()=>{
  const timer=new StageTiming(track);
  timer.launch();
  feed(timer,-4,182,{offset:d=>Math.max(0,Math.min(1,(d-158)/9,(175-d)/4))*(edge(d)+.9)});
  assert.equal(timer.status,'invalid');
  assert.equal(timer.reason,'Checkpoint missed');
  assert.equal(timer.passedGates,1);
  feed(timer,182.25,track.finishDistance+1);
  assert.equal(timer.count,0);
  assert.equal(timer.passedGates,1);
});

test('shallow departures spend time and distance, and short touches inside do not clear them',()=>{
  for(const speed of [18,48]){
    const timer=new StageTiming(track);
    timer.launch();
    const target=40;
    const verge=d=>Math.min(1,Math.max(0,(d-24)/12))*(edge(d)+.48);
    feed(timer,-4,target,{offset:verge,speed});
    assert.equal(timer.status,'running');
    feed(timer,target+speed*stepTime,target+40,{offset:d=>
      edge(d)+.40-.43*Math.cos((d-target)*2*Math.PI/(speed*.28)),speed});
    assert.equal(timer.status,'invalid');
    assert.equal(timer.reason,'Track limits');
  }
});

test('a long shallow chord through the inside of Quarry cannot use the full grace period at speed',()=>{
  const timer=new StageTiming(track);
  timer.launch();
  const first=656,last=737,speed=46;
  feed(timer,-4,first,{speed});
  const a=route.sampleAt(first).p,b=route.sampleAt(last).p;
  const chord=b.clone().sub(a);
  const heading=chord.clone().setY(0).normalize();
  const steps=Math.ceil(chord.length()/(speed*stepTime));
  let invalidAt;
  for(let i=1;i<=steps;i++){
    const p=a.clone().lerp(b,i/steps);
    const {station,lateral}=route.project(p.x,p.z);
    const road=route.sampleAt(station);
    p.y=road.p.y+lateral*road.right.y+.36;
    timer.step(p,heading,speed,stepTime);
    if(timer.status==='invalid')invalidAt??=station;
  }
  assert.equal(timer.status,'invalid');
  assert.equal(timer.reason,'Track limits');
  assert.ok(invalidAt<712,invalidAt);
  feed(timer,last+.25,track.finishDistance+3);
  assert.equal(timer.count,0);
});

test('crossing the projection boundary between nonconsecutive Quarry sections credits no gate',()=>{
  const timer=new StageTiming(track);
  const a=route.sampleAt(610).p,b=route.sampleAt(743).p;
  const left=a.clone().lerp(b,.375), right=a.clone().lerp(b,.38);
  assert.ok(left.distanceTo(right)<.5);
  const before=route.project(left.x,left.z).station, after=route.project(right.x,right.z).station;
  assert.ok(after-before>80);
  const heading=b.sub(a).normalize();
  timer.step(left,heading,50,stepTime);
  timer.launch();
  timer.step(right,heading,50,stepTime);
  assert.equal(timer.status,'invalid');
  assert.equal(timer.reason,'Route shortcut');
  assert.equal(timer.passedGates,0);
});

test('a low flight can cross a bridge gate, while a fall invalidates timing and a reset keeps the gate history',()=>{
  const timer=new StageTiming(track);
  timer.launch();
  const {deckStart}=mountainGorge;
  const deckEntryCount=track.gates.findIndex(gate=>gate.distance===deckStart)+1;
  const speed=30;
  feed(timer,-4,deckStart+3,{speed,height:d=>.36+Math.max(0,Math.min(2.1,(d-deckStart+12)*.21))});
  assert.equal(timer.status,'running');
  assert.equal(timer.passedGates,deckEntryCount);
  const from=deckStart+3.1;
  feed(timer,from,from+6,{speed,height:d=>2.46-(d-from)*1.1});
  assert.equal(timer.status,'invalid');
  assert.equal(timer.reason,'Track limits');
  timer.resumeAfterRecovery();
  assert.equal(timer.passedGates,deckEntryCount);
  feed(timer,from-5,3840);
  assert.equal(timer.passedGates,deckEntryCount+1);
  assert.equal(timer.count,0);
});

test('short reversing keeps the stage valid but going back more than 11 m invalidates it',()=>{
  const timing=new StageTiming(track);
  timing.launch();
  feed(timing,-4,48);
  const passed=timing.passedGates;
  const reverseTo=(from,to)=>{
    for(let distance=from;distance>=to;distance-=.25){
      const road=route.sampleAt(distance);
      road.p.y+=.36;
      timing.step(road.p,road.forward,-30,stepTime);
    }
  };
  reverseTo(47.75,40);
  assert.equal(timing.status,'running');
  assert.equal(timing.passedGates,passed);
  feed(timing,40.25,49);
  reverseTo(48.75,36.5);
  assert.equal(timing.status,'invalid');
  assert.equal(timing.reason,'Wrong direction');
  assert.equal(timing.passedGates,passed);
});
