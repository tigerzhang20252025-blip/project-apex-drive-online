import { Color, MathUtils } from 'three';
import { mountainGorge } from './pineglass-v2.ts';

export type DustSurface = { density: number; color: Color };
export type DustProfile = (station: number, sample: DustSurface) => void;

type Patch = readonly [start: number, full: number, fade: number, end: number, density: number, color: Color];
const {smoothstep,lerp}=MathUtils;

const compactDensity=.25;
const compactColor=new Color(0xa99885);
const loose: readonly Patch[]=[
  [-35,-4,333,448,.78,new Color(0xcfb58d)], // Dry Forest Sprint
  [485,554,951,1095,1,new Color(0xcfb087)], // Loose quarry fines
  [1520,1570,1705,1830,.68,new Color(0xb6a085)], // Exposed Skyline
  [2008,2090,2424,2560,.83,new Color(0xc0a583)], // Spruce Bowl
  [4220,4350,4690,4890,.62,new Color(0xbda98e)], // Pale ridge gravel
  [5430,5510,6030,6140,.13,new Color(0x92826e)], // Shaded descent
];
export const mountainDust: DustProfile = (station,sample)=>{
  sample.density=compactDensity;
  sample.color.copy(compactColor);
  for(const [start,full,fade,end,density,color] of loose){
    if(station<=start||station>=end)continue;
    const cover=smoothstep(station,start,full)*(1-smoothstep(station,fade,end));
    sample.density=lerp(compactDensity,density,cover);
    sample.color.lerp(color,cover);
    break;
  }
  const {deckStart,deckEnd}=mountainGorge;
  const deck=smoothstep(station,deckStart-24,deckStart)*(1-smoothstep(station,deckEnd,deckEnd+30));
  sample.density*=1-deck;
};
