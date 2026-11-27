import * as T from 'three';
import { asset, loadMap, rng, signTexture } from './environment.ts';
import { plantForest } from './forest.ts';
import { surfaceNoise, weatheredConcrete } from './pineglass-materials.ts';
import type { GroundPart } from './pineglass-ground.ts';
import { mountainAlignment as route, mountainGorge, mountainQuarry, mountainSectors, mountainShoulderWidth, mountainUndulation } from './pineglass-v2.ts';
import { gorgeRiverPoint, viaductPoint } from './pineglass-gorge.ts';
import { mirrorExcludedLayer } from './mirrors.ts';
import { StartSignal } from './start-gantry.ts';

const { lerp, smoothstep } = T.MathUtils;
const bounds = new T.Box3().setFromPoints(route.meshStations.map(s => s.p));
type Height = (x: number, z: number) => number;

export function dressMountainSurface(root: T.Object3D, parts: readonly GroundPart[], gridHeight: Height, renderer: T.WebGLRenderer, textures: Set<T.Texture>) {
  const loader = new T.TextureLoader();
  const load = (name: string, srgb = true) => {
    const map = loadMap(loader,name,srgb,Math.min(8,renderer.capabilities.getMaxAnisotropy()));
    textures.add(map);
    return map;
  };
  const road = new T.MeshStandardMaterial({
    color:0xcbbb9e, map:load('gravel-color.jpg'), normalMap:load('gravel-normal.jpg',false),
    normalScale:new T.Vector2(.67,.67), roughness:.96, vertexColors:true, envMapIntensity:.27,
  });
  const shoulder = road.clone();
  shoulder.color.setHex(0xb9ad94);
  shoulder.normalScale.setScalar(.9);
  const grass = load('leafy_grass-diffuse.jpg'), rock = load('lichen_rock-diffuse.jpg'), soil = load('brown-mud.jpg');
  const concreteMap=load('asphalt.jpg');
  const {deckStart,deckEnd}=mountainGorge;
  for(const material of [road,shoulder]){
    const verge=material===shoulder;
    material.customProgramCacheKey=()=>verge?'Pineglass shoulder':'Pineglass road';
    material.onBeforeCompile=shader=>{
      shader.uniforms.bridgeMap={value:concreteMap};
      shader.uniforms.bridgeBounds={value:new T.Vector2(deckStart,deckEnd)};
      if(verge)shader.uniforms.vergeGrass={value:grass};
      shader.vertexShader='attribute float roadStation; varying float pgStation; varying vec2 pgRoad;\n'
        +(verge?'attribute float vergeBlend; varying float pgVerge;\n':'')+shader.vertexShader
        .replace('#include <begin_vertex>','#include <begin_vertex>\npgStation=roadStation; pgRoad=position.xz;'
          +(verge?' pgVerge=vergeBlend;':''));
      shader.fragmentShader='uniform sampler2D bridgeMap; uniform vec2 bridgeBounds; varying float pgStation; varying vec2 pgRoad;\n'
        +(verge?'uniform sampler2D vergeGrass; varying float pgVerge;\n':'')+surfaceNoise+shader.fragmentShader.replace('#include <map_fragment>', `
          float deck=smoothstep(bridgeBounds.x-12.,bridgeBounds.x+4.,pgStation)
            *(1.-smoothstep(bridgeBounds.y-4.,bridgeBounds.y+12.,pgStation));
          vec3 gravel=texture2D(map,vMapUv).rgb;
          float variation=pgNoise(pgRoad*.09);
          ${verge?`
            float coverage=smoothstep(.38,1.03,pgVerge+(pgNoise(pgRoad*2.7)-.5)*.42);
            vec3 leafy=pgTexture(vergeGrass,pgRoad/4.7,variation)*vec3(.78,.92,.73);
            gravel=mix(gravel,leafy,coverage*.85);
          ` : ''}
          vec3 paved=pgTexture(bridgeMap,pgRoad*.26,variation);
          float seam=1.-smoothstep(.002,.006,abs(fract((pgStation-bridgeBounds.x)/46.)-.5));
          float weather=.88+.16*pgNoise(vec2(pgStation*.13,pgRoad.y*.84));
          vec3 deckStone=mix(vec3(.47,.49,.50),paved*vec3(1.00,1.02,1.02),.35)*weather*(1.-.47*seam);
          diffuseColor.rgb*=mix(gravel,deckStone,deck);
        `);
    };
  }
  const ground = new T.MeshStandardMaterial({map:grass,color:0xd2ccae,roughness:1,envMapIntensity:.28,
    emissive:0x273437,emissiveIntensity:.066});
  ground.onBeforeCompile = shader => {
    shader.uniforms.mountainRock = {value:rock};
    shader.uniforms.mountainSoil = {value:soil};
    shader.vertexShader = 'varying vec3 mountainPosition; varying vec3 mountainNormal;\n' + shader.vertexShader
      .replace('#include <begin_vertex>','#include <begin_vertex>\n mountainPosition=position; mountainNormal=normal;');
    shader.fragmentShader = surfaceNoise + `
      uniform sampler2D mountainRock;
      uniform sampler2D mountainSoil;
      varying vec3 mountainPosition;
      varying vec3 mountainNormal;
    ` + shader.fragmentShader.replace('#include <map_fragment>',`
      vec3 p=mountainPosition;
      vec3 n=normalize(mountainNormal);
      float broad=pgNoise(p.xz*.017+7.);
      float flecks=pgNoise(p.xz*.091+p.y*.006);
      float variation=.62*broad+.38*flecks;
      float slope=1.-abs(n.y);
      float exposed=smoothstep(.10,.40,slope+.08*(variation-.5))+.14*smoothstep(425.,545.,p.y);
      float wallBlend=smoothstep(.10,.90,abs(n.z)/max(.001,abs(n.x)+abs(n.z)));
      vec2 fracture=vec2(pgNoise(p.xz*.043),pgNoise(vec2(p.y,p.x+p.z)*.068))-.5;
      vec3 eastRock=pgTexture(mountainRock,vec2(p.z,p.y)*.103+fracture*.43,variation);
      vec3 northRock=pgTexture(mountainRock,vec2(p.x,p.y)*.103+fracture*.43,variation);
      float veins=pgNoise(vec2(p.y*.23,p.x*.018+p.z*.013)+fracture*.7);
      float detail=1.-smoothstep(42.,230.,length(vViewPosition));
      vec3 distantRock=mix(vec3(.19,.19,.18),vec3(.39,.35,.29),broad*.73+veins*.27);
      vec3 strata=mix(distantRock,mix(eastRock,northRock,wallBlend),detail);
      strata*=.82+.28*veins+.11*broad;
      vec3 vegetation=pgTexture(map,vMapUv,variation);
      vec3 loam=pgTexture(mountainSoil,vMapUv*.73,1.-variation);
      float scrub=smoothstep(.24,.81,variation+.16*smoothstep(365.,490.,p.y));
      vec3 field=mix(vegetation*vec3(.79,.91,.72),loam*vec3(1.10,1.03,.79),scrub*.60);
      vec3 distantField=mix(vec3(.13,.16,.094),vec3(.33,.31,.20),scrub);
      field=mix(distantField,field,detail);
      field*=.82+.33*broad+.09*flecks;
      diffuseColor.rgb *= mix(field,strata*vec3(.85,.91,1.02),clamp(exposed,0.,1.));
    `);
  };
  const materials = {road,shoulder,ground};
  const chunks = new Map<string, GroundPart[]>();
  for (const part of parts) {
    if (!part.indices.length) continue;
    const key = part.terrainTile
      ? 'terrain:'+Math.floor(part.vertices[0]/512)+','+Math.floor(part.vertices[2]/512)
      : part.kind+':'+Math.floor(part.station!/640);
    const chunk=chunks.get(key);
    if(chunk) chunk.push(part);
    else chunks.set(key,[part]);
  }
  for (const [key, chunk] of chunks) {
    const {kind,terrainTile}=chunk[0];
    const count=chunk.reduce((sum,part)=>sum+part.vertices.length/3,0);
    const positions=new Float32Array(count*3),colors=new Float32Array(count*3),uv=new Float32Array(count*2);
    const indices=new (count<65536?Uint16Array:Uint32Array)(chunk.reduce((sum,part)=>sum+part.indices.length,0));
    const vergeBlend=kind==='shoulder'?new Float32Array(count):undefined;
    const roadStations=kind==='ground'?undefined:new Float32Array(count);
    let vertex=0,index=0;
    for(const part of chunk){
      positions.set(part.vertices,vertex*3);
      colors.set(part.colors,vertex*3);
      if(part.vergeBlend)vergeBlend?.set(part.vergeBlend,vertex);
      if(part.roadStations)roadStations?.set(part.roadStations,vertex);
      for(const value of part.indices)indices[index++]=value+vertex;
      vertex+=part.vertices.length/3;
    }
    const size=kind==='ground'?4.7:2.65;
    const normals=terrainTile?new Float32Array(positions.length):undefined;
    for(let i=0;i<count;i++){
      const x=positions[i*3],z=positions[i*3+2];
      uv[i*2]=x/size;uv[i*2+1]=z/size;
      if(normals){
        const dx=gridHeight(x-8,z)-gridHeight(x+8,z),dz=gridHeight(x,z-8)-gridHeight(x,z+8);
        const inverse=1/Math.sqrt(dx*dx+256+dz*dz);
        normals[i*3]=dx*inverse;normals[i*3+1]=16*inverse;normals[i*3+2]=dz*inverse;
      }
    }
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(positions,3));
    geometry.setAttribute('color',new T.BufferAttribute(colors,3));
    geometry.setAttribute('uv',new T.BufferAttribute(uv,2));
    if(vergeBlend)geometry.setAttribute('vergeBlend',new T.BufferAttribute(vergeBlend,1));
    if(roadStations)geometry.setAttribute('roadStation',new T.BufferAttribute(roadStations,1));
    geometry.setIndex(new T.BufferAttribute(indices,1));
    if(normals)geometry.setAttribute('normal',new T.BufferAttribute(normals,3));
    else geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh=new T.Mesh(geometry,materials[kind]);
    mesh.name=key;
    mesh.receiveShadow=true;
    root.add(mesh);
  }
  return rock;
}

