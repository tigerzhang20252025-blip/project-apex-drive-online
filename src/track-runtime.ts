import * as T from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildEnvironment } from './environment.ts';
import { buildPineglassMountain } from './pineglass-greybox.ts';
import type { RoadWear } from './road-wear.ts';
import { installStartingGantry } from './start-gantry.ts';
import type { TrackDefinition } from './tracks.ts';
import { stepTime } from './vehicle.ts';

export async function buildTrack(track:TrackDefinition, renderer:T.WebGLRenderer, panorama:Promise<T.Texture>, wear:RoadWear){
  const root=new T.Group();
  root.name=track.name;
  const world=new RAPIER.World({x:0,y:-9.81,z:0});
  world.timestep=stepTime;
  const textures=new Set<T.Texture>();
  function dispose(){
    const materials=new Set<T.Material>(), geometries=new Set<T.BufferGeometry>();
    root.traverse(object=>{
      if(object instanceof T.InstancedMesh)object.dispose();
      if(!(object instanceof T.Mesh))return;
      geometries.add(object.geometry);
      for(const material of Array.isArray(object.material)?object.material:[object.material]){
        materials.add(material);
        for(const value of Object.values(material))if(value instanceof T.Texture)textures.add(value);
      }
    });
    root.removeFromParent();
    root.clear();
    geometries.forEach(geometry=>geometry.dispose());
    materials.forEach(material=>material.dispose());
    textures.forEach(texture=>texture.dispose());
    world.free();
  }

  try {
    const scenery=track.environment.scenery;
    const environment=scenery==='pineglass-mountain'
      ? await buildPineglassMountain(root,world,renderer,textures)
      : {updateVegetation:await buildEnvironment(root,world,renderer,panorama,wear,textures),gantry:installStartingGantry(root)};
    return {root,world,dispose,...environment};
  }catch(error){
    dispose();
    throw error;
  }
}
