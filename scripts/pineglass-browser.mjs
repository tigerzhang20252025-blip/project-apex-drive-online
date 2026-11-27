import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';

const base=process.argv[2]??'http://127.0.0.1:4177/';
const output=process.argv[3]??'test-evidence/pineglass';
const operation=process.argv[4]??'play';
const alpine='alpine-proving-ground', pine='pineglass-run-v2';
const snapshots=[
  [['forest-acceleration',350,'chase'],['quarry-braking',485,'hood'],
    ['quarry-hook',649,'chase'],['quarry-linked-turns',873,'chase'],
    ['skyline-crest',1650,'chase'],['spruce-cutback',2376,'chase'],['slate-double-right',3340,'hood'],
    ['f40-viaduct-entry',3712,'chase'],['f40-viaduct-centre',3880,'chase'],['f40-viaduct-exit',4027,'hood']],
  [['r35-quarry-braking',485,'chase'],['r35-quarry-exit',972,'chase'],
    ['r35-viaduct-entry',3712,'chase'],['r35-viaduct-centre',3880,'chase'],['r35-viaduct-exit',4027,'chase'],
    ['cairn-hairpin',4276,'chase'],['ridge-switch',4390,'chase'],
    ['watchtower-double-left',5265,'hood'],['valley-hairpin',5720,'cockpit'],['valley-descent',5920,'chase']],
];
const report={operation,errors:[],drives:[],snapshots:[],switches:[],performance:{}};
const noInput={throttle:0,brake:0,steer:0,handbrake:false};
await mkdir(output,{recursive:true});
const browser=await launchTestBrowser();

const shutter=(page,name)=>page.screenshot({path:join(output,name+'.jpg'),type:'jpeg',quality:92});
const state=page=>page.evaluate(()=>apexDiagnostics.state());
const select=async(page,id)=>{
  await page.locator('[data-course='+id+']').click();
  await page.locator('#stage[data-track='+id+']').waitFor({timeout:45_000});
  assert.equal(await page.locator('[data-course='+id+']').getAttribute('aria-pressed'),'true');
};
const drive=async page=>{
  await page.locator('#garage-drive').click();
  await page.locator('#garage').waitFor({state:'hidden'});
};
const garage=async page=>{
  await page.locator('#open-garage').click();
  await page.locator('#garage').waitFor();
};
const summarize=values=>{
  const sorted=values.slice().sort((a,b)=>a-b);
  const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {count:sorted.length,median:at(.5),p95:at(.95)};
};
const sampleResources=page=>page.evaluate(()=>{
  const {scene,renderer,T}=apexDiagnostics.inspect;
  const geometry=new Set(),buffers=new Set(),maps=new Set();
  const attr=attribute=>buffers.add(('data' in attribute?attribute.data.array:attribute.array).buffer);
  scene.traverse(node=>{
    if(!(node instanceof T.Mesh))return;
    geometry.add(node.geometry);
    for(const material of Array.isArray(node.material)?node.material:[node.material]){
      for(const value of Object.values(material))if(value instanceof T.Texture)maps.add(value);
    }
    if(node instanceof T.InstancedMesh){
      attr(node.instanceMatrix);
      if(node.instanceColor)attr(node.instanceColor);
    }
  });
  for(const geo of geometry){
    Object.values(geo.attributes).forEach(attr);
    if(geo.index)attr(geo.index);
  }
  if(scene.environment)maps.add(scene.environment);
  const sourceBytes=[...maps].reduce((sum,texture)=>{
    const image=texture.image;
    const source=image?.data?.byteLength??(image?.width??0)*(image?.height??0)*4;
    return sum+source;
  },0);
  const binary=1024**2;
  return {geometryMiB:[...buffers].reduce((sum,b)=>sum+b.byteLength,0)/binary,
    textureSourceMiB:sourceBytes/binary,renderAllocations:{...renderer.info.memory}};
});

async function measure(page,label,places){
  const results=[];
  for(const [index,where] of places.entries()){
    await page.evaluate(where=>apexDiagnostics.placeAtTrack(where),where);
    await page.waitForTimeout(1300);
    await page.evaluate(()=>apexDiagnostics.clearSamples());
    await page.waitForTimeout(2850);
    const s=await state(page);
    results.push({station:where,frames:summarize(s.fpsSamples),physics:summarize(s.physicsSamples),draws:s.draws,mirrorDraws:s.mirrorDraws,triangles:s.triangles});
    assert.equal(s.contacts,4, label+' standing contact at '+where);
    assert.equal(s.courseRoots,1);
    if(index===places.length-1)results.at(-1).resources=await sampleResources(page);
  }
  report.performance[label]=results;
}