function skyline(root: T.Object3D, height: Height) {
  // Distant terrain continues under the local tiles. Its coarse mesh is visual only.
  const extent = bounds.clone().expandByScalar(2400);
  const horizon = new T.PlaneGeometry(extent.max.x-extent.min.x,extent.max.z-extent.min.z,107,78).rotateX(-Math.PI/2);
  const midpoint = extent.getCenter(new T.Vector3());
  horizon.translate(midpoint.x,0,midpoint.z);
  const close = bounds.clone().expandByScalar(638);
  const ridges = (x:number,z:number) => {
    const noise = (x:number,z:number) => {
      const i=Math.floor(x),j=Math.floor(z),u=smoothstep(x-i,0,1),v=smoothstep(z-j,0,1);
      const hash=(x:number,z:number)=>((Math.imul(x+176,747796405)^Math.imul(z-67,2891336453))>>>0)/4294967295;
      return lerp(lerp(hash(i,j),hash(i+1,j),u),lerp(hash(i,j+1),hash(i+1,j+1),u),v);
    };
    const warp=178*(noise(x/1030,z/1030)-.5);
    const main=1-Math.abs(2*noise((x+warp)/480,(z-warp)/480)-1);
    const ridge=1-Math.abs(2*noise((.78*x+z)/310,(z-.51*x)/340)-1);
    return 185*(main**2-.28)+59*(ridge**2-.29)+23*(noise(x/113,z/103)-.5);
  };
  const position = horizon.getAttribute('position');
  const colors: number[] = [];
  const held = new Set<number>();
  const moss = new T.Color(0x5d7166), slate = new T.Color(0x899397), tint = new T.Color();
  for (let i=0; i<position.count; i++) {
    const x=position.getX(i), z=position.getZ(i);
    const local = x>close.min.x && x<close.max.x && z>close.min.z && z<close.max.z;
    const border=Math.max(close.min.x-x,x-close.max.x,close.min.z-z,z-close.max.z);
    const y = height(x,z)+smoothstep(border,0,370)*ridges(x,z);
    if (local) held.add(i);
    position.setY(i,y-(local ? 15 : 2));
    tint.copy(moss).lerp(slate,smoothstep(y,340,800)).multiplyScalar(.89+.11*smoothstep(ridges(x,z),-60,150));
    colors.push(tint.r,tint.g,tint.b);
  }
  const original = horizon.index!.array;
  const index: number[] = [];
  for (let i=0; i<original.length; i+=3) {
    const a=original[i],b=original[i+1],c=original[i+2];
    if (!(held.has(a)&&held.has(b)&&held.has(c))) index.push(a,b,c);
  }
  horizon.setIndex(index);
  horizon.setAttribute('color',new T.Float32BufferAttribute(colors,3));
  horizon.computeVertexNormals();
  const mountains = new T.Mesh(horizon,new T.MeshStandardMaterial({vertexColors:true,roughness:1,envMapIntensity:.15}));
  mountains.name='Outlying mountain ridges';
  root.add(mountains);

  const sky = new T.Mesh(new T.SphereGeometry(1390,36,20),new T.ShaderMaterial({
    side:T.BackSide, depthWrite:false, toneMapped:false,
    uniforms:{
      zenith:{value:new T.Color(0x5c84a5)}, horizonColor:{value:new T.Color(0xc2d1d3)},
      cloudColor:{value:new T.Color(0xe2e5dc)},
    },
    vertexShader:`
      varying vec3 ray;
      void main() { ray=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
    `,
    fragmentShader:`
      varying vec3 ray;
      uniform vec3 zenith,horizonColor,cloudColor;
      float hash(vec2 x){return fract(sin(dot(x,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
      }
      void main(){
        vec3 d=normalize(ray);
        float sun=max(0.,dot(d,normalize(vec3(.339,.672,.659))));
        vec3 c=mix(horizonColor,zenith,smoothstep(.025,.83,d.y));
        vec3 warm=vec3(.26,.17,.095);
        c+=warm*(.35*pow(sun,5.)+1.1*pow(sun,46.));
        c=mix(c,horizonColor+warm*.17,exp(-max(0.,d.y)*12.)*.32);
        vec2 uv=d.xz/(.22+max(.0,d.y))*1.65;
        float vapor=.57*noise(uv)+.28*noise(uv*2.37)+.15*noise(uv*5.41);
        float cloud=smoothstep(.56,.78,vapor)*smoothstep(.15,.36,d.y)*(1.-smoothstep(.72,.98,d.y));
        float high=smoothstep(.58,.78,noise(uv*1.9+vec2(7.,2.))*.68+noise(uv*4.1)*.32);
        gl_FragColor=vec4(mix(c,cloudColor+warm*.13,clamp(cloud*.69+high*.17*smoothstep(.20,.64,d.y),0.,1.)),1.);
        #include <colorspace_fragment>
      }
    `,
  }));
  sky.name='Pineglass mountain sky';
  sky.renderOrder=-10;
  sky.frustumCulled=false;
  root.add(sky);
  return (eye: T.Vector3) => sky.position.copy(eye);
}

