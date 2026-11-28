import {test} from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {Vector3} from 'three';
import {mountainAlignment as route,mountainGorge,mountainQuarry,mountainRegions,mountainShoulderWidth,mountainUndulation} from '../src/pineglass-v2.ts';
import {createMountainGround} from '../src/pineglass-greybox.ts';
import {addPineglassColliders,pineglassFriction} from '../src/pineglass-ground.ts';
import {tracks} from '../src/tracks.ts';
import {StageTiming} from '../src/stage-timing.ts';
import {trackIdentities} from '../shared/tracks.ts';

test('Pineglass 2.0 shares its multiplayer identity and spawns behind ordered stage gates',()=>{
  const track=tracks['pineglass-run-v2'];
  const {id,revision,name,kind}=track;
  assert.deepEqual({id,revision,name,kind},trackIdentities[id]);
  assert.ok(Math.abs(track.grid[0].position.distanceTo(track.grid[1].position)-3.7)<1e-8);
  assert.ok(track.length>=6300&&track.length<=6800);
  assert.equal(track.cornerCount,route.bends.length);
  assert.equal(track.cornerCount,28);
  assert.equal(mountainRegions.length,7);
  assert.ok(route.sampleAt(3360).halfWidth>4.5&&route.sampleAt(3360).right.y<-.01);
  assert.ok(route.sampleAt(5760).halfWidth>4.7&&route.sampleAt(5760).right.y<-.03);
  assert.ok(mountainUndulation(5742,0)>.035);
  assert.equal(mountainUndulation(1685,0),0);
  assert.equal(track.gates[0].distance,0);
  assert.equal(track.gates.at(-1).distance,route.finish);
  assert.ok(track.gates.every((gate,index)=>index===0||gate.distance>track.gates[index-1].distance));
  assert.deepEqual(track.sectors.map(i=>track.gates[i].distance),[2367,5016]);
  const timing=new StageTiming(track);
  function playStage(elapsedSinceStart=0){
    timing.launch(elapsedSinceStart);
    for(let station=-5;station<route.finish+1;station+=.5){
      const s=track.sampleAt(station);
      s.p.y+=.36;
      timing.step(s.p,s.forward,60,1/120);
    }
  }
  playStage();
  assert.equal(timing.status,'complete');
  assert.ok(timing.lastLapSectors.every(split=>split>0));
  assert.ok(Math.abs(timing.lastLapSectors.reduce((sum,split)=>sum+split,0)-timing.last)<1e-8);
  const best=timing.best;
  timing.cancel();
  assert.equal(timing.progress,0);
  playStage();
  assert.equal(timing.count,2);
  assert.ok(Math.abs(timing.best-best)<1e-8);
  timing.cancel();
  playStage(1.25);
  assert.ok(Math.abs(timing.last-best-1.25)<1e-8);
  assert.ok(Math.abs(timing.lastLapSectors[0]-timing.bestLapSectors[0]-1.25)<1e-8);
  const restored=new StageTiming(track);
  restored.restore(JSON.parse(JSON.stringify(timing.records())));
  assert.equal(restored.count,3);
  assert.deepEqual(restored.bestSectors,timing.bestSectors);
  assert.equal(restored.status,'waiting');
});

test('The opening links a genuinely straight run into five tight, alternating quarry turns',()=>{
  const [hook,...linked]=route.bends.slice(0,5);
  assert.equal(hook.entry,mountainQuarry.entry);
  assert.ok(hook.entry>=600);
  assert.equal(hook.angle,-142);
  assert.equal(linked.at(-1).exit,mountainQuarry.technicalEnd);
  const entry=route.sampleAt(0);
  const far=route.sampleAt(hook.entry);
  const straight=far.p.clone().sub(entry.p);
  straight.y=0;
  assert.ok(Math.abs(straight.length()-hook.entry)<.01);
  for(const bend of [hook,...linked]){
    assert.ok(bend.radius>=30&&bend.radius<=50);
    assert.ok(Math.abs(bend.angle)>=60);
  }
  for(const [index,bend] of linked.entries()){
    const prev=route.bends[index];
    assert.equal(bend.turn,-prev.turn);
    assert.ok(bend.entry-prev.exit>=5&&bend.entry-prev.exit<=16);
  }
  assert.ok(route.sampleAt(650).halfWidth>=5.5);
  assert.ok(mountainShoulderWidth(650)>=2.7);
});

