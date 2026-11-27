import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './test-browser.mjs';

const [url = 'http://127.0.0.1:4181/', output = 'test-evidence/pineglass-full-room'] = process.argv.slice(2);
await mkdir(output, {recursive:true});
const browser = await launchTestBrowser();
const report = { samples:[], errors:[] };

async function driver(vehicle, name) {
  const context = await browser.newContext({viewport:{width:960,height:600}});
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('apex.drive.settings',JSON.stringify({quality:'performance',sensitivity:1})));
  await page.goto(new URL('?diagnostics&garage=1&vehicle='+vehicle,url).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('[data-course=pineglass-run-v2]').click();
  await page.locator('#stage[data-track=pineglass-run-v2]').waitFor({timeout:45_000});
  await page.locator('#play-online').click();
  await page.locator('#online-name').fill(name);
  return page;
}

try {
  const a=await driver('f40','F40 driver');
  const b=await driver('r35','R35 driver');
  await a.locator('#online-create').click();
  await a.locator('#online-code').filter({hasText:/[A-Z2-9]{4}-[A-Z2-9]{4}/}).waitFor();
  await b.locator('#online-code-input').fill(await a.locator('#online-code').textContent());
  await b.locator('#online-join button').click();
  await b.locator('#online-room').waitFor();
  await a.locator('#online-mode').selectOption('challenge');
  for(const page of [a,b]){
    await page.waitForFunction(()=>document.querySelector('#online-mode').value==='challenge');
    await page.evaluate(async()=>{
      const d=apexDiagnostics;
      const {pineglassDriver}=await import('/scripts/pineglass-driver.mjs');
      const {mountainAlignment}=await import('/src/pineglass-v2.ts');
      const driver=pineglassDriver(d.inspect.car);
      window.stageLocation=mountainAlignment.project;
      window.longestDriveFrame=0;
      let previous=performance.now();
      const measure=now=>{
        if(document.querySelector('.shell')?.dataset.mode==='track')window.longestDriveFrame=Math.max(window.longestDriveFrame,now-previous);
        previous=now;
        requestAnimationFrame(measure);
      };
      requestAnimationFrame(measure);
      d.setTestDriver(()=>d.inspect.laps.status==='complete'
        ? {throttle:0,brake:.8,steer:driver.input().steer,handbrake:false}
        : driver.input());
    });
    await page.locator('#online-ready').click();
  }
  await a.locator('#online-start').click();
  await Promise.all([a,b].map(page=>page.locator('#online-hud').waitFor()));
  const initial=await a.evaluate(()=>apexDiagnostics.multiplayer().session);
  assert.equal(initial.ends-initial.starts,600_000);
  assert.equal(initial.track.id,'pineglass-run-v2');

  const sample = page => page.evaluate(()=>{
    const d=apexDiagnostics,{laps,car}=d.inspect;
    const {x,z}=car.current.position;
    const result=d.multiplayer().session.results.find(row=>row.slot===d.multiplayer().slot);
    const frame=d.state();
    return {vehicle:frame.carId,gates:laps.passedGates,total:d.gates.length,status:laps.status,reason:laps.reason,
      remaining:d.multiplayer().remaining,station:window.stageLocation(x,z).station,
      time:laps.last,splits:laps.lastLapSectors,record:result.best,gfx:frame.draws,remote:d.multiplayer().remote.received,
      maxFrameMs:Math.round(window.longestDriveFrame)};
  });
  const deadline=Date.now()+360_000;
  while(Date.now()<deadline){
    const values=await Promise.all([a,b].map(sample));
    report.samples.push(values);
    console.log(values.map(({vehicle,station,gates,status,reason})=>
      [vehicle,Math.round(station)+' m',gates+' gates',status,reason].filter(Boolean).join(' ')).join(' | '));
    assert.ok(values.every(item=>item.status!=='invalid'),JSON.stringify(values));
    if(values.every(item=>item.status==='complete'&&item.record!==null)){
      report.finishes=values;
      break;
    }
    await delay(12_000);
  }
  assert.ok(report.finishes,'Both drivers must finish before the test deadline.');
  for(const {gates,total,time,splits,record,remote} of report.finishes){
    assert.equal(gates,total);
    assert.equal(splits.length,3);
    assert.ok(Math.abs(splits.reduce((a,b)=>a+b,0)-time)<1e-8);
    assert.ok(Math.abs(record-time*1000)<1);
    assert.ok(remote>500);
  }
  assert.deepEqual(report.errors,[]);
  await a.screenshot({path:join(output,'finished-f40.jpg'),quality:90});
  await b.screenshot({path:join(output,'finished-r35.jpg'),quality:90});
  await a.locator('#online-track-leave').click();
} finally {
  await browser.close();
  await writeFile(join(output,'full-room.json'),JSON.stringify(report,null,2)+'\n');
}
