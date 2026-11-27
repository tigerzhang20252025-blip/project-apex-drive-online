import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser } from './test-browser.mjs';

const base=process.argv[2]??'http://127.0.0.1:4181/';
const output=process.argv[3]??'test-evidence/pineglass-recovery';
await mkdir(output,{recursive:true});
const browser=await launchTestBrowser();
const evidence={vehicles:{},errors:[]};
const read=page=>page.evaluate(()=>window.recoveryTest.read());
async function setPause(page,paused) {
  if((await page.locator('#stage').getAttribute('data-paused'))!==String(paused))
    await page.keyboard.press('Escape');
  await page.locator('#stage[data-paused="'+paused+'"]').waitFor();
}
const pause=page=>setPause(page,true);
const resume=page=>setPause(page,false);
const snap=(page,name)=>page.screenshot({path:join(output,name+'.jpg'),quality:91});

async function setup(page) {
  await page.evaluate(async()=>{
    const {mountainAlignment:route}=await import('/src/pineglass-v2.ts');
    const {pineglassDriver}=await import('/scripts/pineglass-driver.mjs');
    const {T,car,laps}=apexDiagnostics.inspect;
    const zero={throttle:0,brake:0,steer:0,handbrake:false};
    const up=new T.Vector3(0,1,0);
    const driver=pineglassDriver(car,{route});
    const read=()=>{
      const p=car.current.position, loc=route.project(p.x,p.z);
      return {station:loc.station,lateral:loc.lateral,height:p.y-route.sampleAt(loc.station).p.y,
        upright:up.clone().applyQuaternion(car.current.rotation).y,speed:car.speed*3.6,contacts:car.contacts,
        running:car.running,fuel:car.fuelLitres,gates:laps.passedGates,status:laps.status,reason:laps.reason,records:laps.count};
    };
    window.recoveryTest={
      read,
      go(target) {
        for(let i=0;i<30000&&read().station<target;i+=24)apexDiagnostics.advance(24,driver.input);
        return read();
      },
      crest() {
        let minimum=4;
        car.body.setLinvel({...car.body.linvel(),y:2.8},true);
        for (let i=0;i<72;i+=6) {
          apexDiagnostics.advance(6,driver.input);
          minimum=Math.min(minimum,car.contacts);
        }
        return {minimum,state:read()};
      },
      place(d,offset,height,angle,roll,velocity=[0,0,0]) {
        const road=route.sampleAt(d);
        const p=road.p.clone().addScaledVector(road.right,offset).addScaledVector(up,height);
        const direction=road.forward.clone().setY(0).normalize().applyAxisAngle(up,angle);
        const rotation=new T.Quaternion().setFromAxisAngle(up,Math.atan2(-direction.x,-direction.z));
        rotation.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),roll));
        car.reset(false,p,rotation);
        const v=direction.multiplyScalar(velocity[0]).addScaledVector(up,velocity[1])
          .addScaledVector(road.right.clone().setY(0),velocity[2]);
        car.body.setLinvel(v,true);
      },
      bench(station) {
        let steps=0;
        for(;steps<1050;steps+=4){
          apexDiagnostics.advance(4,{...zero,throttle:.7});
          const s=read();
          if(Math.abs(s.lateral)<route.sampleAt(s.station).halfWidth-.1&&s.speed>4)return s;
          if(Math.abs(s.station-station)>85)break;
        }
        return read();
      },
    };
  });
}

async function waitRecovered(page,reason,model,shotName) {
  const hud=page.locator('#recovery-message');
  await hud.filter({hasText:reason}).waitFor({timeout:18_000});
  if(shotName) await snap(page,model+'-'+shotName);
  await hud.filter({hasText:'Vehicle recovered'}).waitFor({timeout:10_000});
  await page.waitForFunction(()=>window.recoveryTest.read().contacts===4);
  return read(page);
}

