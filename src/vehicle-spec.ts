// SI units unless noted. Suspension stiffness and damping use Rapier's mass-normalised units.
export const sport = {
  // Reference output and wheelbase; loaded mass, inertia, ratios and tire model are tuning estimates.
  model: 'Ferrari F40 · gated five-speed', mass: 1275,
  centerOfMass: {x: 0, y: .105, z: .18},
  inertia: {x: 1530, y: 1720, z: 425},
  peakTorque: 577, idle: 990, redline: 7750,
  torqueCurve: [[800,.27],[1600,.35],[2500,.52],[3200,.76],[4000,1],[5000,.98],[6000,.92],[7000,.831],[7750,.69]],
  turbo: {maxBar:1.1, spoolRate:1.85, releaseRate:5.9},
  finalDrive: 3.92, gears: [2.77,1.72,1.23,.96,.77], reverse: 2.86,
  drivelineEfficiency: .89, shiftCut: .26, throttleRise: 10.5, throttleRelease: 15,
  transmission: {downshiftRpm:8150, reverseSpeed:9, upshiftRpm:5200, electronic:false},
  wheels: [
    {x:-.805, z:-1.243, front:true}, {x:.805, z:-1.243, front:true},
    {x:-.805, z:1.207, front:false}, {x:.805, z:1.207, front:false},
  ],
  radius: .330, suspensionRest: .185, mountHeight: .143, bodyOrigin: .332,
  suspension: {front:66, rear:73, bump:5.3, rebound:6.7, travel:.135, maxForce:14500, lateralLeverFraction:.88},
  steering: {
    // Equivalent front axle angle (degrees) at speed (km/h), before Ackermann.
    // Give back geometric lock for parking and hairpins, then taper toward the
    // measured dry grip limit so full keyboard input doesn't just scrub the fronts.
    lock: [
      [0,41.5],[15,40.5],[20,36.8],[25,28],[30,20.5],[40,11.6],[50,7.8],
      [65,5.05],[80,3.85],[100,2.35],[110,2.0],[120,1.7],[140,1.23],[180,.76],[260,.40],
    ],
    response: 9.6, returnRate: 15, ratio: 12.8, columnRateDeg: 455, columnAccelDeg: 3300,
  },
  tires: {frontGrip:1.14, rearGrip:1.18, frontSide:1.02, rearSide:1.00, grassGrip:.63},
  brakes: {frontTorque:1260, rearTorque:830, handbrakeTorque:2150},
  aero: {airDensity:1.225, dragArea:.68, rollingCoefficient:.013},
  fuel: {capacityLitres:120, idleLitresPerHour:1.25, gramsPerKwh:285, kgPerLitre:.745},
};
export type VehicleSpec = typeof sport & {
  awd?: {baseFront:number; maxFront:number; transferRate:number};
  chassisSections?: number[][];
};

export const rally: VehicleSpec = {
  model:'Nissan GT-R R35 Rally Edition',
  mass:1645, centerOfMass:{x:0,y:.115,z:-.105}, inertia:{x:2240,y:2570,z:695},
  peakTorque:655, idle:880, redline:7250,
  torqueCurve:[[750,.24],[1500,.37],[2400,.64],[3300,.94],[3900,1],[5100,.98],[5800,.96],[6800,.91],[7250,.82]],
  turbo:{maxBar:1.22,spoolRate:2.35,releaseRate:7.5},
  // Effective ratios for the two DCT shafts with a shared final drive.
  finalDrive:3.70, gears:[3.83,2.36,1.69,1.31,1.00,.80], reverse:3.38,
  drivelineEfficiency:.86, shiftCut:.12, throttleRise:13, throttleRelease:17,
  wheels:[
    {x:-.842,z:-1.387,front:true},{x:.842,z:-1.387,front:true},
    {x:-.849,z:1.393,front:false},{x:.849,z:1.393,front:false},
  ],
  radius:.357, suspensionRest:.238, mountHeight:.184, bodyOrigin:.405,
  suspension:{front:49,rear:51,bump:5.0,rebound:6.5,travel:.195,maxForce:16300,lateralLeverFraction:.88},
  steering:{
    lock:[[0,43],[14,42],[20,41],[25,31],[30,24],[40,14.5],[50,9.3],[65,5.6],
      [80,3.65],[100,2.12],[120,1.48],[140,1.08],[180,.65],[260,.33]],
    response:11,returnRate:16,ratio:12.1,columnRateDeg:625,columnAccelDeg:5100,
  },
  tires:{frontGrip:1.12,rearGrip:1.12,frontSide:1.08,rearSide:1.04,grassGrip:.77},
  brakes:{frontTorque:1630,rearTorque:1050,handbrakeTorque:2330},
  aero:{airDensity:1.225,dragArea:.83,rollingCoefficient:.019},
  fuel:{capacityLitres:74,idleLitresPerHour:1.18,gramsPerKwh:298,kgPerLitre:.745},
  awd:{baseFront:.18,maxFront:.50,transferRate:5.2},
  transmission:{downshiftRpm:7000,reverseSpeed:7.5,upshiftRpm:5050,electronic:true},
  chassisSections:[[-2.29,.78,-.145,.19],[-1.38,.91,-.225,.35],[1.39,.91,-.225,.48],[2.30,.81,-.12,.35]],
};

export const drivingAssists = {
  assisted:{traction:true,abs:true,steering:.88},
  sport:{traction:true,abs:true,steering:1},
  simulation:{traction:false,abs:false,steering:1},
} as const;
export type AssistMode = keyof typeof drivingAssists;

export function interpolate(curve: number[][], value: number) {
  if (value <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [end, b] = curve[i], [start, a] = curve[i - 1];
    if (value <= end) return a + (b - a) * (value - start) / (end - start);
  }
  return curve[curve.length - 1][1];
}
