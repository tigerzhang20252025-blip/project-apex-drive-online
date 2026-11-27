import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';

const base=process.argv[2]??'http://127.0.0.1:4181/';
const output=process.argv[3]??'test-evidence/pineglass-dust';
const mode=process.argv[4]??'gameplay';
const evidence={mode,errors:[],vehicles:{}};
await mkdir(output,{recursive:true});
const browser=await launchTestBrowser();

async function configure(page){
  await page.evaluate(async()=>{
    const {mountainAlignment:route}=await import('/src/pineglass-v2.ts');
    const {pineglassDriver}=await import('/scripts/pineglass-driver.mjs');
    const diag=apexDiagnostics;
    const {T,car,laps}=diag.inspect;
    const up=new T.Vector3(0,1,0);
    const neutral={throttle:0,brake:0,steer:0,handbrake:false};
    const driver=pineglassDriver(car,{route});
    const here=()=>route.project(car.current.position.x,car.current.position.z).station;
    const read=()=>({station:here(),speedKph:car.speed*3.6,contacts:car.contacts,
      slip:Math.max(...car.tireTelemetry.map(w=>w.slipAngle*180/Math.PI)),...diag.dust()});
    window.dustTest={
      here,read,
      prepare({station,speed=0,offset=0,yaw=0}){
        diag.placeAtTrack(station,offset);
        if(yaw){
          const road=route.sampleAt(station);
          const heading=road.forward.clone().setY(0).normalize().applyAxisAngle(up,-yaw*Math.PI/180);
          car.reset(false,road.p.addScaledVector(road.right,offset),
            new T.Quaternion().setFromAxisAngle(up,Math.atan2(-heading.x,-heading.z)));
        }
        if(!car.running)car.setIgnition();
        car.parkingBrake=true;
        for(let i=0;i<130;i++)car.update(neutral);
        car.parkingBrake=false;
        car.body.setLinvel(route.sampleAt(station).forward.setY(0).normalize().multiplyScalar(speed),true);
        // Feed the normal route up to the test location, so scenery shots
        // keep the live timing HUD even when starting midway through a stage.
        const initial=route.project(car.current.position.x,car.current.position.z);
        const end=initial.station-.45;
        laps.launch();
        for(let d=-4;d<end;d+=.45){
          const sample=route.sampleAt(d);
          sample.p.addScaledVector(sample.right,initial.lateral*Math.max(0,1-(end-d)/12)).y+=.36;
          laps.step(sample.p,sample.forward,54,1/120);
        }
        laps.step(car.current.position,car.direction,Math.max(1,speed),1/120);
        document.querySelector('#pause-layer').hidden=true;
      },
      advance(seconds,command){
        const input=command==='line'?driver.input:
          command==='brake'?{...neutral,brake:.8}:command==='accelerate'?{...neutral,throttle:1}:neutral;
        let airborne=0,airbornePuffs=0,minContacts=4,peakSlip=0;
        for(let i=0;i<Math.round(seconds*120);i++){
          const before=diag.dust().localEmitted;
          diag.advance(1,input);
          if(!car.contacts){
            airborne++;
            airbornePuffs+=diag.dust().localEmitted-before;
          }
          peakSlip=Math.max(peakSlip,...car.tireTelemetry.map(w=>w.slipAngle*180/Math.PI));
          minContacts=Math.min(minContacts,car.contacts);
        }
        return {...read(),airborneTicks:airborne,airbornePuffs,minContacts,peakSlip};
      },
      lift(){
        car.body.setLinvel({...car.body.linvel(),y:5.7},true);
      },
      reenter(){
        // Turn the vehicle beyond its wake without removing world-space dust.
        // The subsequent crossing of the existing wake uses the normal solver.
        const road=route.sampleAt(here()+4);
        const heading=road.forward.clone().setY(0).negate().normalize();
        car.reset(false,road.p,new T.Quaternion().setFromAxisAngle(up,Math.atan2(-heading.x,-heading.z)));
        laps.cancel();
        car.body.setLinvel(heading.multiplyScalar(24),true);
      },
      stop(){
        car.body.setLinvel({x:0,y:0,z:0},true);
        car.parkingBrake=true;
      },
      pace(){
        diag.setTestDriver(()=>{
          const {steer}=driver.input();
          return {...neutral,steer,throttle:Math.max(0,Math.min(.7,(42-car.speed)*.3)),
            brake:Math.max(0,Math.min(.65,(car.speed-43)*.22))};
        });
      },
    };
  });
}
const prepare=(page,scenario)=>page.evaluate(scenario=>window.dustTest.prepare(scenario),scenario);
const advance=(page,seconds,command)=>page.evaluate(([seconds,command])=>window.dustTest.advance(seconds,command),[seconds,command]);

