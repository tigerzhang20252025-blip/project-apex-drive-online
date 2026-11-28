import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {part,rallyMetal} from './rally-details.ts';

const tau=Math.PI*2;
const bead=.230;
const halfTread=.117;
const grooveDepth=.0064;
const pitches=32;
type Layer=[T.BufferGeometry,T.Material];

function paintCanvas(size:number){
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
  return canvas.getContext('2d')!;
}

function texture(ctx:CanvasRenderingContext2D,color=false,repeat=false){
  const map=new T.CanvasTexture(ctx.canvas);
  if(color)map.colorSpace=T.SRGBColorSpace;
  if(repeat)map.wrapS=map.wrapT=T.RepeatWrapping;
  map.anisotropy=8;
  return map;
}

function sidewallMaps(){
  const size=768,face=paintCanvas(size),height=paintCanvas(size);
  const cx=size/2;
  const colors=face.createRadialGradient(cx,cx,size*.31,cx,cx,size*.505);
  for(const [t,c] of [[0,'#181819'],[.20,'#29292a'],[.65,'#363434'],[.90,'#3e3a37'],[1,'#282828']] as const)colors.addColorStop(t,c);
  face.fillStyle=colors;face.fillRect(0,0,size,size);
  height.fillStyle='#777';height.fillRect(0,0,size,size);
  let seed=0x403257ab;
  const random=()=>{
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    return (seed>>>0)/0x100000000;
  };
  for(let i=0;i<56000;i++){
    const x=random()*size,y=random()*size;
    face.fillStyle=i%3===0?'rgba(171,153,133,.094)':'rgba(0,0,0,.082)';face.fillRect(x,y,1.4,1.1);
    height.fillStyle=i%3===0?'#929292':'#606060';height.fillRect(x,y,1,1);
  }
  const lettering=(ctx:CanvasRenderingContext2D,line:string,angle:number,r:number,sz:number,color:string,bottom=false)=>{
    ctx.font='700 '+sz+'px system-ui';
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;
    const adv=[...line].map(c=>ctx.measureText(c).width+sz*.062);
    let cursor=-adv.reduce((a,b)=>a+b,0)/2;
    [...line].forEach((char,i)=>{
      const a=angle+(bottom?-1:1)*(cursor+adv[i]/2)/r;
      ctx.save();ctx.translate(cx+Math.sin(a)*r,cx-Math.cos(a)*r);
      ctx.rotate(bottom?a-Math.PI:a);ctx.fillText(char,0,0);ctx.restore();
      cursor+=adv[i];
    });
  };
  for(const ctx of [face,height]){
    const color=ctx===face;
    lettering(ctx,'APEX  TARMAC  R',0,323,35,color?'#625e59':'#d5d5d5');
    lettering(ctx,'255 / 50 R18  108Y',Math.PI,320,25,color?'#57534e':'#c2c2c2',true);
    lettering(ctx,'RADIAL  •  TUBELESS',-1.37,324,12,color?'#56534f':'#aeaeae');
    lettering(ctx,'TRACK COMPOUND T2',1.51,324,12,color?'#5b5651':'#aeaeae');
    lettering(ctx,'MADE FOR MOTORSPORT  ·  AD03502',Math.PI,288,9,color?'#4b4844':'#aaa',true);
    for(const [r,w,shade] of [[270,2,53],[276,1.7,57],[352,4,63],[359,1.5,49]]){
      ctx.beginPath();ctx.arc(cx,cx,r,0,tau);ctx.lineWidth=w;
      ctx.strokeStyle=color?'rgb('+shade+','+(shade-3)+','+(shade-5)+')':'#b3b3b3';ctx.stroke();
    }
    for(let i=0;i<82;i++){
      const a=tau*i/82,r=344;
      ctx.save();ctx.translate(cx+Math.sin(a)*r,cx-Math.cos(a)*r);ctx.rotate(a);
      ctx.fillStyle=color?(i%5===0?'#56514a':'#4a4541'):'#a4a4a4';
      ctx.fillRect(-.7,-(i%5===0?7:3),1.5,i%5===0?9:4);ctx.restore();
    }
  }
  return {map:texture(face,true),bumpMap:texture(height)};
}

