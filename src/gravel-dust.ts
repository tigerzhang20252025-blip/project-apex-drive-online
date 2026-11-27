import * as T from 'three';
import { mirrorExcludedLayer } from './mirrors.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { maxDustRate, type DustRates } from '../multiplayer-poc/src/game.ts';
import { surfaceFor, type SurfaceName } from './rally-dynamics.ts';
import type { DustSurface } from './pineglass-dust-profile.ts';
import type { RemoteCar } from './remote-car.ts';
import type { TrackDefinition } from './tracks.ts';
import type { DriverInput, Vehicle } from './vehicle.ts';

const capacity=512;
const {clamp,lerp,smoothstep}=T.MathUtils;
const quality={
  performance:{rate:.50,range:88},
  balanced:{rate:.80,range:126},
  high:{rate:1,range:158},
} as const;
const surfaceAmount: Partial<Record<SurfaceName, number>>={gravel:1,dirt:1.22,grass:.24};

function dustTexture(){
  const size=96, pixels=new Uint8Array(size*size);
  const hash=(x:number,y:number)=>((Math.imul(x+219,1597334677)^Math.imul(y+765,3812015801))>>>0)/4294967295;
  function noise(x:number,y:number){
    const i=Math.floor(x),j=Math.floor(y);
    const u=smoothstep(x-i,0,1),v=smoothstep(y-j,0,1);
    return lerp(lerp(hash(i,j),hash(i+1,j),u),lerp(hash(i,j+1),hash(i+1,j+1),u),v);
  }
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){
    const x=(i+.5)/size,y=(j+.5)/size,r=Math.hypot(2*x-1,2*y-1);
    const broad=noise(3.4*x+2,3.8*y);
    const pockets=noise(8.5*x+.45*broad,9.2*y+1);
    const fines=noise(23*x,24*y);
    const edge=1-smoothstep(r+.42*(.52-broad),.23,.99);
    pixels[j*size+i]=Math.round(255*edge*(.48+.28*broad+.17*pockets+.07*fines));
  }
  const texture=new T.DataTexture(pixels,size,size,T.RedFormat);
  texture.magFilter=T.LinearFilter;
  texture.minFilter=T.LinearMipmapLinearFilter;
  texture.generateMipmaps=true;
  texture.needsUpdate=true;
  return texture;
}