async function capture(page,name,photo=false){
  await page.locator('[data-camera=hood]').click();
  await page.locator('[data-camera=chase]').click();
  if(photo){
    await page.evaluate(async()=>{
      const {scene,camera,renderer,T,car}=apexDiagnostics.inspect;
      const frame=()=>new Promise(requestAnimationFrame);
      for(let i=0;i<18;i++)await frame();
      const forward=car.velocity.clone().setY(0).normalize();
      const right=new T.Vector3(-forward.z,0,forward.x);
      camera.position.copy(car.current.position).addScaledVector(right,9.8).addScaledVector(forward,4.5);
      camera.position.y+=4.1;
      camera.lookAt(car.current.position.clone().addScaledVector(forward,-5.2).add(new T.Vector3(0,1,0)));
      camera.fov=50;
      camera.updateProjectionMatrix();
      renderer.render(scene,camera);
    });
  }else{
    const frame=await page.evaluate(()=>apexDiagnostics.state().drawFrames);
    await page.waitForFunction(frame=>apexDiagnostics.state().drawFrames>=frame+2,frame);
  }
  await page.screenshot({path:join(output,name+'.jpg'),quality:93});
}

async function checkDriving(page,model){
  const shots={};
  await prepare(page,{station:82});
  shots.acceleration=await advance(page,2.3,'accelerate');
  assert.ok(shots.acceleration.speedKph>25&&shots.acceleration.localEmitted>8);
  await capture(page,model+'-acceleration',true);

  await prepare(page,{station:182,speed:38});
  shots.fastLoose=await advance(page,1.65,'coast');
  assert.ok(shots.fastLoose.speedKph>115&&shots.fastLoose.active>22);
  await capture(page,model+'-forest-speed',true);
  const cockpitFrame=await page.evaluate(()=>apexDiagnostics.state().drawFrames);
  await page.locator('[data-camera=cockpit]').click();
  await page.waitForFunction(frame=>apexDiagnostics.state().drawFrames>=frame+2,cockpitFrame);
  await page.screenshot({path:join(output,model+'-cockpit.jpg'),quality:93});
  await page.evaluate(()=>apexDiagnostics.setDustEnabled(false));
  await capture(page,model+'-forest-speed-no-dust',true);
  await page.evaluate(()=>apexDiagnostics.setDustEnabled(true));

  await prepare(page,{station:298,speed:21,offset:5.85,yaw:-36});
  shots.drift=await advance(page,.85,'line');
  assert.ok(shots.drift.peakSlip>25&&shots.drift.localEmitted>12);
  await capture(page,model+'-drift',true);

  await prepare(page,{station:549,speed:36});
  shots.braking=await advance(page,.95,'brake');
  assert.ok(shots.braking.speedKph<120&&shots.braking.localEmitted>10);
  await capture(page,model+'-quarry-braking',true);
  await page.evaluate(()=>window.dustTest.stop());
  shots.dispersing=await advance(page,3.35,'coast');
  assert.ok(shots.dispersing.active>0&&shots.dispersing.active<shots.braking.active);
  assert.equal(shots.dispersing.localEmitted,shots.braking.localEmitted);
  shots.faded=await advance(page,2.4,'coast');
  assert.equal(shots.faded.active,0);

  await prepare(page,{station:3077,speed:38});
  shots.compact=await advance(page,1.65,'coast');
  assert.ok(shots.compact.localEmitted>0&&shots.compact.localEmitted<shots.fastLoose.localEmitted*.55);
  await capture(page,model+'-compact',true);

  await prepare(page,{station:1644,speed:32});
  shots.crestApproach=await advance(page,.95,'line');
  assert.ok(shots.crestApproach.active>12);
  await page.evaluate(()=>window.dustTest.lift());
  shots.crestFlight=await advance(page,.60,'line');
  assert.ok(shots.crestFlight.contacts===0&&shots.crestFlight.airborneTicks>35);
  assert.equal(shots.crestFlight.airbornePuffs,0);
  await capture(page,model+'-airborne',true);
  shots.crestLanding=await advance(page,1.25,'line');
  assert.ok(shots.crestLanding.contacts>0&&shots.crestLanding.localEmitted>shots.crestFlight.localEmitted);
  assert.equal(shots.crestLanding.airbornePuffs,0);

  await prepare(page,{station:3877,speed:37});
  shots.bridge=await advance(page,1.65,'line');
  assert.equal(shots.bridge.contacts,4);
  assert.equal(shots.bridge.localEmitted,0);
  await capture(page,model+'-bridge');

  await prepare(page,{station:185,speed:33});
  const plume=await advance(page,.85,'coast');
  assert.ok(plume.active>0);
  await page.keyboard.press('F8');
  await page.locator('#stage[data-observer=active]').waitFor();
  const observing=await page.evaluate(()=>apexDiagnostics.dust());
  assert.equal(observing.localEmitted,plume.localEmitted);
  assert.ok(observing.active>0);
  await page.waitForFunction(()=>apexDiagnostics.dust().active===0,null,{timeout:12_000});
  assert.equal(await page.evaluate(()=>apexDiagnostics.dust().localEmitted),plume.localEmitted);
  await page.keyboard.press('F8');
  await page.locator('#stage:not([data-observer])').waitFor();
  return shots;
}