function creek(root: T.Object3D, groundY: Height) {
  const positions:number[]=[],colors:number[]=[],indices:number[]=[],bankFade:number[]=[];
  const teal=new T.Color(0x355e62),shoal=new T.Color(0xa2b8ac),tint=new T.Color();
  const rows=300, widthAt=(row:number)=>8+1.6*Math.sin(row*.13)+.83*Math.sin(row*.24);
  for(let row=0;row<=rows;row++){
    const along=-375+row*2.5, ends=smoothstep(Math.min(row,rows-row),0,34);
    const middle=gorgeRiverPoint(along);
    const waterY=groundY(middle.x,middle.z)+1.25;
    for(let col=0;col<9;col++){
      const cross=(col-4)/4,shore=Math.abs(cross);
      const vertex=gorgeRiverPoint(along,cross*widthAt(row)*(1+.09*shore));
      positions.push(vertex.x,waterY,vertex.z);
      tint.copy(teal).lerp(shoal,.31*shore**3);
      colors.push(tint.r,tint.g,tint.b);
      bankFade.push((1-smoothstep(shore,.64,1))*ends);
    }
    if(!row)continue;
    for(let col=0;col<8;col++){
      const i=(row-1)*9+col;
      indices.push(i,i+1,i+9,i+1,i+10,i+9);
    }
  }
  const geometry=new T.BufferGeometry();
  geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
  geometry.setAttribute('bankFade',new T.Float32BufferAttribute(bankFade,1));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  const flowClock={value:0};
  const water=new T.MeshStandardMaterial({vertexColors:true,side:T.DoubleSide,roughness:.35,
    metalness:.10,transparent:true,depthWrite:false,opacity:.92});
  water.onBeforeCompile=shader=>{
    shader.uniforms.creekClock=flowClock;
    shader.vertexShader='attribute float bankFade; varying float pgBank; varying vec2 pgWater;\n'+shader.vertexShader
      .replace('#include <begin_vertex>','#include <begin_vertex>\n pgWater=position.xz; pgBank=bankFade;');
    shader.fragmentShader=surfaceNoise+'uniform float creekClock; varying float pgBank; varying vec2 pgWater;\n'
      +shader.fragmentShader.replace('#include <color_fragment>',`
        #include <color_fragment>
        vec2 flow=vec2(pgWater.x*.48+pgWater.y*.16,pgWater.y*.72-pgWater.x*.12);
        float ripples=pgNoise(flow+vec2(-creekClock*.75,creekClock*.17));
        float streaks=pgNoise(flow*vec2(.29,4.)-vec2(creekClock*.53,.0));
        float glints=smoothstep(.68,.91,ripples*.65+streaks*.35);
        diffuseColor.rgb=diffuseColor.rgb*(.81+.37*ripples)+glints*vec3(.13,.21,.21);
        diffuseColor.a*=pgBank;
      `);
  };
  const mesh=new T.Mesh(geometry,water);
  mesh.name='Glass Creek';
  root.add(mesh);

  const random=rng(4531),dummy=new T.Object3D();
  for(const plants of [false,true]){
    const shape=new T.IcosahedronGeometry(1,plants?0:1);
    const bank=new T.InstancedMesh(shape,new T.MeshStandardMaterial({
      color:plants?0x586b45:0x777c79,roughness:1,flatShading:true,
    }),88);
    for(let i=0;i<bank.count;i++){
      const row=12+random()*(rows-24),side=i%2?1:-1;
      const p=gorgeRiverPoint(-375+row*2.5,side*(widthAt(row)+.75+random()*(plants?7:3.8)));
      const size=.34+random()*(plants?1.58:1.02);
      dummy.position.set(p.x,groundY(p.x,p.z)+size*.16,p.z);
      dummy.rotation.set(random()*.38,random()*Math.PI*2,0);
      dummy.scale.set(size*1.2,plants?size*.88:size*.48,size*.78);
      dummy.updateMatrix();bank.setMatrixAt(i,dummy.matrix);
      bank.setColorAt(i,new T.Color().setScalar(.61+random()*.39));
    }
    bank.name=plants?'Glass Creek bank shrubs':'Glass Creek bank stones';
    bank.computeBoundingSphere();bank.receiveShadow=true;root.add(bank);
  }
  return ()=>{flowClock.value=performance.now()/1000;};
}

