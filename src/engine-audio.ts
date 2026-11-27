import * as T from 'three';
import type {Vehicle} from './vehicle.ts';
import {asset} from './environment.ts';

export class EngineAudio {
  private ctx?:AudioContext;
  private master?:GainNode;
  private engine?:AudioWorkletNode;
  private exhaust?:GainNode;
  private mechanics?:GainNode;
  private air?:GainNode;
  private exhaustFilter?:BiquadFilterNode;
  private position?:StereoPannerNode;
  private noise?:AudioBuffer;
  private gear=0;
  private lastBoost=0;
  private load=0;
  private lastBlowoff=-1;
  private previousUpdate=-1;
  private readonly emitter=new T.Vector3(.0,.13,1.8);
  private readonly exhaustPosition=new T.Vector3();
  private readonly offset=new T.Vector3();
  private readonly cameraRight=new T.Vector3();
  volume=.72;
  get ready(){return !!this.engine;}
  get context(){return this.ctx;}
  get output(){return this.master;}
  constructor(private readonly profile:'f40'|'r35'='f40'){}

  dispose(){
    if(!this.ctx)return;
    void this.ctx.close().catch(()=>{});
    this.ctx=undefined;
    this.engine=undefined;
  }

  unlock(){
    if(!this.ctx){
      const ctx=this.ctx=new AudioContext({latencyHint:'interactive'});
      this.master=ctx.createGain();this.master.gain.value=0;
      this.master.connect(ctx.destination);
      this.position=ctx.createStereoPanner();
      const dc=ctx.createBiquadFilter();dc.type='highpass';dc.frequency.value=31;dc.Q.value=.65;
      const limiter=ctx.createDynamicsCompressor();limiter.threshold.value=-9;limiter.ratio.value=5;limiter.attack.value=.003;
      this.position.connect(dc).connect(limiter).connect(this.master);
      const noise=this.noise=ctx.createBuffer(1,Math.round(ctx.sampleRate*.53),ctx.sampleRate);
      const data=noise.getChannelData(0);
      let seed=3791;
      for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed/2147483648-1;}
      void ctx.audioWorklet.addModule(asset(this.profile+'-drive-processor.js')).then(()=>{
        if(this.ctx!==ctx)return;
        const node=this.engine=new AudioWorkletNode(ctx,'apex-'+this.profile+'-drive',{numberOfInputs:0,numberOfOutputs:3,outputChannelCount:[1,1,1]});
        this.exhaustFilter=ctx.createBiquadFilter();this.exhaustFilter.type='lowpass';this.exhaustFilter.Q.value=.55;
        const mechFilter=ctx.createBiquadFilter();mechFilter.type='lowpass';mechFilter.frequency.value=2180;mechFilter.Q.value=.55;
        const spool=ctx.createBiquadFilter();spool.type='bandpass';spool.frequency.value=2880;spool.Q.value=.65;
        this.exhaust=ctx.createGain();this.mechanics=ctx.createGain();this.air=ctx.createGain();
        for(const [i,filter,gain] of [[0,this.exhaustFilter,this.exhaust],[1,mechFilter,this.mechanics],[2,spool,this.air]] as const){
          gain.gain.value=0;node.connect(filter,i).connect(gain).connect(this.position!);
        }
      }).catch(error=>{if(this.ctx===ctx)console.warn('Engine audio unavailable',error);});
    }
    if(this.ctx.state==='suspended')void this.ctx.resume().catch(()=>{});
  }

  private sweep(start:number,end:number,duration:number,volume:number,type:OscillatorType){
    const ctx=this.ctx;if(!ctx||!this.position)return;
    const t=ctx.currentTime,gain=ctx.createGain(),source=ctx.createOscillator();
    source.type=type;source.frequency.setValueAtTime(start,t);source.frequency.exponentialRampToValueAtTime(end,t+duration);
    gain.gain.setValueAtTime(.0001,t);gain.gain.linearRampToValueAtTime(volume,t+.009);
    gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
    source.connect(gain).connect(this.position);source.onended=()=>{source.disconnect();gain.disconnect();};
    source.start();source.stop(t+duration);
  }

  private burst(frequency:number,duration:number,amount:number,q:number){
    const ctx=this.ctx;
    if(!ctx||!this.noise||!this.position||amount<=0)return;
    const t=ctx.currentTime,node=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=ctx.createGain();
    node.buffer=this.noise;filter.type='bandpass';filter.Q.value=q;
    filter.frequency.setValueAtTime(frequency,t);filter.frequency.exponentialRampToValueAtTime(frequency*.42,t+duration);
    gain.gain.setValueAtTime(.0001,t);gain.gain.linearRampToValueAtTime(amount,t+.013);
    gain.gain.exponentialRampToValueAtTime(.0001,t+duration);
    node.connect(filter).connect(gain).connect(this.position);
    node.onended=()=>{node.disconnect();filter.disconnect();gain.disconnect();};
    node.start();node.stop(t+duration);
  }

  lampMotor(open:boolean,distance:number){
    if(this.volume===0)return;
    const gain=.085/(1+distance*.22);
    this.sweep(open?110:142,open?153:94,.43,gain,'triangle');
    this.burst(1150,.24,gain*.6,1.7);
  }

  shiftCue(gear:number,interior:boolean,proximity=1){
    this.gear=gear;
    this.burst(1680,.095,(interior?.20:.11)*proximity,1.35);
    this.sweep(this.profile==='r35'?760:570,this.profile==='r35'?280:210,.067,.084*proximity,'triangle');
  }

  synchroGrind(interior:boolean){
    if(this.volume===0)return;
    this.burst(2450,.11,interior?.24:.12,3.4);
    this.sweep(410,295,.095,interior?.095:.045,'sawtooth');
  }

  update(car:Vehicle,camera:T.Camera,interior:boolean,active:boolean){
    const ctx=this.ctx,node=this.engine;if(!ctx||!node)return;
    const time=ctx.currentTime;
    if(time-this.previousUpdate<.022)return;
    this.previousUpdate=time;
    const loaded=car.throttleLoad,boost=car.boostBar;
    const want=(param:AudioParam,value:number,lag=.04)=>param.setTargetAtTime(value,time,lag);
    this.exhaustPosition.copy(this.emitter).applyQuaternion(car.current.rotation).add(car.current.position);
    this.offset.subVectors(this.exhaustPosition,camera.position);
    const distance=this.offset.length();
    this.cameraRight.set(1,0,0).applyQuaternion(camera.quaternion);
    const fade=1/(1+Math.max(0,distance-2.7)*.139);
    const behind=-this.offset.dot(car.direction)/Math.max(distance,.001);
    const proximity=interior?1:fade*(.90-.19*behind);
    const shift=1-T.MathUtils.smoothstep(car.shiftProgress,0,.95);

    const parameters=node.parameters;
    for(const [key,value] of Object.entries({
      rpm:car.rpm,load:loaded,boost,running:Number(car.running),starter:Number(car.ignition==='START'),
      warm:T.MathUtils.smoothstep(car.waterTemp,24,75),cut:shift,speed:car.speed,
    }))want(parameters.get(key)!,value,key==='rpm'?.036:.062);
    if(this.profile==='r35'){
      let dirt=0,scrub=0;
      for(let i=0;i<4;i++){
        if(!car.controller.wheelIsInContact(i))continue;
        dirt+=car.controller.wheelGroundObject(i)!.friction()<.5?.25:0;
        const lateral=car.controller.wheelSideImpulse(i)??0,load=car.controller.wheelSuspensionForce(i)??0;
        scrub+=.25*Math.min(1,120*Math.abs(lateral)/Math.max(1,load));
      }
      want(parameters.get('dirt')!,dirt);
      want(parameters.get('scrub')!,scrub);
    }

    want(this.master!.gain,active?this.volume*.88:0,.047);
    want(this.exhaust!.gain,interior?.57:1.09*proximity);
    want(this.mechanics!.gain,interior?1.06:.34*fade);
    want(this.air!.gain,interior?.58:.74*fade);
    want(this.exhaustFilter!.frequency,(interior?980:2050)+loaded*(interior?430:1300));
    want(this.position!.pan,interior?.13:T.MathUtils.clamp(this.offset.dot(this.cameraRight)/Math.max(1,distance)*.8,-.8,.8));
    if(active&&car.running&&car.gear!==this.gear){
      this.shiftCue(car.gear,interior,proximity);
    }
    if(active&&car.running&&this.lastBoost>.20&&this.load>.30&&loaded<this.load-.049&&time-this.lastBlowoff>.30){
      this.burst(2730,.32,this.lastBoost*(interior?.24:.36)*proximity,.82);
      this.lastBlowoff=time;
    }
    this.gear=car.gear;this.load=loaded;this.lastBoost=boost;
  }
}