async function captureView(page,station,view,filename){
  await page.evaluate(station=>apexDiagnostics.placeAtTrack(station),station);
  await page.locator('[data-camera='+view+']').click();
  const frame=(await state(page)).drawFrames;
  await page.waitForFunction(frame=>apexDiagnostics.state().drawFrames>=frame+2,frame);
  await shutter(page,filename);
}

async function behindGridTest(page){
  await page.locator('#ignition').click();
  await page.waitForFunction(()=>apexDiagnostics.inspect.car.running,null,{timeout:12_000});
  await page.locator('[data-camera=chase]').click();
  await page.keyboard.down('w');
  await page.waitForFunction(()=>apexDiagnostics.inspect.car.speed>7,null,{timeout:15_000});
  await page.keyboard.up('w');
  await page.waitForFunction(()=>apexDiagnostics.inspect.laps.status==='running');
  const moved=await state(page);
  assert.ok(moved.travelled>1);
  await page.keyboard.press('r');
  await page.waitForFunction(()=>apexDiagnostics.inspect.laps.status==='waiting'&&apexDiagnostics.inspect.car.contacts===4);
  const reset=await state(page);
  assert.ok(reset.running);
  assert.ok(reset.speed<.1);
  assert.equal(reset.contacts,4);
}

async function checkMountainMinimap(page) {
  const map=await page.evaluate(async()=>{
    const {mountainAlignment:route}=await import('/src/pineglass-v2.ts');
    const canvas=document.querySelector('#minimap');
    const {width,height}=canvas;
    const {T,car}=apexDiagnostics.inspect;
    const {min,max}=new T.Box3().setFromPoints(route.stations.map(({p})=>p));
    const scale=Math.min((width-44)/(max.x-min.x),(height-35)/(max.z-min.z));
    const ctx=canvas.getContext('2d');
    function hasColor(point,[red,green,blue],radius=3) {
      const x=Math.round(width/2+(point.x-(min.x+max.x)/2)*scale);
      const y=Math.round(height/2+7+(point.z-(min.z+max.z)/2)*scale);
      const {data}=ctx.getImageData(x-radius,y-radius,radius*2+1,radius*2+1);
      for (let i=0;i<data.length;i+=4)
        if(data[i]===red&&data[i+1]===green&&data[i+2]===blue&&data[i+3]===255)return true;
      return false;
    }
    return {
      label:canvas.getAttribute('aria-label'),
      route:[2275,2376,2515,3718,4046,4270,4420].map(d=>hasColor(route.sampleAt(d).p,[130,144,149])),
      marker:hasColor(car.current.position,[255,138,82],5),
    };
  });
  assert.equal(map.label,'Pineglass Run 2.0 · 6.554 km');
  assert.ok(map.route.every(Boolean),JSON.stringify(map));
  assert.ok(map.marker,'Missing vehicle marker on the refined crossing');
  return map;
}

async function driveStageInBrowser(page,vehicle,shots){
  await page.locator('#pause').click();
  await page.evaluate(async noInput=>{
    const {pineglassDriver}=await import('/scripts/pineglass-driver.mjs');
    const {mountainAlignment:route}=await import('/src/pineglass-v2.ts');
    window.pineglassTest={input:pineglassDriver(apexDiagnostics.inspect.car,{route}).input,nearest:route.project};
    window.pineglassTest.car=apexDiagnostics.inspect.car;
    apexDiagnostics.advance(132,noInput);
    document.querySelector('#pause-layer').hidden=true;
  },noInput);
  async function next(station){
    return page.evaluate(station=>{
      const {input,nearest,car}=window.pineglassTest;
      const timer=apexDiagnostics.inspect.laps;
      const location=()=>nearest(car.current.position.x,car.current.position.z).station;
      for(let tick=0;tick<55000;tick+=24){
        if(location()>=station||timer.status==='complete'||timer.status==='invalid')break;
        apexDiagnostics.advance(24,input);
      }
      return {station:location(),status:timer.status,reason:timer.reason,seconds:timer.last,
        splits:timer.lastLapSectors, speed:car.speed*3.6, contacts:car.contacts};
    },station);
  }
  for(const [name,station,camera] of shots){
    const sample=await next(station);
    assert.notEqual(sample.status,'invalid',sample.reason);
    assert.ok(sample.station>=station);
    report.snapshots.push({name,vehicle,requestedStation:station,camera,...sample});
    // A paused replay can advance kilometres between renders. Switch out of
    // chase first so returning to it resets the camera's stored position.
    if(camera==='chase')await page.locator('[data-camera=hood]').click();
    await page.locator('[data-camera='+camera+']').click();
    await page.waitForTimeout(230);
    if(name.endsWith('viaduct-centre'))
      report.snapshots.at(-1).minimap=await checkMountainMinimap(page);
    await shutter(page,name);
  }
  const finished=await next(Infinity);
  assert.equal(finished.status,'complete',JSON.stringify(finished));
  assert.equal(finished.splits.length,3);
  report.drives.push({vehicle,...finished});
  await page.locator('#pause').click();
  await page.locator('#stage-result').waitFor();
  await page.locator('#lap-summary').click();
  assert.equal(await page.locator('#timer-best-label').textContent(),'Best stage');
  await page.waitForFunction(()=>document.querySelector('#lap-count').textContent==='1');
  if(vehicle==='r35')await shutter(page,'stage-result');
  await page.locator('#stage-restart').click();
  await page.waitForFunction(()=>apexDiagnostics.inspect.laps.status==='waiting');
  await page.waitForFunction(()=>document.querySelector('#lap-count').textContent==='1');
}