const densityBands = [
  [0,.94],[890,.81],[1310,.43],[1600,.15],[2050,.53],[2450,.71],
  [2720,.21],[3300,.14],[3710,.04],[4050,.04],[4210,.47],[4580,.20],[4910,.12],
  [5110,.31],[5480,.47],[5840,.63],[6290,.94],[6700,.84],
] as const;

function densityAt(d: number) {
  const i = densityBands.findIndex(([station]) => station>d);
  if (i<=0) return d<=0 ? densityBands[0][1] : densityBands.at(-1)![1];
  const [start,a]=densityBands[i-1], [end,b]=densityBands[i];
  return lerp(a,b,smoothstep(d,start,end));
}

function placePineglassTrees(root: T.Object3D, height: Height) {
  const plantations: Array<readonly [number,number]> = [];
  const random = rng(83124);
  for (let d=18; d<route.finish+145; d+=14) {
    for (const side of [-1,1]) for (let i=0; i<12; i++) {
      const station = route.sampleAt(d+(random()-.5)*15);
      const across = side*(13+210*(random()**1.90));
      const p = station.p.clone().addScaledVector(station.right,across);
      const woods = .67+.24*Math.sin(p.x*.024+p.z*.012)+.14*Math.cos(p.z*.038-p.x*.011);
      if (random()>densityAt(d)*woods || route.project(p.x,p.z).distance<12) continue;
      const y = height(p.x,p.z);
      const grade = Math.hypot(height(p.x+4,p.z)-height(p.x-4,p.z),height(p.x,p.z+4)-height(p.x,p.z-4))/8;
      if (grade>.73 || y<station.p.y-27 && Math.abs(d-mountainGorge.station)<230) continue;
      plantations.push([p.x,p.z]);
    }
  }
  return plantForest(root,rng(4226),asset,height,{
    bounds,candidates:0,setback:12,plantations,distance:(x,z)=>route.project(x,z).distance,cuts:[31,66,141,675],tileSize:384,
  });
}