function periodic(s:number){return Math.abs(s-Math.round(s));}
function channel(distance:number,width:number){
  return 1-T.MathUtils.smoothstep(distance,width*.34,width*.65);
}
function cut(x:number,a:number){
  const step=a/tau*pitches;
  const first=channel(Math.abs(x+.040-.005*Math.sin(a*pitches)),.009);
  const second=channel(Math.abs(x-.051+.004*Math.sin(a*pitches+.8)),.011);
  const inner=channel(periodic(step-.48-x*4.2)*.070,.008)*T.MathUtils.smoothstep(-x,.020,.058);
  const outer=channel(periodic(step+.20+x*5.5)*.070,.010)*T.MathUtils.smoothstep(x,.020,.075);
  const centre=channel(periodic(step+.33+x*8.2)*.070,.0045)*(1-T.MathUtils.smoothstep(Math.abs(x),.025,.052))*.66;
  const sipe=channel(periodic(step+.74+x*4.0)*.070,.0026)*T.MathUtils.smoothstep(Math.abs(x),.072,.110)*.54;
  return Math.max(first,second,inner,outer,centre,sipe);
}
function treadMap(){
  const color=paintCanvas(384),height=paintCanvas(384),n=384;
  const base=color.createImageData(n,n),relief=height.createImageData(n,n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=(i/(n-1)*2-1)*halfTread,a=(1-j/(n-1))*tau/pitches;
    const groove=cut(x,a),noise=((i*17389+j*9497+i*j*317)%109)/109;
    const scuff=Math.sin(i*.45+j*.12)*Math.sin(j*.13)*1.7;
    const dust=T.MathUtils.smoothstep(Math.abs(x),.076,.117)*7;
    const c=46+noise*15+dust+scuff-groove*24,k=(j*n+i)*4;
    base.data.set([c+2,c,c-1,255],k);
    const h=78+noise*54;relief.data.set([h,h,h,255],k);
  }
  color.putImageData(base,0,0);height.putImageData(relief,0,0);
  return {map:texture(color,true,true),bumpMap:texture(height,false,true)};
}

function tread(x:number,radius:number){
  const s=Math.abs(x)/halfTread;
  return radius-.012*s**3.4;
}

function surface(rows:number,segments:number,sample:(u:number,v:number)=>[number,number,number,number,number],invert=false){
  const pos=[],uv=[],indices=[];
  for(let j=0;j<=rows;j++)for(let i=0;i<=segments;i++){
    const [x,y,z,s,t]=sample(i/segments,j/rows);
    pos.push(x,y,z);uv.push(s,t);
  }
  for(let j=0;j<rows;j++)for(let i=0;i<segments;i++){
    const a=j*(segments+1)+i,b=a+1,c=a+segments+1,d=c+1;
    if(invert)indices.push(a,c,b,b,c,d);else indices.push(a,b,c,b,d,c);
  }
  const geo=new T.BufferGeometry();
  geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));
  geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
  geo.setIndex(indices);geo.computeVertexNormals();
  const normals=geo.getAttribute('normal');
  for(let j=0;j<=rows;j++){
    const a=j*(segments+1),b=a+segments;
    const n=new T.Vector3().fromBufferAttribute(normals,a).add(new T.Vector3().fromBufferAttribute(normals,b)).normalize();
    normals.setXYZ(a,n.x,n.y,n.z);normals.setXYZ(b,n.x,n.y,n.z);
  }
  return geo;
}

function section(profile:number[][],segments:number){
  return new T.LatheGeometry(profile.map(([x,r])=>new T.Vector2(r,x)),segments).rotateZ(-Math.PI/2);
}

