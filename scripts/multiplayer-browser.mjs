import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultTrack, isTrackId, trackIdentities } from '../multiplayer-poc/src/tracks.ts';
import { launchTestBrowser } from './test-browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:4187/';
const output = process.argv[3] ?? 'test-evidence/multiplayer';
const course = process.argv[4] ?? defaultTrack;
assert.ok(isTrackId(course), 'Select an available course.');
const stageCourse = trackIdentities[course].kind === 'stage';
await mkdir(output, { recursive: true });
const browser = await launchTestBrowser();
const summary = { course, errors: [], combos: [], coverage: {}, frames: { sent: 0, heard: 0, maxSent: 0, maxHeard: 0 } };
const state = page => page.evaluate(() => window.apexDiagnostics.state());
const network = page => page.evaluate(() => window.apexDiagnostics.multiplayer());
const screenshot = (page, name, hideCode = false) => page.screenshot({
  path: join(output, name + '.jpg'), quality: 91,
  mask: hideCode ? [page.locator('#online-code')] : [],
  maskColor: '#25313a',
});
const ready = (page, enabled) => page.waitForFunction(
  enabled => document.querySelector('#online-ready').disabled !== enabled, enabled, { timeout: 30_000 },
);
function recordTraffic(page) {
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.startsWith('/socket/')) return;
    for (const [event, count, maximum] of [['framesent','sent','maxSent'],['framereceived','heard','maxHeard']]) {
      socket.on(event, frame => {
        const payload = frame.payload.toString();
        if (!payload.startsWith('{"type":"snapshot"')) return;
        summary.frames[count]++;
        summary.frames[maximum] = Math.max(summary.frames[maximum], Buffer.byteLength(payload));
      });
    }
  });
}
async function visit(name) {
  const context = await browser.newContext({ viewport: {width: 1280, height: 800}, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(()=>{
    const NativeSocket=window.WebSocket;
    window.WebSocket=class extends NativeSocket {
      constructor(...args){
        super(...args);
        if(new URL(this.url).pathname.startsWith('/socket/'))window.apexTestRelaySocket=this;
      }
    };
  });
  page.on('pageerror', error => summary.errors.push(error.message));
  page.on('console',message=>{
    if(message.type()==='error'&&message.text()!=='Failed to load resource: net::ERR_INTERNET_DISCONNECTED'){
      summary.errors.push(message.text());
    }
  });
  recordTraffic(page);
  await page.goto(new URL('?diagnostics&garage=1', base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('#play-online').click();
  await page.locator('#online-name').fill(name);
  return page;
}
async function waitText(page, selector, expected) {
  await page.locator(selector).filter({hasText:expected}).waitFor({timeout:30_000});
}
async function selectCar(page, id) {
  await page.locator('#online-vehicle').selectOption(id);
  await page.locator('#stage[data-vehicle=' + id + ']').waitFor({timeout:40_000});
  await page.waitForFunction(id => document.querySelector('#online-vehicle').value === id &&
    !document.querySelector('#online-vehicle').disabled, id, {timeout:30_000});
}
async function start(a,b) {
  await ready(a,true);
  await ready(b,true);
  await a.locator('#online-ready').click();
  await b.locator('#online-ready').click();
  await a.locator('#online-start').click();
  try {
    await Promise.all([a,b].map(page=>page.locator('#online-hud').waitFor({timeout:15_000})));
  } catch (cause) {
    const status=await Promise.all([a,b].map(page=>page.locator('#online-status').textContent()));
    throw new Error('The session did not start ('+status.join(' / ')+').',{cause});
  }
  const startTime = await Promise.all([a,b].map(page=>page.evaluate(()=>new Promise(resolve=>{
    const sample=()=>{
      const info=window.apexDiagnostics.multiplayer();
      if(info.remaining<=0)resolve(performance.timeOrigin+performance.now());
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }))));
  assert.ok(Math.abs(startTime[0]-startTime[1]) < 150, 'start wall-clock skew');
  return Math.round(Math.abs(startTime[0]-startTime[1]));
}
async function waitRemote(page, model) {
  await page.waitForFunction(model => {
    const {remote} = window.apexDiagnostics.multiplayer();
    return remote.visible && remote.model === model && remote.received >= 3;
  }, model, {timeout:30_000});
}
async function stats(page, ms=1200) {
  const before = await state(page);
  await delay(ms);
  const after = await state(page);
  const sorted=after.fpsSamples.slice(before.fpsSamples.length).sort((a,b)=>a-b);
  const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {frames:sorted.length, medianFrameMs:at(.5), p95FrameMs:at(.95), draws:after.draws, mirrorDraws:after.mirrorDraws, triangles:after.triangles};
}

async function stageScene(page) {
  return page.evaluate(async () => {
    const {scene,world,RAPIER,T}=apexDiagnostics.inspect;
    const {mountainAlignment:route}=await import('/src/pineglass-v2.ts');
    const {mountainProtection,protectionSection}=await import('/src/pineglass-protection.ts');
    const course=scene.getObjectByName('Pineglass Run 2.0');
    const objects=[], parts=[], geometries=new Set();
    const bytes=data=>new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
    course.updateMatrixWorld(true);
    course.traverse(node=>{
      objects.push([node.name,node.type,node.matrixWorld.toArray(),node.children.length]);
      if(node.isInstancedMesh){
        parts.push(bytes(node.instanceMatrix.array));
        if(node.instanceColor)parts.push(bytes(node.instanceColor.array));
      }
      if(node.isMesh&&!geometries.has(node.geometry)){
        geometries.add(node.geometry);
        for(const item of Object.values(node.geometry.attributes))parts.push(bytes(item.array));
        if(node.geometry.index)parts.push(bytes(node.geometry.index.array));
      }
    });
    parts.unshift(new TextEncoder().encode(JSON.stringify(objects)));
    const buffer=new Uint8Array(parts.reduce((sum,part)=>sum+part.byteLength,0));
    let offset=0;
    for(const part of parts){buffer.set(part,offset);offset+=part.byteLength;}
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',buffer));
    const ray=(origin,dir,length)=>{
      const hit=world.castRayAndGetNormal(new RAPIER.Ray(origin,dir),length,true,RAPIER.QueryFilterFlags.ONLY_FIXED);
      return hit && [hit.collider.friction(),hit.timeOfImpact,hit.normal.x,hit.normal.y,hit.normal.z];
    };
    const down=new T.Vector3(0,-1,0);
    const road=[-4,170,650,1650,3090,3880,4049,5750,6500].map(d=>ray(route.sampleAt(d).p.add(new T.Vector3(0,1,0)),down,2));
    const shoulder=route.sampleAt(215);
    const ground=[.6,25].map((extra,i)=>ray(shoulder.p.clone().addScaledVector(shoulder.right,shoulder.halfWidth+extra)
      .add(new T.Vector3(0,i?75:1,0)),down,i?200:2));
    const rails=mountainProtection.map(run=>{
      const {edge,right,height}=protectionSection(run,(run.start+run.end)/2);
      return ray(edge.addScaledVector(right,-.85).add(new T.Vector3(0,height*.58,0)),right,1.22);
    });
    return {hash:Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join(''),objects:objects.length,
      geometries:geometries.size,colliders:world.colliders.len(),gates:apexDiagnostics.gates,road,ground,rails};
  });
}

async function verifyRecovery(sender,peer) {
  await sender.keyboard.down('w');
  try {
    await sender.waitForFunction(()=>apexDiagnostics.inspect.laps.status==='running'&&apexDiagnostics.inspect.car.speed>3);
  } finally {
    await sender.keyboard.up('w');
  }
  const roadHeight=await sender.evaluate(()=>{
    const {car}=apexDiagnostics.inspect, {x,y,z}=car.current.position;
    car.body.setTranslation({x,y:y-13,z},true);
    car.body.setLinvel({x:0,y:-2,z:0},true);
    return y;
  });
  await peer.waitForFunction(height=>{
    const remote=apexDiagnostics.inspect.scene.children.find(n=>n.userData.remoteVehicle);
    return remote?.visible&&remote.position.y<height-8;
  },roadHeight);
  const peerBefore=(await state(peer)).position;
  const timingBefore=await peer.evaluate(()=>apexDiagnostics.inspect.laps.passedGates);
  await peer.evaluate(()=>{
    window.recoveryHeights=[];
    const record=()=>{
      if(!window.recoveryHeights)return;
      const remote=apexDiagnostics.inspect.scene.children.find(n=>n.userData.remoteVehicle);
      if(remote?.visible)window.recoveryHeights.push(remote.position.y);
      requestAnimationFrame(record);
    };
    record();
  });
  await sender.locator('#recovery-message').filter({hasText:'Vehicle recovered'}).waitFor({timeout:12_000});
  await peer.waitForFunction(height=>{
    const remote=apexDiagnostics.inspect.scene.children.find(n=>n.userData.remoteVehicle);
    return remote?.visible&&Math.abs(remote.position.y-height)<1.5;
  },roadHeight,{timeout:10_000});
  const heights=await peer.evaluate(()=>{
    const samples=window.recoveryHeights;
    delete window.recoveryHeights;
    return samples;
  });
  assert.ok(heights.length>=5);
  assert.ok(heights.every(y=>y<roadHeight-8||Math.abs(y-roadHeight)<1.5),'remote recovery interpolated through terrain');
  assert.equal(await peer.evaluate(()=>apexDiagnostics.inspect.laps.passedGates),timingBefore);
  assert.equal(await sender.evaluate(()=>apexDiagnostics.inspect.laps.status),'invalid');
  assert.ok(Math.hypot(...(await state(peer)).position.map((n,i)=>n-peerBefore[i]))<.5);
  assert.equal((await network(sender)).session.id,(await network(peer)).session.id);
  return {visibleFrames:heights.length};
}

try {
  const a = await visit('Apex Driver');
  await a.locator('#play-solo').click();
  await a.locator('#garage-drive').click();
  await a.locator('[data-camera=chase]').click();
  await delay(850);
  summary.baseline = await stats(a,1800);
  await a.locator('#open-garage').click();
  await a.locator('#play-online').click();

  const b = await visit('Alpine Driver');
  await a.locator('#online-create').click();
  await a.locator('#online-room').waitFor();
  await b.locator('#online-code-input').fill(await a.locator('#online-code').textContent());
  await b.locator('#online-join button').click();
  await waitText(a,'#online-drivers','Alpine Driver');
  await waitText(b,'#online-drivers','Apex Driver');
  assert.deepEqual(await a.locator('#online-track option').evaluateAll(options=>options.map(option=>option.value)),Object.keys(trackIdentities));
  await a.locator('#online-track').selectOption(course);
  await Promise.all([a,b].map(page=>page.locator('#stage[data-track='+course+']').waitFor({timeout:45_000})));
  assert.equal(await b.locator('#online-track').inputValue(),course);
  assert.ok(await b.locator('#online-track').isDisabled());
  await ready(a,true);
  if(stageCourse){
    await a.locator('#online-ready').evaluate(button=>{for(let i=0;i<10;i++)button.click();});
    await waitText(a,'#online-ready','Unready');
    assert.ok((await network(a)).online);
    await delay(240);
    await a.locator('#online-ready').click();
    await a.waitForFunction(()=>document.querySelector('#online-ready').textContent==='Ready');
    await a.evaluate(({id,revision})=>{
      const socket=window.apexTestRelaySocket;
      for(let i=0;i<23;i++)socket.send(JSON.stringify({type:'ready',ready:false,track:id,revision}));
    },trackIdentities[course]);
    await waitText(a,'#online-status','Slow down a moment.');
    assert.ok((await network(a)).online);
    // The synthetic burst drains the whole bucket; let the relay refill before sending Ready and Start.
    await delay(1200);
    summary.coverage.readyBurst=true;
  }
  await screenshot(a,'lobby',true);
  if(stageCourse){
    const [first,second]=await Promise.all([stageScene(a),stageScene(b)]);
    assert.deepEqual(first,second,'Independent clients built different environments or collision meshes.');
    assert.ok(first.road.every(hit=>Math.abs((hit?.[0]??0)-.72)<.001));
    assert.ok(first.rails.every(hit=>Math.abs((hit?.[0]??0)-.24)<.001));
    assert.deepEqual(first.ground.map(hit=>Math.round(hit?.[0]*100)),[62,45]);
    summary.geometry={hash:first.hash,objects:first.objects,geometries:first.geometries,colliders:first.colliders,
      gates:first.gates.length,roadProbes:first.road.length,railProbes:first.rails.length};
  }

  for (const [first,second] of [['f40','f40'],['f40','r35'],['r35','f40'],['r35','r35']]) {
    await selectCar(a,first);
    await selectCar(b,second);
    const skewMs = await start(a,b);
    await Promise.all([waitRemote(a,second),waitRemote(b,first)]);
    assert.equal((await network(a)).session.track.id,course);
    assert.equal((await network(a)).session.track.revision,(await network(b)).session.track.revision);
    assert.equal((await state(a)).liveRigidBodies, 1);
    assert.equal((await state(b)).liveRigidBodies, 1);
    if(stageCourse){
      const [spawnA,spawnB]=await Promise.all([state(a),state(b)]);
      assert.ok(Math.abs(Math.hypot(...spawnA.position.map((n,i)=>n-spawnB.position[i]))-3.7)<.5);
    }
    if (!summary.combos.length) {
      summary.online = await stats(a,1800);
      if(stageCourse){
        await a.locator('[data-camera=cockpit]').click();
        summary.onlineCockpit=await stats(a,1800);
        await a.locator('[data-camera=chase]').click();
      }
      const before=(await state(a)).position;
      await a.keyboard.down('w');
      await a.waitForFunction(speed=>window.apexDiagnostics.state().speed>speed,stageCourse?12:6,{timeout:12_000});
      await a.keyboard.up('w');
      assert.ok(Math.hypot(...(await state(a)).position.map((n,i)=>n-before[i]))>1);
      if(stageCourse){
        summary.coverage.shortStall=await a.evaluate(async()=>{
          const {laps}=apexDiagnostics.inspect;
          const before=laps.elapsed;
          const until=performance.now()+460;
          while(performance.now()<until) { /* Simulate a main-thread rendering stall. */ }
          for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
          return {status:laps.status,advancedMs:Math.round((laps.elapsed-before)*1000)};
        });
        assert.equal(summary.coverage.shortStall.status,'running');
        assert.ok(summary.coverage.shortStall.advancedMs>=425);
        summary.coverage.dust=[];
        for(const [index,[driver,watcher]] of [[a,b],[b,a]].entries()){
          await driver.keyboard.down('w');
          try {
            await driver.waitForFunction(()=>apexDiagnostics.dust().localEmitted>10&&apexDiagnostics.inspect.car.speed>12);
            await watcher.waitForFunction(()=>apexDiagnostics.dust().remoteEmitted>10&&apexDiagnostics.dust().visible);
            const [own,other,localDust]=await Promise.all([
              state(driver),
              watcher.evaluate(()=>{
                const {scene,T}=apexDiagnostics.inspect;
                const remote=scene.children.find(n=>n.userData.remoteVehicle);
                return {position:remote.position.toArray(),direction:new T.Vector3(0,0,-1).applyQuaternion(remote.quaternion).toArray(),
                  dust:apexDiagnostics.dust()};
              }),
              driver.evaluate(()=>apexDiagnostics.dust()),
            ]);
            const lagDistance=Math.hypot(...own.position.map((n,i)=>n-other.position[i]));
            const directionDot=own.direction.reduce((sum,n,i)=>sum+n*other.direction[i],0);
            assert.ok(lagDistance<12&&directionDot>.98,JSON.stringify({lagDistance,directionDot}));
            summary.coverage.dust.push({local:localDust.localEmitted,remote:other.dust.remoteEmitted,lagDistance,directionDot});
            await screenshot(watcher,'driver-'+(index+1)+'-dust-from-peer');
          } finally {
            await driver.keyboard.up('w');
          }
          await driver.keyboard.press('r');
          await driver.waitForFunction(()=>apexDiagnostics.inspect.car.speed<.4);
        }
        const grid=(await state(a)).position;
        await a.keyboard.down('w');
        try {
          await a.waitForFunction(grid=>apexDiagnostics.inspect.car.current.position.distanceTo(
            new apexDiagnostics.inspect.T.Vector3(...grid))>14,grid);
        } finally {
          await a.keyboard.up('w');
        }
      }
      await screenshot(b,'free-drive-chase');
      const plate = await b.evaluate(()=>{
        const {scene,camera}=window.apexDiagnostics.inspect;
        const target=scene.children.find(n=>n.userData.remoteVehicle);
        const values={main:0,mirror:0};
        window.apexDrawChecks=values;
        target.traverse(node=>{
          if(!node.isMesh||node.userData.shadowOnly)return;
          const previous=node.onBeforeRender;
          node.onBeforeRender=function(renderer,scene,view,...args){
            if(view===camera) values.main++;
            else if(view.fov===30) values.mirror++;
            return previous.call(this,renderer,scene,view,...args);
          };
        });
        return target.children.length;
      });
      assert.ok(plate>0);
      for(const view of ['cockpit','hood']){
        await b.locator('[data-camera='+view+']').click();
        await b.evaluate(()=>{window.apexDrawChecks.main=0;});
        await b.waitForFunction(()=>window.apexDrawChecks.main>0,null,{timeout:8_000});
        await screenshot(b,'free-drive-'+view);
        summary.coverage[view]=true;
      }
      await b.locator('[data-camera=cockpit]').click();
      // Move the sender behind the stationary receiver to exercise the mirror frustum.
      const receiver=await state(b);
      await a.evaluate(({position,direction})=>{
        const car=window.apexDiagnostics.inspect.car;
        car.body.setTranslation({x:position[0]-direction[0]*10,y:position[1],z:position[2]-direction[2]*10},true);
        car.body.setLinvel({x:0,y:0,z:0},true);
      },receiver);
      await b.waitForFunction(()=>window.apexDrawChecks.mirror>0,null,{timeout:10_000});
      await screenshot(b,'free-drive-mirror');
      summary.coverage.mirror=true;
      const pixels=await b.evaluate(()=>{
        const source=document.querySelector('#minimap');
        const data=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
        let count=0;
        for(let i=0;i<data.length;i+=4)if(data[i]<130&&data[i+1]>185&&data[i+2]>205)count++;
        return count;
      });
      assert.ok(pixels>0,'opponent minimap dot');
      summary.coverage.minimap=pixels;
      const peerSpawn=(await state(b)).position;
      await a.keyboard.press('r');
      await delay(600);
      assert.equal((await network(a)).session.id,(await network(b)).session.id);
      assert.ok(Math.hypot(...(await state(b)).position.map((n,i)=>n-peerSpawn[i]))<3,'reset remains local');
      if(stageCourse){
        summary.coverage.recovery=await verifyRecovery(a,b);
        const original=a.viewportSize();
        for(const [label,viewport,view] of [
          ['desktop',original,'chase'],['narrow-hood',{width:420,height:760},'hood'],['narrow-cockpit',{width:420,height:760},'cockpit'],
        ]){
          await a.setViewportSize(viewport);
          await a.locator('[data-camera='+view+']').click();
          await a.evaluate(()=>{
            const message=document.querySelector('#recovery-message');
            message.hidden=false;
            message.textContent='Recovering in 1.0 s';
          });
          const intersections=await a.evaluate(()=>{
            const selectors=['#stage-recovery','#online-hud','.view-group','#telemetry'];
            const boxes=selectors.filter(s=>{
              const node=document.querySelector(s);
              return !node.hidden&&getComputedStyle(node).display!=='none';
            }).map(s=>[s,document.querySelector(s).getBoundingClientRect()]);
            return boxes.flatMap(([a,x],i)=>boxes.slice(i+1).filter(([,y])=>
              x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top).map(([b])=>[a,b]));
          });
          assert.deepEqual(intersections,[],label);
          await screenshot(a,'session-panels-'+label);
        }
        await a.setViewportSize(original);
      }
      const offline = Date.now();
      await a.context().setOffline(true);
      await a.evaluate(()=>window.apexTestRelaySocket.close(4000,'Simulated interruption'));
      await a.waitForFunction(()=>!window.apexDiagnostics.multiplayer().online);
      await delay(1100);
      await a.context().setOffline(false);
      await a.waitForFunction(()=>window.apexDiagnostics.multiplayer().online,null,{timeout:18_000});
      await waitRemote(b,first);
      assert.equal((await network(a)).slot,1);
      summary.coverage.offlineTestMs=Date.now()-offline;
    }
    summary.combos.push({first,second,skewMs,remoteA:(await network(a)).remote,remoteB:(await network(b)).remote});
    console.log('Free Drive',first,second,'start skew',skewMs,'ms');
    await a.locator('#online-end').click();
    await Promise.all([a,b].map(page=>page.locator('#online-room').waitFor({timeout:12_000})));
  }

  await a.locator('#online-mode').selectOption('challenge');
  await b.waitForFunction(()=>document.querySelector('#online-mode').value==='challenge');
  assert.equal(await b.locator('#online-mode option[value=challenge]').textContent(),stageCourse?'Best Stage Challenge':'Best Lap Challenge');
  if(stageCourse){
    await start(a,b);
    await a.locator('#online-end').click();
    await Promise.all([a,b].map(page=>page.locator('#online-room').waitFor()));
    summary.coverage.earlyChallengeEnd=true;
  }
  const skewMs=await start(a,b);
  const invalid=await a.evaluate(()=>window.apexDiagnostics.timeLapPath(185,true));
  assert.equal(invalid.count,0);
  let lapA,lapB;
  if(stageCourse){
    await a.keyboard.press('r');
    await a.keyboard.down('w');
    try {
      await a.waitForFunction(()=>apexDiagnostics.inspect.laps.status==='running');
    } finally {
      await a.keyboard.up('w');
    }
    const suspended=await a.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
      Reflect.deleteProperty(document,'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      return apexDiagnostics.inspect.laps.reason;
    });
    assert.equal(suspended,'Tab suspended');
    summary.coverage.visibility=suspended;
    const {session}=await network(a);
    const duration=session.ends-session.starts;
    const elapsed=(page,ms)=>page.waitForFunction(ms=>apexDiagnostics.multiplayer().remaining<=-ms,ms,{timeout:42_000});
    await elapsed(b,36_000);
    lapB=await b.evaluate(()=>apexDiagnostics.timeLapPath(185));
    await elapsed(a,duration-270);
    await a.context().setOffline(true);
    await a.evaluate(()=>window.apexTestRelaySocket.close(4000,'Finish during reconnection'));
    await a.waitForFunction(()=>!apexDiagnostics.multiplayer().online);
    lapA=await a.evaluate(()=>apexDiagnostics.timeLapPath(195));
    await elapsed(a,duration+80);
    await a.context().setOffline(false);
    summary.coverage.finishThroughReconnect=true;
  }else{
    await delay(29_000);
    [lapA,lapB]=await Promise.all([a,b].map((page,i)=>page.evaluate(speed=>window.apexDiagnostics.timeLapPath(speed),[185,175][i])));
  }
  assert.equal(lapA.count,1);
  assert.equal(lapB.count,1);
  await b.waitForFunction(()=>window.apexDiagnostics.multiplayer().session.results.every(row=>row.best!==null),null,{timeout:6_000});

  await Promise.all([a,b].map(page=>page.locator('#online-finish').waitFor({timeout:20_000})));
  await screenshot(a,'challenge-results');
  const results=(await network(a)).session.results;
  assert.ok(results[0].best<results[1].best);
  assert.ok(results.every(row=>row.sectors.every(Boolean)));
  assert.equal(await a.evaluate(()=>localStorage.getItem('apex.laps.alpine-proving-ground-v1.r35')),null);
  if(stageCourse)assert.equal(await a.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('apex.stages.')&&JSON.parse(localStorage[key]).count>0)),false);
  summary.challenge={skewMs,results};
  await b.locator('#online-return').click();
  await a.locator('#online-room').waitFor();
  await a.locator('#online-leave').click();
  await waitText(b,'#online-drivers','You · Host');
  if(stageCourse){
    for(const id of [defaultTrack,course]){
      await b.locator('#online-track').selectOption(id);
      await b.locator('#stage[data-track='+id+']').waitFor({timeout:45_000});
    }
    summary.coverage.bothPlayersCanHostPineglass=true;
  }
  await b.locator('#online-leave').click();
  await b.locator('#online-entry').waitFor();
  assert.deepEqual(summary.errors,[]);
} finally {
  await browser.close();
  await writeFile(join(output,'metrics.json'),JSON.stringify(summary,null,2)+'\n');
}
