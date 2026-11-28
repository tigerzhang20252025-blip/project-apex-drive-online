import * as T from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { addPineglassColliders, createPineglassGround } from './pineglass-ground.ts';
import { dressMountainLandscape, dressMountainSurface } from './pineglass-landscape.ts';
import { cutPineglassGorge } from './pineglass-gorge.ts';
import { buildMountainProtection } from './pineglass-protection.ts';
import { mountainAlignment as route, mountainCrest, mountainGorge, mountainShoulderWidth, mountainUndulation } from './pineglass-v2.ts';

const {lerp,smoothstep}=T.MathUtils;
const crest=route.sampleAt(mountainCrest);
const cliff=route.sampleAt(2860);
const ridge=route.sampleAt(4760);

const ranges = [
  [-600,550,475,600,570],[625,-980,660,742,451],[848,1630,585,470,480],
  [1440,2440,840,720,500],[2430,1600,658,600,381],[2940,-980,780,643,525],
  [3650,1200,640,485,571],[4390,-960,828,579,626],[4950,540,624,800,530],
] as const;

function mountainMasses(x: number, z: number) {
  const warp = z+85*Math.sin(x*.0052);
  const rockFolds = .83+.12*Math.sin(x*.011-z*.009)+.09*Math.cos(z*.023+x*.012)+.04*Math.sin(x*.041+z*.03);
  let broadRidge = 0;
  for (const [east,north,height,width,depth] of ranges) {
    const diagonal = x-east+(z-north)*.34;
    const shape=(diagonal/width)**2+((warp-north)/depth)**2;
    broadRidge=Math.max(broadRidge,height*Math.exp(-(shape**.83))*rockFolds);
  }
  const hill=(p:T.Vector3,h:number,range:number)=>h*Math.exp(-((x-p.x)**2+(z-p.z)**2)/range**2);
  return 180+broadRidge+hill(crest.p,145,700)+hill(ridge.p,170,820)+hill(cliff.p,96,850)
    +20*Math.sin(x*.0042-z*.0012)+12*Math.sin(z*.0028+x*.0020)
    +5*Math.sin(x*.025+z*.031)*Math.sin(z*.012);
}

const catchVerge = [
  [405,480,655,733,-1],
  [645,715,940,1065,1],
  [762,820,1080,1160,-1],
  [1875,1920,2040,2140,1],
  [3090,3135,3205,3250,-1],
  [4051,4080,4140,4186,-1],
  [4093,4141,4190,4226,1],
  [4405,4440,4505,4560,1],
  [5060,5120,5350,5440,1],
  [6095,6150,6370,6470,1],
] as const;

function recoveryVerge(station:number,side:number){
  let blend=0;
  for(const [start,full,leave,end,edge] of catchVerge){
    if(side===edge&&station>start&&station<end)
      blend=Math.max(blend,smoothstep(station,start,full)*(1-smoothstep(station,leave,end)));
  }
  return blend;
}

function mountainHeight(x:number,z:number,near?:ReturnType<typeof route.project>){
  const natural=mountainMasses(x,z);
  if(!near||near.distance>=150)return cutPineglassGorge(x,z,natural);
  const road=route.sampleAt(near.station);
  const d=near.distance, chain=near.station, side=Math.sign(near.lateral);
  const inBand=(a:number,b:number,c:number,e:number)=>smoothstep(chain,a,b)*(1-smoothstep(chain,c,e));
  const exposure=inBand(2630,2750,3190,3545);
  const skyline=inBand(1450,1540,1750,1850);
  const descent=inBand(5440,5530,5990,6200);
  const verge=recoveryVerge(chain,side);
  const forgivingBed=1.87*(.46+.54*verge)*smoothstep(d,7.5,13)*(1-smoothstep(d,24,37));
  const shoulder=road.p.y-2.75+forgivingBed;
  const shelf=lerp(shoulder,natural,smoothstep(d,22+6*verge,141));
  const rockBreak=.82+.15*Math.sin(chain*.021+d*.11)+.13*Math.cos(chain*.046-d*.039);
  const bluff=exposure * (side>0 ? -76 : 69) * rockBreak;
  const crestFlank=side<0 ? -44*skyline : 11*skyline;
  const valleyFlank=side<0 ? -51*descent : -18*descent;
  const relief=(bluff+crestFlank+valleyFlank)*smoothstep(d,18,76)*(1-smoothstep(d,98,150));
  const ditch=-.68*(1-.92*verge)*Math.exp(-(((d-17)/5.1)**2))*(.60+.38*Math.cos(chain*.031))*inBand(13,95,6470,6600);
  const insideCuts = (side>0 ? 16*inBand(3290,3320,3440,3486) :
    12*inBand(2770,2800,2990,3040)+7*inBand(5280,5330,5390,5425))
    *smoothstep(d,12,28)*(1-smoothstep(d,37,68))*rockBreak;
  // A bank in the centre of the Quarry Hook keeps its two legs visually and
  // physically separated while leaving the outside apron recoverable.
  const quarry=side>0 ? 17*inBand(538,605,697,760)*smoothstep(d,13,26)*
    (1-smoothstep(d,35,48))*rockBreak : 0;
  return cutPineglassGorge(x,z,shelf+relief+ditch+insideCuts+quarry);
}

export const createMountainGround=()=>createPineglassGround(route,{
  height:mountainHeight,surfaceHeight:mountainUndulation,blendShoulders:true,
  widerVerge:(station,side)=>2.4+4.6*recoveryVerge(station,side),shoulderWidth:mountainShoulderWidth,deck:[mountainGorge.deckStart,mountainGorge.deckEnd],
});

export async function buildPineglassMountain(root:T.Object3D,world:RAPIER.World,renderer:T.WebGLRenderer,textures:Set<T.Texture>){
  const {parts,groundY,gridHeight,tileBounds}=createMountainGround();
  addPineglassColliders(world,parts);
  const rock = dressMountainSurface(root,parts,gridHeight,renderer,textures);
  buildMountainProtection(root,world);
  return await dressMountainLandscape(root,groundY,mountainMasses,rock,tileBounds);
}
