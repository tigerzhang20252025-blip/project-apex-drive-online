import { MathUtils } from 'three';
import { createStageAlignment } from './stage-alignment.ts';

// Distance to entry, nominal radius, signed angle (left positive), transition,
// and optional entry-to-exit curvature bias.
const quarry = [
  [608,31,-142,18,-.22],
  [12,42,74,17,.08],
  [9,32,-61,14,.23],
  [13,39,86,17,-.16],
  [8,47,-63,19,.40],
] as const;
const forestLink = 1140.3219823169852; // Match the existing Skyline chainage.
const quarryLength = quarry.reduce((sum,[gap,radius,angle,ramp])=>sum+gap+radius*Math.abs(angle)*Math.PI/180+ramp,0);
const linkGap = forestLink-quarryLength-78*31*Math.PI/180-25;
const gorgeApproach = [84.0197,61.3779,77.8967,22,-.20] as const;
const gorgeSweep = [19.8,1117.6259,16.2763,26] as const;
const regions = [
  ['Forest Sprint', [...quarry,[linkGap,78,31,25]]],
  ['Skyline Crest', [[67,42,69,17],[72,65,-55,21],[58,630,-27,46]]],
  // A long opening left falls into the basin before a short right-left reset.
  ['Spruce Bowl', [[254.1435,123.9207,101.462,33,-.43],[8.1064,35.8895,-85.4984,17,.38],[25.1664,77.6171,106.0364,30,-.23]]],
  ['Cliffside Traverse', [[92.1531,620,27,43],[256,98,-53,27,.32],[10,52,-57,18,-.28]]],
  ['Glass Gorge Bridge', [gorgeApproach,gorgeSweep]],
  ['Ridge Attack', [[182.4513,42.5167,-107.7134,18,.28],[26.498,59.7126,102.5404,22,-.23],[76.0606,540,-26,42],[260,88,49,23,-.32],[35,47,80,19,.31],[39,31,-76,15]]],
  ['Valley Descent', [[100,102,62,24],[83,30,-108,14],[90,86,-66,24],[108,56,74,20],[86,110,48,25]]],
] as const;

const lengthOf = ([gap,radius,angle,taper]: readonly number[])=>gap+radius*Math.abs(angle)*Math.PI/180+taper;

export const mountainQuarry={entry:608,technicalEnd:quarryLength,link:forestLink};

const turns=regions.flatMap(([,bends])=>[...bends]);
let boundary=0;
export const mountainRegions=regions.map(([name,bends])=>{
  const start=boundary;
  boundary+=bends.reduce((sum,bend)=>sum+lengthOf(bend),0);
  return {name,start};
});
export const mountainFlatCorners=[9,13,20] as const;
const gorgeEntry=mountainRegions.find(region=>region.name==='Glass Gorge Bridge')!.start;
const deckStart=gorgeEntry+lengthOf(gorgeApproach)+gorgeSweep[0];
const deckEnd=gorgeEntry+lengthOf(gorgeApproach)+lengthOf(gorgeSweep);
export const mountainGorge={station:(deckStart+deckEnd)/2,deckStart,deckEnd};
export const mountainCrest=1685;

export function mountainShoulderWidth(station:number){
  const {smoothstep}=MathUtils;
  const bridge=smoothstep(station,deckStart-58,deckStart)*
    (1-smoothstep(station,deckEnd,deckEnd+56));
  const quarry=smoothstep(station,420,510)*(1-smoothstep(station,1006,1090));
  return 2.38+.40*quarry-.88*bridge;
}
const sectorStations=[2367,5016] as const;
const gates=[
  0,170,390,545,605,712,789,850,934,1020,1140,1260,1460,1880,2040,2210,2367,
  2490,2630,2790,3130,3310,3430,3550,deckStart,3820,3950,deckEnd,4175,4290,4420,4490,4680,4880,5016,
  5165,5330,5490,5690,5840,5990,6150,6350,
];
const heights=[
  [0,239],[190,246],[350,256],[491,265.3],[575,270.9],[655,276.2],[755,284.4],
  [850,294.7],[997,309],[1200,331],[1510,363],[1710,371],[1880,367],
  [2180,351],[2520,381],[2780,409],[3060,430],[3370,439],[3645,433],[deckStart,432.5],
  [3880,434],[deckEnd,435.7],[4140,440],[4260,449],[4345,456],[4485,463],[4520,464],
  [4810,470],[5050,454],[5340,424],[5650,384],
  [5910,348],[6180,310],[6450,282],[6650,278],[7000,278],
] as const;