function createRubber(radius:number,hi:boolean){
  const shoulderRadius=tread(halfTread,radius);
  const profile=new T.SplineCurve([
    new T.Vector2(.103,bead),new T.Vector2(.122,.248),new T.Vector2(.136,.286),
    new T.Vector2(.137,.310),new T.Vector2(.133,.328),new T.Vector2(.127,.337),
    new T.Vector2(halfTread,shoulderRadius),
  ]);
  const sides=[-1,1].map(side=>surface(hi?14:8,hi?128:64,(u,v)=>{
    const point=profile.getPoint(v),a=u*tau,y=Math.cos(a)*point.y,z=Math.sin(a)*point.y;
    return [side*point.x,y,z,.5-side*z/(2*radius),.5+y/(2*radius)];
  },side===1));
  const shoulder=mergeGeometries(sides)!;sides.forEach(g=>g.dispose());
  const contact=surface(hi?44:12,hi?384:96,(u,v)=>{
    const x=(v*2-1)*halfTread,a=u*tau;
    const widthFade=1-T.MathUtils.smoothstep(Math.abs(x),.112,halfTread);
    const r=tread(x,radius)-(hi?grooveDepth*cut(x,a)*widthFade:0);
    return [x,r*Math.cos(a),r*Math.sin(a),v,u*pitches];
  });
  return {shoulder,contact};
}

function machinedIron(){
  const canvas=paintCanvas(256);
  const center=128;
  canvas.fillStyle='#a29d97';canvas.fillRect(0,0,256,256);
  for(let i=0;i<154;i++){
    const r=i*1.071,color=145+(i*37%23);
    canvas.beginPath();canvas.arc(center,center,r,0,tau);
    canvas.strokeStyle=i%23===0?'#79736e':'rgb('+color+','+(color-3)+','+(color-6)+')';
    canvas.lineWidth=i%23===0?.72:.42;canvas.stroke();
  }
  const map=texture(canvas,true);
  return new T.MeshStandardMaterial({color:0xbfc2c2,map,roughness:.49,metalness:.78});
}

function discUV(geometry:T.BufferGeometry,disc:number){
  const p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
  for(let i=0;i<p.count;i++)uv.setXY(i,.5+p.getZ(i)/(2*disc),.5+p.getY(i)/(2*disc));
}

function wheelAlloys(){
  return {
    rim:new T.MeshPhysicalMaterial({color:0x8c7c62,metalness:.79,roughness:.39,clearcoat:.21,clearcoatRoughness:.37}),
    turned:rallyMetal(0xa9a69f,.34),dark:rallyMetal(0x3b3735,.66),iron:machinedIron(),
    rotorHat:rallyMetal(0x534a41,.57),darkSteel:rallyMetal(0x333437,.39),
    enamel:new T.MeshPhysicalMaterial({color:0x782d26,metalness:.33,roughness:.45,clearcoat:.29}),
  };
}

function sweptSpoke(branch:number,a:number){
  const ca=Math.cos(a),sa=Math.sin(a);
  const curve=new T.CatmullRomCurve3([
    new T.Vector3(.051,.096,.019),new T.Vector3(.095,.097,.020),new T.Vector3(.135,.103,.026),
    new T.Vector3(.180,.120,.037),new T.Vector3(.216,.124,.039),new T.Vector3(.221,.124,.039),
  ]);
  return surface(14,12,(u,v)=>{
    const point=curve.getPoint(v);
    const t=u*tau,k=Math.cos(t),l=Math.sin(t);
    const size=T.MathUtils.lerp(.012,.010,v);
    const thickness=T.MathUtils.lerp(.0145,.010,v);
    const flatten=(s:number)=>Math.sign(s)*Math.sqrt(Math.abs(s));
    const x=point.y+flatten(k)*thickness,s=branch*point.z+flatten(l)*size;
    return [x,point.x*ca-s*sa,point.x*sa+s*ca,u,v];
  },true);
}

