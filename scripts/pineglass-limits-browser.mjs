import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';

const base=process.argv[2]??'http://127.0.0.1:4181/';
const output=process.argv[3]??'test-evidence/pineglass-limits';
await mkdir(output,{recursive:true});
const browser=await launchTestBrowser();
const evidence={errors:[],vehicles:{}};
const state=page=>page.evaluate(()=>window.limitTest.read());
async function capture(page,name){
  await page.locator('[data-camera=hood]').click();
  const frame=await page.evaluate(()=>apexDiagnostics.state().drawFrames);
  await page.locator('[data-camera=chase]').click();
  await page.waitForFunction(frame=>apexDiagnostics.state().drawFrames>frame,frame);
  await page.screenshot({path:join(output,name+'.jpg'),quality:92});
}

async function setupDeparture(page, returning){
  await page.evaluate(async returning=>{
    const {mountainAlignment:route,mountainShoulderWidth}=await import('/src/pineglass-v2.ts');
    const {pineglassDriver}=await import('/scripts/pineglass-driver.mjs');
    const {T,car,laps}=apexDiagnostics.inspect;
    const read=()=>{
      const {position}=car.current;
      const {station,lateral}=route.project(position.x,position.z);
      const outside=Math.abs(lateral)-route.sampleAt(station).halfWidth-mountainShoulderWidth(station);
      return {station,outside,gates:laps.passedGates,count:laps.count,status:laps.status,reason:laps.reason,warning:laps.trackLimitWarning};
    };
    const neutral={throttle:0,brake:0,steer:0,handbrake:false};
    const station=returning?246:243;
    const road=route.sampleAt(station);
    const lateral=road.halfWidth+mountainShoulderWidth(station)+1.05;
    const heading=road.forward.clone().setY(0).normalize();
    if(returning) heading.applyAxisAngle(new T.Vector3(0,1,0),7*Math.PI/180);
    car.reset(false,road.p.addScaledVector(road.right,lateral),
      new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),Math.atan2(-heading.x,-heading.z)));
    if(!car.running)car.setIgnition();
    car.parkingBrake=true;
    for(let i=0;i<255;i++)car.update(neutral);
    car.parkingBrake=false;
    car.body.setLinvel(heading.multiplyScalar(returning?23:18),true);
    const initial=route.project(car.current.position.x,car.current.position.z);
    const end=initial.station-.4;
    laps.cancel();
    laps.launch();
    for(let d=-4;d<end;d+=.45){
      const sample=route.sampleAt(d);
      const across=initial.lateral*Math.max(0,1-(end-d)/3.5);
      sample.p.addScaledVector(sample.right,across).y+=.36;
      laps.step(sample.p,sample.forward,54,1/120);
    }
    laps.step(car.current.position,car.direction,18,1/120);
    const driver=returning?pineglassDriver(car,{route}).input:neutral;
    window.limitTest={read,advance:steps=>apexDiagnostics.advance(steps,driver)};
    document.querySelector('#pause-layer').hidden=true;
  },returning);
  assert.equal((await state(page)).status,'running');
}

try {
  const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  page.on('pageerror',error=>evidence.errors.push(error.message));
  await page.goto(new URL('?diagnostics&garage=1',base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('[data-course=pineglass-run-v2]').click();
  await page.locator('#stage[data-track=pineglass-run-v2]').waitFor({timeout:45_000});
  for(const model of ['f40','r35']){
    if(await page.locator('#stage').getAttribute('data-vehicle')!==model)
      await page.locator('button[data-vehicle='+model+']').click();
    await page.locator('#stage[data-vehicle='+model+']').waitFor();
    await page.locator('#garage-drive').click();
    await page.keyboard.press('Escape');
    await page.locator('#stage[data-paused=true]').waitFor();
    const banner=page.locator('#sector-banner[data-kind=warning]');
    await setupDeparture(page,true);
    await page.evaluate(()=>window.limitTest.advance(26));
    await banner.waitFor();
    const verge=await state(page);
    assert.ok(verge.warning&&verge.outside>0&&verge.status==='running');
    assert.match(await banner.textContent(),/return to road/);
    await capture(page,model+'-verge-warning');
    await page.evaluate(()=>window.limitTest.advance(126));
    await banner.waitFor({state:'hidden'});
    const returned=await state(page);
    assert.ok(!returned.warning&&returned.outside<0&&returned.status==='running');
    assert.equal(returned.gates,verge.gates);

    await setupDeparture(page,false);
    await page.evaluate(()=>window.limitTest.advance(27));
    await banner.waitFor();
    assert.equal((await state(page)).status,'running');
    await page.evaluate(()=>window.limitTest.advance(100));
    await page.locator('#sector-banner[data-kind=invalid]').waitFor();
    const sustained=await state(page);
    assert.equal(sustained.status,'invalid');
    assert.equal(sustained.reason,'Track limits');
    assert.equal(sustained.count,0);
    await capture(page,model+'-sustained-invalid');
    evidence.vehicles[model]={verge,returned,sustained};
    await page.locator('#open-garage').click();
  }
  assert.deepEqual(evidence.errors,[]);
} finally {
  try {
    await writeFile(join(output,'limits-browser.json'),JSON.stringify(evidence,null,2)+'\n');
  } finally {
    await browser.close();
  }
}
