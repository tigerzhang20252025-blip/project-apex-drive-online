import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {launchTestBrowser} from './test-browser.mjs';

const [url = 'http://127.0.0.1:4194/', output = 'test-evidence/production', vehicle = 'f40', course = 'alpine-proving-ground'] = process.argv.slice(2);
assert.ok(vehicle === 'f40' || vehicle === 'r35');
assert.ok(course==='alpine-proving-ground'||course==='pineglass-run-v2');
const stageCourse=course==='pineglass-run-v2';
mkdirSync(output, {recursive:true});
const browser = await launchTestBrowser();
const errors = [], resources = [];
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(request.url() + ' ' + request.failure().errorText));
  page.on('response', response => {
    resources.push({url:response.url(), status:response.status()});
    if (response.status() >= 400) errors.push(response.status() + ' ' + response.url());
  });

  // Sample the actual production audio signal at the master output.
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args) {
      if (args[0] instanceof AudioDestinationNode) {
        window.smokeAudio = this.context.createAnalyser();
        connect.call(this, window.smokeAudio);
        const worklet = this.context.audioWorklet;
        const load = worklet.addModule.bind(worklet);
        worklet.addModule = async (moduleUrl, options) => {
          await load(moduleUrl, options);
          window.smokeWorklet = new URL(moduleUrl, location.href).pathname;
        };
      }
      return connect.apply(this,args);
    };
  });
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForFunction(() => document.querySelector('#stage')?.dataset.ready === 'true',null,{timeout:120000});
  if(await page.locator('#garage-drive').isVisible()){
    if(vehicle==='r35'){
      await page.locator('#garage-select').click();
      await page.locator('[data-vehicle=r35]').click();
      await page.locator('#stage[data-vehicle=r35]').waitFor();
    }
    if(stageCourse){
      await page.locator('[data-course=pineglass-run-v2]').click();
      await page.locator('#stage[data-track=pineglass-run-v2]').waitFor();
    }
    await page.locator('#garage-drive').click();
  }
  assert.equal(await page.evaluate(() => typeof window.apexDiagnostics), 'undefined');
  assert.equal(await page.locator('#scene canvas').count(),1);
  assert.match(await page.locator('#minimap').getAttribute('aria-label'),stageCourse?/Pineglass Run 2\.0.*6\.554 km/:/Alpine Proving Ground.*5\.0\d+ km/);
  await page.screenshot({path:output+'/chase.jpg'});
  await page.locator('#ignition').click();
  await page.waitForFunction(() => Number(document.querySelector('#rpm')?.textContent) > 700);
  await page.locator('[data-camera=cockpit]').click();
  assert.equal(await page.locator('[data-camera=cockpit]').getAttribute('aria-pressed'),'true');
  await page.keyboard.press('p');
  await page.keyboard.press('b');
  await page.waitForFunction(() => document.querySelector('#signal')?.textContent.includes('WIPER LOW'));
  await page.locator('#lap-summary').click();
  await page.keyboard.down('w');
  let telemetry;
  try {
    await page.waitForFunction(profile => Number(document.querySelector('#speed')?.textContent) >= 20
      && document.querySelector('#lap-current')?.textContent !== '—'
      && window.smokeWorklet?.endsWith('/'+profile+'-drive-processor.js'),vehicle,{timeout:30000});
    telemetry = await page.evaluate(() => {
      const labels = Object.fromEntries(['speed','rpm','gear','distance','lap-current'].map(id=>[id,document.getElementById(id).textContent]));
      const analyser = window.smokeAudio;
      const signal = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(signal);
      const audioRms = Math.sqrt(signal.reduce((sum,sample)=>sum+sample*sample,0)/signal.length);
      return {...labels,audioRms,audioState:analyser.context.state,worklet:window.smokeWorklet};
    });
  } finally {
    await page.keyboard.up('w');
  }
  assert.equal(telemetry.audioState,'running');
  assert.ok(telemetry.audioRms > 0.0001,JSON.stringify(telemetry));
  await page.waitForFunction(previous => document.querySelector('#lap-current')?.textContent !== previous,telemetry['lap-current']);
  await page.screenshot({path:output+'/cockpit.jpg'});
  const model=vehicle==='r35'?'r35-rally.glb':'f40-road.glb';
  for(const asset of [model,'driver/left.glb','driver/right.glb','alps.hdr',stageCourse?'gravel-color.jpg':'asphalt.jpg','pine-close.glb']) {
    assert.ok(resources.some(r=>new URL(r.url).pathname.endsWith('/'+asset) && r.status < 400),asset);
  }
  assert.ok(resources.every(r => new URL(r.url).origin === new URL(url).origin), 'unexpected off-origin asset');
  console.log(JSON.stringify({url,telemetry,requests:resources.length,errors},null,2));
  assert.deepEqual(errors,[]);
} finally {
  await browser.close();
  writeFileSync(output+'/network.json',JSON.stringify({resources,errors},null,2));
}
