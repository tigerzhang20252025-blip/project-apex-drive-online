import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// Batch authored static parts within their actual moving parent. Each retained mesh has one material.
export function batchParts(group:T.Group) {
  const groups = new Map<T.Material,T.Mesh[]>();
  for(const obj of [...group.children]){
    if(!(obj instanceof T.Mesh)||Array.isArray(obj.material)||obj.userData.action)continue;
    const items=groups.get(obj.material)??[];items.push(obj);groups.set(obj.material,items);
  }
  for(const [material,items] of groups){
    if(items.length<2)continue;
    const sources=items.map(m=>{
      m.updateMatrix();
      const g=m.geometry.index?m.geometry.toNonIndexed():m.geometry.clone();
      g.applyMatrix4(m.matrix);g.deleteAttribute('uv1');g.deleteAttribute('tangent');
      return g;
    });
    const joined=mergeGeometries(sources);
    if(joined){
      items.forEach(m=>m.removeFromParent());const mesh=new T.Mesh(joined,material);mesh.castShadow=mesh.receiveShadow=true;group.add(mesh);
    }
    sources.forEach(g=>g.dispose());
  }
}

// Batch static opaque meshes under a subtree into root-local space, keeping excluded
// animated/light subtrees untouched and originals hidden for clean template disposal.
export function batchSubtree(root: T.Object3D, exclude?: (node: T.Object3D) => boolean) {
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  const buckets = new Map<string, T.Mesh<T.BufferGeometry, T.Material>[]>();
  const visit = (node: T.Object3D) => {
    if (!node.visible || exclude?.(node)) return;
    if (node instanceof T.Mesh) {
      if (
        !Array.isArray(node.material) &&
        !node.material.transparent &&
        !node.material.userData?.remoteLight &&
        !node.userData.shadowOnly
      ) {
        const attrs = Object.keys(node.geometry.attributes).sort().join('/');
        const key = `${node.material.uuid}|${attrs}|${Number(Boolean(node.geometry.index))}|${Number(node.castShadow)}|${Number(node.receiveShadow)}`;
        const list = buckets.get(key) ?? [];
        list.push(node);
        buckets.set(key, list);
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const child of [...root.children]) visit(child);

  const relative = new T.Matrix4();
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const copies = meshes.map(mesh => {
      const source = mesh.geometry;
      const copy = new T.BufferGeometry();
      for (const [name, attr] of Object.entries(source.attributes)) {
        const array = new Float32Array(attr.count * attr.itemSize);
        for (let i = 0; i < attr.count; i++) {
          for (let c = 0; c < attr.itemSize; c++) {
            array[i * attr.itemSize + c] = attr.getComponent(i, c);
          }
        }
        copy.setAttribute(name, new T.BufferAttribute(array, attr.itemSize));
      }
      if (source.index) copy.setIndex(source.index.clone());
      relative.multiplyMatrices(rootInverse, mesh.matrixWorld);
      return copy.applyMatrix4(relative);
    });
    const merged = mergeGeometries(copies);
    if (merged) {
      const first = meshes[0];
      const combined = new T.Mesh(merged, first.material);
      combined.castShadow = first.castShadow;
      combined.receiveShadow = first.receiveShadow;
      root.add(combined);
      for (const mesh of meshes) mesh.visible = false;
    }
    for (const copy of copies) copy.dispose();
  }
}