async function playerView(page,view,mouseDistance=0){
  await page.evaluate(()=>{document.querySelector('#pause-layer').hidden=true;});
  if(await page.locator('#stage').getAttribute('data-view')===view)
    await page.locator('[data-camera=hood]').click();
  await page.locator('[data-camera='+view+']').click();
  if(!mouseDistance)return;
  await page.keyboard.press('Escape');
  await page.mouse.move(644,400);
  await page.mouse.down({button:'right'});
  await page.mouse.move(644+mouseDistance,400,{steps:8});
  await page.mouse.up({button:'right'});
  await page.keyboard.press('Escape');
  assert.ok(Math.abs(await page.evaluate(()=>apexDiagnostics.state().lookYaw))>.8);
}

async function playerFrame(page,name){
  if((await page.locator('#stage').getAttribute('data-view'))==='chase'&&
     (await page.locator('#stage').getAttribute('data-observer'))===null){
    await page.locator('[data-camera=hood]').click();
    await page.locator('[data-camera=chase]').click();
  }
  await page.waitForTimeout(270);
  await page.screenshot({path:join(output,name+'.png')});
  return page.evaluate(()=>{
    const {car,camera}=apexDiagnostics.inspect;
    const {view,lookYaw}=apexDiagnostics.state();
    return {...window.dustTest.read(),view,lookYaw,position:car.current.position.toArray(),camera:camera.position.toArray()};
  });
}

async function compareView(page,name){
  const frame=await playerFrame(page,name);
  await page.evaluate(()=>apexDiagnostics.setDustEnabled(false));
  await playerFrame(page,name+'-off');
  await page.evaluate(()=>apexDiagnostics.setDustEnabled(true));
  return frame;
}

async function checkVisibility(page,model){
  const results={};

  await playerView(page,'chase');
  await prepare(page,{station:148,speed:37});
  await advance(page,2.1,'accelerate');
  results.fast=await compareView(page,model+'-chase-speed');

  await playerView(page,'cockpit');
  await prepare(page,{station:148,speed:37});
  await advance(page,2.1,'accelerate');
  results.windshield=await compareView(page,model+'-cockpit-speed');

  await playerView(page,'chase');
  await prepare(page,{station:3077,speed:38});
  await advance(page,1.65,'coast');
  results.compact=await compareView(page,model+'-chase-compact');

  await playerView(page,'chase');
  await prepare(page,{station:298,speed:21,offset:5.85,yaw:-36});
  const drift=await advance(page,.53,'line');
  results.drift=await compareView(page,model+'-chase-drift');
  results.drift.peakSlip=drift.peakSlip;

  for(const [name,mouse] of [['cockpit-forward',0],['cockpit-left',-278],['cockpit-right',278]]){
    await playerView(page,'cockpit',mouse);
    await prepare(page,{station:298,speed:21,offset:5.85,yaw:-36});
    await advance(page,.53,'line');
    results[name]=await compareView(page,model+'-drift-'+name);
  }

  await playerView(page,'cockpit');
  await prepare(page,{station:155,speed:21});
  await advance(page,1.7,'accelerate');
  await page.evaluate(()=>window.dustTest.reenter());
  await advance(page,.68,'coast');
  results.reentry=await compareView(page,model+'-cockpit-wake');

  await playerView(page,'chase');
  await prepare(page,{station:188,speed:28});
  await advance(page,1.65,'accelerate');
  await page.keyboard.press('F8');
  await page.locator('#stage[data-observer=active]').waitFor();
  await page.evaluate(async()=>{
    const {camera,car,T}=apexDiagnostics.inspect;
    const forward=car.velocity.clone().setY(0).normalize();
    const right=new T.Vector3(-forward.z,0,forward.x);
    camera.position.copy(car.current.position).addScaledVector(right,10.6).addScaledVector(forward,5);
    camera.position.y+=4.5;
    camera.lookAt(car.current.position.clone().addScaledVector(forward,-6.6));
  });
  results.observer=await playerFrame(page,model+'-observer');
  await page.keyboard.press('F8');
  await page.locator('#stage:not([data-observer])').waitFor();
  return results;
}

