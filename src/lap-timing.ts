import {MathUtils,Vector3} from 'three';
import {courseLength,lineDistance,nearestStation,roadHalfWidth,sampleAt,stations} from './track.ts';

export const startDistance=lineDistance;
const gates=Array.from({length:20},(_,i)=>sampleAt(startDistance+courseLength*i/20));
export const checkpointGates=gates.slice(1);
const nodeCount=stations.length-1,spacing=courseLength/nodeCount;
export const SECTOR_LAYOUT_ID='g7-g14-v1';
export const sectorBoundaryIndices=[7,14] as const;
export const lastLapHoldSeconds=3;

export type SectorIndex=0|1|2;
export type SectorNumbers=[number,number,number];
export type SectorTuple=[number|null,number|null,number|null];
export type SectorRating='pending'|'baseline'|'purple'|'green'|'equal'|'yellow'|'invalid';
export type SectorRefKind='bestLap'|'bestSector'|null;
export type LapHistoryEntry={lap:number;seconds:number;sectors?:SectorNumbers};
export type StoredLapRecords={
  count:number;
  best:number|null;
  history:LapHistoryEntry[];
  sectorLayout?:string;
  bestSectors?:SectorTuple;
  bestLapSectors?:SectorNumbers|null;
};
export type SectorDisplay={
  mode:'waiting'|'current'|'last-lap'|'invalid';
  lap:number|null;
  reason:string|null;
  activeSector:SectorIndex|null;
  currentSectorTime:number|null;
  sectors:SectorTuple;
  ratings:[SectorRating,SectorRating,SectorRating];
  deltas:SectorTuple;
  refKinds:[SectorRefKind,SectorRefKind,SectorRefKind];
};

const deltaMs=(delta:number)=>Math.round(delta*1000)||0;

export function lapTime(seconds:number|null){
  if(seconds===null)return '—';
  const ms=Math.round(seconds*1000);
  return [Math.floor(ms/60000),Math.floor(ms/1000)%60].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');
}
export function sectorTime(seconds:number|null){
  if(seconds===null)return '—';
  const ms=Math.round(seconds*1000);
  const mins=Math.floor(ms/60000),secs=Math.floor(ms/1000)%60,frac=String(ms%1000).padStart(3,'0');
  return mins>0?`${mins}:${String(secs).padStart(2,'0')}.${frac}`:`${secs}.${frac}`;
}
export function sectorDelta(delta:number|null){
  if(delta===null)return '';
  const ms=deltaMs(delta);
  if(ms===0)return '0.000';
  return (ms>0?'+':'-')+(Math.abs(ms)/1000).toFixed(3);
}

const isPositive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
function parseSectorNumbers(raw:unknown,expectedSum?:number):SectorNumbers|null{
  if(!Array.isArray(raw)||raw.length!==3||!raw.every(isPositive))return null;
  if(expectedSum!==undefined&&Math.abs(raw[0]+raw[1]+raw[2]-expectedSum)>.05)return null;
  return [raw[0],raw[1],raw[2]];
}

type LapRecapHold=
  |{
    kind:'last-lap';
    lap:number;
    seconds:number;
    sectors:SectorNumbers;
    ratings:[SectorRating,SectorRating,SectorRating];
    deltas:SectorTuple;
    refKinds:[SectorRefKind,SectorRefKind,SectorRefKind];
    until:number;
  }
  |{
    kind:'invalid';
    lap:number;
    reason:string;
    sectors:SectorTuple;
    until:number;
  };

export class AttemptTiming {
  private readonly layout: string;
  constructor(layout: string) { this.layout=layout; }
  count=0;
  best:number|null=null;
  last:number|null=null;
  progress=0;
  readonly history:LapHistoryEntry[]=[];
  status:'waiting'|'running'|'invalid'|'complete'='waiting';
  reason='';
  sectors:SectorTuple=[null,null,null];
  sectorRatings:[SectorRating,SectorRating,SectorRating]=['pending','pending','pending'];
  sectorDeltas:SectorTuple=[null,null,null];
  sectorRefKinds:[SectorRefKind,SectorRefKind,SectorRefKind]=[null,null,null];
  bestSectors:SectorTuple=[null,null,null];
  bestLapSectors:SectorNumbers|null=null;
  lastLapSectors:SectorNumbers|null=null;
  protected elapsed=0;
  protected began=0;
  private sectorBegan=0;
  private sectorIndex:SectorIndex=0;
  protected lastLapHold:LapRecapHold|null=null;

