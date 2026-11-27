import {Multiplayer} from './multiplayer.ts';
import {lightFlags, type Progress, type Seat, type Session, type VehicleSample} from '../shared/game.ts';
import {challengeName,defaultTrack,isTrackId,trackIdentities,type TrackId} from '../shared/tracks.ts';
import {ChaseCamera,type ChasePreset} from './chase-camera.ts';
import {ObserverCamera,inspectObserverRoad} from './observer-camera.ts';
import {StageTiming} from './stage-timing.ts';
import {StageRecovery} from './stage-recovery.ts';
import {buildTrack} from './track-runtime.ts';
import {tracks,type TrackDefinition} from './tracks.ts';
import {LapTiming,lapTime,sectorDelta,sectorTime,type SectorRating} from './lap-timing.ts';
import {RoadWear} from './road-wear.ts';
import {TireMarks} from './tire-marks.ts';
import {GravelDust} from './gravel-dust.ts';
import {mirrorExcludedLayer} from './mirrors.ts';
import './style.css';
import {EngineAudio} from './engine-audio.ts';
import * as T from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { asset } from './environment.ts';
import { groundShadow } from './contact-shadow.ts';
import type {Switch} from './car-visual.ts';
import {disposeVisual,type VehicleVisual} from './vehicle-visual.ts';
import {isVehicleId,nominalPower,vehicleIds,vehicles,type VehicleId} from './vehicle-registry.ts';
import {installBindings,shortcutLabel,vehicleShortcuts,type ControlAction,type VehicleShortcut} from './shortcuts.ts';
import {installHelp,cockpitHint,controlReference} from './help.ts';
import {Showroom} from './showroom.ts';
import {drivingAssists,type AssistMode} from './vehicle-spec.ts';
import { noInput, stepTime, Vehicle, type DriverInput } from './vehicle.ts';

type View = 'cockpit' | 'chase' | 'hood' | 'orbit';
type Quality = 'performance' | 'balanced' | 'high';

const views: View[] = ['cockpit', 'chase', 'hood'];
const presets = {
  performance: { pixels: 1440, height: 900, shadows: 768, span: 26 },
  balanced: { pixels: 1920, height: 1080, shadows: 1024, span: 26 },
  high: { pixels: 2560, height: 1440, shadows: 2048, span: 32 },
} as const;
const byId = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const stage = byId('stage');
const settings = byId<HTMLDialogElement>('settings-dialog');
const controls = byId<HTMLDialogElement>('controls-dialog');
const qualityField = byId<HTMLSelectElement>('quality');
const transmission = byId<HTMLSelectElement>('transmission');
const sensitivityField = byId<HTMLInputElement>('sensitivity');
const loading = byId('loading');
const shell=document.querySelector<HTMLElement>('.shell')!;
const recordKey=(track:TrackDefinition,id:VehicleId)=>track.id===defaultTrack
  ?'apex.laps.alpine-proving-ground-v1.'+id
  :'apex.stages.'+track.id+'.'+track.revision+'.'+track.timingLayout+'.'+id;
const newTiming=(track:TrackDefinition)=>track.kind==='circuit'?new LapTiming():new StageTiming(track);
type Timing = ReturnType<typeof newTiming>;
function loadRecords(track:TrackDefinition,id:VehicleId){
  const timing=newTiming(track);
  try{timing.restore(JSON.parse(localStorage.getItem(recordKey(track,id))??'null'));}catch{}
  return timing;
}
function saveRecords(track:TrackDefinition,id:VehicleId,timing:Timing){
  try{localStorage.setItem(recordKey(track,id),JSON.stringify(timing.records()));}catch{}
}

function storeSettings(quality: Quality, sensitivity: number) {
  try { localStorage.setItem('apex.drive.settings', JSON.stringify({ quality, sensitivity })); }
  catch { /* A private browsing session may deny storage. */ }
}

function loadSettings(): { quality: Quality; sensitivity: number } {
  try {
    const data = JSON.parse(localStorage.getItem('apex.drive.settings') ?? '{}');
    return {
      quality: Object.hasOwn(presets, data.quality) ? data.quality : 'balanced',
      sensitivity: typeof data.sensitivity === 'number' ? Math.min(2, Math.max(.6, data.sensitivity)) : 1,
    };
  } catch { return { quality: 'balanced', sensitivity: 1 }; }
}

function drawCourse(canvas:HTMLCanvasElement,track:TrackDefinition,caption:boolean) {
  const {width,height}=canvas;
  const bounds=new T.Box3().setFromPoints(track.minimap.map(s=>s.p));
  const h=caption?35:12, w=caption?44:16;
  const scale=Math.min((width-w)/(bounds.max.x-bounds.min.x),(height-h)/(bounds.max.z-bounds.min.z));
  const xc=(bounds.max.x+bounds.min.x)*.5,zc=(bounds.max.z+bounds.min.z)*.5;
  const mapX=(x:number)=>width*.5+(x-xc)*scale;
  const mapY=(z:number)=>height*.5+(z-zc)*scale+(caption?7:0);
  const ctx=canvas.getContext('2d')!;
  ctx.strokeStyle=caption?'#829095':'#a6afa9';
  ctx.lineWidth=caption?3.4:2.4;
  ctx.lineJoin=ctx.lineCap='round';
  ctx.beginPath();
  for(const {p} of track.minimap)ctx.lineTo(mapX(p.x),mapY(p.z));
  ctx.stroke();
  const mark=(x:number,z:number,color:string,r:number)=>{
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(mapX(x),mapY(z),r,0,2*Math.PI);ctx.fill();
  };
  const start=track.gates[0].p;
  mark(start.x,start.z,'#dda67b',caption?3.8:3);
  if(track.kind==='stage'){
    const finish=track.gates.at(-1)!.p;
    mark(finish.x,finish.z,'#efeee4',caption?3.6:3);
    if(caption)for(const i of track.sectors){
      const {p}=track.gates[i];mark(p.x,p.z,'#79a7ac',2.3);
    }
  }
  if(caption){
    ctx.fillStyle='#a9b4bb';
    ctx.font='bold 11px sans-serif';
    ctx.letterSpacing='1.4px';
    ctx.fillText(track.kind.toUpperCase()+'  ·  '+(track.length/1000).toFixed(3)+' KM',15,19);
  }
  return {mapX,mapY};
}

function makeMinimap(track:TrackDefinition) {
  const minimap = byId<HTMLCanvasElement>('minimap');
  const { width, height } = minimap;
  const base = document.createElement('canvas');
  base.width = width; base.height = height;
  const {mapX,mapY}=drawCourse(base,track,true);
  minimap.setAttribute('aria-label',track.name+' · '+(track.length/1000).toFixed(3)+' km');
  const cameraCtx = minimap.getContext('2d')!;
  return (x: number, z: number, direction: T.Vector3, opponent?:T.Vector3) => {
    cameraCtx.clearRect(0, 0, width, height);
    cameraCtx.drawImage(base, 0, 0);
    cameraCtx.save();
    cameraCtx.translate(mapX(x), mapY(z));
    cameraCtx.rotate(Math.atan2(direction.x, -direction.z));
    cameraCtx.beginPath();
    cameraCtx.moveTo(0, -8); cameraCtx.lineTo(5.4, 5.5); cameraCtx.lineTo(0, 3.1); cameraCtx.lineTo(-5.4, 5.5);
    cameraCtx.closePath();
    cameraCtx.fillStyle = '#ff8a52'; cameraCtx.fill();
    cameraCtx.restore();
    if(opponent){
      const px=mapX(opponent.x),py=mapY(opponent.z);
      const near=Math.hypot(px-mapX(x),py-mapY(z))<9;
      cameraCtx.beginPath();
      cameraCtx.arc(px,py,near?6:3.6,0,Math.PI*2);
      if(near){cameraCtx.strokeStyle='#73d7e9';cameraCtx.lineWidth=1.5;cameraCtx.stroke();}
      else{
        cameraCtx.fillStyle='#73d7e9';cameraCtx.fill();
        cameraCtx.strokeStyle='#17212a';cameraCtx.lineWidth=1.2;cameraCtx.stroke();
      }
    }
  };
}

