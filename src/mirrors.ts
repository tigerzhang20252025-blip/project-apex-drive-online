import * as T from 'three';

export const mirrorExcludedLayer=4;

// A rear-facing camera supplies a shared panorama. The side mirrors take different crops.
export class Mirrors{
  private target=new T.WebGLRenderTarget(448,144,{depthBuffer:true});
  private camera=new T.PerspectiveCamera(30,448/144,.22,970);
  private nextRefresh=0;
  private mirrorCalls=0;
  get drawCalls(){return this.mirrorCalls;}
  private rear=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),Math.PI);
  private surface=new T.MeshBasicMaterial({map:this.target.texture,side:T.DoubleSide,toneMapped:true});
  dispose(){this.target.dispose();this.surface.dispose();}
  attach(mesh:T.Mesh){
    const geometry=mesh.geometry;geometry.computeBoundingBox();
    const bounds=geometry.boundingBox!,size=bounds.getSize(new T.Vector3()),vertices=geometry.getAttribute('position'),uv=[];
    const [start,width]=mesh.name==='mirrorLeft'?[.62,.38]:mesh.name==='mirrorRight'?[0,.38]:[.23,.54];
    for(let i=0;i<vertices.count;i++){
      const u=(vertices.getX(i)-bounds.min.x)/size.x,v=(vertices.getY(i)-bounds.min.y)/size.y;
      uv.push(start+(1-u)*width,.24+.56*v);
    }
    geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));mesh.material=this.surface;mesh.castShadow=false;
  }
  private warmedTrack?: string;
  private configure(position:T.Vector3,quaternion:T.Quaternion,compact:boolean){
    const far=compact?500:970;
    if(this.camera.far!==far){this.camera.far=far;this.camera.updateProjectionMatrix();}
    this.camera.position.set(0,.65,2.27).applyQuaternion(quaternion).add(position);
    this.camera.quaternion.copy(quaternion).multiply(this.rear);
  }

  warm(renderer:T.WebGLRenderer,scene:T.Scene,body:T.Group,trackKey?:string,position:T.Vector3=body.position,quaternion:T.Quaternion=body.quaternion){
    if(trackKey&&this.warmedTrack===trackKey)return;
    this.warmedTrack=trackKey;
    this.configure(position,quaternion,true);
    const current=renderer.getRenderTarget(),shadows=renderer.shadowMap.autoUpdate,visible=body.visible;
    body.visible=false;renderer.shadowMap.autoUpdate=false;renderer.setRenderTarget(this.target);
    try {
      renderer.render(scene,this.camera);
    } finally {
      renderer.setRenderTarget(current);
      body.visible=visible;renderer.shadowMap.autoUpdate=shadows;
    }
  }

  update(renderer:T.WebGLRenderer,scene:T.Scene,body:T.Group,now:number,compact=false){
    if(now<this.nextRefresh)return;
    this.nextRefresh=now+140;
    this.configure(body.position,body.quaternion,compact);
    const current=renderer.getRenderTarget(),shadows=renderer.shadowMap.autoUpdate,visible=body.visible;
    body.visible=false;renderer.shadowMap.autoUpdate=false;renderer.setRenderTarget(this.target);
    try {
      renderer.render(scene,this.camera);
      this.mirrorCalls=renderer.info.render.calls;
    } finally {
      renderer.setRenderTarget(current);
      body.visible=visible;renderer.shadowMap.autoUpdate=shadows;
    }
  }
}