function alloyLayers(side:number,front:boolean,materials:ReturnType<typeof wheelAlloys>):{spin:Layer[];fixed:Layer[]}{
  const spin:Layer[]=[],fixed:Layer[]=[];
  const {rim,turned,dark,iron,rotorHat,darkSteel,enamel}=materials;
  const barrel=section([[-.113,.221],[-.105,.231],[.110,.231],[.119,.235],[.131,.235],
    [.133,.228],[.127,.218],[.101,.214],[.074,.214],[.058,.203],[-.078,.203],[-.099,.211],[-.113,.216],[-.113,.221]],92);
  spin.push([barrel,rim]);
  spin.push([section([[.126,.218],[.128,.221],[.129,.227],[.132,.229],[.134,.229]],92),turned]);
  const disc=front?.174:.163;
  // Two swept iron faces, separated by genuinely open cooling passages.
  for(const ax of [.027,.051]){
    const swept=section([[ax-.004,.081],[ax-.004,disc-.002],[ax-.002,disc],[ax+.002,disc],[ax+.004,disc-.002],[ax+.004,.081]],72);
    discUV(swept,disc);spin.push([swept,iron]);
    for(let i=0;i<6;i++){
      const a=i*tau/6,shape=new T.Shape();
      shape.moveTo(.099,0);shape.quadraticCurveTo(.130,.011,.158,.025);shape.lineTo(.161,.022);
      shape.quadraticCurveTo(.132,.007,.102,-.002);shape.closePath();
      const slot=new T.ShapeGeometry(shape,7).rotateY(Math.PI/2).rotateX(a).translate(ax+.0043,0,0);
      // The face is viewed from +X on the shared unmirrored design.
      spin.push([slot,dark]);
    }
  }
  for(let i=0;i<24;i++){
    const a=i*tau/24;
    const vane=new T.BoxGeometry(.017,.061,.010).rotateX(a+.12)
      .translate(.039,.142*Math.cos(a),.142*Math.sin(a));
    spin.push([vane,dark]);
  }
  spin.push([section([[.052,.029],[.052,.074],[.056,.083],[.063,.083],[.077,.065],[.086,.063],[.086,.038]],72),rotorHat]);
  spin.push([section([[.084,.043],[.089,.062],[.101,.069],[.122,.064],[.134,.054],[.135,.030],[.135,.008]],76),rim]);
  for(let i=0;i<6;i++)for(const branch of [-1,1]){
    spin.push([sweptSpoke(branch,i*tau/6),rim]);
  }
  const bolt=new T.CylinderGeometry(.0071,.0075,.007,6).rotateZ(-Math.PI/2);
  for(let i=0;i<5;i++){
    const a=i*tau/5,y=.044*Math.cos(a),z=.044*Math.sin(a);
    spin.push([new T.CylinderGeometry(.0094,.0094,.002,18).rotateZ(-Math.PI/2).translate(.135,y,z),darkSteel],
      [bolt.clone().translate(.138,y,z),turned]);
  }
  bolt.dispose();
  spin.push([section([[.135,.001],[.135,.024],[.136,.027],[.140,.027],[.142,.024],[.142,.001]],48),darkSteel]);
  const label=paintCanvas(128);
  label.fillStyle='#232526';label.fillRect(0,0,128,128);
  label.strokeStyle='#b1a18b';label.lineWidth=3;label.beginPath();label.arc(64,64,60,0,tau);label.stroke();
  label.font='900 italic 53px system-ui';label.textAlign='center';label.textBaseline='middle';
  label.fillStyle='#d8cdbd';label.fillText('A',64,65);
  spin.push([new T.CircleGeometry(.020,28).rotateY(Math.PI/2).translate(.1423,0,0),
    new T.MeshStandardMaterial({map:texture(label,true),roughness:.46,metalness:.25})]);
  const stem=new T.CylinderGeometry(.004,.005,.019,12).rotateZ(-.47).translate(.115,.080,-.196);
  spin.push([stem,darkSteel],[new T.CylinderGeometry(.0048,.0048,.009,10).rotateZ(-.47).translate(.121,.091,-.196),turned]);
  // The two caliper shells follow the knuckle, while cooling vanes and rotor follow the wheel.
  const caliper=new T.Shape().moveTo(-.052,.149).quadraticCurveTo(-.061,.169,-.048,.182)
    .quadraticCurveTo(0,.203,.050,.182).quadraticCurveTo(.061,.168,.052,.142)
    .lineTo(.039,.124).quadraticCurveTo(0,.137,-.037,.124).closePath();
  for(const ax of [-.008,.060]){
    const geo=new T.ExtrudeGeometry(caliper,{depth:.014,bevelSegments:2,bevelThickness:.004,bevelSize:.0038,curveSegments:6})
      .rotateY(Math.PI/2).translate(ax,0,0).rotateX(front?.75:1.04);
    fixed.push([geo,enamel]);
  }
  for(const z of [-.036,.036]){
    const bridge=new T.BoxGeometry(.073,.017,.022).translate(.031,.186,z).rotateX(front?.75:1.04);
    fixed.push([bridge,enamel]);
    fixed.push([new T.CylinderGeometry(.0053,.0053,.003,6).rotateZ(-Math.PI/2)
      .translate(.080,.167,z).rotateX(front?.75:1.04),turned]);
  }
  if(side<0){
    // Reflect the full cross section for left wheels. Flip triangle winding along with X.
    for(const [geo] of [...spin,...fixed]){
      if(geo.type==='CircleGeometry'){
        const uv=geo.getAttribute('uv');
        for(let i=0;i<uv.count;i++)uv.setX(i,1-uv.getX(i));
      }
      geo.scale(-1,1,1);
      const indices=geo.index;
      if(indices){
        for(let i=0;i<indices.count;i+=3){
          const x=indices.getX(i);indices.setX(i,indices.getX(i+2));indices.setX(i+2,x);
        }
      }else{
        for(const attr of Object.values(geo.attributes)){
          for(let i=0;i<attr.count;i+=3)for(let k=0;k<attr.itemSize;k++){
            const value=attr.getComponent(i,k);attr.setComponent(i,k,attr.getComponent(i+2,k));attr.setComponent(i+2,k,value);
          }
        }
      }
    }
  }
  return {spin,fixed};
}