async function start() {
  const params=new URLSearchParams(location.search);
  const diagnostic=import.meta.env.DEV&&params.has('diagnostics');
  let currentVehicle:VehicleId='f40', currentTrack=tracks[defaultTrack];
  try{
    const stored=diagnostic?params.get('vehicle'):localStorage.getItem('apex.vehicle');
    if(isVehicleId(stored))currentVehicle=stored;
    const savedTrack=diagnostic?params.get('track'):localStorage.getItem('apex.track');
    if(isTrackId(savedTrack))currentTrack=tracks[savedTrack];
  }catch{}
  let inGarage=!diagnostic||params.has('garage');
  let selecting=false,switching=false;
  shell.dataset.mode=inGarage?'garage':'track';
  const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.035;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  const scene = new T.Scene();
  scene.background = new T.Color(0x829db1);
  scene.fog = new T.Fog(0x7e897c,480,1760);
  const rim = new T.HemisphereLight(0xe2ebf5, 0x978d77, .86);
  scene.add(rim);
  const sun = new T.DirectionalLight(0xfff0d8, 2.35);
  sun.castShadow = true;
  sun.shadow.bias = -.00014;
  sun.shadow.normalBias = .003;
  sun.shadow.camera.layers.enable(1);
  sun.shadow.camera.layers.enable(3);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 215;
  scene.add(sun, sun.target);
  const skyPromise = Promise.all([
    new HDRLoader().loadAsync(asset('alps.hdr')),
    new T.TextureLoader().loadAsync(asset('alps-background.jpg')),
  ]).then(([hdr, panorama])=>{
    hdr.mapping=T.EquirectangularReflectionMapping;
    scene.environment=hdr;scene.environmentIntensity=.42;scene.environmentRotation.y=-.47;
    // Display the full 4K panorama directly. The prefiltered reflection map is for materials.
    panorama.colorSpace=T.SRGBColorSpace;
    const skydome=new T.Mesh(new T.SphereGeometry(1300,80,44).scale(-1,1,1),
      new T.MeshBasicMaterial({map:panorama,fog:false,toneMapped:false,depthWrite:false}));
    skydome.rotation.y=Math.PI-.47;
    skydome.renderOrder=-5;scene.add(skydome);
    return skydome;
  });

  await RAPIER.init();
  const wear=new RoadWear();
  const panorama=skyPromise.then(sky=>sky.material.map!);
  const trackLoadingStart=performance.now();
  let [runtime,initialVisual,skydome]=await Promise.all([
    buildTrack(currentTrack,renderer,panorama,wear),
    vehicles[currentVehicle].build(),
    skyPromise,
  ]);
  let visual:VehicleVisual=initialVisual;
  let trackLoadMs=performance.now()-trackLoadingStart;
  let {world,gantry}=runtime;
  scene.add(runtime.root);
  let car = new Vehicle(world,vehicles[currentVehicle].spec,currentTrack.grid[0]);
  await visual.load();
  const applyTrackLighting=()=>{
    const {panorama,background,fog,hemisphere,sunIntensity}=currentTrack.environment;
    skydome.visible=panorama;
    (scene.background as T.Color).setHex(background);
    scene.fog=new T.Fog(...fog);
    rim.color.setHex(hemisphere[0]);
    rim.groundColor.setHex(hemisphere[1]);
    sun.intensity=sunIntensity;
    scene.userData.forest=runtime.root.userData.forest;
  };
  applyTrackLighting();
  const updateVegetation=(eye:T.Vector3)=>runtime.updateVegetation(eye);
  const marks=new TireMarks(scene,wear);
  const dust=new GravelDust(scene);
  let laps=loadRecords(currentTrack,currentVehicle);
  let recovery=currentTrack.kind==='stage'?new StageRecovery(currentTrack):undefined;
  let multiplayer:Multiplayer;
  let onlineRun:Session|null=null;
  let gridSlot:Seat=1;
  let poseReset=0;
  let submittedAttempts=0;
  let stageLaunchOnGo=false;
  const physicsSamples:number[]=[];
  const showroom=new Showroom(scene.environment);
  function driveStep(input:DriverInput,timed=true,completedAt?:number){
    if(timed&&laps instanceof StageTiming&&(stageLaunchOnGo||(car.running&&input.throttle>0))){
      laps.launch();stageLaunchOnGo=false;
    }
    const physicsStart=diagnostic?performance.now():0;
    car.update(input);
    if(diagnostic&&physicsSamples.length<12000)physicsSamples.push(performance.now()-physicsStart);
    visual.popups.step(stepTime);marks.update(car);
    dust.stepLocal(currentTrack,car,input,stepTime);
    if(!onlineRun)gantry.signal.step(stepTime);
    if(timed)timeLap(car.current.position,car.direction,car.signedSpeed,stepTime,completedAt);
    if(timed&&recovery&&laps instanceof StageTiming&&!document.hidden&&(!onlineRun||(!paused&&!overlayOpen()))&&
      recovery.step(car,input,laps.passedGates,stepTime))return applyRecovery();
    return false;
  }
  function timeLap(position:T.Vector3,heading:T.Vector3,speed:number,dt:number,completedAt?:number){
    const count=laps.count;
    laps.step(position,heading,speed,dt);
    if(laps.count===count)return;
    if(!onlineRun)saveRecords(currentTrack,currentVehicle,laps);
    else if(laps.lastLapSectors){
      const [a,b,c]=laps.lastLapSectors;
      const first=Math.round(a*1000), second=Math.round((a+b)*1000), total=Math.round((a+b+c)*1000);
      if(multiplayer.submitAttempt(submittedAttempts+1,[first,second-first,total-second],completedAt))submittedAttempts++;
    }
  }
  const q=(n:number,precision=1000)=>Math.round(n*precision)/precision;
  function networkPose():VehicleSample{
    const {position,rotation}=car.current;
    const wheels=car.wheelState;
    const flags=(car.brakeLight?lightFlags.brake:0)|(car.lights?lightFlags.lights:0)|
      (visual.popups.requested?lightFlags.auxiliary:0)|(car.gear<0?lightFlags.reverse:0)|
      (car.blink&&car.turn!==1?lightFlags.left:0)|(car.blink&&car.turn!==-1?lightFlags.right:0);
    return {
      position:[q(position.x),q(position.y),q(position.z)],
      orientation:[q(rotation.x,10000),q(rotation.y,10000),q(rotation.z,10000),q(rotation.w,10000)],
      velocity:[q(car.velocity.x,100),q(car.velocity.y,100),q(car.velocity.z,100)],
      steering:[q(wheels[0].steer,100),q(wheels[1].steer,100)],
      wheels:wheels.map(w=>q(w.spin,100)) as [number,number,number,number],
      suspension:wheels.map(w=>q(w.length,100)) as [number,number,number,number],
      flags,reset:poseReset,progress:q(laps.progress,10000),
      ...(currentTrack.dust&&dust.rates.some(rate=>rate>0)?{dust:dust.rates}:{}),
    };
  }
  function networkTiming():Progress{
    return {sector:laps.currentSector,ms:laps.current===null?null:Math.round(laps.current*1000),
      splits:laps.sectors.map(n=>n===null?null:Math.round(n*1000)) as [number|null,number|null,number|null],
      invalid:laps.status==='invalid',complete:laps.status==='complete'};
  }
  let groundContact=groundShadow(scene,car);
  (inGarage?showroom.scene:scene).add(visual.group);
  function settle(vehicle=car){
    for(let i=0;i<130;i++)vehicle.update(noInput);
    vehicle.travelled=0;
  }
  settle();

  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', 'Interactive 3D driving view');
  byId('scene').append(canvas);
  const camera = new T.PerspectiveCamera(58,1,.032,currentTrack.environment.viewDistance);
  camera.layers.enable(mirrorExcludedLayer);
  let orbitYaw=0,orbitPitch=.19,orbitDistance=5.35;
  let view: View = 'chase';
  let { quality, sensitivity } = loadSettings();
  let paused = false;
  let launched = false;
  let looking = false;
  let lookYaw = 0, lookPitch = -.195, gearLook = false;
  let snapView = true;
  let width = 1, height = 1;
  let frameCap = 0;
  let clock = performance.now();
  let fpsWindow = 0, frames = 0;
  let accumulator = 0;
  let sinceUI = 1;
  const chaseCamera=new ChaseCamera();
  let drawFrames = 0;
  let shadowRefresh=0;
  const lightDir=new T.Vector3(.339,.672,.659).normalize(); // brightest region of alps.hdr, in the panorama frame
  const lightX=new T.Vector3(0,1,0).cross(lightDir).normalize(),lightY=lightDir.clone().cross(lightX).normalize();
  const shadowAnchor=new T.Vector3();
  const samples: number[] = [];
  const keys = new Set<string>();
  let map = makeMinimap(currentTrack);
  const viewButtons = document.querySelectorAll<HTMLButtonElement>('[data-camera]');
  const ignition = byId<HTMLButtonElement>('ignition');
  const engineDot = byId('engine-dot');
  const status = byId('status');
  const telemetry = byId('telemetry');
  const labels = Object.fromEntries(['speed','rpm','gear','gear-mode','signal','sector','distance','fps','tach','ignition-text'].map(id => [id,byId(id)]));
  const setText = (el: HTMLElement, value: string) => { if (el.textContent !== value) el.textContent = value; };

  const observer = new ObserverCamera(camera);
  const observerHud = byId('observer-hud');
  const observerReadout = byId('observer-readout');
  const observerFields = ['position', 'elevation', 'speed', 'road', 'grade', 'warning'].map(id => byId('observer-' + id));
  let observerView: { layers: number; far: number; fog: T.Fog | T.FogExp2 | null } | undefined;
  let observerDrag = false;
  let observerUiDue = 0;

  function endObservation() {
    if (!observerView) return;
    camera.layers.mask = observerView.layers;
    camera.far = observerView.far;
    camera.updateProjectionMatrix();
    scene.fog = observerView.fog;
    observerView = undefined;
    delete stage.dataset.observer;
    delete shell.dataset.observer;
    observerHud.hidden = true;
    observer.clearInput();
    observerDrag = false;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    keys.clear();
    looking = false;
    accumulator = 0;
    clock = performance.now();
    snapView = true;
    frameCap = 4;
    sinceUI = 1;
    if (paused) byId('resume').focus({preventScroll: true});
    else stage.focus({preventScroll: true});
  }

  function beginObservation() {
    observerView = { layers: camera.layers.mask, far: camera.far, fog: scene.fog };
    observer.begin();
    camera.layers.enable(1);
    camera.far = Math.max(camera.far, 5200);
    camera.updateProjectionMatrix();
    if (scene.fog instanceof T.Fog) scene.fog = new T.Fog(scene.fog.color, 1250, 4600);
    if (laps.status === 'running') laps.invalidate('Observer used');
    byId('observer-attempt').hidden = laps.reason !== 'Observer used';
    stage.dataset.observer = shell.dataset.observer = 'active';
    observerHud.hidden = false;
    observerUiDue = 0;
    looking = false;
    canvas.style.cursor = '';
    canvas.title = '';
    keys.clear();
    accumulator = 0;
    stage.focus({preventScroll: true});
  }

  function updateObserverReadout(now: number) {
    if (observerHud.hidden || observerReadout.hidden || now < observerUiDue) return;
    observerUiDue = now + 125;
    const [position, elevation, speed, road, grade, warning] = observerFields;
    const xyz = (point: T.Vector3) => point.toArray().map(value => value.toFixed(1)).join(' / ') + ' m';
    const estimate = inspectObserverRoad(currentTrack, camera.position);
    setText(position, xyz(camera.position));
    setText(elevation, camera.position.y.toFixed(1) + ' m');
    setText(speed, observer.speed.toFixed(1) + ' / ' + observer.baseSpeed.toFixed(1) + ' m/s');
    setText(road, xyz(estimate.sample.p));
    setText(grade, (estimate.distance / 1000).toFixed(3) + ' km / ' +
      (Number.isFinite(estimate.grade) ? (estimate.grade > 0 ? '+' : '') + estimate.grade.toFixed(1) + '%' : '—'));
    const messages = [
      estimate.ambiguous ? 'Ambiguous road estimate. Nearby sections overlap or run close together.' : '',
      estimate.overhead ? 'Road centreline is above the camera. Check which level you are viewing.' : '',
    ].filter(Boolean);
    warning.hidden = messages.length === 0;
    setText(warning, messages.join(' '));
  }

  function resize() {
    width = Math.max(1, stage.clientWidth);
    height = Math.max(1, stage.clientHeight);
    const preset = presets[quality];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65, preset.pixels / width, preset.height / height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    frameCap = 4;
  }

  function applyQuality(value: Quality) {
    quality = value;
    dust.setQuality(quality);
    const { shadows, span } = presets[quality];
    sun.shadow.mapSize.set(shadows, shadows);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    sun.shadow.camera.left = sun.shadow.camera.bottom = -span;
    sun.shadow.camera.right = sun.shadow.camera.top = span;
    sun.shadow.camera.updateProjectionMatrix();
    shadowRefresh=0;
    resize();
    storeSettings(quality, sensitivity);
  }

  function setView(next: View) {
    if (view !== next) {
      view = next;
      snapView = true;
      lookYaw = 0; lookPitch = -.195;gearLook=false;
      looking = false;
      canvas.style.cursor = '';

    }
    for (const button of viewButtons) {
      const isSelected = button.dataset.camera === next;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    }
    if(view==='cockpit')camera.layers.disable(1);else camera.layers.enable(1);
    telemetry.hidden = view === 'cockpit'||view==='orbit';
    stage.dataset.view = view;
    frameCap = 14;
  }

  function setPaused(next: boolean) {
    paused = next;
    keys.clear();
    looking = false;
    canvas.style.cursor = '';
    accumulator = 0;
    byId('pause-layer').hidden = !paused;
    setText(byId('pause-heading'), onlineRun ? 'Session continues' : 'Paused');
    setText(byId('pause-mode-label'), onlineRun ? 'MULTIPLAYER' : 'FREE DRIVE');
    byId('restart').hidden = Boolean(onlineRun);
    setText(byId('pause-garage'),onlineRun?'Leave Room':'Return to garage');
    setText(byId('pause'), paused ? 'Resume' : 'Pause');
    stage.dataset.paused = String(next);
    updateRecoveryHud();
    if (next) byId('resume').focus();
    else stage.focus({ preventScroll: true });
    sinceUI = 1;
    frameCap = 4;
  }

  const dialLighting=byId<HTMLInputElement>('dial-lighting');
  const assistOption=byId<HTMLSelectElement>('assist-mode');
  function setAssist(mode:AssistMode){
    if(!car.spec.awd)return;
    car.setAssist(mode);assistOption.value=mode;
    try{localStorage.setItem('apex.assist.'+currentVehicle,mode);}catch{}
  }
  function restoreAssist(){
    try{
      const mode=localStorage.getItem('apex.assist.'+currentVehicle);
      setAssist(mode&&Object.hasOwn(drivingAssists,mode)?mode as AssistMode:'sport');
    }catch{setAssist('sport');}
  }
  restoreAssist();
  assistOption.addEventListener('change',()=>setAssist(assistOption.value as AssistMode));
  try{const saved=localStorage.getItem('apex.dial-lighting');if(saved!==null)dialLighting.value=saved;}catch{}
  const setDialLight=()=>{visual.instrumentBrightness=Number(dialLighting.value);frameCap=2;};
  setDialLight();
  dialLighting.addEventListener('input',()=>{setDialLight();try{localStorage.setItem('apex.dial-lighting',dialLighting.value);}catch{}});

  function reset(restart = false) {
    const spawn=currentTrack.grid[onlineRun&&gridSlot===2?1:0];
    car.reset(restart,spawn.position,spawn.rotation);
    if(onlineRun)poseReset++;
    laps.cancel();
    recovery?.reset();
    if(onlineRun&&!restart)dust.resetLocal();else dust.clear();
    byId('stage-result').hidden=true;
    if(restart){marks.clear();visual.popups.reset();gantry.signal.reset();restoreAssist();}else marks.disconnect();
    accumulator = 0;
    lookYaw = 0; lookPitch = -.195;gearLook=false;
    snapView = true;
    keys.clear();
    sinceUI = 1;
    if (restart) {
      launched = false;
      setView('chase');
      setPaused(false);
    }
  }

  function canRecover() {
    return recovery?.ready && !inGarage && !paused && !observerView && !overlayOpen() && !document.hidden &&
      (!onlineRun || (multiplayer.connected && !multiplayer.prestart && !multiplayer.finished));
  }

  function applyRecovery() {
    if (!recovery || !(laps instanceof StageTiming)) return false;
    const station=recovery.recover(laps.passedGates);
    if (station===null) {
      const spawn=currentTrack.grid[onlineRun&&gridSlot===2?1:0];
      car.reset(false,spawn.position,spawn.rotation);
    } else {
      const {p,forward}=currentTrack.sampleAt(station);
      const yaw=Math.atan2(-forward.x,-forward.z);
      car.reset(false,p,{x:0,y:Math.sin(yaw/2),z:0,w:Math.cos(yaw/2)});
    }
    laps.resumeAfterRecovery();
    if(onlineRun)dust.resetLocal();else dust.clear();
    if (onlineRun) poseReset++;
    marks.disconnect();
    keys.clear();
    snapView=true;
    frameCap=4;
    sinceUI=1;
    updateRecoveryHud();
    return true;
  }

  const recoveryHud=byId('stage-recovery');
  const recoverButton=byId<HTMLButtonElement>('recover-vehicle');
  const recoveryMessage=byId('recovery-message');
  function updateRecoveryHud() {
    const show=Boolean(recovery)&&!inGarage&&!paused&&!observerView&&(!onlineRun||(!multiplayer.prestart&&!multiplayer.finished));
    recoveryHud.hidden=!show;
    if (!show || !recovery) return;
    recoverButton.disabled=!canRecover();
    const pending=recovery.pending;
    const message=pending ? pending.reason+' · recovering in '+Math.max(1,Math.ceil(pending.seconds))+' s' :
      recovery.recentlyRecovered ? 'Vehicle recovered'+(laps.status==='invalid'?' · no time recorded':'') : '';
    recoveryMessage.hidden=!message;
    setText(recoveryMessage,message);
  }
  recoverButton.addEventListener('click',()=>{
    if(canRecover())applyRecovery();
    stage.focus({preventScroll:true});
  });

  let audio=new EngineAudio(currentVehicle);
  const volume=byId<HTMLInputElement>('engine-volume');
  try{const saved=localStorage.getItem('apex.engine-volume');if(saved!==null)volume.value=saved;}catch{}
  audio.volume=Number(volume.value);
  volume.addEventListener('input',()=>{
    audio.volume=Number(volume.value);
    try{localStorage.setItem('apex.engine-volume',volume.value);}catch{}
  });
  const armsField=byId<HTMLInputElement>('driver-arms');
  const tractionField=byId<HTMLInputElement>('traction-setting');
  const absField=byId<HTMLInputElement>('abs-setting');
  const notifyField=byId<HTMLInputElement>('control-notifications');
  const shortcutField=byId<HTMLInputElement>('shortcut-visibility');
  const notification=byId('control-notification');
  const strip=byId('shortcut-strip');
  const shortcutButtons=new Map<VehicleShortcut,HTMLButtonElement>();
  let notificationTimer:number|undefined;

  function readPreference(id:string,fallback:boolean) {
    try { const value=localStorage.getItem(id);return value===null?fallback:value==='true'; }
    catch { return fallback; }
  }
  function writePreference(id:string,value:boolean){
    try { localStorage.setItem(id,String(value)); } catch {}
  }
  const armsKey=()=> 'apex.driver-arms.'+currentVehicle;
  function restoreArms(){
    visual.driver.visible=readPreference(armsKey(),currentVehicle==='f40');
    armsField.checked=visual.driver.visible;
  }
  restoreArms();
  notifyField.checked=readPreference('apex.control-notifications',true);
  shortcutField.checked=readPreference('apex.shortcut-visibility',true);
  strip.hidden=!shortcutField.checked;
  notifyField.addEventListener('change',()=>{
    writePreference('apex.control-notifications',notifyField.checked);
    if(!notifyField.checked)notification.hidden=true;
  });
  shortcutField.addEventListener('change',()=>{
    writePreference('apex.shortcut-visibility',shortcutField.checked);
    strip.hidden=!shortcutField.checked;
  });
  const onOff=(enabled:boolean)=>enabled?'ON':'OFF';
  const gearText=(gear:number)=>gear===-1?'R':gear===0?'N':String(gear);
  function notify(text:string){
    if(!notifyField.checked)return;
    setText(notification,text);
    notification.hidden=false;
    window.clearTimeout(notificationTimer);
    notificationTimer=window.setTimeout(()=>{notification.hidden=true;},1550);
  }
  function controlState(action:VehicleShortcut):{text:string;active?:boolean}{
    switch(action){
      case 'transmission': return {text:car.automatic?'AUTO':'MANUAL',active:!car.automatic};
      case 'shift-down': return {text:'↓ Shift'};
      case 'shift-up': return {text:'↑ Shift'};
      case 'traction': return {text:'TC '+onOff(car.tractionControl),active:car.tractionControl};
      case 'abs': return {text:'ABS '+onOff(car.absEnabled),active:car.absEnabled};
      case 'light': return {text:'Lights '+onOff(car.lights),active:car.lights};
      case 'wiper': return {text:'Wiper '+car.wiper.mode,active:car.wiper.mode!=='OFF'};
      case 'ignition': return {text:car.ignition==='START'?'Starting':car.running?'Engine ON':'Ignition',active:car.running};
      case 'arms': return {text:'Arms '+onOff(visual.driver.visible),active:visual.driver.visible};
      case 'popup': return {text:(currentVehicle==='f40'?'Pop-ups ':'Aux ')+onOff(visual.popups.requested),active:visual.popups.requested};
      case 'left': return {text:'Left '+onOff(car.turn===-1||car.turn===2)};
      case 'right': return {text:'Right '+onOff(car.turn===1||car.turn===2)};
      case 'hazard': return {text:'Hazards '+onOff(car.turn===2)};
      case 'parking': return {text:'Parking '+onOff(car.parkingBrake)};
    }
  }
  function supportsShortcut(action:VehicleShortcut){
    if(action==='abs')return Boolean(car.spec.awd);
    if(action==='parking')return visual.hitTargets.some(target=>target.userData.action==='parking');
    return true;
  }
  function syncControlPanel(){
    for(const [action,button] of shortcutButtons){
      const state=controlState(action),key=shortcutLabel(action);
      setText(button.firstElementChild as HTMLElement,key);
      setText(button.lastElementChild as HTMLElement,state.text);
      if(state.active!==undefined)button.setAttribute('aria-pressed',String(state.active));
      button.hidden=!supportsShortcut(action)||((action==='shift-up'||action==='shift-down')&&car.automatic);
      const accessibleLabel=vehicleShortcuts[action][1]+' · '+key+(state.active===undefined?'':' · '+state.text);
      if(button.getAttribute('aria-label')!==accessibleLabel)button.setAttribute('aria-label',accessibleLabel);
    }
    setText(byId('ignition-shortcut'),shortcutLabel('ignition'));
    tractionField.checked=car.tractionControl;
    absField.checked=car.absEnabled;
    armsField.checked=visual.driver.visible;
    const requested=car.pendingManualGear;
    const gearMode=requested===null?(car.automatic?'AUTO':'MAN'):'SHIFT → '+gearText(requested);
    setText(labels['gear-mode'],gearMode);
  }
  function applySwitch(action:ControlAction,back=false){
    audio.unlock();
    if(action==='shift')action=back?'shift-down':'shift-up';
    if(action==='transmission'&&car.speed>.6){
      notify('Stop the vehicle to change transmission mode');
      transmission.value=car.automatic?'auto':'manual';
      return;
    }
    if(action!=='arms'&&action!=='abs'&&action!=='shift-up'&&action!=='shift-down')visual.animateControl?.(action);
    let message='';
    switch(action){
      case 'shift-up':
      case 'shift-down': {
        const result=!car.automatic&&car.running&&car.isShifting?'busy':car.shift(action==='shift-up'?1:-1);
        const reasons={
          automatic:'Switch to manual to select gears',engine:'Start the engine before shifting',
          direction:'Stop before changing driving direction',rpm:'Downshift blocked by engine speed',
          synchro:'Gear blocked by synchronizer — speed too high',
          limit:action==='shift-up'?'Already in the highest gear':'Already in reverse',busy:'Shift in progress',
        };
        if(result==='accepted'){
          visual.animateControl?.(action);
          audio.shiftCue(car.gear,view==='cockpit');
        }else if(result==='synchro'){
          audio.synchroGrind(view==='cockpit');
        }
        message=result==='accepted'?(car.pendingManualGear===null?'Gear ':'Shift requested → ')+gearText(car.gear):reasons[result];
        break;
      }
      case 'transmission':
        car.toggleTransmission();
        transmission.value=car.automatic?'auto':'manual';
        message=car.automatic?'Automatic transmission':'Manual transmission';
        break;
      case 'arms':
        visual.driver.visible=!visual.driver.visible;
        writePreference(armsKey(),visual.driver.visible);
        message=visual.driver.visible?'Driver arms shown':'Driver arms hidden';
        break;
      case 'abs':
        if(!car.spec.awd)return;
        car.absEnabled=!car.absEnabled;
        message='ABS '+onOff(car.absEnabled);
        break;
      case 'traction':
        car.tractionControl=!car.tractionControl;
        message='Traction control '+onOff(car.tractionControl);
        break;
      case 'light':
        car.lights=!car.lights;
        message='Headlights '+onOff(car.lights);
        break;
      case 'popup':
        visual.popups.requested=!visual.popups.requested;
        if(currentVehicle==='f40')audio.lampMotor(visual.popups.requested,camera.position.distanceTo(visual.group.position));
        message=(currentVehicle==='f40'?'Pop-up lamps ':'Auxiliary lamps ')+onOff(visual.popups.requested);
        break;
      case 'wiper':
        car.wiper.cycle();
        message='Wipers '+car.wiper.mode;
        break;
      case 'ignition':
        car.setIgnition();
        if (!launched&&car.ignition==='START'){launched=true;setView('cockpit');}
        message=car.ignition==='START'?'Starting engine':'Engine stopped';
        break;
      case 'key':car.operateKey(back);break;
      case 'parking':
        car.parkingBrake=!car.parkingBrake;
        message='Parking brake '+onOff(car.parkingBrake);
        break;
      case 'assist':{
        const modes=Object.keys(drivingAssists) as AssistMode[];
        setAssist(modes[(modes.indexOf(car.assistMode)+1)%modes.length]);
        break;
      }
      case 'dial':
        dialLighting.value=String(Number(dialLighting.value)<.35?.55:Number(dialLighting.value)<.7?.90:.15);
        dialLighting.dispatchEvent(new Event('input'));
        break;
      case 'left':
      case 'right':
      case 'hazard':{
        const direction=action==='left'?-1:action==='right'?1:2;
        car.turn=car.turn===direction?0:direction;
        message=vehicleShortcuts[action][1]+' '+onOff(car.turn===direction);
        break;
      }
    }
    if(message)notify(message);
    syncControlPanel();
    sinceUI=1;
    frameCap=Math.max(frameCap,4);
  }
  for(const [field,action,value] of [
    [armsField,'arms',()=>visual.driver.visible],
    [tractionField,'traction',()=>car.tractionControl],
    [absField,'abs',()=>car.absEnabled],
  ] as const){
    field.addEventListener('change',()=>{if(field.checked!==value())applySwitch(action);});
  }
  for(const action of Object.keys(vehicleShortcuts) as VehicleShortcut[]){
    if(['left','right','hazard','parking'].includes(action))continue;
    const button=document.createElement('button');
    button.type='button';
    button.dataset.shortcut=action;
    button.append(document.createElement('kbd'),document.createElement('span'));
    button.addEventListener('click',()=>{
      if(paused||overlayOpen())return;
      applySwitch(action);
      stage.focus({preventScroll:true});
    });
    shortcutButtons.set(action,button);
    byId('vehicle-keys').append(button);
  }

  function overlayOpen() { return settings.open || controls.open || help.active; }

  function showDialog(dialog: HTMLDialogElement) {
    keys.clear();
    looking = false;
    transmission.value = car.automatic ? 'auto' : 'manual';
    transmission.disabled = car.speed > .6;
    byId('assist-row').hidden=!car.spec.awd;
    byId('abs-row').hidden=!car.spec.awd;
    byId('abs-key').closest('label')!.toggleAttribute('hidden',!car.spec.awd);
    byId('parking-key').closest('label')!.toggleAttribute('hidden',!supportsShortcut('parking'));
    byId('controls-reference').textContent=controlReference(car,visual);
    syncControlPanel();
    dialog.showModal();
  }

  const timerPanel=byId('lap-panel'),timerDetails=byId('lap-details'),summary=byId('lap-summary');
  const stageResult=byId('stage-result');
  byId('stage-restart').addEventListener('click',()=>{
    if(!onlineRun||!multiplayer.finished)reset();
    stage.focus({preventScroll:true});
  });
  function updateTrackLabels(){
    const attempt=currentTrack.kind==='stage'?'stage':'lap';
    setText(byId('track-name'),currentTrack.name);
    setText(byId('timer-last-label'),'Last '+attempt);
    setText(byId('timer-best-label'),'Best '+attempt);
    setText(byId('timer-splits-label'),'Best '+attempt);
    setText(byId('timer-setting-label'),'Show '+attempt+' timing');
    byId('test-start-lights').hidden=currentTrack.kind==='stage';
    stageResult.hidden=true;
    stage.dataset.track=currentTrack.id;
    updateRecoveryHud();
  }
  function updateStageResult(){
    const show=currentTrack.kind==='stage'&&!inGarage&&!paused&&(!onlineRun||!multiplayer.finished)&&
      (laps.status==='complete'||(laps.status==='invalid'&&!recovery?.hasRecovered));
    stageResult.hidden=!show;
    if(!show)return;
    setText(byId('stage-result-title'),laps.status==='complete'?'Stage complete · '+lapTime(laps.last):'Stage invalid · '+laps.reason);
    const splits=laps.status==='complete'?laps.lastLapSectors:null;
    setText(byId('stage-result-splits'),splits?splits.map((split,i)=>'S'+(i+1)+' '+sectorTime(split)).join('  ·  '):
      'Continue driving or restart for a timed attempt.');
  }
  const timingVisible=byId<HTMLInputElement>('show-timing');
  try{timingVisible.checked=localStorage.getItem('apex.timing')!=='hidden';}catch{}
  timerPanel.hidden=!timingVisible.checked;
  timingVisible.addEventListener('change',()=>{timerPanel.hidden=!timingVisible.checked;try{localStorage.setItem('apex.timing',timerPanel.hidden?'hidden':'shown');}catch{}});
  summary.addEventListener('click',()=>{timerDetails.hidden=!timerDetails.hidden;summary.setAttribute('aria-expanded',String(!timerDetails.hidden));sinceUI=1;stage.focus({preventScroll:true});});
  byId('reset-timer').addEventListener('click',()=>{
    if(onlineRun)return;
    laps.reset();saveRecords(currentTrack,currentVehicle,laps);sinceUI=1;stage.focus({preventScroll:true});
  });
  const timerFields=Object.fromEntries(['state','current','count','progress','last','best','theo','history'].map(k=>[k,byId('lap-'+k)]));
  const sectorBanner=byId('sector-banner');
  const sectorCells=[0,1,2].map(i=>{
    const el=timerPanel.querySelector<HTMLElement>(`.sector-cell[data-sector="${i}"]`)!;
    return {
      el,
      tag:el.querySelector<HTMLElement>('.sector-tag')!,
      time:el.querySelector<HTMLElement>('.sector-time')!,
      delta:el.querySelector<HTMLElement>('.sector-delta')!,
    };
  });
  const bestSectorFields=[1,2,3].map(n=>byId('best-s'+n));
  const bestLapSectorFields=[1,2,3].map(n=>byId('bestlap-s'+n));
  const sectorTags:Record<SectorRating|'active',string>={
    pending:'',baseline:'SET',active:'●',purple:'PB',green:'▲',equal:'=',yellow:'▼',invalid:'×',
  };
  let historyShown='';
  function updateLaps(){
    if(timerPanel.hidden)return;
    const signalText=gantry.signal.phase==='countdown'?gantry.signal.count+' / 5 red lamps':gantry.signal.phase==='go'?'Lights out':'';
    setText(byId('start-light-state'),signalText);
    (byId('test-start-lights') as HTMLButtonElement).disabled=Boolean(onlineRun)||paused||gantry.signal.phase==='countdown';
    if(timerPanel.dataset.status!==laps.status)timerPanel.dataset.status=laps.status;
    const stageCourse=currentTrack.kind==='stage';
    const attempt=stageCourse?'Stage':'Lap';
    const waiting=stageCourse?(onlineRun&&multiplayer.prestart?'Awaiting start':'Drive to start'):'Cross start line';
    setText(timerFields.state,laps.status==='running'?attempt+' '+(laps.count+1):laps.status==='complete'?'Stage complete':
      laps.status==='invalid'?laps.reason:waiting);
    setText(timerFields.current,lapTime(laps.status==='complete'?laps.last:laps.current));
    const display=laps.sectorDisplay();
    const usesBestSectorRef=display.refKinds.some(k=>k==='bestSector');
    let bannerText='',bannerKind='';
    if(display.mode==='last-lap'){
      bannerKind='last-lap';
      bannerText=(stageCourse?'STAGE COMPLETE':'LAST LAP')+(display.lap!==null?' · '+(stageCourse?'#':'L')+display.lap:'')+(usesBestSectorRef?' · REF BEST SEC':'');
    }else if(display.mode==='invalid'){
      bannerKind='invalid';
      bannerText=laps.status==='running'&&display.reason
        ?'LAST LAP INVALID · '+display.reason
        :'INVALID · NOT RECORDED';
    }else if(laps instanceof StageTiming&&laps.trackLimitWarning){
      bannerKind='warning';
      bannerText='Track limits · return to road';
    }else if(usesBestSectorRef){
      bannerKind='ref';
      bannerText='DELTA VS BEST SEC';
    }
    sectorBanner.hidden=!bannerText;
    if(bannerText){
      if(sectorBanner.dataset.kind!==bannerKind)sectorBanner.dataset.kind=bannerKind;
      setText(sectorBanner,bannerText);
    }
    for(let i=0;i<3;i++){
      const cell=sectorCells[i];
      const isActive=display.mode==='current'&&display.activeSector===i&&display.sectors[i]===null;
      const state:SectorRating|'active'=isActive?'active':display.ratings[i];
      if(cell.el.dataset.state!==state)cell.el.dataset.state=state;
      setText(cell.tag,sectorTags[state]);
      const value=isActive?display.currentSectorTime:display.sectors[i];
      setText(cell.time,sectorTime(value));
      setText(cell.delta,isActive||display.mode==='invalid'?'':sectorDelta(display.deltas[i]));
    }
    if(timerDetails.hidden)return;
    setText(timerFields.count,String(laps.count));setText(timerFields.progress,Math.floor(laps.progress*100)+'%');
    setText(timerFields.last,lapTime(laps.last));setText(timerFields.best,lapTime(laps.best));
    setText(timerFields.theo,lapTime(laps.theoreticalBest));
    for(let i=0;i<3;i++){
      setText(bestSectorFields[i],sectorTime(laps.bestSectors[i]));
      setText(bestLapSectorFields[i],sectorTime(laps.bestLapSectors?laps.bestLapSectors[i]:null));
    }
    const history=laps.history.map(l=>attempt+' '+l.lap+'   '+lapTime(l.seconds)+(l.seconds===laps.best?'   BEST':'')).join('\n');
    if(history!==historyShown){historyShown=history;timerFields.history.replaceChildren(...(history?history.split('\n'):[]).map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));}
  }
  function updateUI() {
    updateRecoveryHud();
    const debug=byId('debug-panel');
    if(!debug.hidden){
      const contacts=car.spec.wheels.map((_,i)=>car.controller.wheelIsInContact(i)?'●':'○').join(' ');
      const loads=car.spec.wheels.map((_,i)=>((car.controller.wheelSuspensionForce(i)??0)/1000).toFixed(1)).join(' / ');
      setText(debug,`VEHICLE TELEMETRY
${(car.speed*3.6).toFixed(1)} km/h   ${Math.round(car.rpm)} rpm
Front steer  ${(car.wheelState[0].steer*180/Math.PI).toFixed(1)}° / ${(car.wheelState[1].steer*180/Math.PI).toFixed(1)}°
Yaw rate     ${(car.body.angvel().y*180/Math.PI).toFixed(1)}°/s
FL FR RL RR  ${contacts}
Load kN      ${loads}
Fuel         ${car.fuelLitres.toFixed(2)} L
Input        ${driverInput().steer.toFixed(2)}
Radius v/ω   ${Math.abs(car.body.angvel().y)>.02?(car.speed/Math.abs(car.body.angvel().y)).toFixed(1)+' m':'—'}
Torque F/R   ${Math.round(car.deliveredFrontShare*100)} / ${Math.round((1-car.deliveredFrontShare)*100)} %
TC / ABS     ${car.tcActive} / ${car.absActive}
${car.spec.awd?car.tireTelemetry.map((w,i)=>['FL','FR','RL','RR'][i]+' '+w.surface+' '+(w.slipAngle*180/Math.PI).toFixed(1)+'° '+(w.contact?'contact':'air')).join('\n')+'\nSlip angle is estimated from contact-point velocity.':''}`);
    }
    updateLaps();
    updateStageResult();
    const progress=laps.progress;
    setText(labels.sector,currentTrack.regionAt(car.current.position.x,car.current.position.z));
    setText(labels.distance, `${(car.travelled / 1000).toFixed(2)} KM DRIVEN · ${Math.floor(progress*100)}% ${currentTrack.kind.toUpperCase()}`);
    setText(labels.speed, String(Math.round(car.speed * 3.6)));
    setText(labels.rpm, String(Math.round(car.rpm)));
    setText(labels.gear,gearText(car.indicatedGear));
    syncControlPanel();
    setText(labels['ignition-text'], car.running ? 'Stop engine' : 'Start engine');
    ignition.setAttribute('aria-label',car.running?'Stop engine':'Start engine');
    ignition.classList.toggle('engaged', car.running);
    ignition.setAttribute('aria-pressed', String(car.running));
    setText(status, car.running ? 'ENGINE RUNNING' : car.ignition==='OUT' ? 'KEY REMOVED' : 'IGNITION '+car.ignition);
    engineDot.classList.toggle('on', car.running);
    const signal = car.blink ? (car.turn === -1 ? '◀' : car.turn === 1 ? '▶' : car.turn === 2 ? '◀ ▶' : '') : '';
    setText(labels.signal, [car.lights ? 'LAMPS' : '', signal, car.wiper.mode==='OFF'?'':'WIPER '+car.wiper.mode].filter(Boolean).join(' · '));
    labels.tach.style.transform = `scaleX(${Math.min(1, car.rpm / car.spec.redline)})`;
    map(car.current.position.x, car.current.position.z, car.direction, multiplayer.remote.visiblePosition);
    multiplayer.renderTrack();
  }

  const forward = new T.Vector3(), target = new T.Vector3(), desired = new T.Vector3();
  const flat = new T.Quaternion(), aim = new T.Quaternion();
  const pitch = new T.Quaternion(), yaw = new T.Quaternion();
  const yAxis = new T.Vector3(0,1,0), xAxis = new T.Vector3(1,0,0);
  const helper = new T.Object3D();
  const headMotion=byId<HTMLInputElement>('head-motion');
  try{const saved=localStorage.getItem('apex.head-motion');if(saved!==null)headMotion.value=saved;}catch{}
  headMotion.addEventListener('input',()=>{try{localStorage.setItem('apex.head-motion',headMotion.value);}catch{}});
  const headRotation=new T.Quaternion();
  const chaseSetting=byId<HTMLSelectElement>('chase-camera');
  try{if(localStorage.getItem('apex.chase-camera')==='standard')chaseSetting.value='standard';}catch{}
  chaseSetting.addEventListener('change',()=>{
    if(view==='chase'){snapView=true;frameCap=4;}
    try{localStorage.setItem('apex.chase-camera',chaseSetting.value);}catch{}
  });

  function drivingCameraPose(dt: number) {
    const { position, quaternion } = visual.group;
    if(view==='chase'){
      chaseCamera.update(camera,position,quaternion,car,dt,chaseSetting.value as ChasePreset,snapView);
    }else{
      forward.set(0,0,-1).applyQuaternion(quaternion);
      flat.setFromAxisAngle(yAxis,Math.atan2(-forward.x,-forward.z));
      let fov=47;
      if(view==='orbit'){
        const planar=orbitDistance*Math.cos(orbitPitch);
        desired.set(Math.sin(orbitYaw)*planar,.34+orbitDistance*Math.sin(orbitPitch),-Math.cos(orbitYaw)*planar).applyQuaternion(flat).add(position);
        target.set(0,.30,0).add(position);
        helper.position.copy(desired);helper.lookAt(target);
        aim.copy(helper.quaternion).multiply(new T.Quaternion(0,1,0,0));
      }else{
        const local=view==='cockpit'?visual.eye:visual.hood;
        desired.copy(local);
        if(view==='cockpit'&&gearLook){desired.x+=.066;desired.y+=.015;desired.z-=.041;}
        desired.applyQuaternion(quaternion).add(position);
        yaw.setFromAxisAngle(yAxis,view==='cockpit'?lookYaw:0);
        pitch.setFromAxisAngle(xAxis,view==='cockpit'?lookPitch:-.035);
        // Horizon stabilisation attenuates pitch and roll while the eye stays on the seat.
        headRotation.copy(flat).slerp(quaternion,view==='cockpit'?Number(headMotion.value):1);
        aim.copy(headRotation).multiply(yaw).multiply(pitch);
        fov=view==='cockpit'?67:64;
      }
      camera.position.copy(desired);
      camera.quaternion.copy(aim);
      if(Math.abs(fov-camera.fov)>.005){
        camera.fov=fov;
        camera.updateProjectionMatrix();
      }
    }
    snapView = false;
  }

  function cameraPose(dt: number) {
    if (!observerView) drivingCameraPose(dt);
    skydome.position.copy(camera.position);
    updateVegetation(camera.position);

    const position = observerView ? camera.position : visual.group.position;
    const texel=2*sun.shadow.camera.right/sun.shadow.mapSize.x;
    shadowAnchor.copy(position);
    const lx=position.dot(lightX),ly=position.dot(lightY);
    shadowAnchor.addScaledVector(lightX,Math.round(lx/texel)*texel-lx).addScaledVector(lightY,Math.round(ly/texel)*texel-ly);
    sun.target.position.copy(shadowAnchor);sun.position.copy(shadowAnchor).addScaledVector(lightDir,110);

  }

  let testDriver: (()=>DriverInput) | undefined;
  function driverInput(): DriverInput {
    if(import.meta.env.DEV && testDriver)return testDriver();
    return {
      throttle: Number(keys.has('KeyW') || keys.has('ArrowUp')),
      brake: Number(keys.has('KeyS') || keys.has('ArrowDown')),
      steer: Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')),
      handbrake: keys.has('Space'),
    };
  }

  function frame(now: number) {
    requestAnimationFrame(frame);
    const elapsed = Math.max(0,(now - clock) / 1000);
    const dt = Math.min(elapsed, .075);
    clock = now;
    if(inGarage){
      accumulator+=Math.min(dt,.03);
      if(!overlayOpen()&&!switching&&(frameCap||car.running||car.ignition==='START')){
        while(accumulator>=stepTime){
          if(car.running||car.ignition==='START')car.update(noInput);
          visual.popups.step(stepTime);accumulator-=stepTime;
        }
      }else accumulator=0;
      audio.update(car,camera,true,!overlayOpen()&&!switching&&!document.hidden&&document.hasFocus());
      if(frameCap>0||car.running||car.ignition==='START'){
        frameCap=Math.max(0,frameCap-1);
        visual.sync(car,1);
        showroom.render(renderer,visual,car,width,height);
      }
      help.update();return;
    }
    const acceptsInput = !observerView && !paused && !overlayOpen() && !document.hidden;
    const active = Boolean(onlineRun) || (!observerView && !paused && !overlayOpen());
    if (observerView && !document.hidden) {
      dust.advanceTime(dt);
      observer.step(Math.min(elapsed, .25));
      updateObserverReadout(now);
    }
    const maxOnlineGap=.9;
    const serverNow=onlineRun?multiplayer.serverNow():0;
    const holding={...noInput,handbrake:true};
    if(onlineRun){
      if(serverNow>=onlineRun.starts && serverNow-elapsed*1000<(onlineRun.ends??Infinity)){
        if(elapsed>maxOnlineGap)laps.invalidate('Simulation interrupted');
        else if(multiplayer.timingConnectionExpired)laps.invalidate('Connection interrupted');
      }
      gantry.signal.synchronize(onlineRun.starts-serverNow);
    }
    if (active) {
      const input=onlineRun&&!acceptsInput?holding:driverInput();
      accumulator += onlineRun&&elapsed<=maxOnlineGap ? elapsed : dt;
      while (accumulator >= stepTime) {
        accumulator -= stepTime;
        const completedAt=serverNow-accumulator*1000;
        const held=onlineRun&&(completedAt<onlineRun.starts||completedAt>(onlineRun.ends??Infinity));
        const timed=!onlineRun||(!held&&!document.hidden&&!multiplayer.timingConnectionExpired);
        if(driveStep(held?holding:input,timed,completedAt)) {
          accumulator=0;
          break;
        }
      }
    }
    if(onlineRun){
      multiplayer.tick(now,dt,networkPose,networkTiming);
      dust.stepRemote(currentTrack,multiplayer.remote.dustSource,world,dt);
    }
    audio.update(car,camera,view==='cockpit',acceptsInput&&document.hasFocus());
    if (active || (observerView && !document.hidden) || frameCap > 0) {
      if (frameCap > 0) frameCap--;
      const alpha=active ? Math.min(1,accumulator/stepTime) : 1;
      marks.flush(now/1000);
      gantry.sync();
      visual.sync(car,alpha);
      groundContact.update(visual.group,alpha);
      cameraPose(dt);
      dust.flush(!observerView&&(view==='cockpit'||view==='hood'));
      if(!observerView&&view==='cockpit')visual.mirrors.update(renderer,scene,visual.group,now,currentTrack.kind==='stage');
      renderer.shadowMap.autoUpdate=(!observerView&&view==='cockpit'&&!car.spec.awd)||now>=shadowRefresh;
      if(renderer.shadowMap.autoUpdate)shadowRefresh=now+(quality==='high'?0:1000/(car.spec.awd?20:30));
      renderer.render(scene, camera);
      drawFrames++;help.update();
    }
    sinceUI += dt;
    if (sinceUI > .075) { updateUI(); sinceUI = 0; }

    if (active && elapsed > 0) {
      fpsWindow += elapsed;
      frames++;
      if (import.meta.env.DEV && samples.length < 3600) samples.push(elapsed * 1000);
      if (fpsWindow >= 1) {
        setText(labels.fps, `${Math.round(frames / fpsWindow)} FPS`);
        frames = 0; fpsWindow = 0;
      }
    }
  }

  const bindings=installBindings(byId('binding-fields'),syncControlPanel);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'F8' && !event.ctrlKey && !event.metaKey && !event.altKey && !inGarage && !overlayOpen()) {
      if (!observerView && currentTrack.kind !== 'stage') return;
      event.preventDefault();
      if (!event.repeat) {
        if (observerView) endObservation();
        else if (onlineRun || multiplayer.isOpen) notify('Observer camera is available in single player');
        else beginObservation();
      }
      return;
    }
    if (observerView) {
      if (!event.metaKey && !event.altKey && event.code !== 'Escape') event.preventDefault();
      if (event.metaKey || event.altKey) return;
      observer.keydown(event.code);
      if (!event.repeat) {
        if (event.code === 'KeyH') observerHud.hidden = !observerHud.hidden;
        if (event.code === 'KeyI') observerReadout.hidden = !observerReadout.hidden;
        if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
          observer.jump(currentTrack, event.code === 'BracketRight' ? 1 : -1);
        }
        observerUiDue = 0;
      }
      return;
    }
    if (overlayOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLButtonElement && (event.code === 'Space' || event.code === 'Enter')) return;
    const key = event.code;
    if(inGarage){
      if(multiplayer.isOpen)return;
      if(!event.repeat&&selecting&&!switching&&(key==='ArrowLeft'||key==='ArrowRight')){
        event.preventDefault();void cycleVehicle(key==='ArrowLeft'?-1:1);
      }
      return;
    }
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape'].includes(key)) event.preventDefault();
    if (!paused) keys.add(key);
    if (event.repeat) {if(bindings.actionFor(key))event.preventDefault();return;}
    if (key === 'F2') {event.preventDefault(); byId('debug-panel').hidden = !byId('debug-panel').hidden; sinceUI=1;}
    if (key === 'Escape') setPaused(!paused);
    if (paused) return;
    if (key === 'Backspace' && recovery) {
      event.preventDefault();
      if (canRecover()) applyRecovery();
      return;
    }
    const action=bindings.actionFor(key);
    if(action&&supportsShortcut(action)){
      event.preventDefault();
      applySwitch(action);
      return;
    }
    switch (key) {
      case 'KeyC': setView(views[(views.indexOf(view)+1) % views.length]); break;
      case 'KeyO': setView(view==='orbit'?'chase':'orbit'); break;
      case 'KeyG':
        if(view!=='cockpit')setView('cockpit');
        gearLook=!gearLook;
        lookYaw=gearLook?-.58:0;lookPitch=gearLook?-.69:-.195;
        break;
      case 'KeyV': lookYaw = 0; lookPitch = -.195;gearLook=false; break;
      case 'KeyR': reset(); break;
    }
  });
  window.addEventListener('keyup', event => {
    keys.delete(event.code);
    observer.keyup(event.code);
  });
  window.addEventListener('blur', () => {
    keys.clear(); looking = false; canvas.style.cursor = '';
    observer.clearInput(); observerDrag = false;
  });
  document.addEventListener('visibilitychange',()=>{
    if (observerView) {
      observer.clearInput();
      observerDrag = false;
      clock = performance.now();
    }
    if(onlineRun&&document.hidden){keys.clear();laps.invalidate('Tab suspended');}
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());

  function clickTarget(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const coords = new T.Vector2((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    return visual.hit(camera, coords);
  }
  canvas.addEventListener('pointerdown', (event) => {
    stage.focus({ preventScroll: true });
    if (observerView) {
      if (event.button === 2) {
        observerDrag = true;
        canvas.setPointerCapture(event.pointerId);
      } else if (event.button === 0 && document.pointerLockElement !== canvas) {
        try { void Promise.resolve(canvas.requestPointerLock()).catch(() => {}); } catch { /* Right-drag remains available. */ }
      }
      return;
    }
    if(inGarage){
      if(!switching&&(!overlayOpen()||help.active)&&event.button===0){looking=true;canvas.setPointerCapture(event.pointerId);canvas.style.cursor='grabbing';}
      return;
    }
    if ((paused || overlayOpen())&&!help.active || (view !== 'cockpit'&&view!=='orbit')) return;
    if (event.button === 2||(view==='orbit'&&event.button===0)) {
      looking = true;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    }
    if (!help.active&&view==='cockpit'&&event.button === 0 && !looking) {
      const action = clickTarget(event.clientX,event.clientY);
      if (action) applySwitch(action,event.shiftKey);
    }
  });
  document.addEventListener('mousemove', event => {
    if (observerView && document.pointerLockElement === canvas) observer.look(event.movementX, event.movementY, sensitivity);
  });
  document.addEventListener('pointerlockchange', () => {
    if (!observerView && document.pointerLockElement === canvas) document.exitPointerLock();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (observerView) {
      if (observerDrag && document.pointerLockElement !== canvas) observer.look(event.movementX, event.movementY, sensitivity);
      return;
    }
    if((paused||overlayOpen())&&!help.active)return;
    if(inGarage){if(looking){if(help.active)showroom.guideLook(event.movementX,event.movementY);else showroom.orbit(event.movementX,event.movementY);frameCap=2;}return;}
    if(view==='orbit'){
      if(looking&&(event.buttons&3)){
        orbitYaw=T.MathUtils.euclideanModulo(orbitYaw-event.movementX*.008,Math.PI*2);
        orbitPitch=T.MathUtils.clamp(orbitPitch+event.movementY*.006,.045,1.10);
      }
      return;
    }
    if(view!=='cockpit')return;
    if (looking && !(event.buttons & 2)) looking = false;
    if (looking) {
      gearLook=false;
      lookYaw = T.MathUtils.clamp(lookYaw - event.movementX * .0035 * sensitivity, -1.37, 1.37);
      lookPitch = T.MathUtils.clamp(lookPitch - event.movementY * .0035 * sensitivity, -1.12, .42);
      if(help.active)frameCap=2;
    } else {
      const action=clickTarget(event.clientX,event.clientY);
      canvas.style.cursor=action?'pointer':'';
      canvas.title=action?cockpitHint(car,visual,action):'';help.hover(action);

    }
  });
  canvas.addEventListener('pointerleave',()=>{help.hover(undefined);canvas.title='';});
  canvas.addEventListener('wheel',event=>{
    if (observerView) {
      event.preventDefault();
      observer.adjustSpeed(event.deltaY, event.deltaMode);
      observerUiDue = 0;
      return;
    }
    if(inGarage&&!overlayOpen()){event.preventDefault();showroom.zoom(event.deltaY);frameCap=2;return;}
    if(view!=='orbit'||overlayOpen())return;
    event.preventDefault();
    orbitDistance=T.MathUtils.clamp(orbitDistance*Math.exp(event.deltaY*.0014),3.55,9);
    frameCap=2;
  },{passive:false});
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    canvas.addEventListener(type, () => { looking = false; observerDrag = false; canvas.style.cursor = ''; });
  }

  byId('test-start-lights').addEventListener('click',()=>{
    if(!paused&&!onlineRun)gantry.signal.begin();
    sinceUI=1;
    stage.focus({preventScroll:true});
  });
  ignition.addEventListener('click', () => { if (!paused) applySwitch('ignition'); stage.focus({ preventScroll: true }); });
  for (const button of viewButtons) button.addEventListener('click', () => { setView(button.dataset.camera as View); stage.focus({ preventScroll: true }); });
  byId('pause').addEventListener('click', () => setPaused(!paused));
  byId('resume').addEventListener('click', () => setPaused(false));
  byId('restart').addEventListener('click', () => {if(!onlineRun)reset(true);});
  byId('settings').addEventListener('click', () => showDialog(settings));
  byId('controls').addEventListener('click', () => showDialog(controls));
  for (const dialog of [settings, controls]) dialog.addEventListener('close', () => {
    accumulator = 0; frameCap = 6;
    if (!paused) stage.focus({ preventScroll: true });
  });
  qualityField.value = quality;
  sensitivityField.value = String(sensitivity);
  qualityField.addEventListener('change', () => applyQuality(qualityField.value as Quality));
  sensitivityField.addEventListener('input', () => {
    sensitivity = Number(sensitivityField.value);
    storeSettings(quality, sensitivity);
  });
  transmission.addEventListener('change', () => {
    if ((transmission.value === 'auto') !== car.automatic) applySwitch('transmission');
  });
  new ResizeObserver(resize).observe(stage);

  const garage=byId('garage'),carButtons=byId('garage-cars'),garageError=byId('garage-error');
  for(const id of vehicleIds){
    const button=document.createElement('button');button.type='button';button.className='quiet';button.dataset.vehicle=id;
    button.textContent=vehicles[id].name;
    button.addEventListener('click',()=>void switchVehicle(id));
    carButtons.append(button);
  }
  const courseButtons:HTMLButtonElement[]=[];
  for(const track of Object.values(tracks)){
    const button=document.createElement('button');
    button.type='button';button.className='course-choice';button.dataset.course=track.id;
    const preview=document.createElement('canvas');preview.width=145;preview.height=46;preview.setAttribute('aria-hidden','true');
    const name=document.createElement('b');name.textContent=track.name;
    const facts=document.createElement('small');
    facts.textContent=(track.length/1000).toFixed(3)+' km · '+(track.kind==='circuit'?'Circuit':'Point to point')+
      ' · '+track.surfaceName+' · '+track.cornerCount+' corners';
    button.append(preview,name,facts);
    button.addEventListener('click',async()=>{
      if(await switchTrack(track.id)){
        try{localStorage.setItem('apex.track',track.id);}catch{}
      }
    });
    byId('course-choices').append(button);
    drawCourse(preview,track,false);
    courseButtons.push(button);
  }
  const busyButtons=['garage-drive','garage-prev','garage-next','garage-audio','garage-lights','garage-special']
    .map(id=>byId<HTMLButtonElement>(id));
  function updateGarage(){
    const entry=vehicles[currentVehicle];
    garage.hidden=!inGarage;
    shell.dataset.mode=inGarage?'garage':'track';
    stage.dataset.vehicle=currentVehicle;
    byId('garage-selection').hidden=!selecting;
    garage.querySelector<HTMLButtonElement>('[data-showroom=wheel]')!.hidden=!visual.studioLighting;
    byId<HTMLButtonElement>('garage-select').setAttribute('aria-expanded',String(selecting));
    for(const button of [...busyButtons,...carButtons.querySelectorAll('button')])button.disabled=switching;
    for(const button of carButtons.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.vehicle===currentVehicle));
    garage.setAttribute('aria-busy',String(switching));
    for(const button of courseButtons){
      button.disabled=switching;
      button.setAttribute('aria-pressed',String(button.dataset.course===currentTrack.id));
    }
    setText(byId('course-description'),currentTrack.description);

    setText(byId('garage-name'),entry.name);
    setText(byId('garage-trim'),entry.trim);
    setText(byId('garage-description'),entry.description);
    setText(byId('garage-drive'),selecting?'Start Driving':'Drive');
    setText(byId('garage-special'),currentVehicle==='f40'?'Pop-up lights':'Auxiliary lights');
    setText(byId('garage-audio'),car.running||car.ignition==='START'?'Stop engine':'Preview engine');
    byId<HTMLAnchorElement>('garage-credits').href=asset(entry.credits);
    const rows=[['Engine',entry.engine],['Drivetrain',entry.traction],['Gearbox',entry.transmission],
      ['Simulated mass',entry.spec.mass.toLocaleString('en-US')+' kg'],['Simulated power',nominalPower(entry.spec)+' kW']];
    byId('garage-specs').replaceChildren(...rows.flatMap(([name,value])=>{
      const key=document.createElement('dt'),description=document.createElement('dd');
      key.textContent=name;description.textContent=value;return [key,description];
    }));
  }

  function enterGarage(){
    if(inGarage)return;
    endObservation();
    inGarage=true;selecting=true;garageError.hidden=true;
    reset(true);settle();testDriver=undefined;
    audio.dispose();audio=new EngineAudio(currentVehicle);audio.volume=Number(volume.value);
    showroom.reset();showroom.scene.add(visual.group);
    updateGarage();frameCap=8;
    byId('garage-drive').focus();
  }
  function enterTrack(){
    if(!inGarage||switching)return;
    inGarage=false;selecting=false;garageError.hidden=true;
    if(car.running||car.ignition==='START')car.setIgnition();
    scene.add(visual.group);marks.disconnect();laps.cancel();
    if(currentTrack.kind==='stage'){
      updateVegetation(car.current.position);
      dust.warm(renderer,scene,camera);
      visual.mirrors.warm(renderer,scene,visual.group);
    }
    clock=performance.now();setView('chase');setPaused(false);snapView=true;
    updateGarage();
  }
  async function switchVehicle(id:VehicleId){
    if(!inGarage||switching||id===currentVehicle)return;
    switching=true;garageError.hidden=true;updateGarage();
    let next;
    try{
      next=await vehicles[id].build();
      await next.load();
    }catch(error){
      if(next)disposeVisual(next);
      console.error(error);garageError.hidden=false;
      setText(garageError,'Could not load '+vehicles[id].name+'. The current car is still available.');
      switching=false;updateGarage();return;
    }
    saveRecords(currentTrack,currentVehicle,laps);
    groundContact.dispose();
    car.dispose();
    disposeVisual(visual);
    audio.dispose();
    renderer.renderLists.dispose();
    currentVehicle=id;visual=next;restoreArms();
    audio=new EngineAudio(id);audio.volume=Number(volume.value);
    car=new Vehicle(world,vehicles[id].spec,currentTrack.grid[0]);restoreAssist();
    laps=loadRecords(currentTrack,id);historyShown='';byId('lap-history').replaceChildren();
    groundContact=groundShadow(scene,car);
    settle();marks.clear();dust.clear();
    try{localStorage.setItem('apex.vehicle',id);}catch{}
    showroom.reset();showroom.scene.add(visual.group);
    switching=false;updateGarage();setDialLight();syncControlPanel();frameCap=10;
  }
  async function switchTrack(id:TrackId):Promise<boolean>{
    if(id===currentTrack.id)return true;
    if(!inGarage||switching||onlineRun)return false;
    const chosen=tracks[id], pending=byId('course-loading');
    switching=true;garageError.hidden=true;pending.hidden=false;
    setText(pending,'Loading '+chosen.name+'…');updateGarage();
    const started=performance.now();
    let replacement:Awaited<ReturnType<typeof buildTrack>>|undefined;
    let nextCar:Vehicle;
    try{
      replacement=await buildTrack(chosen,renderer,panorama,wear);
      nextCar=new Vehicle(replacement.world,vehicles[currentVehicle].spec,chosen.grid[0]);
      settle(nextCar);
    }catch(error){
      replacement?.dispose();
      console.error(error);garageError.hidden=false;
      setText(garageError,'Could not load '+chosen.name+'. The current course is still available.');
      switching=false;pending.hidden=true;updateGarage();
      return false;
    }
    saveRecords(currentTrack,currentVehicle,laps);
    groundContact.dispose();
    car.dispose();
    runtime.dispose();
    runtime=replacement;
    ({world,gantry}=runtime);
    renderer.renderLists.dispose();
    scene.add(runtime.root);
    currentTrack=chosen;
    recovery=chosen.kind==='stage'?new StageRecovery(chosen):undefined;
    trackLoadMs=performance.now()-started;
    car=nextCar;
    restoreAssist();
    groundContact=groundShadow(scene,car);
    applyTrackLighting();
    camera.far=currentTrack.environment.viewDistance;
    camera.updateProjectionMatrix();
    marks.clear();dust.clear();
    laps=loadRecords(currentTrack,currentVehicle);
    historyShown='';byId('lap-history').replaceChildren();
    map=makeMinimap(currentTrack);
    updateTrackLabels();
    switching=false;pending.hidden=true;
    updateGarage();frameCap=8;sinceUI=1;
    return true;
  }

  function cycleVehicle(direction:number){
    const index=vehicleIds.indexOf(currentVehicle);
    return switchVehicle(vehicleIds[(index+direction+vehicleIds.length)%vehicleIds.length]);
  }
  const garageFromTrack=()=>{if(onlineRun)multiplayer.leave();else enterGarage();};
  byId('open-garage').addEventListener('click',garageFromTrack);
  byId('pause-garage').addEventListener('click',garageFromTrack);
  byId('garage-drive').addEventListener('click',enterTrack);
  byId('garage-select').addEventListener('click',()=>{selecting=!selecting;updateGarage();});
  byId('garage-settings').addEventListener('click',()=>showDialog(settings));
  byId('garage-prev').addEventListener('click',()=>void cycleVehicle(-1));
  byId('garage-next').addEventListener('click',()=>void cycleVehicle(1));
  byId('garage-lights').addEventListener('click',()=>{car.lights=!car.lights;frameCap=2;});
  byId('garage-special').addEventListener('click',()=>{applySwitch('popup');frameCap=60;});
  byId('garage-audio').addEventListener('click',()=>{
    audio.unlock();car.setIgnition();frameCap=6;
    const playing=car.ignition==='START'||car.running;
    setText(byId('garage-audio'),playing?'Stop engine':'Preview engine');
  });
  const showroomAngles:Record<string,number>={front:0,side:-Math.PI/2,rear:Math.PI};
  for(const button of garage.querySelectorAll<HTMLButtonElement>('[data-showroom]')){
    button.addEventListener('click',()=>{
      const choice=button.dataset.showroom!;
      if(choice==='reset')showroom.reset();
      else if(choice==='cockpit')showroom.cockpit=!showroom.cockpit;
      else if(choice==='wheel')showroom.focusWheel();
      else showroom.preset(showroomAngles[choice]);
      frameCap=4;
    });
  }

  let savedGuide:{view:View;yaw:number;pitch:number;paused:boolean;garage:boolean;cockpit:boolean;gearLook:boolean}|undefined;
  const help=installHelp({
    car:()=>car,visual:()=>visual,garage:()=>inGarage,camera,guideCamera:()=>inGarage?showroom.guideView:camera,canvas,
    enter:()=>{
      savedGuide={view,yaw:lookYaw,pitch:lookPitch,paused,garage:inGarage,cockpit:showroom.cockpit,gearLook};
      keys.clear();looking=false;accumulator=0;gearLook=false;
      if(inGarage){showroom.cockpit=true;showroom.render(renderer,visual,car,width,height);}
      else {setPaused(true);byId('pause-layer').hidden=true;setView('cockpit');}
      frameCap=4;
    },
    restore:()=>{
      if(!savedGuide)return;
      lookYaw=savedGuide.yaw;lookPitch=savedGuide.pitch;gearLook=savedGuide.gearLook;
      if(savedGuide.garage){showroom.cockpit=savedGuide.cockpit;showroom.guideTarget=null;showroom.guideFree=false;}
      else {setView(savedGuide.view);setPaused(savedGuide.paused);}
      accumulator=0;clock=performance.now();frameCap=6;
    },
    focus:point=>{
      if(inGarage){showroom.guideTarget=point;showroom.guideFree=false;frameCap=4;return;}
      const local=point.clone().sub(visual.group.localToWorld(visual.eye.clone())).applyQuaternion(visual.group.quaternion.clone().invert());
      lookYaw=Math.atan2(-local.x,-local.z);lookPitch=Math.atan2(local.y,Math.hypot(local.x,local.z));
      frameCap=4;
    },
    frame:()=>{frameCap=4;},
    restoreBindings:bindings.restore,
  });
  multiplayer=new Multiplayer(scene,{
    vehicle:()=>currentVehicle,
    changeVehicle:switchVehicle,
    track:()=>trackIdentities[currentTrack.id],
    changeTrack:switchTrack,
    enter:(session,slot)=>{
      endObservation();
      onlineRun=session;
      gridSlot=slot;
      submittedAttempts=0;
      poseReset=0;
      laps=newTiming(currentTrack);
      historyShown='';
      byId('reset-timer').hidden=true;
      reset(true);
      settle();
      enterTrack();
      car.setIgnition();
      stageLaunchOnGo=currentTrack.kind==='stage';
      setText(byId('track-mode-label'),multiplayer.mode==='challenge'?challengeName(multiplayer.track).toUpperCase():'ONLINE FREE DRIVE');
      sinceUI=1;
      stage.focus({preventScroll:true});
    },
    exit:()=>{
      onlineRun=null;stageLaunchOnGo=false;
      gantry.signal.reset();
      enterGarage();
      laps=loadRecords(currentTrack,currentVehicle);
      historyShown='';
      submittedAttempts=0;
      byId('reset-timer').hidden=false;
      setText(byId('track-mode-label'),'FREE DRIVE');
      sinceUI=1;
      byId('play-online').focus({preventScroll:true});
    },
    interrupted:expired=>{
      if(!onlineRun)return;
      keys.clear();
      if(expired)laps.invalidate('Connection interrupted');
    },
    unlockAudio:()=>audio.unlock(),
  });
  if (diagnostic) {
    Object.assign(window, { apexDiagnostics: {
      inspect:{get laps(){return laps;},marks,wear,get audio(){return audio;},get gantry(){return gantry;},
        get visual(){return visual;},get car(){return car;},get world(){return world;},RAPIER,renderer,camera,scene,T,updateVegetation,sun,skydome,showroom},
      multiplayer:()=>multiplayer.diagnostics,
      timeLapPath(speed:number,cutTrack=false){
        if(!onlineRun||multiplayer.prestart||multiplayer.finished)throw new Error('A session must be running.');
        laps.cancel();
        const spacing=speed*stepTime;
        if(laps instanceof StageTiming){laps.launch();stageLaunchOnGo=false;}
        const length=currentTrack.finishDistance-currentTrack.startDistance;
        for(let d=-.5;d<=length+spacing*2;d+=spacing){
          const {p,forward,right}=currentTrack.sampleAt(currentTrack.startDistance+d);
          p.y+=.33;
          if(cutTrack&&d>25&&d<27)p.addScaledVector(right,7.2);
          timeLap(p,forward,speed,stepTime);
        }
        return {count:laps.count,best:laps.best,display:laps.sectorDisplay()};
      },
      placeAtTrack(distance:number,lateral=0){
        if(inGarage||onlineRun||observerView||!Number.isFinite(distance)||Math.abs(lateral)>18)throw new Error('Use an offline drive for course inspection.');
        const at=currentTrack.sampleAt(distance), yaw=Math.atan2(-at.forward.x,-at.forward.z);
        car.reset(false,at.p.addScaledVector(at.right,lateral),{x:0,y:Math.sin(yaw/2),z:0,w:Math.cos(yaw/2)});
        settle();laps.cancel();marks.disconnect();dust.clear();snapView=true;frameCap=4;sinceUI=1;
      },
      clearSamples(){samples.length=physicsSamples.length=0;},
      dust:()=>dust.stats,
      setDustEnabled(enabled:boolean){dust.setEnabled(enabled);frameCap=4;},
      setTestDriver(driver:(()=>DriverInput)|undefined){testDriver=driver;},
      state: () => ({
        position: car.current.position.toArray(), direction: car.direction.toArray(),
        speed: car.speed, signedSpeed: car.signedSpeed, gear: car.gear, rpm: car.rpm,
        contacts: car.contacts, running: car.running, lights: car.lights, turn: car.turn,
        eyeError: camera.position.distanceTo(visual.group.localToWorld(visual.eye.clone())),
        forwardDot: camera.getWorldDirection(new T.Vector3()).dot(new T.Vector3(0,0,-1).applyQuaternion(visual.group.quaternion)),
        steer: car.steer, yawRate: car.body.angvel().y, fuelLitres:car.fuelLitres, parkingBrake:car.parkingBrake, tractionControl:car.tractionControl,
        wheelPose: car.wheelState.map(w=>({...w})),
        driverArms:visual.driver.visible, absEnabled:car.absEnabled, indicatedGear:car.indicatedGear,pendingGear:car.pendingManualGear,
        view, lookYaw, paused, travelled: car.travelled, drawFrames,
        carId:currentVehicle,inGarage,frontTorqueShare:car.frontTorqueShare,assist:car.assistMode,
        liveRigidBodies:world.bodies.len(),
        buffer: renderer.getDrawingBufferSize(new T.Vector2()).toArray(),
        draws: renderer.info.render.calls, mirrorDraws:view==='cockpit'?visual.mirrors.drawCalls:0, triangles: renderer.info.render.triangles,
        fpsSamples:samples.slice(),physicsSamples:physicsSamples.slice(),trackLoadMs,
        renderMemory:{...renderer.info.memory}, trackId:currentTrack.id,trackRevision:currentTrack.revision,
        colliderCount:world.colliders.len(),courseRoots:scene.children.filter(object=>Object.values(tracks).some(track=>track.name===object.name)).length,
      }),
      railContact() {
        let touching = false;
        for (let i = 0; i < car.body.numColliders(); i++) {
          world.contactPairsWith(car.body.collider(i), (collider) => {
            touching ||= Math.abs(collider.friction() - .37) < .0001;
          });
        }
        return touching;
      },
      controlPoint(action: Switch) {
        const part = visual.hitTargets.find(m => m.userData.action === action);
        if (!part) return null;
        const projected = part.getWorldPosition(new T.Vector3()).project(camera);
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + (projected.x + 1) * .5 * rect.width, y: rect.top + (1 - projected.y) * .5 * rect.height };
      },
      advance(steps: number, input: DriverInput|(()=>DriverInput)) {
        if (!paused||inGarage||observerView) throw new Error('Pause the driving session before stepping diagnostics.');
        for (let i = 0; i < steps; i++) driveStep(typeof input==='function'?input():input);
        frameCap = 1;
      },
      get gates(){return currentTrack.gates.map(g=>({p:g.p.toArray(),d:g.distance}));},
      get stations(){return currentTrack.minimap.map(s=>({p:s.p.toArray(),right:s.right.toArray(),d:s.distance}));},
    } });
  }
  applyQuality(quality);
  setView('chase');
  stage.dataset.paused = 'false';
  updateTrackLabels();
  updateUI();
  visual.sync(car, 1);
  updateGarage();
  if(inGarage)showroom.render(renderer,visual,car,width,height);
  else {cameraPose(stepTime);renderer.render(scene, camera);}
  loading.hidden = true;
  ignition.disabled = false;
  stage.dataset.ready = 'true';
  clock = performance.now();
  requestAnimationFrame(frame);
}

start().catch((error: unknown) => {
  loading.classList.add('error');
  loading.querySelector('strong')!.textContent = 'The course could not load';
  byId('load-detail').textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
