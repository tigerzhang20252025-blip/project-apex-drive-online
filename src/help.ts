import * as T from 'three';
import type {VehicleVisual} from './vehicle-visual.ts';
import type {Vehicle} from './vehicle.ts';
import type {Switch} from './f40-cabin.ts';
import {shortcutLabel,type ControlAction} from './shortcuts.ts';

const names:Record<string,[string,string]>={
  ignition:['Engine start / stop','发动机启动与停止'],key:['Ignition key','车钥匙'],
  shift:['Five-speed gear lever','五速手动换挡杆'],transmission:['Transmission mode','自动与手动模式'],
  'shift-up':['Right paddle · upshift','右拨片升挡'],'shift-down':['Left paddle · downshift','左拨片降挡'],
  light:['Headlights','车灯'],popup:['Special lamps','翻灯 / 辅助拉力灯'],
  wiper:['Wiper control','雨刮器'],left:['Left indicator','左转向灯'],right:['Right indicator','右转向灯'],
  hazard:['Hazard lights','双闪'],traction:['Traction control','牵引力控制'],parking:['Parking brake','驻车制动'],
  dial:['Instrument brightness','仪表亮度'],arms:['Driver arms','驾驶员手臂'],abs:['ABS','防抱死制动'],
};
const settingInfo:Record<string,[string,string,string]>={
  quality:['Balanced','Caps drawing resolution and shadow detail. Performance 1440×900 / 768 shadow, Balanced 1920×1080 / 1024, High 2560×1440 / 2048. Actual resolution also follows window size.','控制渲染分辨率与阴影精度。性能 1440×900 / 768，平衡 1920×1080 / 1024，高画质 2560×1440 / 2048。实际分辨率同时受窗口大小限制。'],
  'engine-volume':['.72','0–1. Controls vehicle sound, including engine and tire sound. Higher is louder.','0–1。控制车辆声音，包括发动机与轮胎。越高越响。'],
  'dial-lighting':['.35','0–1. Higher brightens powered instrument illumination.','0–1。越高，有电状态下的仪表照明越亮。'],
  sensitivity:['1','0.6–2. Mouse look speed. Higher turns the view faster.','0.6–2。鼠标观察速度，调高后镜头转动更快。'],
  'chase-camera':['close','Close enlarges the car. Standard gives more surrounding road visibility.','近距突出车辆，标准距离扩大周围道路视野。'],
  'head-motion':['.85','0.35–1. Chassis pitch and roll inherited by the cockpit view. Lower stabilizes the horizon.','0.35–1。座舱继承车身俯仰和侧倾的程度，降低可稳定地平线。'],
  'show-timing':['true','Shows or hides the timing panel. Lap recording continues.','显示或隐藏计时面板，圈速继续记录。'],
  transmission:['auto','Automatic or Manual. Change only below 0.6 m/s. In manual, use shifts through R, N and forward gears.','自动或手动。仅低于 0.6 m/s 时切换。手动模式逐级切换倒挡、空挡及前进挡。'],
  'assist-mode':['sport','GT-R only. Grip enables TC/ABS and gentler keyboard steering. Rally enables TC/ABS with full rack travel and progressive slip. Simulation starts with TC/ABS off. TC can also be toggled in the cockpit.','仅 GT-R。Grip 启用 TC/ABS 并减缓满键转向。Rally 启用 TC/ABS、全转角及渐进侧滑。Simulation 默认关闭 TC/ABS。舱内可单独切换 TC。'],
  'driver-arms':['vehicle','Shows gloves, sleeves and wristwatch. Saved separately for each vehicle.','显示手套、手臂和手表，两款车独立保存。'],
  'traction-setting':['mode','Controls traction control independently for the current drive. Selecting an assist preset restores its TC value.','单独控制本次驾驶的牵引力控制。切换驾驶辅助预设会应用其 TC 设置。'],
  'abs-setting':['mode','GT-R only. Controls ABS independently. Selecting an assist preset restores its ABS value.','仅 GT-R。单独开关 ABS，切换辅助预设会应用其 ABS 设置。'],
  'control-notifications':['true','Shows short feedback when you use vehicle controls.','操作车辆功能时显示短时提示。'],
  'shortcut-visibility':['true','Shows the bottom shortcut strip. More Controls stays available.','显示底部快捷键提示，更多操作入口仍可使用。'],
};
function keyFor(action:string){
  if(action==='shift')return shortcutLabel('shift-up')+' / '+shortcutLabel('shift-down')+' · Click / Shift-click';
  if(action==='key')return 'Click / Shift-click';
  return shortcutLabel(action)||'Click';
}
function state(car:Vehicle,visual:VehicleVisual,action:string){
  const on=(v:boolean)=>v?'ON':'OFF';
  switch(action){
    case 'ignition':case 'key':return car.ignition;
    case 'wiper':return car.wiper.mode;
    case 'light':return on(car.lights);
    case 'popup':return on(visual.popups.requested);
    case 'transmission':return car.automatic?'Automatic':'Manual';
    case 'traction':return on(car.tractionControl);
    case 'abs':return on(car.absEnabled);
    case 'arms':return on(visual.driver.visible);
    case 'parking':return on(car.parkingBrake);
    case 'left':return on(car.turn===-1||car.turn===2);
    case 'right':return on(car.turn===1||car.turn===2);
    case 'hazard':return on(car.turn===2);
    case 'dial':return document.querySelector<HTMLInputElement>('#dial-lighting')!.value;
    default:return car.gear===0?'N':String(car.gear);
  }
}
export function cockpitHint(car:Vehicle,visual:VehicleVisual,action:ControlAction,zh=false){
  if(action==='ignition'&&car.spec.awd){
    return zh
      ? '发动机启动与停止 · 按住刹车并点击舱内按钮启动。也可按 '+keyFor(action)+' 或点击 HUD 启动。'
      : 'Engine start / stop · Hold the brake and click to start, or use '+keyFor(action)+' or the HUD.';
  }
  const entry=names[action];return entry?entry[zh?1:0]+' · '+state(car,visual,action)+' · '+keyFor(action):action;
}
export function controlReference(car:Vehicle,visual:VehicleVisual,zh=false){
  const basics=zh
    ?'W / ↑ 油门，S / ↓ 刹车，自动模式停稳后持续 S 倒车。A D / ← → 转向，Space 手刹。C 切换视角，O 环绕，R 重置，Esc 暂停，F2 物理数据。右键拖动观察，V 回正，G 查看换挡区。'
    :'W / ↑ throttle. S / ↓ brake, hold at rest to reverse in automatic. A D / ← → steer, Space handbrake. C cameras, O orbit, R reset, Esc pause, F2 physics telemetry. Right-drag to look, V center, G view gear gate. Drag and scroll in orbit or in the garage.';
  const actions:ControlAction[]=['transmission','shift-down','shift-up','traction','light','wiper','ignition','arms','popup','left','right','hazard'];
  if(car.spec.awd)actions.push('abs');
  else actions.push('parking','key','shift');
  if(visual.hitTargets.some(m=>m.userData.action==='dial'))actions.push('dial');
  const manual=zh?'手动模式才接受升降挡。F40 左键操作钥匙或换挡杆，Shift 左键反向操作。':'Shift keys operate in manual. On the F40, click the ignition key or lever to advance and Shift-click to move back.';
  return basics+'\n\n'+actions.map(action=>cockpitHint(car,visual,action,zh)).join('\n')+'\n\n'+manual;
}
type Host={
  car:()=>Vehicle;visual:()=>VehicleVisual;garage:()=>boolean;
  enter:()=>void;restore:()=>void;focus:(point:T.Vector3)=>void;
  camera:T.PerspectiveCamera;guideCamera:()=>T.Camera;canvas:HTMLCanvasElement;frame:()=>void;restoreBindings:()=>void;
};
export function installHelp(host:Host){
  let zh=false,index=0,active=false;
  const panel=document.createElement('section');panel.id='apex-help';panel.hidden=true;panel.setAttribute('aria-label','Driving help');
  panel.innerHTML='<header><strong>APEX DRIVE · HELP</strong><button id="help-language">中文</button><button id="help-close" aria-label="Close help">×</button></header><nav><button data-help-tab="cockpit">Cockpit Guide</button><button data-help-tab="controls">Controls</button><button data-help-tab="settings">Settings Guide</button></nav><div id="help-copy"></div><footer><button id="help-prev">← Previous</button><span id="help-count"></span><button id="help-next">Next →</button></footer>';
  document.body.append(panel);
  const copy=panel.querySelector<HTMLElement>('#help-copy')!,count=panel.querySelector<HTMLElement>('#help-count')!;
  const marker=new T.Mesh(new T.SphereGeometry(1,16,10),new T.MeshBasicMaterial({color:0xf7bd76,transparent:true,opacity:.22,depthTest:false}));
  marker.renderOrder=1000;marker.visible=false;
  const cursor=document.createElement('div');cursor.id='cockpit-guide-label';cursor.hidden=true;document.body.append(cursor);
  let tab='cockpit';
  function entries(){
    const visual=host.visual();
    const controls=[...new Set(visual.hitTargets.map(m=>m.userData.action as Switch))].filter(a=>names[a]);
    return ['instruments',...controls,'mirrors',...(host.car().spec.awd?['assist']:[])];
  }
  function target(action:string){
    const v=host.visual(),point=new T.Vector3();
    if(action==='instruments'){
      const mesh=v.group.getObjectByName(host.car().spec.awd?'R35 Tachometer spindle':'Instrument binnacle');
      return mesh?.getWorldPosition(point)??v.steering.getWorldPosition(point);
    }
    if(action==='mirrors'){
      let mirror:T.Object3D|undefined=v.group.getObjectByName('mirrorCenter');
      v.group.traverse(node=>{if(!mirror&&node instanceof T.Mesh&&/^mirror/i.test(node.name))mirror=node;});
      return mirror?.getWorldPosition(point);
    }
    return v.hitTargets.find(m=>m.userData.action===action)?.getWorldPosition(point);
  }
  function refresh(){
    host.frame();copy.scrollTop=0;panel.scrollTop=0;
    marker.visible=false;cursor.hidden=true;
    panel.querySelector('footer')!.toggleAttribute('hidden',tab!=='cockpit');
    if(tab==='settings'){
      copy.replaceChildren();
      for(const [id,[configuredDefault,en,cn]] of Object.entries(settingInfo)){
        const field=document.getElementById(id) as HTMLInputElement|HTMLSelectElement;
        if((id==='assist-mode'||id==='abs-setting')&&!host.car().spec.awd)continue;
        const def=configuredDefault==='vehicle'?String(!host.car().spec.awd):configuredDefault==='mode'?String(host.car().assistMode!=='simulation'||!host.car().spec.awd):configuredDefault;
        const item=document.createElement('article'),title=document.createElement('strong'),text=document.createElement('p'),reset=document.createElement('button');
        title.textContent=field.closest('label')!.childNodes[0].textContent!.trim();
        const defaultValue=field instanceof HTMLInputElement&&field.type==='checkbox'
          ? (def==='true'?(zh?'开启':'On'):(zh?'关闭':'Off'))
          : field instanceof HTMLSelectElement ? [...field.options].find(option=>option.value===def)?.text||def : def;
        text.textContent=(zh?cn:en)+(zh?' 默认值 ':' Default ')+defaultValue;
        reset.textContent=zh?'恢复此项默认值':'Restore this default';
        reset.onclick=()=>{
          if(id==='transmission'&&host.car().speed>.6){reset.textContent=zh?'请先停车':'Stop the vehicle first';return;}
          if(field instanceof HTMLInputElement&&field.type==='checkbox')field.checked=def==='true';else field.value=def;
          field.dispatchEvent(new Event(field instanceof HTMLInputElement&&field.type==='range'?'input':'change'));
          host.frame();
        };
        item.append(title,text,reset);copy.append(item);
      }
      const bindings=document.createElement('article'),title=document.createElement('strong'),details=document.createElement('p'),reset=document.createElement('button');
      title.textContent=zh?'键盘绑定':'Keyboard bindings';
      details.textContent=zh?'在 Settings → Keyboard bindings 修改车辆按键。占用的键不能重复绑定。Controls 显示当前绑定。':'Change vehicle keys under Settings → Keyboard bindings. Occupied keys are unavailable. Controls shows the current assignments.';
      reset.textContent=zh?'恢复全部默认键位':'Restore default bindings';
      reset.onclick=()=>{host.restoreBindings();reset.textContent=zh?'已恢复默认键位':'Default bindings restored';};
      bindings.append(title,details,reset);copy.append(bindings);
      return;
    }
    if(tab==='controls'){
      copy.textContent=controlReference(host.car(),host.visual(),zh);
      return;
    }
    const list=entries();index=(index+list.length)%list.length;const action=list[index];
    const point=target(action);
    count.textContent=(index+1)+' / '+list.length;
    if(point){
      host.focus(point);marker.position.copy(point);marker.scale.setScalar(action==='instruments'?.072:action==='mirrors'?.046:.023);
      host.visual().group.parent!.add(marker);marker.visible=true;cursor.hidden=false;
    }
    const title=action==='instruments'?(zh?'实时机械仪表':'Live mechanical instruments'):action==='mirrors'?(zh?'后视镜':'Rear-view mirrors'):action==='assist'?(zh?'驾驶辅助 · Settings':'Driving assists · Settings'):cockpitHint(host.car(),host.visual(),action as Switch,zh);
    const text=zh?'右键拖动可以继续观察。高亮由当前模型的实际交互位置生成。按所示快捷键或退出教程后左键点击此部件。':'Right-drag to inspect. The highlight follows this model’s interaction target. Use the shown shortcut during driving, or close this guide and click the part.';
    copy.innerHTML='';const heading=document.createElement('h2');heading.textContent=title;const detail=document.createElement('p');detail.textContent=text;
    if(action==='instruments')detail.textContent=zh?'速度、转速、油量与温度来自实时模拟。档位显示 R、N 或当前前进挡。':'Speed, RPM, fuel and temperatures follow the live simulation. Gear shows R, N or the forward gear.';
    if(action==='assist')detail.textContent=zh?settingInfo['assist-mode'][2]:settingInfo['assist-mode'][1];
    copy.append(heading,detail);host.frame();
  }
  function close(){
    if(!active)return;active=false;panel.hidden=true;cursor.hidden=true;marker.visible=false;marker.removeFromParent();host.restore();
  }
  function open(){
    if(active)return;active=true;host.enter();panel.hidden=false;tab='cockpit';index=0;refresh();
  }
  panel.querySelector('#help-close')!.addEventListener('click',close);
  panel.querySelector('#help-language')!.addEventListener('click',()=>{zh=!zh;panel.querySelector('#help-language')!.textContent=zh?'English':'中文';refresh();});
  panel.querySelector('#help-prev')!.addEventListener('click',()=>{index--;refresh();});
  panel.querySelector('#help-next')!.addEventListener('click',()=>{index++;refresh();});
  panel.querySelectorAll<HTMLButtonElement>('[data-help-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.helpTab!;refresh();});
  document.querySelectorAll('[data-open-help]').forEach(b=>b.addEventListener('click',open));
  window.addEventListener('keydown',e=>{if(active&&e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}},true);
  return {hover(action:Switch|undefined){
    if(active)return;
    if(!action){marker.visible=false;marker.removeFromParent();return;}
    const point=target(action);if(!point)return;
    marker.position.copy(point);marker.scale.setScalar(.017);marker.visible=true;
    host.visual().group.parent!.add(marker);
  },get active(){return active;},get open(){return active;},update(){
    if(!active||!marker.visible)return;
    const rect=host.canvas.getBoundingClientRect(),p=marker.position.clone().project(host.guideCamera());
    cursor.hidden=p.z>1||Math.abs(p.x)>1||Math.abs(p.y)>1;
    cursor.textContent='◎';cursor.style.left=(rect.left+(p.x+1)*rect.width/2)+'px';cursor.style.top=(rect.top+(1-p.y)*rect.height/2)+'px';
  }};
}