function percentiles(samples){
  const sorted=samples.slice().sort((a,b)=>a-b);
  const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {samples:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99)};
}

async function benchmark(page,enabled){
  await page.evaluate(enabled=>apexDiagnostics.setDustEnabled(enabled),enabled);
  await prepare(page,{station:53,speed:39});
  await page.evaluate(()=>window.dustTest.pace());
  await page.keyboard.press('Escape');
  await page.locator('#stage[data-paused=false]').waitFor();
  await page.waitForFunction(()=>window.dustTest.here()>=103);
  await page.evaluate(()=>apexDiagnostics.clearSamples());
  await page.waitForFunction(()=>window.dustTest.here()>=322);
  const report=await page.evaluate(()=>{
    const state=apexDiagnostics.state();
    return {frames:state.fpsSamples,physics:state.physicsSamples,draws:state.draws,triangles:state.triangles,dust:apexDiagnostics.dust(),
      speed:state.speed,buffer:state.buffer};
  });
  await page.keyboard.press('Escape');
  await page.locator('#stage[data-paused=true]').waitFor();
  assert.equal(report.dust.active>0,enabled);
  return {...report,frames:percentiles(report.frames),physics:percentiles(report.physics)};
}

try{
  const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  page.on('pageerror',error=>evidence.errors.push(error.message));
  page.on('console',message=>{
    if(message.type()==='error'&&!message.text().includes('404 (Not Found)'))evidence.errors.push(message.text());
  });
  await page.goto(new URL('?diagnostics&garage=1&track=pineglass-run-v2',base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  for(const model of ['f40','r35']){
    if(await page.locator('#stage').getAttribute('data-vehicle')!==model)
      await page.locator('[data-vehicle='+model+']').click();
    await page.locator('#stage[data-vehicle='+model+']').waitFor();
    await page.locator('#garage-drive').click();
    await page.keyboard.press('Escape');
    await page.locator('#stage[data-paused=true]').waitFor();
    await configure(page);
    if(mode==='performance'){
      const pair=model==='f40'?[false,true]:[true,false];
      evidence.vehicles[model]=[];
      for(const [view,order] of [['chase',pair],['cockpit',pair.slice().reverse()]]){
        await playerView(page,view);
        for(const enabled of order)evidence.vehicles[model].push({view,enabled,...await benchmark(page,enabled)});
      }
    }else{
      evidence.vehicles[model]=await (mode==='visibility'?checkVisibility:checkDriving)(page,model);
    }
    await page.locator('#open-garage').click();
  }
  await page.locator('[data-course=alpine-proving-ground]').click();
  await page.locator('#stage[data-track=alpine-proving-ground]').waitFor();
  await page.locator('#garage-drive').click();
  await page.locator('#ignition').click();
  await page.waitForFunction(()=>apexDiagnostics.inspect.car.running);
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(()=>apexDiagnostics.inspect.car.speed>7);
  } finally {
    await page.keyboard.up('w');
  }
  assert.equal(await page.evaluate(()=>apexDiagnostics.dust().localEmitted),0);
  assert.deepEqual(evidence.errors,[]);
} finally {
  try{
    await writeFile(join(output,mode+'.json'),JSON.stringify(evidence,null,2)+'\n');
  }finally{
    await browser.close();
  }
}