  get current(){return this.status==='running'?this.elapsed-this.began:null;}
  get currentSector():SectorIndex{return this.sectorIndex;}
  get currentSectorTime(){return this.status==='running'?this.elapsed-this.sectorBegan:null;}
  get theoreticalBest(){
    const [a,b,c]=this.bestSectors;
    return a!==null&&b!==null&&c!==null?a+b+c:null;
  }
  get showingLastLap(){
    return (this.status==='running'||this.status==='complete')&&this.lastLapHold?.kind==='last-lap'&&this.elapsed<this.lastLapHold.until;
  }
  get showingInvalidRecap(){
    return this.status==='running'&&this.lastLapHold?.kind==='invalid'&&this.elapsed<this.lastLapHold.until;
  }

  sectorDisplay():SectorDisplay{
    if((this.status==='running'||this.status==='complete')&&this.lastLapHold&&this.elapsed<this.lastLapHold.until){
      if(this.lastLapHold.kind==='last-lap'){
        return {
          mode:'last-lap',
          lap:this.lastLapHold.lap,
          reason:null,
          activeSector:null,
          currentSectorTime:null,
          sectors:[...this.lastLapHold.sectors],
          ratings:[...this.lastLapHold.ratings],
          deltas:[...this.lastLapHold.deltas],
          refKinds:[...this.lastLapHold.refKinds],
        };
      }
      return {
        mode:'invalid',
        lap:this.lastLapHold.lap,
        reason:this.lastLapHold.reason,
        activeSector:null,
        currentSectorTime:null,
        sectors:[...this.lastLapHold.sectors],
        ratings:['invalid','invalid','invalid'],
        deltas:[null,null,null],
        refKinds:[null,null,null],
      };
    }
    if(this.status==='invalid'){
      return {
        mode:'invalid',
        lap:this.count+1,
        reason:this.reason||null,
        activeSector:null,
        currentSectorTime:null,
        sectors:[...this.sectors],
        ratings:['invalid','invalid','invalid'],
        deltas:[null,null,null],
        refKinds:[null,null,null],
      };
    }
    if(this.status==='running'){
      return {
        mode:'current',
        lap:this.count+1,
        reason:null,
        activeSector:this.sectorIndex,
        currentSectorTime:this.currentSectorTime,
        sectors:[...this.sectors],
        ratings:[...this.sectorRatings],
        deltas:[...this.sectorDeltas],
        refKinds:[...this.sectorRefKinds],
      };
    }
    return {
      mode:'waiting',
      lap:null,
      reason:null,
      activeSector:null,
      currentSectorTime:null,
      sectors:[null,null,null],
      ratings:['pending','pending','pending'],
      deltas:[null,null,null],
      refKinds:[null,null,null],
    };
  }

  records():StoredLapRecords{
    return {
      count:this.count,
      best:this.best,
      history:this.history.map(entry=>entry.sectors
        ?{lap:entry.lap,seconds:entry.seconds,sectors:[...entry.sectors] as SectorNumbers}
        :{lap:entry.lap,seconds:entry.seconds}),
      sectorLayout:this.layout,
      bestSectors:[...this.bestSectors],
      bestLapSectors:this.bestLapSectors?[...this.bestLapSectors]:null,
    };
  }

  restore(data:unknown){
    if(!data||typeof data!=='object')return;
    const raw=data as Partial<StoredLapRecords>;
    if(!Number.isSafeInteger(raw.count)||(raw.count as number)<1||!isPositive(raw.best)||!Array.isArray(raw.history))return;
    const layoutMatches=raw.sectorLayout===this.layout;
    const history:LapHistoryEntry[]=[];
    for(const item of raw.history){
      if(!item||typeof item!=='object')continue;
      const l=item as Partial<LapHistoryEntry>;
      if(!Number.isSafeInteger(l.lap)||(l.lap as number)<1||(l.lap as number)>(raw.count as number)||!isPositive(l.seconds))continue;
      const entry:LapHistoryEntry={lap:l.lap as number,seconds:l.seconds};
      if(layoutMatches){
        const parsed=parseSectorNumbers(l.sectors,l.seconds);
        if(parsed)entry.sectors=parsed;
      }
      history.push(entry);
      if(history.length>=6)break;
    }
    this.count=raw.count as number;
    this.best=raw.best;
    this.last=history[0]?.seconds ?? null;
    this.history.splice(0,this.history.length,...history);
    this.bestSectors=[null,null,null];
    this.bestLapSectors=null;
    this.lastLapSectors=history[0]?.sectors?[...history[0].sectors]:null;
    if(!layoutMatches)return;
    if(Array.isArray(raw.bestSectors)&&raw.bestSectors.length===3){
      const next:SectorTuple=[null,null,null];
      let valid=true;
      for(let k=0;k<3;k++){
        const v=raw.bestSectors[k];
        if(v===null)next[k]=null;
        else if(isPositive(v))next[k]=v;
        else {valid=false;break;}
      }
      if(valid)this.bestSectors=next;
    }
    const bestLapSectors=parseSectorNumbers(raw.bestLapSectors,this.best);
    if(bestLapSectors){
      const consistent=bestLapSectors.every((v,k)=>this.bestSectors[k]===null||v>=this.bestSectors[k]!-1e-3);
      if(consistent){
        this.bestLapSectors=bestLapSectors;
        for(let k=0;k<3;k++){
          if(this.bestSectors[k]===null)this.bestSectors[k]=bestLapSectors[k];
        }
      }
    }
  }