function vergeDetails(root: T.Object3D, height: Height, rockMap: T.Texture) {
  const random = rng(99720);
  const dummy = new T.Object3D();
  const boulder = new T.IcosahedronGeometry(1,1);
  const coordinates = boulder.getAttribute('position');
  for (let i=0; i<coordinates.count; i++) {
    const x=coordinates.getX(i), y=coordinates.getY(i), z=coordinates.getZ(i);
    const shape = .88+.14*Math.sin(4*x+5*z)*Math.cos(5*y-2*z)+.07*Math.cos(8*y+2*x);
    coordinates.setXYZ(i,x*shape,y*shape,z*shape);
  }
  boulder.computeVertexNormals();
  const stone = new T.MeshStandardMaterial({color:0x988e7d,map:rockMap,flatShading:true,roughness:.97});
  const bladePoints: number[] = [];
  for (let i=0; i<8; i++) {
    const x=(random()-.5)*.42,z=(random()-.5)*.37, y=.15+random()*.26;
    const a=i*2.399, dx=Math.cos(a)*.016,dz=Math.sin(a)*.016;
    bladePoints.push(x-dx,0,z-dz,x+dx,0,z+dz,x+4.1*dz,y,z-4.1*dx);
  }
  const grass = new T.BufferGeometry();
  grass.setAttribute('position',new T.Float32BufferAttribute(bladePoints,3));
  grass.computeVertexNormals();
  const shoots = new T.MeshStandardMaterial({color:0x939554,side:T.DoubleSide,roughness:1});
  const bush = new T.IcosahedronGeometry(1,0);
  const brush = new T.MeshStandardMaterial({color:0x697a42,flatShading:true,roughness:1});
  const cells: Array<{center:T.Vector3; meshes:T.InstancedMesh[]}> = [];
  for (let start=-18; start<route.finish+32; start+=146) {
    const byType = [[],[],[]] as T.Matrix4[][];
    const finishes = [boulder,grass,bush] as const;
    const mats = [stone,shoots,brush] as const;
    for (let i=0; i<170; i++) {
      const d = start+random()*146;
      if (d>=mountainGorge.deckStart-2 && d<=mountainGorge.deckEnd+2) continue;
      const s=route.sampleAt(d);
      const type=i<33 ? 0 : i<143 ? 1 : 2;
      const side=random()<.5 ? -1 : 1;
      const margin=s.halfWidth+mountainShoulderWidth(s.distance);
      const cross=(margin+.12+(type===0?random()*random()*35:type===1?random()*random()*6:2+random()*19))*side;
      const p=s.p.clone().addScaledVector(s.right,cross);
      if (route.project(p.x,p.z).distance<margin+.04) continue;
      const edge = s.p.y+cross*s.right.y+mountainUndulation(s.distance,cross)-.066;
      const y = Math.max(height(p.x,p.z),lerp(edge,height(p.x,p.z)-.07,smoothstep(Math.abs(cross),margin,13.9)));
      const large=type===0 && Math.abs(cross)>18 && random()<.22;
      const scale=type===0 ? (large ? 1.35+random()**1.8*3.6 : .16+random()**1.8*.65) :
        type===1 ? .49+random()*1.14 : .28+random()*.59;
      dummy.position.set(p.x,y+(type===1 ? -.025 : scale*.10),p.z);
      dummy.rotation.set(type===0?random()*.38:0,random()*Math.PI*2,0);
      dummy.scale.set(scale*(1.06+random()*.68),scale*(type===1?1:.73),scale);
      dummy.updateMatrix();
      byType[type].push(dummy.matrix.clone());
    }
    const meshes = byType.flatMap((transforms,type) => {
      if (!transforms.length) return [];
      const mesh = new T.InstancedMesh(finishes[type],mats[type],transforms.length);
      const color = new T.Color();
      transforms.forEach((matrix,index) => {
        mesh.setMatrixAt(index,matrix);
        color.setScalar(.69+random()*.30);
        if (type!==0) color.b *= .80+random()*.20;
        mesh.setColorAt(index,color);
      });
      mesh.computeBoundingSphere();
      mesh.receiveShadow=true;
      if(type===1)mesh.layers.set(mirrorExcludedLayer);
      root.add(mesh);
      return [mesh];
    });
    cells.push({center:route.sampleAt(start+73).p,meshes});
  }
  return (eye: T.Vector3) => {
    for (const cell of cells) {
      const d=eye.distanceToSquared(cell.center);
      for (const [i,mesh] of cell.meshes.entries()) mesh.visible=d<(i===1?205:465)**2;
    }
  };
}