test('Glass Gorge has a continuous long curved crossing and spaced timing gates',()=>{
  const {deckStart,deckEnd}=mountainGorge;
  const length=deckEnd-deckStart;
  assert.ok(length>=330&&length<=360);
  const first=route.sampleAt(deckStart),last=route.sampleAt(deckEnd);
  assert.ok(first.forward.angleTo(last.forward)>.2);
  const deckGates=route.gates.filter(gate=>gate.distance>=deckStart&&gate.distance<=deckEnd);
  assert.equal(deckGates.length,4);
  assert.equal(deckGates[0].distance,deckStart);
  assert.equal(deckGates.at(-1).distance,deckEnd);
  const after=route.bends.find(bend=>bend.entry>deckEnd);
  assert.ok(after.entry-deckEnd>=175&&after.angle< -100);
});

test('Mountain road, bridge and shoulders stay continuous and leave the braking approaches visible',async()=>{
  await RAPIER.init();
  const world=new RAPIER.World({x:0,y:-9.81,z:0});
  try{
    const ground=createMountainGround();
    addPineglassColliders(world,ground.parts);world.step();
    let count=0;
    for(let d=-29.83;d<route.end-2;d+=5){
      const s=route.sampleAt(d);
      const verge=mountainShoulderWidth(d)-.12;
      for(const offset of [-s.halfWidth-verge,-s.halfWidth+.08,0,s.halfWidth-.08,s.halfWidth+verge]){
        const origin=s.p.clone().addScaledVector(s.right,offset).add(new Vector3(0,2,0));
        const hit=world.castRay(new RAPIER.Ray(origin,{x:0,y:-1,z:0}),3,true);
        const kind=Math.abs(offset)<s.halfWidth?'road':'shoulder';
        assert.ok(hit&&Math.abs(hit.collider.friction()-pineglassFriction[kind])<.0001,
          'Missing '+kind+' contact at '+d+' m, offset '+offset);
        const blend=kind==='shoulder'?(Math.abs(offset)-s.halfWidth)/mountainShoulderWidth(d):0;
        const height=.014+mountainUndulation(d,offset)-.08*blend;
        assert.ok(Math.abs(hit.timeOfImpact-(2-height))<.06,'Contact height at '+d+' m, offset '+offset);
        count++;
      }
    }
    for(const [d,side] of [[475,-1],[640,-1],[795,1],[930,1],[1980,1],[3135,-1],[4110,-1],[6220,1]]){
      const s=route.sampleAt(d);
      const edge=s.halfWidth+mountainShoulderWidth(d);
      let previous=3;
      for(let m=0;m<=5;m++){
        const origin=s.p.clone().addScaledVector(s.right,side*(edge+m)).add(new Vector3(0,3,0));
        const hit=world.castRay(new RAPIER.Ray(origin,{x:0,y:-1,z:0}),4.2,true);
        assert.ok(hit&&Math.abs(hit.timeOfImpact-previous)<.25,'Recovery shelf at '+d+' m, shoulder +'+m);
        previous=hit.timeOfImpact;
      }
    }
    const deck=route.sampleAt(mountainGorge.station).p;
    assert.ok(deck.y-ground.groundY(deck.x,deck.z)>85);
    const span=mountainGorge.deckEnd-mountainGorge.deckStart;
    for (const fraction of [.18,.26,.5,.72,.82]) {
      const s=route.sampleAt(mountainGorge.deckStart+span*fraction);
      assert.ok(s.p.y-ground.groundY(s.p.x,s.p.z)>16,'open span at '+fraction);
    }
    for(const [id,distance] of [[1,260],[10,210],[14,225],[18,240],[21,230],[25,100]]){
      const start=route.bends[id-1].entry, from=route.sampleAt(start-distance).p, to=route.sampleAt(start).p;
      from.y+=1.15;to.y+=.60;
      const ray=to.sub(from),length=ray.length();
      const hit=world.castRay(new RAPIER.Ray(from,ray.normalize()),length,true);
      assert.ok(!hit,'Obstructed C'+id+' at ray distance '+hit?.timeOfImpact);
    }
    console.log('Mountain collider ray probes',count);
  }finally{world.free();}
});