try{
  const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('404 (Not Found)'))report.errors.push(message.text());});
  await page.goto(new URL('?diagnostics&garage=1',base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:80_000});
  assert.deepEqual(await page.locator('[data-course]').evaluateAll(buttons=>buttons.map(button=>button.dataset.course)),[alpine,pine]);
  if(operation==='performance'){
    await drive(page);
    await measure(page,'alpine-f40',[82,1650,3450]);
    await garage(page);
    await select(page,pine);
    await drive(page);
    await measure(page,'pineglass-f40',[-5,1695,3877,4049]);
    await page.locator('[data-camera=cockpit]').click();
    await measure(page,'pineglass-f40-cockpit',[-5,3877]);
    for(const course of [alpine,pine,alpine,pine]){
      await garage(page);
      await select(page,course);
      await drive(page);
      await page.waitForTimeout(480);
      const s=await state(page), resources=await sampleResources(page);
      assert.equal(s.courseRoots,1);assert.equal(s.liveRigidBodies,1);
      report.switches.push({course,loadMs:s.trackLoadMs,colliders:s.colliderCount,...resources});
    }
  }else{
    await select(page,pine);
    assert.ok(await page.locator('#play-online').isEnabled());
    assert.ok(await page.evaluate(()=>{
      const drive=document.querySelector('#garage-drive').getBoundingClientRect();
      return drive.bottom<=document.querySelector('.garage-panel').getBoundingClientRect().bottom;
    }));
    await shutter(page,'garage-course-selection');
    await drive(page);
    await page.waitForTimeout(1300);
    await page.evaluate(()=>apexDiagnostics.placeAtTrack(-19));
    await page.waitForTimeout(320);
    await shutter(page,'stage-start');
    await page.keyboard.press('r');
    await behindGridTest(page);
    await driveStageInBrowser(page,'f40',snapshots[0]);
    for(const [station,view,name] of [
      [505,'hood','pineglass-f40-hood'],[2230,'cockpit','spruce-warnings'],
      [2354,'chase','sector-1-approach'],[4992,'cockpit','sector-2-approach'],
      [5515,'chase','valley-braking-chase'],[5515,'cockpit','valley-braking-cockpit'],
    ])await captureView(page,station,view,name);
    await garage(page);
    await page.locator('[data-vehicle=r35]').click();
    await page.locator('#stage[data-vehicle=r35]').waitFor();
    await drive(page);
    await behindGridTest(page);
    await driveStageInBrowser(page,'r35',snapshots[1]);
    await captureView(page,505,'hood','pineglass-r35-hood');
    await garage(page);
    await select(page,alpine);
    await drive(page);
    assert.ok(await page.locator('#play-online').isEnabled());
    assert.match(await page.locator('#minimap').getAttribute('aria-label'),/^Alpine Proving Ground/);
    assert.equal(await page.locator('#timer-best-label').textContent(),'Best lap');
    assert.equal(await page.evaluate(()=>apexDiagnostics.inspect.laps.count),0);
    await captureView(page,82,'hood','alpine-r35-hood');
    await garage(page);
    await page.locator('[data-vehicle=f40]').click();
    await page.locator('#stage[data-vehicle=f40]').waitFor();
    await drive(page);
    await captureView(page,82,'hood','alpine-f40-hood');
    await garage(page);
    await select(page,pine);
    await drive(page);
    assert.equal(await page.evaluate(()=>apexDiagnostics.inspect.laps.count),1);
    const saved=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('apex.stages.')).map(key=>[key,JSON.parse(localStorage[key]).count]));
    assert.equal(saved.filter(([,count])=>count===1).length,2);
    report.saved=saved;
  }
  assert.deepEqual(report.errors,[]);
}finally{
  try {
    await writeFile(join(output,operation+'-browser.json'),JSON.stringify(report,null,2)+'\n');
  } finally {
    await browser.close();
  }
}