function assemble(parent:T.Group,layers:Layer[]){
  const batches=new Map<T.Material,T.BufferGeometry[]>();
  for(const [geometry,material] of layers){
    const batch=batches.get(material)??[];
    batch.push(geometry);batches.set(material,batch);
  }
  for(const [material,geometries] of batches){
    if(geometries.length===1){part(parent,geometries[0],material);continue;}
    const uniformIndex=geometries.every(g=>Boolean(g.index)===Boolean(geometries[0].index));
    const sources=uniformIndex?geometries:geometries.map(g=>g.index?g.toNonIndexed():g);
    const combined=mergeGeometries(sources)!;
    part(parent,combined,material);
    new Set([...sources,...geometries]).forEach(g=>g.dispose());
  }
}

export function rallyWheelSet(radius:number, exteriorOnly=false){
  const rubber=new T.MeshStandardMaterial({...treadMap(),roughness:.86,metalness:0,bumpScale:.00125});
  const sidewall=new T.MeshStandardMaterial({...sidewallMaps(),roughness:.83,metalness:0,bumpScale:.00195});
  const distantRubber=new T.MeshStandardMaterial({map:rubber.map,roughness:.86,metalness:0});
  const distantSidewall=new T.MeshStandardMaterial({map:sidewall.map,roughness:.83,metalness:0});
  const alloys=wheelAlloys();
  const low=createRubber(radius,false),high=exteriorOnly?null:createRubber(radius,true);
  const silhouette=exteriorOnly?null:section([[-.115,radius-.016],[-.080,radius-.0007],[.080,radius-.0007],[.115,radius-.016]],32);
  const shadowOnly=exteriorOnly?null:new T.MeshStandardMaterial({colorWrite:false,depthWrite:false});
  return (pivot:T.Group,roller:T.Group,side:number,front:boolean)=>{
    if(exteriorOnly){
      part(roller,low.shoulder,distantSidewall).castShadow=false;
      part(roller,low.contact,distantRubber).castShadow=false;
    }else{
      const detail=new T.LOD();detail.name='R35 tyre distance LOD';roller.add(detail);
      for(const [level,range] of [[high!,0],[low,2.85]] as const){
        const group=new T.Group();
        part(group,level.shoulder,range?distantSidewall:sidewall).castShadow=false;
        part(group,level.contact,range?distantRubber:rubber).castShadow=false;
        detail.addLevel(group,range,.10);
      }
      const shadow=part(roller,silhouette!,shadowOnly!);
      shadow.name='R35 tyre shadow proxy';shadow.layers.set(3);shadow.userData.shadowOnly=true;
    }
    const {spin,fixed}=alloyLayers(side,front,alloys);
    assemble(roller,spin);
    const caliper=new T.Group();caliper.name='R35 fixed brake caliper';pivot.add(caliper);assemble(caliper,fixed);
  };
}
