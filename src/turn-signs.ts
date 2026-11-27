import * as T from 'three';
import {batchParts} from './batch.ts';
import {railOffset,sampleAt,surveyMeters} from './track.ts';

// Outside-of-curve alignment, with the panel facing approaching traffic. Only
// selected hazards get a sequence; the summit also gets an advance hairpin board.
export function placeTurnSigns(scene:T.Object3D){
  const panels=new T.Group();panels.name='Curve alignment signs';scene.add(panels);
  const steel=new T.MeshStandardMaterial({color:0x848e90,metalness:.68,roughness:.42});
  const reflective=new T.MeshStandardMaterial({color:0xf6c828,metalness:.10,roughness:.44,emissive:0x644600,emissiveIntensity:.09});
  const ink=new T.MeshStandardMaterial({color:0x171915,roughness:.69});
  const posts=new T.BoxGeometry(.068,3.9,.080),plate=new T.BoxGeometry(.62,.79,.032);
  const face=new T.PlaneGeometry(.596,.765);
  const arrowShape=new T.Shape();arrowShape.moveTo(-.205,.296);arrowShape.lineTo(-.01,.296);arrowShape.lineTo(.205,0);arrowShape.lineTo(-.01,-.296);arrowShape.lineTo(-.205,-.296);arrowShape.lineTo(.016,0);arrowShape.closePath();
  const arrow=new T.ShapeGeometry(arrowShape);
  const signs:Array<{d:number;right:boolean;outside:number;kind:string;position:number[]}>=[];panels.userData.signs=signs;
  function place(d:number,right:boolean,advance:boolean){
    const s=sampleAt(d),f=sampleAt(d-12).forward,outside=-(right?1:-1)*(railOffset+1.55);
    const p=s.p.clone().addScaledVector(s.right,outside),q=new T.Quaternion().setFromAxisAngle(T.Object3D.DEFAULT_UP,Math.atan2(-f.x,-f.z));
    function part(g:T.BufferGeometry,m:T.Material,y:number,z:number,flip=false){
      const mesh=new T.Mesh(g,m);mesh.position.set(0,y,z).applyQuaternion(q).add(p);mesh.quaternion.copy(q);
      if(flip)mesh.rotateZ(Math.PI);mesh.castShadow=mesh.receiveShadow=true;panels.add(mesh);return mesh;
    }
    part(posts,steel,-.13,0);
    part(plate,steel,1.55,.055);part(face,reflective,1.55,.073);
    if(advance){
      const c=document.createElement('canvas');c.width=256;c.height=320;const ctx=c.getContext('2d')!;
      ctx.fillStyle='#f5c92c';ctx.fillRect(0,0,256,320);ctx.fillStyle=ctx.strokeStyle='#202219';ctx.lineWidth=20;ctx.lineJoin='round';
      ctx.save();if(!right){ctx.translate(256,0);ctx.scale(-1,1);}ctx.beginPath();ctx.moveTo(72,233);ctx.lineTo(72,122);ctx.bezierCurveTo(72,44,178,39,178,123);ctx.lineTo(178,155);ctx.stroke();
      ctx.beginPath();ctx.moveTo(146,142);ctx.lineTo(210,142);ctx.lineTo(178,195);ctx.fill();ctx.restore();
      ctx.font='bold 37px sans-serif';ctx.textAlign='center';ctx.fillText('80 m',128,288);const map=new T.CanvasTexture(c);map.colorSpace=T.SRGBColorSpace;
      part(face,new T.MeshStandardMaterial({map,roughness:.54}),1.55,.076);
    }else part(arrow,ink,1.55,.076,!right);
    signs.push({d,right,outside,kind:advance?'hairpin advance':'chevron',position:p.toArray()});
  }
  for(const [point,offsets] of [[6,[-18,6,30]],[23,[-39,-22,-5,12,29,46]],[29,[-19,3,25]],[53,[-23,0,23]],[60,[-18,5,28]],[67,[-20,4,28]]] as const){
    const d=surveyMeters[point],right=sampleAt(d).curvature>0;
    if(point===23)place(d-80,right,true);
    for(const offset of offsets)place(d+offset,right,false);
  }
  batchParts(panels);
}