try {
  const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  page.on('pageerror',error=>evidence.errors.push(error.message));
  await page.goto(new URL('?diagnostics&garage=1',base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('[data-course=pineglass-run-v2]').click();
  await page.locator('#stage[data-track=pineglass-run-v2]').waitFor({timeout:45_000});

  for(const model of ['f40','r35']) {
    if(await page.locator('#stage').getAttribute('data-vehicle')!==model)
      await page.locator('button[data-vehicle='+model+']').click();
    await page.locator('#stage[data-vehicle='+model+']').waitFor({timeout:40_000});
    await page.locator('#garage-drive').click();
    await page.locator('#ignition').click();
    await page.waitForFunction(()=>apexDiagnostics.inspect.car.running);
    await page.locator('[data-camera=chase]').click();
    await setup(page);
    await pause(page);
    const crestStart=await page.evaluate(()=>window.recoveryTest.go(1644));
    assert.equal(crestStart.status,'running');
    const crest=await page.evaluate(()=>window.recoveryTest.crest());
    assert.ok(crest.minimum<4);
    assert.equal(crest.state.status,'running');
    assert.ok(crest.state.station>crestStart.station+15);

    const last=await page.evaluate(()=>window.recoveryTest.go(3120));
    assert.equal(last.status,'running');
    assert.ok(last.station>=3120&&last.gates>=12);
    // Seed a car that has already escaped the barrier. The actual solver
    // supplies the fall, failure delay, landing and the recovered vehicle.
    await page.evaluate(()=>window.recoveryTest.place(3160,37,-8,0,0,[0,-9,0]));
    await resume(page);
    const fall=await waitRecovered(page,'Below the road',model,'cliff-countdown');
    assert.equal(fall.gates,last.gates);
    assert.equal(fall.status,'invalid');
    assert.equal(fall.records,0);
    assert.ok(fall.running&&fall.upright>.9);
    assert.ok(fall.station<=last.station&&fall.station>=last.station-9);
    if(model==='f40') await snap(page,'f40-recovered-at-cliff');

    await pause(page);
    const next=await page.evaluate(()=>window.recoveryTest.go(3350));
    assert.ok(next.station>=3350);
    assert.ok(next.gates>fall.gates,'ordered checkpoints stopped after recovery');
    await page.evaluate(d=>window.recoveryTest.place(d,0,.45,0,Math.PI),next.station);
    await resume(page);
    const roll=await waitRecovered(page,'Vehicle overturned',model,model==='r35'?'rollover-countdown':undefined);
    assert.equal(roll.gates,next.gates);
    assert.ok(roll.station<next.station&&roll.station>next.station-12);
    assert.equal(roll.records,0);
    assert.ok(roll.running&&roll.upright>.9);
    await page.waitForFunction(()=>!document.querySelector('#recover-vehicle').disabled);

    const comeFrom=await read(page);
    await page.keyboard.press('Backspace');
    await page.locator('#recovery-message').filter({hasText:'Vehicle recovered'}).waitFor();
    const manual=await read(page);
    await page.locator('#recover-vehicle:disabled').waitFor();
    assert.equal(manual.gates,comeFrom.gates);
    assert.ok(manual.station<=comeFrom.station+.2&&manual.station>comeFrom.station-8);

    await pause(page);
    const bridgeBefore=await page.evaluate(()=>window.recoveryTest.go(3890));
    assert.ok(bridgeBefore.station>=3890);
    await page.evaluate(()=>window.recoveryTest.place(3935,17,-8,0,0,[0,-9,0]));
    await resume(page);
    const bridgeRecovered=await waitRecovered(page,'Below the road',model,'viaduct-countdown');
    assert.ok(bridgeRecovered.station<=bridgeBefore.station&&bridgeRecovered.station>=bridgeBefore.station-9);
    assert.ok(Math.abs(bridgeRecovered.lateral)<3&&bridgeRecovered.upright>.9);
    assert.equal(bridgeRecovered.gates,bridgeBefore.gates);
    assert.equal(bridgeRecovered.records,0);
    await pause(page);
    const bridgeExit=await page.evaluate(()=>window.recoveryTest.go(4055));
    assert.ok(bridgeExit.station>=4055&&bridgeExit.gates>bridgeRecovered.gates);
    await resume(page);

    await page.keyboard.press('r');
    await page.waitForFunction(()=>window.recoveryTest.read().status==='waiting'&&window.recoveryTest.read().station<0);
    await pause(page);
    // From the open shelf after the final Quarry rail, steer back under power.
    const verge={station:1050,lateral:-10.5};
    const bench=await page.evaluate(()=>{
      window.recoveryTest.place(1050,-10.5,-.35,-.94,0);
      return window.recoveryTest.bench(1050);
    });
    assert.ok(Math.abs(bench.lateral)<4.5&&bench.speed>4,JSON.stringify(bench));
    await page.evaluate(()=>window.recoveryTest.place(2850,3.44,0,-Math.PI/2,0));
    await resume(page);
    await page.keyboard.down('w');
    let trapped;
    try {
      trapped=await waitRecovered(page,'Vehicle stuck',model);
    } finally {
      await page.keyboard.up('w');
    }
    assert.ok(trapped.upright>.9&&trapped.running);
    assert.equal(trapped.records,0);

    await page.keyboard.press('r');
    await page.waitForFunction(()=>window.recoveryTest.read().status==='waiting'&&window.recoveryTest.read().station<0);
    await pause(page);
    const beforeStranding=await page.evaluate(()=>window.recoveryTest.go(1047));
    assert.ok(beforeStranding.station>=1047&&beforeStranding.gates>=10);
    // Settle on the lower slope with steering stopped and the handbrake set.
    // This shelf is above the deep-fall cutoff and has no rollover.
    await page.evaluate(()=>window.recoveryTest.place(1022,-44.5,-5.0,0,0));
    await resume(page);
    await page.keyboard.down('Space');
    let stranded;
    try {
      stranded=await waitRecovered(page,'Stranded below the verge',model,'lower-verge-countdown');
    } finally {
      await page.keyboard.up('Space');
    }
    assert.equal(stranded.gates,beforeStranding.gates);
    assert.equal(stranded.status,'invalid');
    assert.equal(stranded.records,0);
    assert.ok(stranded.running&&stranded.upright>.9);
    assert.ok(stranded.station<beforeStranding.station&&stranded.station>beforeStranding.station-9);

    evidence.vehicles[model]={crestStart,crest,last,fall,next,roll,manual,bridgeBefore,bridgeRecovered,bridgeExit,verge,bench,trapped,beforeStranding,stranded};
    await page.locator('#open-garage').click();
  }
  await page.locator('[data-course=alpine-proving-ground]').click();
  await page.locator('#stage[data-track=alpine-proving-ground]').waitFor({timeout:45_000});
  await page.locator('#garage-drive').click();
  await page.locator('#recover-vehicle').waitFor({state:'hidden'});
  assert.deepEqual(evidence.errors,[]);
} finally {
  try {
    await writeFile(join(output,'recovery-browser.json'),JSON.stringify(evidence,null,2)+'\n');
  } finally {
    await browser.close();
  }
}