function trackFixtures(root: T.Object3D, height: Height) {
  const timber = new T.MeshStandardMaterial({color:0x634c38,roughness:.92});
  const gray = new T.MeshStandardMaterial({color:0x777975,metalness:.33,roughness:.78});
  const concrete = weatheredConcrete(new T.MeshStandardMaterial({color:0x89857b,roughness:.93}));
  const ochre = new T.MeshStandardMaterial({color:0xb76532,roughness:.81});
  const white = new T.MeshStandardMaterial({color:0xcccbc0,roughness:.92});
  const geo = new T.BoxGeometry(1,1,1);
  const fixtureBoxes:T.Mesh<T.BufferGeometry,T.Material>[]=[];
  const box = (parent:T.Object3D, material:T.Material, w:number,h:number,d:number,x:number,y:number,z:number) => {
    const mesh=new T.Mesh(geo,material);
    mesh.position.set(x,y,z);
    mesh.scale.set(w,h,d);
    mesh.receiveShadow=true;
    parent.add(mesh);
    fixtureBoxes.push(mesh);
    return mesh;
  };
  const at = (station: number, side = 0, onGround = false, parent = root) => {
    const s = route.sampleAt(station);
    const group = new T.Group();
    group.position.copy(s.p).addScaledVector(s.right,side);
    if (onGround) group.position.y=height(group.position.x,group.position.z);
    group.rotation.y=Math.atan2(-s.forward.x,-s.forward.z);
    parent.add(group);
    return group;
  };
  const warningTexture=(title:string,label:string)=>{
    const canvas=document.createElement('canvas');
    canvas.width=512;canvas.height=192;
    const ctx=canvas.getContext('2d')!;
    ctx.fillStyle='#201d16';ctx.fillRect(0,0,512,192);
    ctx.fillStyle='#ffd33a';ctx.fillRect(9,9,494,174);
    ctx.fillStyle='#17160e';ctx.textAlign='center';
    ctx.font='bold 100px Arial';ctx.fillText(title,256,111,454);
    ctx.font='bold 26px Arial';ctx.fillText(label,256,154,456);
    const map=new T.CanvasTexture(canvas);map.colorSpace=T.SRGBColorSpace;
    return map;
  };
  const board = (group: T.Object3D, title: string, label: string, w: number, h: number, y: number, z=0, dark=true, warning=false) => {
    const map=warning?warningTexture(title,label):signTexture(title,label,dark);
    const material=new T.MeshStandardMaterial({map,roughness:.87,
      ...(warning?{emissive:0xffffff,emissiveMap:map,emissiveIntensity:.16}:{})});
    const mesh=new T.Mesh(new T.PlaneGeometry(w,h),material);
    mesh.position.set(0,y,z);
    group.add(mesh);
  };
  const start = at(0);
  const finish = at(route.finish);
  for (const [group,title,caption] of [[start,'PINEGLASS RUN','CEDAR GATE  /  MOUNTAIN STAGE'],[finish,'FINISH','LOWER VALLEY  /  PINEGLASS RUN']] as const) {
    for (const side of [-1,1]) {
      box(group,timber,.28,5.0,.29,side*6.28,2.4,0);
      box(group,concrete,.46,.78,.51,side*6.28,.22,0);
      box(group,ochre,.30,.36,.31,side*6.28,1.32,0);
    }
    box(group,timber,12.95,.32,.32,0,4.88,0);
    box(group,gray,5.72,1.78,.20,0,4.67,.10);
    board(group,title,caption,5.54,1.66,4.67,.22);
    box(group,white,8.65,.014,.31,0,.024,0);
  }

  const lenses = Array.from({length:5},(_,i) => {
    const material = new T.MeshStandardMaterial({color:0x501b10,emissive:0xff3823,emissiveIntensity:0,roughness:.46});
    box(start,material,.18,.15,.10,(i-2)*.32,3.60,.20);
    return material;
  });
  for (const [station,side,title,caption] of [
    [23,1,'FOREST SPRINT','608 M STRAIGHT'],
    [mountainQuarry.entry-250,-1,'250','QUARRY HOOK'],
    [712,1,'QUARRY CUT','LINKED TURNS'],
    [1364,-1,'SKYLINE','BLIND CREST AHEAD'],
    [2003,1,'SPRUCE BOWL','OPENS LEFT  /  CUTBACK BELOW'],
    [2658,1,'CLIFFSIDE','NARROW SHELF  /  EXPOSED EDGE'],
    [mountainGorge.deckStart-22,-1,'GLASS GORGE','VIADUCT'],
    [mountainGorge.deckEnd-65,1,'250','CAIRN HAIRPIN'],
    [mountainGorge.deckEnd+64,1,'120','UPHILL RIGHT HAIRPIN'],
    [5005,1,'WATCHTOWER','DOUBLE LEFT  /  TIGHTENS'],
    [5472,1,'VALLEY DESCENT','STEEP GRADE AHEAD'],
  ] as const) {
    const s = route.sampleAt(station);
    const group = at(station,side*(s.halfWidth+mountainShoulderWidth(station)+.64));
    box(group,gray,.10,2.42,.10,0,.52,0);
    box(group,gray,1.78,.69,.06,0,1.75,.02);
    board(group,title,caption,1.75,.655,1.75,.06,false);
  }
  const roadsideStand=(station:number,side:number)=>{
    const s=route.sampleAt(station);
    return at(station,side*(s.halfWidth+mountainShoulderWidth(station)+1.33));
  };
  const warning=(distance:number,side:number,title:string,caption:string)=>{
    const group=roadsideStand(distance,side);
    group.name='Pineglass warning '+title+' '+caption;
    box(group,gray,.12,2.4,.12,0,.75,0);
    board(group,title,caption,2.25,.88,1.93,.08,false,true);
  };
  const turns=[
    [1,'QUARRY HOOK',[150,75]],
    [11,'SPRUCE CUTBACK',[150,90]],
    [18,'CAIRN HAIRPIN',[135,68]],
    [22,'WATCHTOWER',[180,100]],
    [23,'WATCHTOWER EXIT',[90,45]],
    [25,'VALLEY HAIRPIN',[200,120,60]],
  ] as const;
  for(const [id,title,approach] of turns){
    const bend=route.bends[id-1];
    const side=bend.turn,arrow=side<0?'› ›':'‹ ‹';
    for(const distance of approach) warning(bend.entry-distance,side,distance+' m '+arrow[0],title);
    for(const advance of [-29,10,36]) warning(bend.entry+advance,side,arrow,title);
  }
  for(const [index,gate] of mountainSectors.entries()){
    const distance=route.gates[gate].distance;
    for(const side of [-1,1]){
      const group=roadsideStand(distance,side);
      group.name='Pineglass sector '+(index+1);
      box(group,gray,.12,2.34,.12,0,.68,0);
      board(group,'S'+(index+1),'SECTOR SPLIT',1.48,.67,1.82,.08,false,true);
    }
  }
  const finishPost=at(route.finish+18,route.sampleAt(route.finish+18).halfWidth+4.1);
  box(finishPost,concrete,3.1,.24,2.6,0,-.12,0);
  box(finishPost,timber,2.58,2.18,1.92,0,1.0,0);
  box(finishPost,gray,2.95,.18,2.22,0,2.17,0);
  board(finishPost,'TIMING','FINISH CONTROL',1.86,.58,1.54,1.01);
  for(const side of [-1,1]){
    const fence=at(route.finish+31,side*(route.sampleAt(route.finish+31).halfWidth+3.6));
    for(const z of [-2.8,0,2.8])box(fence,timber,.13,1.1,.13,0,.51,z);
    for(const y of [.40,.81])box(fence,timber,.075,.105,5.64,0,y,0);
  }
  // The watch platform has timber braces, a pitched roof and a small anemometer.
  const lookout = at(4475,-25,true);
  for (const x of [-1.9,1.9]) for (const z of [-1.55,1.55]) {
    box(lookout,concrete,.65,.57,.65,x,-.03,z);
    box(lookout,timber,.24,8.5,.24,x,4.14,z);
  }
  for (const z of [-1.55,1.55]) for (const sign of [-1,1]) {
    const beam=box(lookout,timber,.16,8.0,.14,0,3.68,z);
    beam.rotation.z=sign*.51;
  }
  box(lookout,timber,4.7,.29,3.9,0,7.53,0);
  box(lookout,timber,3.83,2.36,3.18,0,8.75,0);
  box(lookout,gray,2.35,.7,.045,0,9.12,1.602);
  for (const side of [-1,1]) box(lookout,gray,2.48,.17,3.9,side*1.15,10.10,0).rotation.z=-side*.24;
  box(lookout,gray,.07,2.25,.07,1.48,10.91,0);
  box(lookout,ochre,.87,.14,.14,1.77,11.92,0);

  // A continuous haunched box girder follows the banking and grade of the road ribbon.
  const bridge = new T.Group();
  const {deckStart,deckEnd} = mountainGorge;
  const piers=[.16,.33,.455,.63,.82].map(fraction=>lerp(deckStart,deckEnd,fraction));
  const supports=[deckStart,...piers,deckEnd];
  const steps=Math.ceil((deckEnd-deckStart)/3);
  function addGirder(material:T.Material, profile:(width:number,depth:number)=>readonly (readonly [number,number])[]) {
    const vertices:number[]=[],indices:number[]=[];
    const stride=4;
    for (let i=0;i<=steps;i++) {
      const d=lerp(deckStart,deckEnd,i/steps);
      const s=route.sampleAt(d);
      const nearSupport=Math.min(...supports.map(station=>Math.abs(station-d)));
      const depth=2.15+1.48*(1-smoothstep(nearSupport,0,21));
      const width=s.halfWidth+mountainShoulderWidth(d)+.24;
      for (const [x,y] of profile(width,depth)) vertices.push(...viaductPoint(d,x,y).toArray());
      if (i===0) continue;
      // The driving surface closes the top. An extra face below it causes depth flicker at distance.
      for(let face=1;face<stride;face++){
        const a=(i-1)*stride+face,b=(i-1)*stride+(face+1)%stride;
        indices.push(a,a+stride,b,b,a+stride,b+stride);
      }
    }
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const girder=new T.Mesh(geometry,material);
    girder.receiveShadow=true;
    girder.name='Glass Gorge continuous deck';
    root.add(girder);
  }
  const soffit=new T.MeshStandardMaterial({color:0x485d60,roughness:.78,metalness:.23,side:T.DoubleSide});
  const slab=weatheredConcrete(new T.MeshStandardMaterial({color:0xb7b2a4,roughness:.88,side:T.DoubleSide}));
  addGirder(slab,w=>[[-w,-.12],[w,-.12],[w-.24,-.76],[-w+.24,-.76]]);
  addGirder(soffit,(_,h)=>[[-4.22,-.72],[4.22,-.72],[2.62,-h],[-2.62,-h]]);
  for (const d of piers) {
    const section=at(d,0,false,bridge);
    const top=-4.6;
    for (const side of [-1,1]) {
      const x=side*2.3, foot=viaductPoint(d,x,0);
      const bottom=height(foot.x,foot.z)-section.position.y-.9;
      const tall=top-bottom;
      box(section,concrete,2.75,tall,3.5,x,(top+bottom)/2,0);
      box(section,gray,.23,tall-1.5,.13,x,(top+bottom)/2,1.76);
      box(section,concrete,4.15,2.75,4.75,x,bottom+1.26,0);
    }
    box(section,concrete,9.7,1.48,4.4,0,-4.01,0);
    box(section,gray,6.5,.32,3.44,0,-3.28,0);
  }
  for (const d of [deckStart+.8,deckEnd-.8]) {
    const section=at(d,0,false,bridge);
    const depth=Math.max(4,section.position.y-height(section.position.x,section.position.z)+.9);
    box(section,concrete,13.95,depth,3.55,0,-depth/2-.61,0);
    box(section,gray,13.5,.51,3.64,0,-.57,0);
  }
  root.updateMatrixWorld(true);
  bridge.updateMatrixWorld(true);
  const instances = new Map<string,{material:T.Material; matrices:T.Matrix4[]; bridge:boolean}>();
  for(const box of fixtureBoxes){
    const isBridge=box.parent?.parent===bridge;
    const x=Math.floor(box.matrixWorld.elements[12]/320),z=Math.floor(box.matrixWorld.elements[14]/320);
    const key=[box.material.id,x,z,isBridge].join(',');
    let batch=instances.get(key);
    if(!batch){batch={material:box.material,matrices:[],bridge:isBridge};instances.set(key,batch);}
    batch.matrices.push(box.matrixWorld.clone());
    box.removeFromParent();
  }
  for(const {material,matrices,bridge:isBridge} of instances.values()){
    const mesh=new T.InstancedMesh(geo,material,matrices.length);
    mesh.name=isBridge?'Glass Gorge structure':'Pineglass roadside structures';
    matrices.forEach((matrix,i)=>mesh.setMatrixAt(i,matrix));
    mesh.computeBoundingSphere();
    mesh.receiveShadow=true;
    root.add(mesh);
  }

  const signal = new StartSignal();
  let count = -1;
  return {signal,sync() {
    if (signal.count===count) return;
    count=signal.count;
    lenses.forEach((material,i) => {material.emissiveIntensity=i<count?3.4:0;});
  }};
}

export async function dressMountainLandscape(root: T.Object3D, groundY: Height, farHeight: Height, rock: T.Texture) {
  const updateSky = skyline(root,farHeight);
  const updateDetails = vergeDetails(root,groundY,rock);
  const updateCreek=creek(root,groundY);
  const gantry = trackFixtures(root,groundY);
  const updateForest = await placePineglassTrees(root,groundY);
  return {gantry,updateVegetation(eye: T.Vector3) {
    updateSky(eye);
    updateCreek();
    updateDetails(eye);
    updateForest(eye);
  }};
}