// Full-strength spans with smooth tapers into the surrounding road.
// Crossfall is positive when the right edge is higher than the left.
const crossSections=[
  [0,60,448,510, .32, .000],
  [450,555,680,744, 1.12,-.029], // broad approach and bank into the quarry hook
  [721,746,769,789, .51, .022],
  [786,803,826,851, .50,-.021],
  [847,874,912,939, .59, .023],
  [931,954,1002,1044, .58,-.020],
  [1135,1210,1260,1343, .34, .030],
  [2040,2100,2300,2342, .29, .024],
  [2320,2344,2405,2431, .71,-.034],
  [2430,2460,2585,2650, .29, .021],
  [3220,3302,3475,3530, .27, -.013], // supported linked rights on the cliff shelf
  [5045,5114,5320,5390, .35, .011],
  [deckStart-35,deckStart,deckEnd,deckEnd+45, .73,.015],
  [4110,4193,4308,4353, .69,-.034],
  [4330,4370,4460,4512, .37,.028],
  [5090,5243,5290,5350, .05,-.018], // mild adverse camber on the second Watchtower turn
  [5680,5740,5790,5842,  .27,-.034], // give the descending hairpin an inside bank
  [5860,5904,5970,6065, -.10, .024], // right-hand arc falls away to the outside
] as const;
function mountainCrossSection(station:number){
  let halfWidthDelta=0,crossfallDelta=0;
  for(const [start,begin,end,finish,width,crossfall] of crossSections){
    const amount=MathUtils.smoothstep(station,start,begin)*(1-MathUtils.smoothstep(station,end,finish));
    halfWidthDelta+=amount*width;
    crossfallDelta+=amount*crossfall;
  }
  return {halfWidthDelta,crossfallDelta};
}

// Isolated rolling imperfections. Each span returns to the design surface with
// zero slope and curvature. A lateral tilt keeps them from acting like speed bumps.
const undulations = [
  [213,282,.045,.12,1],[757,793,-.045,-.15,-1],[1176,1234,.061,.22,1],
  [2467,2521,-.074,-.18,1],[3328,3378,.066,.17,-1],[4146,4194,-.051,.14,-1],
  [5312,5362,.066,-.16,1],[5718,5771,.083,.20,-1],
] as const;
export function mountainUndulation(station:number,across:number){
  for(const [start,end,amplitude,skew,side] of undulations){
    if(station<=start||station>=end)continue;
    const t=(station-start)/(end-start);
    const shape=Math.sin(Math.PI*(t+skew*t*(1-t)))**4;
    return amplitude*shape*(.79+.21*side*MathUtils.clamp(across/4.4,-1,1));
  }
  return 0;
}

export const mountainAlignment=createStageAlignment({
  // Origin tied to the old Forest–Skyline join, leaving the skyline and gorge in place.
  alignment:turns,heights,headingDegrees:11,origin:[178.94479,-199.05849],finishStraight:105,gateDistances:gates,
  // Extra lift at Skyline, followed much later by isolated compressions. Keep
  // the main bridge deck on the broad vertical profile.
  verticalFeatures:[[1455,1865,5.7],[4056,4153,-.34],[5850,6120,-2.25]],
  sightlineEasing:[[3028,3370,.74],[4805,5200,.68]],profile:mountainCrossSection,
  flatCorners:mountainFlatCorners,baseHalfWidth:4.4,leadIn:-34,runoff:235,
});
export const mountainSectors=[gates.indexOf(sectorStations[0]),gates.indexOf(sectorStations[1])] as const;

export function mountainRegionAt(station:number){
  return mountainRegions.findLast(region=>station>=region.start)?.name??mountainRegions[0].name;
}
