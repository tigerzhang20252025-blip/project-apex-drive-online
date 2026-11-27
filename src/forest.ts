import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {firBoughs} from './fir-boughs.ts';
import {birchGeometry} from './birch.ts';
import {nearestStation,stations} from './track.ts';

type Tree={position:T.Vector3;matrix:T.Matrix4;color:T.Color;species:number};
type Batch={geometry:T.BufferGeometry;material:T.Material;level:number;species:number;name:string};
function distantCrown(){
  const pos:number[]=[],col:number[]=[];
  // Interleaved asymmetric whorls retain an opaque crown silhouette from any direction.
  for(let tier=0;tier<4;tier++)for(let j=0;j<7;j++){
    const y=.13+tier*.16,rad=.20-tier*.029,angle=j*Math.PI*2/7+tier*.81;
    const point=(a:number,k:number,h:number)=>[Math.cos(a)*rad*k,h,Math.sin(a)*rad*k];
    const a=point(angle,1+.12*Math.sin(j*7+tier),y),b=point(angle+.90,1,y+.018*Math.cos(j*3));
    pos.push(...a,.005,y+.39,0,...b);const v=.74+.22*Math.cos(angle+.4);
    for(const lum of [.74,1.16,.79])col.push(.063*v*lum,.116*v*lum,.069*v*lum);
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('color',new T.Float32BufferAttribute(col,3));g.computeVertexNormals();return g;
}
type ForestLayout={
  bounds:T.Box3;
  candidates:number;
  setback:number;
  plantations?:ReadonlyArray<readonly [number,number]>;
  distance:(x:number,z:number)=>number;
  cuts?:readonly [number,number,number,number];
  tileSize?: number;
};

export async function plantForest(scene:T.Object3D,random:()=>number,asset:(s:string)=>string,groundY:(x:number,z:number)=>number,layout?:ForestLayout){
  const loader=new GLTFLoader();
  const [close,regular,mid]=await Promise.all(['pine-close.glb','trackside-pine.glb','pine-mid.glb'].map(f=>loader.loadAsync(asset(f))));
  const extent=layout?.bounds??new T.Box3().setFromPoints(stations.map(s=>s.p)).expandByScalar(220);
  const trees:Tree[]=[],dummy=new T.Object3D();
  const scattered=layout?.candidates??18200, planted=layout?.plantations??[];
  for(let i=0;i<scattered+planted.length;i++){
    const intentional=i>=scattered;
    const [x,z]=intentional?planted[i-scattered]:[
      T.MathUtils.lerp(extent.min.x,extent.max.x,random()),T.MathUtils.lerp(extent.min.z,extent.max.z,random()),
    ];
    const d=layout?layout.distance(x,z):nearestStation(x,z).distance;
    const paddock=!layout&&((x>-158&&x<-114&&z>140&&z<266)||(x>-103&&x<-69&&z>75&&z<165));
    if(d<(layout?.setback??17.5)||paddock)continue;
    const woodland=.49+.25*Math.sin(x*.018+Math.cos(z*.013)*2)+.17*Math.sin(z*.033+x*.006)+.09*Math.sin(x*.079-z*.047);
    const density=T.MathUtils.smoothstep(woodland,.13,.84)*(.18+.72*T.MathUtils.smoothstep(d,17,48));
    if(!intentional&&random()>density*.82)continue;
    const y=groundY(x,z),seed=random(),birch=woodland<.63&&seed>.75;
    const h=(birch?5.3:4.0)+(birch?7.5:13)*(.42*woodland+.58*random());
    dummy.position.set(x,y-.10,z);dummy.rotation.set(0,random()*Math.PI*2,0);
    const width=h*(.82+random()*.42);dummy.scale.set(width,h,width);dummy.updateMatrix();
    const shade=.75+.23*random();trees.push({position:dummy.position.clone(),matrix:dummy.matrix.clone(),color:new T.Color(shade,shade*(.98+random()*.06),shade*(.88+random()*.08)),species:birch?1:seed<.66?2:0});
  }
  const batches:Batch[]=[],materials=new Map<string,T.MeshStandardMaterial>();
  regular.scene.traverse(o=>{if(o instanceof T.Mesh){const m=o.material as T.MeshStandardMaterial;
    m.roughness=.94;m.envMapIntensity=.64;if(m.map)m.map.anisotropy=8;
    if(m.name.includes('twig')){m.transparent=false;m.depthWrite=true;m.alphaTest=.35;m.alphaToCoverage=true;}
    materials.set(m.name,m);
  }});
  const add=(g:T.BufferGeometry,m:T.Material,level:number,species:number,name:string)=>{
    batches.push({geometry:g,material:m,level,species,name});
  };
  for(const [level,model] of [close,regular,mid].entries()){
    model.scene.updateMatrixWorld(true);model.scene.traverse(o=>{if(!(o instanceof T.Mesh))return;
      const material=materials.get((o.material as T.Material).name)!;
      // The older intermediate bark has only two faces. Reuse the 486-face trunk from the close asset.
      let g=o.geometry.clone().applyMatrix4(o.matrixWorld);
      if(level===1&&material.name.includes('bark')){close.scene.traverse(n=>{if(n instanceof T.Mesh&&(n.material as T.Material).name===material.name){g.dispose();g=n.geometry.clone().applyMatrix4(n.matrixWorld);}});}
      add(g,material,level,0,['Near pines','Woodland pines','Valley pines'][level]);
    });
  }
  const leaves=new T.MeshStandardMaterial({vertexColors:true,roughness:.93,side:T.DoubleSide}),bark=new T.MeshStandardMaterial({color:0xb7ae9d,roughness:.93});
  for(const level of [0,1,2]){
    const [wood,leaf]=birchGeometry(level!==0);
    add(wood,bark,level,1,'Birch trunks');add(leaf,leaves,level,1,'Birch canopy');
  }
  const distant=new T.MeshStandardMaterial({vertexColors:true,side:T.DoubleSide,roughness:1});
  const crown=distantCrown();add(crown,distant,3,0,'Distant conifer stands');
  const broad=new T.IcosahedronGeometry(.27,0).scale(1,1.5,1).translate(0,.57,0);add(broad,new T.MeshStandardMaterial({color:0x737d50,roughness:1}),3,1,'Distant broadleaf stands');
  const needles=await new T.TextureLoader().loadAsync(asset('fir-sprays.webp'));
  needles.colorSpace=T.SRGBColorSpace;needles.anisotropy=4;
  const needlesMat=new T.MeshStandardMaterial({map:needles,alphaTest:.14,alphaToCoverage:true,
    vertexColors:true,side:T.DoubleSide,roughness:.96,envMapIntensity:.58});
  const trunkMat=materials.get('pine_sapling_small_bark')!;
  for(const level of [0,1,2]){
    const stem=new T.CylinderGeometry(.0025,.014,1,level===0?9:5).translate(0,.5,0);
    add(stem,trunkMat,level,2,'Mature fir trunks');
    add(firBoughs(level),needlesMat,level,2,'Layered fir boughs');
  }
  add(crown,distant,3,2,'Distant fir stands');
  const tiles=new Map<string,{center:T.Vector3;trees:Tree[];batches:Map<Batch,T.InstancedMesh>;levels:Int8Array}>();
  const tileSize=layout?.tileSize??112;
  for(const tree of trees){
    const x=Math.floor(tree.position.x/tileSize),z=Math.floor(tree.position.z/tileSize),key=x+','+z;
    let cell=tiles.get(key);
    if(!cell){cell={center:new T.Vector3((x+.5)*tileSize,0,(z+.5)*tileSize),trees:[],batches:new Map(),levels:new Int8Array()};tiles.set(key,cell);}
    cell.trees.push(tree);
  }
  for(const cell of tiles.values()){
    cell.levels=new Int8Array(cell.trees.length).fill(-1);
    cell.center.y=cell.trees.reduce((sum,t)=>sum+t.position.y,0)/cell.trees.length;
  }
  const last=new T.Vector3(Infinity,0,Infinity),cuts=layout?.cuts??[47,100,185,860];
  scene.userData.forest={trees:trees.length,nearTriangles:7578,matureFirs:trees.filter(t=>t.species===2).length};
  return (eye:T.Vector3)=>{
    if(last.distanceToSquared(eye)<25)return;last.copy(eye);
    for(const cell of tiles.values()){
      if(cell.center.distanceToSquared(eye)>(cuts[3]+(layout?.tileSize ? tileSize : 95))**2){
        for(const mesh of cell.batches.values())mesh.visible=false;
        cell.levels.fill(-1);continue;
      }
      let dirty=false;
      for(let i=0;i<cell.trees.length;i++){
        const t=cell.trees[i],r=t.position.distanceTo(eye),old=cell.levels[i];
        let level=r<cuts[0]?0:r<cuts[1]?1:r<cuts[2]?2:r<cuts[3]?3:-1;
        if(old>=0&&level>=0&&Math.abs(old-level)===1&&Math.abs(r-cuts[Math.min(old,level)])<5)level=old;
        if(old!==level){dirty=true;cell.levels[i]=level;}
      }
      if(!dirty)continue;
      for(const batch of batches){
        let mesh=cell.batches.get(batch),n=0;
        for(let i=0;i<cell.trees.length;i++){
          const tree=cell.trees[i];if(cell.levels[i]!==batch.level||tree.species!==batch.species)continue;
          if(!mesh){
            mesh=new T.InstancedMesh(batch.geometry,batch.material,cell.trees.length);
            mesh.name=batch.name;mesh.castShadow=batch.level===0;mesh.receiveShadow=batch.level<=1;
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.boundingSphere=new T.Sphere(cell.center.clone(),Math.max(...cell.trees.map(t=>t.position.distanceTo(cell.center)))+22);
            cell.batches.set(batch,mesh);scene.add(mesh);
          }
          mesh.setMatrixAt(n,tree.matrix);mesh.setColorAt(n++,tree.color);
        }
        if(mesh){mesh.visible=n>0;mesh.count=n;if(n){mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor!.needsUpdate=true;}}
      }
    }
  };
}
