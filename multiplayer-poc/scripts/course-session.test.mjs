import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreGameCourse, updateGame, viewGame } from '../src/game-room.ts';
import { maxFrameSize, poseFrom } from '../../shared/protocol.ts';
import { finishGraceMs, livePoseFrom } from '../../shared/game.ts';
import { defaultTrack, trackIdentities } from '../../shared/tracks.ts';

test('Only finishes for the selected Alpine revision score in a room',()=>{
  const members=[1,2].map(slot=>({slot,generation:'connection-'+slot,driver:{name:'Driver '+slot,vehicle:'f40',ready:false}}));
  const game={host:1,mode:'challenge',session:null};
  const change=(slot,msg,now=100_000)=>updateGame(game,members,members[slot-1],msg,now,999_000,false);
  assert.equal(viewGame(game,members).track.id,defaultTrack);
  assert.match(change(2,{type:'track',track:defaultTrack}).error,/Only the host/);
  assert.match(change(1,{type:'track',track:'pineglass-run'}).error,/available course/);
  const track=viewGame(game,members).track;
  assert.deepEqual(track,trackIdentities[defaultTrack]);
  assert.ok(members.every(m=>!m.driver.ready));
  assert.match(change(2,{type:'ready',ready:true,track:track.id,revision:'old'}).error,/course changed/);
  assert.match(change(1,{type:'start'}).error,/Both drivers/);
  for(const slot of [1,2])assert.ok(change(slot,{type:'ready',ready:true,track:track.id,revision:track.revision}).persist);
  assert.ok(change(1,{type:'start'}).persist);
  assert.equal(game.session.track.revision,track.revision);
  assert.match(change(1,{type:'track',track:defaultTrack}).error,/Return to the lobby/);
  const message={type:'lap',session:game.session.id,revision:track.revision,number:1,completedAt:220_000,splits:[40_000,35_000,30_000]};
  assert.deepEqual(change(1,{...message,type:'stage'},220_000),{});
  assert.deepEqual(change(1,{...message,revision:'old'},220_000),{});
  assert.ok(change(1,message,220_000).persist);
  assert.deepEqual(change(1,message,220_000),{});
  assert.ok(change(1,{...message,number:2,completedAt:330_000,splits:[33_000,40_000,36_000]},330_000).persist);
  assert.equal(game.session.results[0].laps,2);
  assert.equal(game.session.results[0].best,105_000);
  assert.deepEqual(game.session.results[0].sectors,[33_000,35_000,30_000]);
});

test('Restoring a room on a removed course returns both drivers to the Alpine lobby',()=>{
  const members=[1,2].map(slot=>({slot,generation:'connection-'+slot,driver:{name:'Driver '+slot,vehicle:'f40',ready:true}}));
  const game={
    host:1, mode:'challenge', track:'pineglass-run',
    session:{id:'old-session',track:{id:'pineglass-run'}},
    lastFinish:{1:220_000},
  };
  assert.equal(restoreGameCourse(game,members),true);
  assert.equal(viewGame(game,members).track.id,defaultTrack);
  assert.equal(game.session,null);
  assert.equal(game.lastFinish,undefined);
  assert.ok(members.every(member=>!member.driver.ready));
  assert.equal(restoreGameCourse(game,members),false);
});

test('The host can switch to Pineglass and both drivers must accept its revision',()=>{
  const members=[1,2].map(slot=>({slot,generation:'connection-'+slot,driver:{name:'Driver '+slot,vehicle:'f40',ready:true}}));
  const game={host:1,mode:'challenge',session:null};
  const change=(slot,msg,now=100_000)=>updateGame(game,members,members[slot-1],msg,now,999_000,false);
  const track=trackIdentities['pineglass-run-v2'];
  assert.match(change(2,{type:'track',track:track.id}).error,/Only the host/);
  assert.ok(change(1,{type:'track',track:track.id}).persist);
  assert.deepEqual(viewGame(game,members).track,track);
  assert.ok(members.every(m=>!m.driver.ready));
  assert.match(change(2,{type:'ready',ready:true,track:track.id,revision:'old'}).error,/course changed/);
  for(const slot of [1,2])assert.ok(change(slot,{type:'ready',ready:true,track:track.id,revision:track.revision}).persist);
  assert.ok(change(1,{type:'start'}).persist);
  assert.deepEqual(game.session.track,track);
  const finish={type:'stage',session:game.session.id,revision:track.revision,number:1,completedAt:390_000,
    splits:[100_000,94_000,72_000]};
  assert.deepEqual(change(1,{...finish,type:'lap'},390_000),{});
  assert.ok(change(1,finish,390_000).persist);
  assert.equal(game.session.results[0].best,266_000);
  game.session.track={...track,revision:'previous-pineglass'};
  assert.equal(restoreGameCourse(game,members),true);
  assert.equal(game.track,track.id);
  assert.equal(game.session,null);
});

test('A pose can include four bounded wheel dust rates',()=>{
  const pose={session:'room-session',reset:0,steering:[0,0],wheels:[0,0,0,0],suspension:[.2,.2,.2,.2],flags:0,progress:0};
  assert.deepEqual(livePoseFrom(pose,pose.session),pose);
  assert.deepEqual(livePoseFrom({...pose,dust:[0,18,80,0]},pose.session)?.dust,[0,18,80,0]);
  for(const dust of [[0,0,0],[0,-1,0,0],[0,81,0,0],[0,1.5,0,0],null]){
    assert.equal(livePoseFrom({...pose,dust},pose.session),undefined);
  }
});

test('A late Pineglass snapshot fits within half of the WebSocket frame budget',()=>{
  const session='abcdef01-2345-6789-abcd-ef0123456789';
  const snapshot={type:'snapshot',seq:111999,t:1795800000987,rate:15,
    position:[3821.999,469.996,-1425.256],orientation:[-.3135,.5475,-.4361,.6459],
    velocity:[-17.31,-7.32,-51.29],
    live:{session,reset:123,steering:[-.13,.14],wheels:[195640.89,-175334.22,194364.56,199999.99],
      suspension:[.21,.31,.17,.23],flags:63,progress:.9999,dust:[80,80,80,80]},
    ack:{generation:'12345678-abcd-9876-abcd-987654321012',seq:111998}};
  const bytes=new TextEncoder().encode(JSON.stringify(snapshot)).length;
  assert.equal(maxFrameSize,1024);
  assert.ok(bytes<maxFrameSize/2,'Snapshot used '+bytes+' bytes');
  assert.ok(poseFrom(snapshot));
  assert.ok(livePoseFrom(snapshot.live,session));
});

test('A pre-deadline finish can arrive in the room grace window only',()=>{
  const track=trackIdentities['pineglass-run-v2'];
  const driver={slot:1,generation:'seat',driver:{name:'Driver',vehicle:'f40',ready:false}};
  const result={slot:1,laps:0,best:null,sectors:[null,null,null]};
  const ends=200_000,session={id:'stage',starts:150_000,ends,track,results:[result]};
  const game={host:1,track:track.id,mode:'challenge',session};
  const completion={type:'stage',session:session.id,revision:track.revision,number:1,completedAt:ends-200,
    splits:[11_000,13_000,8_000]};
  const send=(patch,now)=>updateGame(game,[driver],driver,{...completion,...patch},now,900_000,false);
  assert.deepEqual(send({completedAt:ends+10},ends+250),{});
  assert.deepEqual(send({},ends+finishGraceMs+1),{});
  assert.ok(send({},ends+finishGraceMs-100).persist);
  assert.equal(result.best,32_000);
  assert.deepEqual(send({},ends+finishGraceMs),{});
});