  private clearCurrentSectors(){
    this.sectorIndex=0;
    this.sectors=[null,null,null];
    this.sectorRatings=['pending','pending','pending'];
    this.sectorDeltas=[null,null,null];
    this.sectorRefKinds=[null,null,null];
  }

  cancel(){
    this.status='waiting';this.reason='';this.progress=0;
    this.lastLapHold=null;
    this.clearCurrentSectors();
  }

  reset(){
    this.cancel();
    this.elapsed=0;this.began=0;this.sectorBegan=0;
    this.count=0;this.best=this.last=null;this.history.length=0;
    this.bestSectors=[null,null,null];
    this.bestLapSectors=null;
    this.lastLapSectors=null;
  }

  invalidate(reason:string){
    if(this.status==='running'){
      this.status='invalid';
      this.reason=reason;
      this.lastLapHold=null;
      this.sectorRatings=['invalid','invalid','invalid'];
      this.sectorDeltas=[null,null,null];
      this.sectorRefKinds=[null,null,null];
    }
  }

  private evaluateSector(index:SectorIndex,seconds:number):{rating:SectorRating;delta:number|null;refKind:SectorRefKind}{
    const bestSector=this.bestSectors[index];
    const bestLapSector=this.bestLapSectors?.[index]??null;
    const ref=bestLapSector??bestSector;
    if(ref===null)return {rating:'baseline',delta:null,refKind:null};
    const refKind:SectorRefKind=bestLapSector!==null?'bestLap':'bestSector';
    const delta=seconds-ref;
    const ms=deltaMs(delta);
    const bestSectorMs=bestSector!==null?deltaMs(seconds-bestSector):null;
    if(bestSectorMs!==null&&bestSectorMs<0)return {rating:'purple',delta,refKind};
    if(bestLapSector!==null&&ms<0)return {rating:'green',delta,refKind};
    if(ms===0)return {rating:'equal',delta:0,refKind};
    return {rating:'yellow',delta,refKind};
  }

  protected beginAttempt(when: number) {
    this.began=this.sectorBegan=when;
    this.status='running';
    this.reason='';
    this.clearCurrentSectors();
  }

  protected completeSector(when: number) {
    const index=this.sectorIndex;
    const duration=when-this.sectorBegan;
    const evaluated=this.evaluateSector(index,duration);
    this.sectors[index]=duration;
    this.sectorRatings[index]=evaluated.rating;
    this.sectorDeltas[index]=evaluated.delta;
    this.sectorRefKinds[index]=evaluated.refKind;
    this.sectorBegan=when;
    if(index<2)this.sectorIndex=(index+1) as SectorIndex;
    this.lastLapHold=null;
  }

  protected recordAttempt(when: number, hold: number) {
    this.completeSector(when);
    const splits:SectorNumbers=[this.sectors[0]!,this.sectors[1]!,this.sectors[2]!];
    const seconds=when-this.began;
    this.count++;
    this.last=seconds;
    this.lastLapSectors=[...splits];
    if(this.best===null||seconds<this.best){
      this.best=seconds;
      this.bestLapSectors=[...splits];
    }
    splits.forEach((split,k)=>{
      const previous=this.bestSectors[k];
      if(previous===null||split<previous)this.bestSectors[k]=split;
    });
    this.history.unshift({lap:this.count,seconds,sectors:[...splits]});
    if(this.history.length>6)this.history.pop();
    this.lastLapHold={
      kind:'last-lap',lap:this.count,seconds,sectors:[...splits],
      ratings:[...this.sectorRatings],deltas:[...this.sectorDeltas],refKinds:[...this.sectorRefKinds],
      until:when+hold,
    };
  }
}

