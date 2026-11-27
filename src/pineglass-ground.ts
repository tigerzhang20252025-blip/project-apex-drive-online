import { Box3, MathUtils } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { StageAlignment } from './stage-alignment.ts';

const { lerp, smoothstep } = MathUtils;
const tileSize = 128, cellSize = 8;
export const pineglassFriction = { road:.72, shoulder:.62, ground:.45 } as const;

export type GroundPart = {
  kind: keyof typeof pineglassFriction;
  vertices: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
  vergeBlend?: Float32Array;
  terrainTile?: boolean;
  station?: number;
  roadStations?: Float32Array;
};

type TerrainLocation = ReturnType<StageAlignment['project']>;
type TerrainProfile = {
  height: (x: number, z: number, near?: TerrainLocation) => number;
  deck?: readonly [start:number,end:number];
  surfaceHeight?: (station:number,across:number) => number;
  blendShoulders?: boolean;
  widerVerge?: (station:number,side:number) => number;
  shoulderWidth?: (station:number) => number;
};

export function createPineglassGround(
  route:StageAlignment, profile:TerrainProfile,
) {
  const {meshStations,project}=route;
  const vicinitySize=64, vicinity=new Set<string>();
  for(let i=0;i<meshStations.length;i+=12){
    const {x,z}=meshStations[i].p;
    const a=Math.floor(x/vicinitySize),b=Math.floor(z/vicinitySize);
    for(let u=a-2;u<=a+2;u++)for(let v=b-2;v<=b+2;v++)vicinity.add(u+','+v);
  }
  const parts: GroundPart[] = [];
  const heights = new Map<number,Map<number,number>>();
  const gridHeight = (x: number, z: number) => {
    let row=heights.get(x);
    if(!row){row=new Map();heights.set(x,row);}
    const cached=row.get(z);
    if(cached!==undefined)return cached;
    const keyInVicinity=Math.floor(x/vicinitySize)+','+Math.floor(z/vicinitySize);
    const value=profile.height(x,z,vicinity.has(keyInVicinity)?project(x,z):undefined);
    row.set(z,value);
    return value;
  };
  // The same diagonal and samples as the underlying terrain tiles. Shoulder
  // edges meet the actual triangle height, including on the hairpin shelf.
  const groundY = (x: number, z: number) => {
    const left = Math.floor(x/cellSize)*cellSize, top = Math.floor(z/cellSize)*cellSize;
    const u = (x-left)/cellSize, v = (z-top)/cellSize;
    if(u+v<=1)return (1-u-v)*gridHeight(left,top)+u*gridHeight(left+cellSize,top)+v*gridHeight(left,top+cellSize);
    return (u+v-1)*gridHeight(left+cellSize,top+cellSize)+(1-u)*gridHeight(left,top+cellSize)+(1-v)*gridHeight(left+cellSize,top);
  };
  const bounds = new Box3().setFromPoints(meshStations.map(s=>s.p)).expandByScalar(660);
  const cells = tileSize/cellSize;
  for(let x0=Math.floor(bounds.min.x/tileSize)*tileSize;x0<bounds.max.x;x0+=tileSize){
    for(let z0=Math.floor(bounds.min.z/tileSize)*tileSize;z0<bounds.max.z;z0+=tileSize){
      const vertices=new Float32Array((cells+1)**2*3),indices=new Uint32Array(cells*cells*6);
      const colors=new Float32Array(vertices.length).fill(1);
      let vertex=0,index=0;
      for(let j=0;j<=cells;j++)for(let i=0;i<=cells;i++){
        const x=x0+i*cellSize,z=z0+j*cellSize;
        vertices[vertex++]=x;vertices[vertex++]=gridHeight(x,z);vertices[vertex++]=z;
        if(i<cells&&j<cells){
          const k=j*(cells+1)+i;
          indices[index++]=k;indices[index++]=k+cells+1;indices[index++]=k+1;
          indices[index++]=k+cells+1;indices[index++]=k+cells+2;indices[index++]=k+1;
        }
      }
      parts.push({kind:'ground',terrainTile:true,vertices,indices,colors});
    }
  }
  const addRibbon = (first: number,last: number,kind: 'road'|'shoulder'|'ground',side: number) => {
    const vertices:number[] = [], indices:number[] = [], colors:number[] = [];
    const columns = kind==='road'?[-1,-.82,-.62,-.43,-.23,0,.23,.43,.62,.82,1]:kind==='shoulder'?[0,1]:[0,.38,.74,1];
    const stride=columns.length;
    const roadStations=kind==='ground'?undefined:[] as number[];
    const vergeBlend = profile.blendShoulders && kind==='shoulder' ? [] as number[] : undefined;
    for(let i=first;i<=last;i++){
      const s=meshStations[i];
      const extra=kind==='ground'?(profile.widerVerge?.(s.distance,side)??0):0;
      const shoulder=profile.shoulderWidth?.(s.distance)??1.5;
      for(const column of side<0?[...columns].reverse():columns){
        const inner=s.halfWidth+shoulder, outer=Math.max(11.5+extra,inner+.7);
        const across=kind==='road'?column*s.halfWidth:side*(kind==='shoulder'?s.halfWidth+column*shoulder:lerp(inner,outer,column));
        const x=s.p.x+across*s.right.x,z=s.p.z+across*s.right.z;
        const ripple=profile.surfaceHeight?.(s.distance,across)??0;
        const crown=s.p.y+across*s.right.y+.014+ripple;
        const y=kind==='road'?crown:kind==='shoulder'?crown-.08*column:
          lerp(crown-.08,groundY(x,z)-.07,smoothstep(column,0,1));
        vertices.push(x,y,z);
        vergeBlend?.push(column);
        roadStations?.push(s.distance);
        const rut=Math.exp(-((Math.abs(across)-1.55)**2)/.84);
        const band=kind==='road'?.98-.13*rut:kind==='shoulder'?.88:.84;
        const tint=band+.045*Math.sin(x*.089+z*.048)+.036*Math.sin(s.distance*.095+across*.67);
        colors.push(tint,tint,tint*.96);
      }
      const deck = profile.deck && s.distance>profile.deck[0] && s.distance<=profile.deck[1];
      if(i>first&&!(kind==='ground'&&deck)){
        const row=(i-first-1)*stride;
        for(let k=0;k<stride-1;k++){
          const n=row+k;
          indices.push(n,n+1,n+stride,n+1,n+stride+1,n+stride);
        }
      }
    }
    if (!indices.length) return; // A terrain ribbon can lie entirely below the bridge deck.
    parts.push({kind,station:meshStations[first].distance,vertices:new Float32Array(vertices),indices:new Uint32Array(indices),colors:new Float32Array(colors),
      ...(vergeBlend ? {vergeBlend:new Float32Array(vergeBlend)} : {}),
      ...(roadStations ? {roadStations:new Float32Array(roadStations)} : {})});
  };
  for(let first=0;first<meshStations.length-1;first+=104){
    const last=Math.min(first+104,meshStations.length-1);
    addRibbon(first,last,'road',1);
    for(const side of [-1,1]){
      addRibbon(first,last,'shoulder',side);
      addRibbon(first,last,'ground',side);
    }
  }
  return { parts, groundY, gridHeight };
}

export function addPineglassColliders(world: RAPIER.World, parts: readonly GroundPart[]) {
  for (const part of parts) {
    world.createCollider(RAPIER.ColliderDesc.trimesh(part.vertices,part.indices,RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(pineglassFriction[part.kind]));
  }
}