const vertexShader=`
  uniform float dustClock, dustRange;
  attribute vec4 birth;
  attribute vec4 motion;
  attribute vec4 tone;
  attribute vec4 shape;
  attribute vec4 groundPlane;
  varying vec2 dustUV;
  varying vec4 dustColor;
  varying vec3 dustView;
  varying float dustHeight;
  #include <fog_pars_vertex>
  void main(){
    dustUV=uv;
    dustColor=vec4(tone.rgb,0.);
    float age=dustClock-birth.w;
    if(age<0. || age>=motion.w){
      gl_Position=vec4(2.,2.,2.,1.);
      return;
    }
    float wake=groundPlane.w;
    vec3 normal=groundPlane.xyz;
    float life=age/motion.w;
    float travel=age/(1.+mix(1.2,.68,wake)*age);
    vec3 shift=normal*mix(.17,.37,wake)+motion.xyz*travel+vec3(.61,.14,-.32)*age;
    vec4 mvPosition=modelViewMatrix*vec4(birth.xyz+shift,1.);
    float depth=-mvPosition.z;
    float viewDistance=length(mvPosition.xyz);
    if(depth<=.18 || viewDistance>=dustRange){
      gl_Position=vec4(2.,2.,2.,1.);
      return;
    }
    float falloff=smoothstep(.18,1.55,depth)*(1.-smoothstep(dustRange*.66,dustRange,viewDistance));
    float fade=smoothstep(0.,mix(.028,.062,wake),age)*(1.-smoothstep(mix(.19,.27,wake),1.,life));
    float angle=shape.x+shape.y*age;
    float c=cos(angle),s=sin(angle);
    float scale=shape.z*(1.+mix(2.5,1.92,wake)*age/(1.+mix(1.1,.43,wake)*age));
    // Very close, broad lobes should read as passing haze and leave the road legible.
    float fillsView=smoothstep(.86,2.0,scale*shape.w/max(.35,depth));
    dustColor.a=tone.a*falloff*fade*(1.-.46*fillsView);
    // Fine dust has broad lobes. The nearby wheel spray stays lower and tighter.
    vec2 offset=mat2(c,s,-s,c)*(position.xy*vec2(shape.w,mix(.93,.78,wake)))*scale;
    dustHeight=dot(shift,normal)+dot(vec3(offset,0.),mat3(modelViewMatrix)*normal);
    mvPosition.xy+=offset;
    dustView=mvPosition.xyz;
    gl_Position=projectionMatrix*mvPosition;
    #include <fog_vertex>
  }
`;
const fragmentShader=`
  uniform sampler2D cloud;
  uniform float forwardView;
  varying vec2 dustUV;
  varying vec4 dustColor;
  varying vec3 dustView;
  varying float dustHeight;
  #include <fog_pars_fragment>
  void main(){
    float grain=texture2D(cloud,dustUV).r;
    // Feather against the local road plane and still depth-test the actual terrain and car.
    float aboveGround=smoothstep(-.12,.31,dustHeight);
    float forward=1.-smoothstep(.13,.57,abs(dustView.x)/max(.18,-dustView.z));
    float sightline=1.-forwardView*(.12+.34*forward);
    float alpha=dustColor.a*grain*aboveGround*sightline;
    if(alpha<.003)discard;
    vec3 shade=dustColor.rgb*mix(.72,1.19,smoothstep(.04,.92,dustUV.y));
    gl_FragColor=vec4(shade,alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class GravelDust {
  private readonly geometry=new T.InstancedBufferGeometry();
  private readonly birth=new T.InstancedBufferAttribute(new Float32Array(capacity*4),4);
  private readonly motion=new T.InstancedBufferAttribute(new Float32Array(capacity*4),4);
  private readonly tone=new T.InstancedBufferAttribute(new Float32Array(capacity*4),4);
  private readonly shape=new T.InstancedBufferAttribute(new Float32Array(capacity*4),4);
  private readonly groundPlane=new T.InstancedBufferAttribute(new Float32Array(capacity*4),4);
  private readonly texture=dustTexture();
  private readonly material=new T.ShaderMaterial({
    uniforms:{...T.UniformsLib.fog,
      cloud:{value:this.texture},dustClock:{value:0},dustRange:{value:quality.balanced.range},forwardView:{value:0}},
    vertexShader,fragmentShader,transparent:true,depthWrite:false,fog:true,
  });
  private readonly mesh=new T.Mesh(this.geometry,this.material);
  private readonly expires=new Float32Array(capacity);
  private readonly credits=[0,.33,.68,.17];
  private readonly remoteCredits=[0,0,0,0];
  readonly rates:DustRates=[0,0,0,0];
  private readonly rayOrigin=new T.Vector3();
  private readonly ray=new RAPIER.Ray(this.rayOrigin,{x:0,y:-1,z:0});
  private readonly sample: DustSurface={density:0,color:new T.Color()};
  private readonly tireSurface: DustSurface={density:0,color:new T.Color()};
  private readonly origin=new T.Vector3();
  private readonly normal=new T.Vector3();
  private readonly axle=new T.Vector3();
  private readonly contactVelocity=new T.Vector3();
  private readonly attrs=[this.birth,this.motion,this.tone,this.shape,this.groundPlane];
  private options:typeof quality[keyof typeof quality]=quality.balanced;
  private clock=0;
  private latestExpiry=0;
  private next=0;
  private dirty=0;
  private used=0;
  private randomState=964249;
  private localEmitted=0;
  private remoteEmitted=0;
  private enabled=true;

  constructor(scene:T.Scene){
    this.geometry.setIndex([0,1,2,0,2,3]);
    this.geometry.setAttribute('position',new T.Float32BufferAttribute([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0],3));
    this.geometry.setAttribute('uv',new T.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));
    for(const [index,name] of ['birth','motion','tone','shape','groundPlane'].entries())
      this.geometry.setAttribute(name,this.attrs[index].setUsage(T.DynamicDrawUsage));
    this.mesh.name='Pineglass gravel dust';
    this.mesh.layers.set(mirrorExcludedLayer);
    this.mesh.frustumCulled=false;
    this.mesh.visible=false;
    this.mesh.renderOrder=2;
    scene.add(this.mesh);
  }

  setQuality(preset: keyof typeof quality){
    this.options=quality[preset];
    this.material.uniforms.dustRange.value=this.options.range;
  }

  setEnabled(enabled: boolean){
    this.enabled=enabled;
    this.clear();
  }

  resetLocal(){
    this.rates.fill(0);
    this.credits.splice(0,4,0,.33,.68,.17);
    this.localEmitted=0;
  }

  clear(){
    this.clock=this.latestExpiry=this.next=this.used=this.dirty=0;
    this.resetLocal();
    this.remoteCredits.fill(0);
    this.remoteEmitted=0;
    this.randomState=964249;
    this.mesh.visible=false;
  }

  get stats(){
    let active=0;
    for(let i=0;i<this.used;i++)if(this.expires[i]>this.clock)active++;
    return {active,capacity,localEmitted:this.localEmitted,remoteEmitted:this.remoteEmitted,visible:this.mesh.visible};
  }

  private random(){
    this.randomState=(Math.imul(this.randomState,1664525)+1013904223)>>>0;
    return this.randomState/4294967296;
  }

  private emit(velocity: T.Vector3, side: number, strength: number, slip: number, airspeed: number, surface: DustSurface){
    const slot=this.next;
    const wake=this.random()>.34+.16*slip;
    const dustiness=Math.sqrt(surface.density);
    const life=(wake?lerp(1.6,5.35,dustiness):lerp(.50,1.18,dustiness))*lerp(.80,1.06,this.random());
    const opacity=wake?lerp(.21,.55,strength):lerp(.28,.66,strength);
    const alpha=opacity*lerp(.46,1,dustiness)*lerp(.77,1.12,this.random());
    const diameter=(wake?lerp(1.55,2.85,this.random()):lerp(.70,1.62,this.random()))*lerp(.53,1.16,dustiness);
    const offset=side*lerp(.10,wake ? .46 : .32,this.random());
    this.birth.setXYZW(slot,this.origin.x+this.axle.x*offset,this.origin.y+this.axle.y*offset,
      this.origin.z+this.axle.z*offset,this.clock);
    const sideways=clamp(this.contactVelocity.dot(this.axle)/9,-1,1);
    const scatter=side*(wake?lerp(1.1,2.7,this.random()):lerp(1.7,3.7,this.random()));
    // Airflow at speed pushes the youngest dust around the wheel arches before it settles into the wake.
    const spread=scatter*(.82+.56*strength+airspeed*.72)+sideways*slip*(wake?3.2:5.2);
    const carry=(wake?lerp(.075,.164,this.random()):lerp(.12,.26,this.random()))+.11*airspeed;
    const lift=wake?lerp(.94,2.12,strength):lerp(1.38,3.55,strength);
    const rise=(lift+airspeed*(wake ? .61 : 1.18))*lerp(.67,1.14,this.random());
    this.motion.setXYZW(slot,velocity.x*carry+this.axle.x*spread,rise,velocity.z*carry+this.axle.z*spread,life);
    const {r,g,b}=surface.color;
    this.tone.setXYZW(slot,r,g,b,alpha);
    const tilt=(this.random()-.5)*(wake?1.2:1.9);
    this.shape.setXYZW(slot,tilt,this.random()*.72-.36,diameter,lerp(1.12,wake?1.9:1.58,this.random()));
    this.groundPlane.setXYZW(slot,this.normal.x,this.normal.y,this.normal.z,Number(wake));
    this.expires[slot]=this.clock+life;
    this.latestExpiry=Math.max(this.latestExpiry,this.clock+life);
    this.next=(slot+1)%capacity;
    this.used=Math.min(capacity,this.used+1);
    this.dirty++;
  }

  advanceTime(dt:number){
    if(this.enabled)this.clock+=dt;
  }

  stepLocal(track:TrackDefinition, car:Vehicle, input:DriverInput, dt:number){
    this.rates.fill(0);
    if(!track.dust||!this.enabled)return;
    this.advanceTime(dt);
    if(!car.contacts||car.speed<1.4)return;
    const {position,rotation}=car.current;
    track.dust(track.project(position.x,position.z).station,this.sample);
    if(this.sample.density<.01)return;
    const speed=smoothstep(car.speed,1.4,33);
    const moving=smoothstep(car.speed,1.4,6);
    const airspeed=smoothstep(car.speed,20,44);
    const braking=car.brakeLight?Math.max(input.brake,input.handbrake ? .7 : 0):0;
    const controller=car.controller;
    for(let i=0;i<4;i++){
      if(!controller.wheelIsInContact(i))continue;
      const friction=controller.wheelGroundObject(i)?.friction()??0;
      const material=friction>=.40?surfaceAmount[surfaceFor(friction)]??0:0;
      if(!material)continue;
      const driving=i>=2||car.spec.awd?input.throttle:input.throttle*.12;
      const slip=smoothstep(car.tireTelemetry[i].slipAngle,.07,.41);
      const load=smoothstep(controller.wheelSuspensionForce(i)??0,140,1150);
      const activity=5+14*speed+10*driving+22*slip+7*braking;
      const grit=this.sample.density*material;
      const rate=activity*grit*moving*load;
      this.rates[i]=Math.min(maxDustRate,Math.round(rate));
      this.credits[i]+=this.options.rate*rate*dt;
      if(this.credits[i]<1)continue;
      this.credits[i]-=1;
      if(!controller.wheelContactPoint(i,this.origin)||!controller.wheelContactNormal(i,this.normal)||this.normal.y<.42)continue;
      track.dust(track.project(this.origin.x,this.origin.z).station,this.tireSurface);
      if(this.tireSurface.density<.01)continue;
      this.axle.set(1,0,0).applyQuaternion(rotation);
      this.axle.addScaledVector(this.normal,-this.axle.dot(this.normal)).normalize();
      car.body.velocityAtPoint(this.origin,this.contactVelocity);
      const strength=clamp((.30+.34*speed+.23*driving+.42*slip+.17*braking)*Math.sqrt(grit),0,1);
      this.emit(car.velocity,i%2?1:-1,strength,slip,airspeed,this.tireSurface);
      this.localEmitted++;
    }
  }

  stepRemote(track:TrackDefinition, source:RemoteCar['dustSource'], world:RAPIER.World, dt:number){
    const profile=track.dust;
    const rates=source?.motion.dust;
    if(!this.enabled||!profile||!source||!rates){
      this.remoteCredits.fill(0);
      return;
    }
    const {motion,spec}=source;
    const {position,rotation,velocity,suspension}=motion;
    const airspeed=smoothstep(velocity.length(),20,44);
    for(const [i,wheel] of spec.wheels.entries()){
      const rate=rates[i];
      if(!rate){
        this.remoteCredits[i]=0;
        continue;
      }
      this.remoteCredits[i]+=this.options.rate*rate*dt;
      if(this.remoteCredits[i]<1)continue;
      const count=Math.floor(this.remoteCredits[i]);
      this.remoteCredits[i]-=count;
      this.rayOrigin.set(wheel.x,spec.mountHeight-suspension[i]-spec.radius,wheel.z)
        .applyQuaternion(rotation).add(position).y+=.48;
      const hit=world.castRayAndGetNormal(this.ray,.9,true,RAPIER.QueryFilterFlags.ONLY_FIXED);
      if(!hit||hit.normal.y<.42||hit.collider.friction()<.40)continue;
      this.origin.copy(this.rayOrigin).y-=hit.timeOfImpact;
      profile(track.project(this.origin.x,this.origin.z).station,this.tireSurface);
      if(this.tireSurface.density<.01)continue;
      this.normal.copy(hit.normal);
      this.axle.set(1,0,0).applyQuaternion(rotation);
      this.axle.addScaledVector(this.normal,-this.axle.dot(this.normal)).normalize();
      this.contactVelocity.copy(velocity);
      const slip=smoothstep(Math.abs(velocity.dot(this.axle)),1,9);
      const strength=clamp(.25+rate/maxDustRate+.25*slip,0,1);
      for(let j=0;j<count;j++)this.emit(velocity,i%2?1:-1,strength,slip,airspeed,this.tireSurface);
      this.remoteEmitted+=count;
    }
  }

  warm(renderer:T.WebGLRenderer,scene:T.Scene,camera:T.Camera){
    void renderer.compileAsync(this.mesh,camera,scene);
  }

  flush(forwardView: boolean){
    this.mesh.visible=this.enabled&&this.used>0&&this.clock<this.latestExpiry;
    if(!this.mesh.visible){
      if(this.clock>=this.latestExpiry)this.used=this.next=this.dirty=0;
      return;
    }
    this.material.uniforms.dustClock.value=this.clock;
    this.material.uniforms.forwardView.value=Number(forwardView);
    this.geometry.instanceCount=this.used;
    if(!this.dirty)return;
    const count=Math.min(this.dirty,capacity);
    const begin=(this.next+capacity-count)%capacity;
    const first=Math.min(count,capacity-begin);
    for(const attr of this.attrs){
      attr.addUpdateRange(begin*4,first*4);
      if(first<count)attr.addUpdateRange(0,(count-first)*4);
      attr.needsUpdate=true;
    }
    this.dirty=0;
  }
}
