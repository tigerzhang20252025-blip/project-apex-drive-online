import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {launchTestBrowser} from './test-browser.mjs';

const [port='4177',output='test-evidence/r35-cockpit']=process.argv.slice(2);
mkdirSync(output,{recursive:true});
const browser=await launchTestBrowser();
const errors=[],controls={};
const report={controls,errors};
try{
  const page=await browser.newPage({viewport:{width:1966,height:1206},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  page.on('response',res=>{if(res.status()>=400)errors.push(res.status()+' '+res.url());});
  await page.goto('http://127.0.0.1:'+port+'/?diagnostics&vehicle=r35',{waitUntil:'domcontentloaded'});
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90000});
  await page.locator('[data-camera=cockpit]').click();
  const read=()=>page.evaluate(()=>{
    const d=window.apexDiagnostics,{car,visual,scene}=d.inspect;
    const object=name=>visual.group.getObjectByName(name);
    return {...d.state(),aux:visual.popups.requested,automatic:car.automatic,wiper:car.wiper.mode,
      dim:Number(document.getElementById('dial-lighting').value),
      brightness:object('R35 factory gear aperture').material.emissiveIntensity,
      stalk:object('R35 combination stalk').rotation.z,collar:object('R35 headlamp collar').rotation.x,
      wipeCollar:object('R35 wipe speed collar').rotation.x,selector:object('R35 stock gear selector').rotation.z,
      activeCar:scene.children.filter(node=>node===visual.group).length,
    };
  });
  const photo=name=>page.screenshot({path:output+'/'+name+'.jpg',quality:93});
  const viewport=async()=>page.locator('#scene canvas').boundingBox();
  const target=action=>page.evaluate(action=>{
    const d=window.apexDiagnostics,{visual,camera,T,renderer}=d.inspect,point=d.controlPoint(action);
    const rect=renderer.domElement.getBoundingClientRect();
    const actual=visual.hit(camera,new T.Vector2((point.x-rect.x)*2/rect.width-1,1-(point.y-rect.y)*2/rect.height));
    return {...point,actual,visible:point.x>=rect.x&&point.x<rect.right&&point.y>=rect.y&&point.y<rect.bottom};
  },action);
  async function consoleView(){
    await page.keyboard.press('v');await page.keyboard.press('g');await page.waitForTimeout(110);
  }
  async function neutralView(){
    await page.keyboard.press('v');await page.waitForTimeout(100);
  }
  const motion={
    ignition:['R35 stock engine starter','position','y',.0005],
    hazard:['R35 hazard switch','position','z',.0005],
    transmission:['R35 stock gear selector','rotation','z',.040],
    'shift-up':['R35 right paddle','rotation','y',.07],
    'shift-down':['R35 left paddle','rotation','y',.07],
  };
  async function click(action,view='neutral'){
    if(view==='console')await consoleView();else await neutralView();
    const point=await target(action);
    assert.ok(point.visible&&point.actual===action,JSON.stringify({action,view,point}));
    await page.mouse.move(point.x-8,point.y-8);
    await page.mouse.move(point.x,point.y);
    await page.waitForFunction(()=>document.querySelector('#scene canvas').style.cursor==='pointer');
    const hint=await page.locator('#scene canvas').getAttribute('title');
    assert.ok(hint&&hint!==action);
    if(motion[action])await page.evaluate(([name,field,axis])=>{
      const object=window.apexDiagnostics.inspect.visual.group.getObjectByName(name);
      const read=()=>object[field][axis],start=read(),deadline=performance.now()+515;
      const sample={peak:0};window.rallyControlMotion=sample;
      function observe(now){
        sample.peak=Math.max(sample.peak,Math.abs(read()-start));
        if(now<deadline)requestAnimationFrame(observe);
      }
      requestAnimationFrame(observe);
    },motion[action]);
    await page.mouse.click(point.x,point.y);
    await page.waitForTimeout(245);
    controls[action]={hint};
    if(motion[action]){
      const displacement=await page.evaluate(()=>window.rallyControlMotion.peak);
      assert.ok(displacement>motion[action][3],JSON.stringify({action,displacement}));
      controls[action].motion=displacement;
    }
  }

  await click('ignition','console');
  assert.equal(await page.evaluate(()=>window.apexDiagnostics.inspect.car.ignition),'OUT');
  await page.locator('#control-notification').filter({hasText:'Press the brake to start the engine'}).waitFor();
  await page.keyboard.down('s');
  try { await click('ignition','console'); }
  finally { await page.keyboard.up('s'); }
  await page.waitForFunction(()=>window.apexDiagnostics.inspect.car.running);
  await neutralView();
  await photo('after');
  await page.waitForTimeout(300);
  const start=(await read()).fpsSamples.length;
  await page.waitForTimeout(4800);
  const idle=await read();
  const stationary=idle.fpsSamples.slice(start),frameSum=stationary.reduce((a,b)=>a+b,0);
  report.stationary={fps:1000*stationary.length/frameSum,frames:stationary.length,buffer:idle.buffer,draws:idle.draws,triangles:idle.triangles};
  await click('light');
  const lit=await read();
  assert.equal(lit.lights,true);assert.ok(lit.collar>.4);controls.light.rotation=lit.collar;
  await click('left');
  const left=await read();
  assert.equal(left.turn,-1);assert.ok(left.stalk<-.12);controls.left.rotation=left.stalk;
  await click('right');
  const right=await read();
  assert.equal(right.turn,1);assert.ok(right.stalk>.12);controls.right.rotation=right.stalk;
  await click('wiper');
  const slow=await read();
  assert.equal(slow.wiper,'LOW');assert.ok(slow.wipeCollar>.44);
  await click('wiper');
  const fast=await read();assert.equal(fast.wiper,'HIGH');assert.ok(fast.wipeCollar>.9);
  controls.wiper.positions=[slow.wipeCollar,fast.wipeCollar];
  await click('wiper');assert.equal((await read()).wiper,'OFF');
  await click('hazard','console');assert.equal((await read()).turn,2);
  await click('popup','console');assert.equal((await read()).aux,true);
  await click('traction','console');assert.equal((await read()).tractionControl,false);
  const beforeDim=await read();
  await click('dial');
  const afterDim=await read();
  assert.ok(afterDim.dim!==beforeDim.dim&&afterDim.brightness!==beforeDim.brightness);
  controls.dial.levels=[beforeDim.dim,afterDim.dim];
  await click('transmission','console');
  const manual=await read();
  assert.equal(manual.automatic,false);assert.equal(manual.gear,0);assert.ok(Math.abs(manual.selector)>.025);
  await click('shift-up');assert.equal((await read()).gear,1);
  await click('shift-up');assert.equal((await read()).gear,2);
  await click('shift-down');assert.equal((await read()).gear,1);
  await click('transmission','console');assert.equal((await read()).automatic,true);
  await page.locator('#settings').click();
  await page.locator('#assist-mode').selectOption('simulation');
  await page.getByRole('button',{name:'Close settings'}).click();
  assert.equal((await read()).assist,'simulation');assert.equal((await read()).tractionControl,false);
  controls.assist={location:'Settings',mode:'simulation'};

  await neutralView();
  const tracking=await page.evaluate(()=>{
    const d=window.apexDiagnostics,{visual,car,camera,T}=d.inspect;
    const speed=visual.group.getObjectByName('R35 Speedometer needle'),tach=visual.group.getObjectByName('R35 Tachometer needle');
    const gear=visual.group.getObjectByName('R35 factory gear aperture');
    const angle=f=>T.MathUtils.degToRad(133)*(1-2*T.MathUtils.clamp(f,0,1));
    const metric={samples:0,maxSpeedError:0,maxTachError:0,maxEyeError:0,maxSpeed:0,gearValues:[]};
    window.rallyTrackMetrics=metric;
    window.rallyGaugeObserve=true;
    function measure(){
      if(!window.rallyGaugeObserve)return;
      metric.samples++;
      metric.maxSpeed=Math.max(metric.maxSpeed,car.speed*3.6);
      metric.maxSpeedError=Math.max(metric.maxSpeedError,Math.abs(speed.rotation.z-angle(car.speed*3.6/340)));
      metric.maxTachError=Math.max(metric.maxTachError,Math.abs(tach.rotation.z-angle(car.rpm/9000)));
      metric.maxEyeError=Math.max(metric.maxEyeError,camera.position.distanceTo(visual.group.localToWorld(visual.eye.clone())));
      if(!metric.gearValues.includes(car.gear))metric.gearValues.push(car.gear);
      requestAnimationFrame(measure);
    }
    requestAnimationFrame(measure);
    return gear.geometry.parameters.width;
  });
  assert.ok(tracking<=.03);
  const drivingStart=(await read()).fpsSamples.length;
  await page.keyboard.down('w');
  try{await page.waitForFunction(()=>window.apexDiagnostics.inspect.car.speed>72/3.6,null,{timeout:18000});}
  finally{await page.keyboard.up('w');}
  report.instruments=await page.evaluate(()=>{window.rallyGaugeObserve=false;return window.rallyTrackMetrics;});
  assert.ok(report.instruments.maxSpeed>=65&&report.instruments.samples>20);
  assert.ok(report.instruments.maxSpeedError<.0001&&report.instruments.maxTachError<.0001&&report.instruments.maxEyeError<.00001);
  const driving=(await read()).fpsSamples.slice(drivingStart),sorted=driving.toSorted((a,b)=>a-b);
  report.driving={fps:1000*driving.length/driving.reduce((a,b)=>a+b,0),frames:driving.length,p95Ms:sorted[Math.floor(sorted.length*.95)]};
  await photo('driving');

  await page.keyboard.press('r');
  await consoleView();await photo('driver-console-look');
  await neutralView();
  const views=[
    ['wheel-and-gauges',[-.369,1.165,.303],[-.371,.919,-.331],45],
    ['center-console',[.282,1.129,.255],[.014,.758,-.095],48],
    ['lighting-stalk',[-.645,.994,.105],[-.538,.875,-.238],38],
    ['wiper-stalk',[-.094,.999,.115],[-.196,.877,-.222],38],
  ];
  for(const [name,from,toward,fov] of views){
    const jpg=await page.evaluate(({from,toward,fov})=>{
      const {camera,renderer,T,scene,visual,car}=window.apexDiagnostics.inspect;
      const zoom=camera.clone(),lift=.074-car.spec.bodyOrigin;
      const point=([x,y,z])=>visual.group.localToWorld(new T.Vector3(x,y+lift,z));
      zoom.position.copy(point(from));zoom.lookAt(point(toward));zoom.fov=fov;zoom.updateProjectionMatrix();
      renderer.render(scene,zoom);
      return renderer.domElement.toDataURL('image/jpeg',.94).split(',')[1];
    },{from,toward,fov});
    writeFileSync(output+'/'+name+'.jpg',Buffer.from(jpg,'base64'));
  }
  const canvas=await viewport();
  await page.mouse.move(canvas.x+canvas.width*.61,canvas.y+canvas.height*.45);
  await page.mouse.down({button:'right'});
  await page.mouse.move(canvas.x+canvas.width*.72,canvas.y+canvas.height*.55,{steps:7});
  await page.mouse.up({button:'right'});
  assert.ok(Math.abs((await read()).lookYaw)>.2);
  await neutralView();assert.equal((await read()).lookYaw,0);
  assert.deepEqual(errors,[]);
}finally{
  await browser.close();
  writeFileSync(output+'/results.json',JSON.stringify(report,null,2));
}