export class LapTiming extends AttemptTiming {
  private node=-1;
  private previous=new Vector3();
  private initialized=false;
  private nextGate=1;
  private distance=0;
  private peak=0;
  private arc=0;

  constructor(){super(SECTOR_LAYOUT_ID);}

  override cancel(){
    super.cancel();
    this.node=-1;
    this.initialized=false;
  }

  private locate(p:Vector3){
    if(this.node<0)this.node=nearestStation(p.x,p.z).index;
    let best=Infinity,found=this.node;
    for(let i=-4;i<=4;i++){
      const idx=(this.node+i+nodeCount)%nodeCount,q=stations[idx].p,dist=(p.x-q.x)**2+(p.z-q.z)**2;
      if(dist<best){found=idx;best=dist;}
    }
    this.node=found;
    const {p:q,forward}=stations[found],dx=p.x-q.x,dz=p.z-q.z;
    const along=(dx*forward.x+dz*forward.z)/(forward.x**2+forward.z**2);
    const deviation=Math.hypot(dx-forward.x*along,dz-forward.z*along);
    return {arc:found*spacing+along,onRoad:deviation<roadHalfWidth+.60&&Math.abs(p.y-q.y-along*forward.y)<1.65};
  }

  step(p:Vector3,heading:Vector3,signedSpeed:number,dt:number){
    const old=this.previous;
    if(this.initialized&&old.distanceToSquared(p)>4){this.invalidate('Position jump');this.node=-1;this.initialized=false;}
    const loc=this.locate(p);
    this.elapsed+=dt;
    this.progress=MathUtils.euclideanModulo(loc.arc-startDistance,courseLength)/courseLength;
    if(this.initialized){
      let delta=loc.arc-this.arc;
      if(Math.abs(delta)>courseLength/2)delta-=Math.sign(delta)*courseLength;
      this.distance+=delta;this.peak=Math.max(this.distance,this.peak);
      if(!loc.onRoad)this.invalidate('Track limits');
      if(this.peak-this.distance>3)this.invalidate('Wrong direction');
      // Checking the local gates catches missed gates and reverse crossings as well as the finish.
      for(let i=0;i<gates.length;i++){
        const g=gates[i],x=p.x-g.p.x,z=p.z-g.p.z;
        if(Math.abs(x)>10||Math.abs(z)>10)continue;
        const a=(old.x-g.p.x)*g.forward.x+(old.z-g.p.z)*g.forward.z;
        const b=x*g.forward.x+z*g.forward.z;
        if(!(a<0&&b>=0)&&!(a>0&&b<=0))continue;
        if(!loc.onRoad)continue;
        const withinGate=Math.abs(x*g.right.x+z*g.right.z)<=roadHalfWidth+.30;
        const forward=b>a&&heading.dot(g.forward)>.25&&signedSpeed>0;
        if(!withinGate){
          if(this.status==='running'&&forward&&(i===this.nextGate||(i===0&&this.nextGate===gates.length))){
            this.invalidate('Checkpoint missed');
          }
          continue;
        }
        if(!forward){this.invalidate('Wrong direction');continue;}
        if(i===0){
          const when=this.elapsed-dt+dt*(-a/(b-a));
          if(this.status==='running'&&this.nextGate===gates.length&&this.distance>courseLength-5
             &&this.sectors[0]!==null&&this.sectors[1]!==null){
            this.recordAttempt(when,lastLapHoldSeconds);
          }else if(this.status==='invalid'){
            this.lastLapHold={
              kind:'invalid',
              lap:this.count+1,
              reason:this.reason||'Invalid lap',
              sectors:[...this.sectors],
              until:when+lastLapHoldSeconds,
            };
          }else{
            this.lastLapHold=null;
          }
          this.distance=this.peak=0;
          this.nextGate=1;
          this.beginAttempt(when);
        }else if(this.status==='running'){
          if(i===this.nextGate){
            const boundary=sectorBoundaryIndices.indexOf(i as (typeof sectorBoundaryIndices)[number]);
            if(boundary!==-1)this.completeSector(this.elapsed-dt+dt*(-a/(b-a)));
            this.nextGate++;
          }else this.invalidate('Checkpoint missed');
        }
      }
    }
    this.arc=loc.arc;this.initialized=true;old.copy(p);
  }
}
