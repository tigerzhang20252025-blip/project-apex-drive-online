import type * as T from 'three';

export const surfaceNoise = `
  float pgHash(vec2 p){
    vec3 q=fract(vec3(p.xyx)*.1031);
    q+=dot(q,q.yzx+33.33);
    return fract((q.x+q.y)*q.z);
  }
  float pgNoise(vec2 p){
    vec2 i=floor(p),f=fract(p);
    f=f*f*(3.-2.*f);
    return mix(mix(pgHash(i),pgHash(i+vec2(1.,0.)),f.x),
      mix(pgHash(i+vec2(0.,1.)),pgHash(i+vec2(1.,1.)),f.x),f.y);
  }
  vec3 pgTexture(sampler2D tex,vec2 uv,float variation){
    mat2 turn=mat2(.799,.602,-.602,.799);
    return mix(texture2D(tex,uv).rgb,texture2D(tex,turn*uv*.41+vec2(7.1,2.4)).rgb,
      smoothstep(.19,.79,variation)*.80+.10);
  }
`;

export function weatheredConcrete(material:T.MeshStandardMaterial){
  material.onBeforeCompile=shader=>{
    shader.vertexShader='varying vec3 pgMasonry;\n'+shader.vertexShader.replace('#include <begin_vertex>',`
      #include <begin_vertex>
      vec4 pgLocal=vec4(transformed,1.);
      #ifdef USE_INSTANCING
        pgLocal=instanceMatrix*pgLocal;
      #endif
      pgMasonry=(modelMatrix*pgLocal).xyz;
    `);
    shader.fragmentShader='varying vec3 pgMasonry;\n'+surfaceNoise+shader.fragmentShader.replace('#include <color_fragment>',`
      #include <color_fragment>
      vec2 wall=vec2(pgMasonry.x*.72+pgMasonry.z*.69,pgMasonry.y);
      float pores=pgNoise(wall*49.);
      float stain=pgNoise(wall*vec2(.71,.14)+5.);
      float seam=smoothstep(.94,.991,fract(pgMasonry.y*.48+.03*pgNoise(wall)));
      diffuseColor.rgb*=.88+.17*pores+.22*stain-.11*seam;
    `);
  };
  return material;
}
