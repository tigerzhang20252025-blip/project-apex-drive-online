import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:4181/';
const output = process.argv[3] ?? 'test-evidence/pineglass-environment';
await mkdir(output,{recursive:true});
const browser=await launchTestBrowser();
const report = {errors:[],views:[]};
// Triples encode chainage, offset to the right and height above the road.
const views = [
  ['opening-forest-overview',[370,281,620],[379,235,0],.65],
  ['quarry-sequence-aerial',[804,-155,327],[815,6,-6]],
  ['forest-straight-ground',[147,-2.5,2.7],[545,0,.3]],
  ['quarry-brake-approach',[508,-4.2,2.75],[622,1,.40]],
  ['quarry-hook-outside',[652,-14,7],[687,-1,-.5]],
  ['quarry-catch-verge',[914,15,6],[953,3,0]],
  ['skyline-crest',[1590,-35,27],[1760,4,11]],
  ['slate-linked-rights',[3401,-46,39],[3380,0,6]],
  ['spruce-bowl',[2280,84,130],[2310,0,2],.86],
  ['gorge-bridge',[3884,265,121],[3877,0,-19]],
  ['gorge-river-and-piers',[3882,100,-59],[3883,0,-35]],
  ['viaduct-entrance',[3709,-1.5,2.7],[3920,0,3]],
  ['cairn-hairpin',[4280,-49,56],[4270,0,2]],
  ['watchtower-linked-lefts',[5231,53,48],[5220,-4,3]],
  ['valley-hairpin',[5717,21,27],[5777,-2,0]],
];
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('console',message => {
    if(message.type()==='error') report.errors.push(message.text());
  });
  await page.goto(new URL('?diagnostics&garage=1',base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('[data-course=pineglass-run-v2]').click();
  await page.locator('#stage[data-track=pineglass-run-v2]').waitFor({timeout:60_000});
  await page.locator('#garage-drive').click();
  await page.keyboard.press('F8');
  await page.locator('#observer-hud').waitFor();
  await page.keyboard.press('h');
  const initial=await page.evaluate(()=>apexDiagnostics.inspect.car.current.position.toArray());
  for (const [name,eye,aim,zoom=1] of views) {
    const frame=await page.evaluate(async ([eye,aim,zoom]) => {
      const {mountainAlignment:route}=await import('/src/pineglass-v2.ts');
      const position=([d,side,height]) => {
        const station=route.sampleAt(d);
        const p=station.p.addScaledVector(station.right,side);
        p.y+=height;
        return p;
      };
      const {camera}=apexDiagnostics.inspect;
      camera.position.copy(position(eye));
      camera.lookAt(position(aim));
      camera.zoom=zoom;
      camera.updateProjectionMatrix();
      return apexDiagnostics.state().drawFrames;
    },[eye,aim,zoom]);
    await page.waitForFunction(frame=>apexDiagnostics.state().drawFrames>=frame+2,frame);
    await page.screenshot({path:join(output,name+'.jpg'),quality:93});
    assert.deepEqual(await page.evaluate(()=>apexDiagnostics.inspect.car.current.position.toArray()),initial);
    report.views.push({name,eye,aim,zoom});
  }
  await page.keyboard.press('F8');
  await page.locator('#stage:not([data-observer])').waitFor();
  assert.deepEqual(report.errors,[]);
} finally {
  try {
    await writeFile(join(output,'environment-browser.json'),JSON.stringify(report,null,2)+'\n');
  } finally {
    await browser.close();
  }
}
