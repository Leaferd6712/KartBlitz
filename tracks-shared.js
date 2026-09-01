// Shared track data + finalize helpers (used by index.html and admin.html)
// ── SPLINE MATH ─────────────────────────────────────────
function catmullRom(p0,p1,p2,p3,t) {
  const t2=t*t, t3=t2*t;
  return {
    x: 0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: 0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3)
  };
}
function buildSpline(wps, steps=25) {
  const pts=[], n=wps.length;
  for(let i=0;i<n;i++){
    const p0=wps[(i-1+n)%n],p1=wps[i],p2=wps[(i+1)%n],p3=wps[(i+2)%n];
    for(let s=0;s<steps;s++) pts.push(catmullRom(p0,p1,p2,p3,s/steps));
  }
  return pts;
}
function splineTangent(spl, idx) {
  const n=spl.length;
  const a=spl[(idx-1+n)%n], b=spl[(idx+1)%n];
  const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1;
  return {x:dx/len, y:dy/len};
}
function distToSeg(px,py,ax,ay,bx,by) {
  const dx=bx-ax,dy=by-ay,lenSq=dx*dx+dy*dy;
  if(lenSq===0) return Math.hypot(px-ax,py-ay);
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/lenSq));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}
function linesCross(ax,ay,bx,by,cx,cy,dx,dy) {
  function cross(o,a,b){return(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);}
  const A={x:ax,y:ay},B={x:bx,y:by},C={x:cx,y:cy},D={x:dx,y:dy};
  return cross(A,B,C)*cross(A,B,D)<0 && cross(C,D,A)*cross(C,D,B)<0;
}

// ── TRACK DATA ───────────────────────────────────────────
// Default free circuits (AI-friendly pack + Titan). Author challenge tracks unlock with coins.
const DEFAULT_UNLOCKED_TRACKS = [0, 1, 2, 3, 4, 5];

const TRACKS = [
  // ── AI-FRIENDLY PACK (wide, flowing, gentle braking) ───────────────
  {
    id:0, name:'SUNSET SPEEDWAY', difficulty:'EASY', diffClass:'diff-easy', diffLetter:'e',
    targetLap:42, laps:3, trackWidth:160, lapDistance:0, coinMult:1.0, aiFriendly:true,
    grassColor:'#173012', grassColor2:'#1e3e18',
    trackColor:'#2e2e2e', borderColor:'#ff9500', lineColor:'#ffffff',
    accentColor:'#ff6b35', bgColor:'#0f1a08',
    treeColor:'#1a4010', treeColor2:'#2a6018',
    standRoof:'#2a2218', standConcrete:'#3a3228',
    seatPalette:['#ff6b35','#ff9500','#ffd166','#cc4400'],
    crowdColors:['#e8d4b8','#d4a574','#ff6b35','#1a3a6a','#cc2222','#ffee88'],
    waypoints:[
      {x:1800,y:4200},{x:2400,y:4200},{x:3200,y:4200},
      {x:3700,y:4100},{x:4050,y:3800},{x:4200,y:3400},
      {x:4200,y:2800},{x:4200,y:2200},
      {x:4050,y:1750},{x:3700,y:1450},{x:3200,y:1350},
      {x:2500,y:1350},{x:1700,y:1350},
      {x:1100,y:1500},{x:800,y:1850},
      {x:750,y:2450},
      {x:700,y:2800},{x:600,y:3100},{x:700,y:3400},{x:900,y:3600},
      {x:1050,y:3850},{x:1200,y:4050},{x:1500,y:4200},{x:1650,y:4200}
    ],
    startPos:{x:2100,y:4200}, startAngle:0,
    pitPos:{x:2200,y:4020},
    pitLane:{
      path:[{x:1700,y:4200},{x:1700,y:4020},{x:2200,y:4020},{x:2800,y:4020},{x:2800,y:4200}],
      entryPt:{x:1700,y:4200}, garagePos:{x:2200,y:4020}, garageAngle:0,
      exitPos:{x:2800,y:4200}, exitAngle:0, width:58
    },
    cpFracs:[0.0, 0.19, 0.37, 0.54, 0.70, 0.86],
    drsFracs:[[0.01, 0.16], [0.39, 0.51]],
    aiBrakeLookaheadScale:0.96,
    surface:{offTrackMult:1.00, label:'GRASS'}
  },
  {
    id:1, name:'MEADOW PARK', difficulty:'EASY', diffClass:'diff-easy', diffLetter:'e',
    targetLap:38, laps:3, trackWidth:168, lapDistance:0, coinMult:1.0, aiFriendly:true,
    // Wide stadium oval — almost flat everywhere, ideal for AI races
    grassColor:'#1a3a14', grassColor2:'#244e1c',
    trackColor:'#2a2a2a', borderColor:'#6dd46a', lineColor:'#ffffff',
    accentColor:'#8ef08a', bgColor:'#0c1a0a',
    treeColor:'#204818', treeColor2:'#347028',
    standRoof:'#1e2a1c', standConcrete:'#2e3a2c',
    seatPalette:['#6dd46a','#4488cc','#ffd166','#cc5555'],
    crowdColors:['#e8d4b8','#c4a882','#6dd46a','#1a3a6a','#cc2222','#ffee88'],
    waypoints:[
      {x:1100,y:4000},{x:1900,y:4000},{x:2800,y:4000},{x:3500,y:3900},
      {x:3900,y:3600},{x:4050,y:3100},{x:4050,y:2500},
      {x:3900,y:2000},{x:3500,y:1700},{x:2800,y:1600},{x:1900,y:1600},
      {x:1200,y:1700},{x:850,y:2000},{x:700,y:2500},{x:700,y:3100},
      {x:850,y:3600},{x:1100,y:3900}
    ],
    startPos:{x:1600,y:4000}, startAngle:0,
    pitPos:{x:2000,y:3820},
    pitLane:{
      path:[{x:1400,y:4000},{x:1400,y:3820},{x:2000,y:3820},{x:2700,y:3820},{x:2700,y:4000}],
      entryPt:{x:1400,y:4000}, garagePos:{x:2000,y:3820}, garageAngle:0,
      exitPos:{x:2700,y:4000}, exitAngle:0, width:60
    },
    cpFracs:[0.0, 0.18, 0.36, 0.54, 0.72, 0.90],
    drsFracs:[[0.02, 0.14], [0.48, 0.60]],
    aiBrakeLookaheadScale:0.98,
    surface:{offTrackMult:1.05, label:'PARKLAND'}
  },
  {
    id:2, name:'BLUE BAY RUN', difficulty:'EASY', diffClass:'diff-easy', diffLetter:'e',
    targetLap:44, laps:3, trackWidth:158, lapDistance:0, coinMult:1.1, aiFriendly:true,
    // Gentle kidney loop — long sweeps, one light brake zone
    grassColor:'#0a2840', grassColor2:'#123850',
    trackColor:'#1e2830', borderColor:'#4db8ff', lineColor:'#ffffff',
    accentColor:'#7ad4ff', bgColor:'#061018',
    treeColor:'#1a3840', treeColor2:'#2a5060',
    standRoof:'#142830', standConcrete:'#243840',
    seatPalette:['#4db8ff','#ffd166','#ff6b6b','#88ccaa'],
    crowdColors:['#e8d4b8','#c4a882','#4db8ff','#1a3a6a','#cc2222','#ffee88'],
    waypoints:[
      {x:900,y:4600},{x:1800,y:4600},{x:2700,y:4600},{x:3400,y:4450},
      {x:3800,y:4100},{x:3950,y:3600},{x:3850,y:3100},
      {x:3500,y:2750},{x:2900,y:2550},{x:2300,y:2400},
      {x:1800,y:2100},{x:1400,y:1800},{x:1000,y:1750},
      {x:650,y:2000},{x:500,y:2500},{x:500,y:3200},
      {x:600,y:3800},{x:750,y:4300}
    ],
    startPos:{x:1400,y:4600}, startAngle:0,
    pitPos:{x:1900,y:4420},
    pitLane:{
      path:[{x:1200,y:4600},{x:1200,y:4420},{x:1900,y:4420},{x:2600,y:4420},{x:2600,y:4600}],
      entryPt:{x:1200,y:4600}, garagePos:{x:1900,y:4420}, garageAngle:0,
      exitPos:{x:2600,y:4600}, exitAngle:0, width:58
    },
    cpFracs:[0.0, 0.17, 0.34, 0.50, 0.67, 0.84],
    drsFracs:[[0.02, 0.13], [0.52, 0.64]],
    aiBrakeLookaheadScale:0.96,
    surface:{offTrackMult:0.95, label:'COASTAL'}
  },
  {
    id:3, name:'HURRICANE PASS', difficulty:'EASY', diffClass:'diff-easy', diffLetter:'e',
    targetLap:52, laps:3, trackWidth:148, lapDistance:0, coinMult:1.15, aiFriendly:true,
    grassColor:'#08182e', grassColor2:'#0c2040',
    trackColor:'#1e1e30', borderColor:'#00ccff', lineColor:'#ffffff',
    accentColor:'#00f5ff', bgColor:'#040a18',
    treeColor:'#0c2840', treeColor2:'#184868',
    standRoof:'#101828', standConcrete:'#1c2838',
    seatPalette:['#00ccff','#0088aa','#66eeff','#004466'],
    crowdColors:['#e8d4b8','#c4a882','#00ccff','#1a3a6a','#cc2222','#ffee88'],
    waypoints:[
      {x:700,y:5400},{x:1600,y:5400},{x:2700,y:5400},
      {x:3250,y:5250},{x:3550,y:4950},{x:3650,y:4550},
      {x:3650,y:4050},
      {x:3500,y:3700},{x:3200,y:3550},
      {x:2650,y:3500},{x:2100,y:3500},
      {x:1700,y:3500},{x:1400,y:3700},{x:1300,y:4000},{x:1400,y:4300},{x:1700,y:4500},
      {x:2200,y:4600},{x:2600,y:4600},
      {x:3000,y:4500},{x:3100,y:4200},
      {x:3100,y:3600},{x:3100,y:3100},
      {x:2950,y:2750},{x:2600,y:2550},
      {x:2000,y:2550},{x:1400,y:2550},
      {x:1050,y:2600},{x:750,y:2800},{x:700,y:3100},
      {x:750,y:3600},
      {x:600,y:3900},{x:450,y:4200},{x:500,y:4500},{x:650,y:4750},
      {x:700,y:5150}
    ],
    startPos:{x:1200,y:5400}, startAngle:0,
    pitPos:{x:1500,y:5224},
    pitLane:{
      path:[{x:800,y:5400},{x:800,y:5224},{x:1500,y:5224},{x:2400,y:5224},{x:2400,y:5400}],
      entryPt:{x:800,y:5400}, garagePos:{x:1500,y:5224}, garageAngle:0,
      exitPos:{x:2400,y:5400}, exitAngle:0, width:58
    },
    cpFracs:[0.0, 0.12, 0.25, 0.38, 0.50, 0.63, 0.76, 0.88],
    drsFracs:[[0.02, 0.11], [0.44, 0.54]],
    aiBrakeLookaheadScale:0.94,
    surface:{offTrackMult:0.90, label:'WET GROUND'}
  },
  {
    id:4, name:'RIVIERA GP', difficulty:'MEDIUM', diffClass:'diff-med', diffLetter:'m',
    targetLap:58, laps:3, trackWidth:150, lapDistance:0, coinMult:1.35, aiFriendly:true,
    grassColor:'#092236', grassColor2:'#10304a',
    trackColor:'#1b2630', borderColor:'#4dd9ff', lineColor:'#ffffff',
    accentColor:'#ffd166', bgColor:'#041019',
    treeColor:'#0c3040', treeColor2:'#184858',
    standRoof:'#122830', standConcrete:'#223840',
    seatPalette:['#4dd9ff','#ffd166','#ff6b35','#88ccee'],
    crowdColors:['#e8d4b8','#c4a882','#4dd9ff','#ffd166','#1a3a6a','#cc2222'],
    waypoints:[
      {x:900,y:5800},{x:1700,y:5800},{x:2600,y:5800},{x:3400,y:5800},
      {x:3900,y:5600},{x:4200,y:5200},{x:4300,y:4700},
      {x:4250,y:4200},{x:4100,y:3800},{x:3800,y:3500},{x:3350,y:3350},{x:2900,y:3300},
      {x:2500,y:3150},{x:2300,y:2800},{x:2300,y:2350},
      {x:2500,y:1950},{x:2900,y:1750},{x:3450,y:1700},{x:4000,y:1700},
      {x:4450,y:1550},{x:4700,y:1250},{x:4700,y:850},{x:4450,y:600},{x:3950,y:520},
      {x:3400,y:600},{x:2850,y:780},{x:2450,y:1100},{x:2150,y:1500},{x:1900,y:2000},
      {x:1600,y:2350},{x:1200,y:2550},{x:850,y:2850},{x:700,y:3300},{x:650,y:3900},{x:700,y:4600},{x:780,y:5250}
    ],
    startPos:{x:1450,y:5800}, startAngle:0,
    pitPos:{x:1950,y:5590},
    pitLane:{
      path:[{x:1300,y:5800},{x:1300,y:5590},{x:1950,y:5590},{x:2600,y:5590},{x:2600,y:5800}],
      entryPt:{x:1300,y:5800}, garagePos:{x:1950,y:5590}, garageAngle:0,
      exitPos:{x:2600,y:5800}, exitAngle:0, width:60
    },
    cpFracs:[0.03, 0.10, 0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.88],
    drsFracs:[[0.02, 0.10], [0.44, 0.54]],
    aiBrakeLookaheadScale:0.92,
    surface:{offTrackMult:0.88, label:'SEASIDE'}
  },

  // ── AUTHOR CHALLENGE TRACKS (kept intact) ──────────────────────────
  {
    id:5, name:'TITAN LOOP', difficulty:'MEDIUM', diffClass:'diff-med', diffLetter:'m',
    targetLap:63, laps:3, trackWidth:128, lapDistance:0, coinMult:1.5,
    // Acid-industrial: lime borders on dark olive infield
    grassColor:'#0a1500', grassColor2:'#142000',
    trackColor:'#1a1a10', borderColor:'#b3ff00', lineColor:'#ffffff',
    accentColor:'#39ff14', bgColor:'#060900',
    treeColor:'#1a4010', treeColor2:'#2a6018',
    standRoof:'#1a2210', standConcrete:'#2a3220',
    seatPalette:['#39ff14','#88aa00','#ccff44','#226622'],
    crowdColors:['#e8d4b8','#c4a882','#2a4a1a','#f0ffe0','#8b2020','#1a3a6a','#ffee88'],
    waypoints:[
      {x:700,y:5000},
      {x:1500,y:5000},
      {x:2400,y:5000},
      {x:3050,y:4950},
      {x:3380,y:4700},
      {x:3550,y:4300},
      {x:3560,y:3800},
      {x:4059,y:3120},
      {x:3280,y:2880},
      {x:2960,y:2620},
      {x:2520,y:2500},
      {x:3932,y:1471},
      {x:1924,y:1829},
      {x:1400,y:2260},
      {x:1160,y:2050},
      {x:980,y:1800},
      {x:830,y:1950},
      {x:700,y:2240},
      {x:620,y:2600},
      {x:700,y:3000},
      {x:980,y:3240},
      {x:1280,y:3380},
      {x:1240,y:3800},
      {x:1130,y:4250},
      {x:980,y:4620},
      {x:760,y:4800},
      {x:464,y:4818}
    ],
    racingLine:[
      {x:700,y:5000},
      {x:1500,y:5000},
      {x:2400,y:5000},
      {x:3050,y:4950},
      {x:3380,y:4700},
      {x:3550,y:4300},
      {x:3560,y:3800},
      {x:4082,y:3168},
      {x:3280,y:2880},
      {x:2960,y:2620},
      {x:2521,y:2537},
      {x:3918,y:1479},
      {x:1924,y:1829},
      {x:1449,y:2265},
      {x:1149,y:1986},
      {x:1002,y:1798},
      {x:785,y:2023},
      {x:700,y:2240},
      {x:620,y:2600},
      {x:700,y:3000},
      {x:980,y:3240},
      {x:1277,y:3413},
      {x:1240,y:3800},
      {x:1130,y:4250},
      {x:980,y:4620},
      {x:760,y:4800},
      {x:500,y:4799}
    ],
    startPos:{x:1300,y:5000}, startAngle:0,
    pitPos:{x:1740,y:4840},
    pitLane:{
      path:[{x:1180,y:5000},{x:1180,y:4840},{x:1740,y:4840},{x:2420,y:4840},{x:2420,y:5000}],
      entryPt:{x:1180,y:5000},
      garagePos:{x:1740,y:4840}, garageAngle:0,
      exitPos:{x:2420,y:5000}, exitAngle:0, width:56
    },
    cpFracs:[0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.96],
    drsFracs:[[0.02, 0.11], [0.55, 0.66]],
    aiBrakeLookaheadScale:0.90,
    surface:{offTrackMult:1, label:'GRASS'}
  },
  {
    id:6, name:'AMBER HIGHWAY', difficulty:'MEDIUM', diffClass:'diff-med', diffLetter:'m',
    targetLap:55, laps:3, trackWidth:136, lapDistance:0, coinMult:1.6, locked:true, unlockCost:200,
    // Desert dusk: burnt amber asphalt, warm sand runoff
    grassColor:'#1a0a00', grassColor2:'#2a1200',
    trackColor:'#252015', borderColor:'#ff8800', lineColor:'#ffffff',
    accentColor:'#ff6600', bgColor:'#0e0500',
    treeColor:'#3a2810', treeColor2:'#5a3c18',
    standRoof:'#2a1810', standConcrete:'#3a2820',
    seatPalette:['#ff6600','#cc4400','#ffaa33','#884400'],
    crowdColors:['#e8d4b8','#d4a574','#f5c6a0','#8b4510','#1a3a6a','#cc2222','#ffe0a0'],
    waypoints:[
      {x:700,y:5000},
      {x:1400,y:5000},
      {x:2100,y:5000},
      {x:2800,y:5000},
      {x:3350,y:4995},
      {x:3925,y:4928},
      {x:3900,y:4300},
      {x:3900,y:3700},
      {x:3558,y:3390},
      {x:1581,y:4034},
      {x:2899,y:2651},
      {x:2035,y:2096},
      {x:1637,y:1241},
      {x:306,y:1029},
      {x:1791,y:2685},
      {x:1715,y:2987},
      {x:900,y:3000},
      {x:616,y:2178},
      {x:-359,y:2360},
      {x:-87,y:4624},
      {x:380,y:5000}
    ],
    racingLine:[
      {x:700,y:5000},
      {x:1400,y:5000},
      {x:2100,y:5000},
      {x:2800,y:5000},
      {x:3423,y:5040},
      {x:3895,y:4903},
      {x:3900,y:4300},
      {x:3932,y:3663},
      {x:3485,y:3425},
      {x:1586,y:4039},
      {x:2903,y:2699},
      {x:2035,y:2096},
      {x:1637,y:1241},
      {x:290,y:1007},
      {x:1816,y:2683},
      {x:1538,y:3034},
      {x:900,y:3000},
      {x:616,y:2178},
      {x:-357,y:2372},
      {x:-87,y:4624},
      {x:380,y:5000}
    ],
    startPos:{x:1100,y:5000}, startAngle:0,
    pitPos:{x:1600,y:4836},
    pitLane:{
      path:[{x:550,y:5000},{x:550,y:4836},{x:1600,y:4836},{x:2800,y:4836},{x:2800,y:5000}],
      entryPt:{x:550,y:5000},
      garagePos:{x:1600,y:4836}, garageAngle:0,
      exitPos:{x:2800,y:5000}, exitAngle:0, width:56
    },
    cpFracs:[0, 0.11, 0.22, 0.34, 0.47, 0.6, 0.72, 0.84],
    drsFracs:[[0.02, 0.12], [0.5, 0.61]],
    aiBrakeLookaheadScale:0.88,
    surface:{offTrackMult:1, label:'GRASS'}
  },
  {
    id:7, name:'NEON CITY GP', difficulty:'HARD', diffClass:'diff-hard', diffLetter:'h',
    targetLap:65, laps:3, trackWidth:200, lapDistance:0, coinMult:1.8, locked:true, unlockCost:450,
    // Night metro: magenta neon on deep purple pavement
    grassColor:'#0c0016', grassColor2:'#140020',
    trackColor:'#18182a', borderColor:'#ff00cc', lineColor:'#ffffff',
    accentColor:'#dd00ff', bgColor:'#070010',
    treeColor:'#1a0830', treeColor2:'#2a1050',
    standRoof:'#1a1028', standConcrete:'#2a2038',
    seatPalette:['#ff00cc','#00ddff','#aa00ff','#ff66ee'],
    crowdColors:['#e8d4b8','#c4a882','#ff66cc','#66eeff','#2a1a4a','#ffee88','#cc2244'],
    waypoints:[
      {x:700,y:5900},
      {x:1500,y:5900},
      {x:2508,y:5909},
      {x:3131,y:5930},
      {x:3887,y:5925},
      {x:4204,y:6386},
      {x:5114,y:6432},
      {x:6330,y:6786},
      {x:6191,y:7354},
      {x:7474,y:7748},
      {x:5904,y:10494},
      {x:5719,y:11234},
      {x:4718,y:11669},
      {x:4013,y:10623},
      {x:3135,y:9469},
      {x:928,y:8645},
      {x:354,y:9797},
      {x:-1934,y:9378},
      {x:-2455,y:7631},
      {x:-739,y:7117},
      {x:-1503,y:6440}
    ],
    racingLine:[
      {x:700,y:5900},
      {x:1500,y:5900},
      {x:2508,y:5909},
      {x:3131,y:5930},
      {x:3832,y:5987},
      {x:4244,y:6336},
      {x:5114,y:6432},
      {x:6367,y:6753},
      {x:6129,y:7336},
      {x:7464,y:7663},
      {x:5904,y:10494},
      {x:5719,y:11234},
      {x:4718,y:11669},
      {x:4013,y:10623},
      {x:3135,y:9469},
      {x:928,y:8645},
      {x:354,y:9797},
      {x:-1934,y:9378},
      {x:-2455,y:7631},
      {x:-739,y:7117},
      {x:-1534,y:6477}
    ],
    startPos:{x:1100,y:5900}, startAngle:0,
    pitPos:{x:1820,y:5716},
    pitLane:{
      path:[{x:1200,y:5900},{x:1200,y:5716},{x:1820,y:5716},{x:2300,y:5716},{x:2300,y:5900}],
      entryPt:{x:1200,y:5900},
      garagePos:{x:1820,y:5716}, garageAngle:0,
      exitPos:{x:2300,y:5900}, exitAngle:0, width:56
    },
    cpFracs:[0.03, 0.09, 0.18, 0.27, 0.37, 0.47, 0.56, 0.65, 0.74, 0.83, 0.92],
    drsFracs:[[0.02, 0.08], [0.57, 0.66]],
    aiBrakeLookaheadScale:0.86,
    surface:{offTrackMult:1, label:'GRASS'}
  }
];

// Build splines, checkpoint geometry, and spatial grid.
// Easy tracks keep low minCorners so remap does not inject AI-breaking chicanes.
const TRACK_REMAP_PROFILES = {
  easy: {
    widthBoost:1.42, cornerThreshold:0.34, cornerPull:0.26, maxInsert:150, minSeg:170,
    aiBrakeLookaheadScale:0.96, aiLaneSpreadScale:1.38,
    minCorners:6, cornerCountAngle:0.45, straightThreshold:780, chicaneOffset:110, overlapGap:300
  },
  medium: {
    widthBoost:1.28, cornerThreshold:0.30, cornerPull:0.28, maxInsert:175, minSeg:145,
    aiBrakeLookaheadScale:0.90, aiLaneSpreadScale:1.28,
    minCorners:10, cornerCountAngle:0.40, straightThreshold:620, chicaneOffset:150, overlapGap:260
  },
  hard: {
    widthBoost:1.18, cornerThreshold:0.26, cornerPull:0.28, maxInsert:175, minSeg:125,
    aiBrakeLookaheadScale:0.85, aiLaneSpreadScale:1.28,
    minCorners:12, cornerCountAngle:0.36, straightThreshold:500, chicaneOffset:165, overlapGap:230
  }
};
// Per-track overrides keyed to current roster ids (0–7).
const TRACK_REMAP_OVERRIDES = {
  // AI-friendly pack — stay wide, avoid forced technical inserts
  0: { widthBoost:1.48, minCorners:5, straightThreshold:820, chicaneOffset:90, overlapGap:320, aiBrakeLookaheadScale:0.97, aiLaneSpreadScale:1.42 },
  1: { widthBoost:1.50, minCorners:4, straightThreshold:860, chicaneOffset:80, overlapGap:340, aiBrakeLookaheadScale:0.98, aiLaneSpreadScale:1.45 },
  2: { widthBoost:1.46, minCorners:5, straightThreshold:800, chicaneOffset:95, overlapGap:310, aiBrakeLookaheadScale:0.96, aiLaneSpreadScale:1.40 },
  3: { widthBoost:1.40, minCorners:7, straightThreshold:720, chicaneOffset:120, overlapGap:280, aiBrakeLookaheadScale:0.94, aiLaneSpreadScale:1.34 },
  4: { widthBoost:1.34, minCorners:9, straightThreshold:640, chicaneOffset:140, overlapGap:260, aiBrakeLookaheadScale:0.92, aiLaneSpreadScale:1.30 },
  // Author challenge tracks — keep geometry, widen slightly for driveability
  5: { widthBoost:1.32, cornerThreshold:0.28, cornerPull:0.30, maxInsert:190, minCorners:10, straightThreshold:560, chicaneOffset:160, overlapGap:250, aiBrakeLookaheadScale:0.90, aiLaneSpreadScale:1.28 },
  6: { widthBoost:1.28, cornerThreshold:0.28, cornerPull:0.28, maxInsert:180, minCorners:11, straightThreshold:540, chicaneOffset:155, overlapGap:245, aiBrakeLookaheadScale:0.88, aiLaneSpreadScale:1.26 },
  7: { widthBoost:1.20, cornerThreshold:0.26, cornerPull:0.26, maxInsert:170, minCorners:12, straightThreshold:500, chicaneOffset:150, overlapGap:230, aiBrakeLookaheadScale:0.86, aiLaneSpreadScale:1.24 }
};
const TRACK_WIDTH_SCALE = 18.0;
const TRACK_CENTERLINE_BUFFER = 88;
const TRACK_PIT_BUFFER = 24;

function getTrackGridLayout(trackWidth) {
  const safeWidth = Math.max(180, trackWidth || 0);
  const slotWidth = Math.round(Math.max(24, Math.min(36, safeWidth * 0.013)));
  const slotLength = Math.round(Math.max(46, Math.min(72, safeWidth * 0.022)));
  const laneGap = Math.round(Math.max(20, Math.min(28, safeWidth * 0.0105)));
  const rowGap = Math.round(Math.max(56, Math.min(86, slotLength + 14)));
  return {
    slotWidth,
    slotLength,
    laneGap,
    rowGap,
    labelSize: Math.max(11, Math.min(15, Math.round(slotWidth * 0.45))),
    chipWidth: Math.max(26, Math.min(40, Math.round(slotLength * 0.48))),
    chipHeight: Math.max(18, Math.min(26, Math.round(slotWidth * 0.72)))
  };
}

function getTrackRemapProfile(tr) {
  const base = TRACK_REMAP_PROFILES[(tr.difficulty || 'MEDIUM').toLowerCase()] || TRACK_REMAP_PROFILES.medium;
  return {...base, ...(TRACK_REMAP_OVERRIDES[tr.id] || {})};
}

function getWaypointTurnAngle(prev, cur, next) {
  const inX = cur.x - prev.x, inY = cur.y - prev.y;
  const outX = next.x - cur.x, outY = next.y - cur.y;
  const inLen = Math.hypot(inX, inY);
  const outLen = Math.hypot(outX, outY);
  if(inLen < 1 || outLen < 1) return 0;
  const dot = (inX / inLen) * (outX / outLen) + (inY / inLen) * (outY / outLen);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function countWaypointCorners(wps, minAngle) {
  if(!wps || wps.length < 3) return 0;
  let count = 0;
  for(let i = 0; i < wps.length; i++) {
    const prev = wps[(i - 1 + wps.length) % wps.length];
    const cur = wps[i];
    const next = wps[(i + 1) % wps.length];
    if(getWaypointTurnAngle(prev, cur, next) >= minAngle) count++;
  }
  return count;
}

function minWaypointSegmentClearance(wps) {
  if(!wps || wps.length < 4) return Infinity;
  let minClearance = Infinity;
  const n = wps.length;
  for(let i = 0; i < n; i++) {
    const ni = (i + 1) % n;
    const a = wps[i], b = wps[ni];
    for(let j = i + 1; j < n; j++) {
      const nj = (j + 1) % n;
      if(i === j || ni === j || nj === i) continue;
      const c = wps[j], d = wps[nj];
      if(linesCross(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)) return 0;
      const clearance = Math.min(
        distToSeg(a.x, a.y, c.x, c.y, d.x, d.y),
        distToSeg(b.x, b.y, c.x, c.y, d.x, d.y),
        distToSeg(c.x, c.y, a.x, a.y, b.x, b.y),
        distToSeg(d.x, d.y, a.x, a.y, b.x, b.y)
      );
      if(clearance < minClearance) minClearance = clearance;
    }
  }
  return minClearance;
}

function hasWaypointOverlapRisk(wps, minGap) {
  return minWaypointSegmentClearance(wps) < minGap;
}

function insertCornerControlPoints(wps, remap) {
  if(!wps || wps.length < 3) return wps;
  const n = wps.length;
  const out = [];
  for(let i = 0; i < n; i++) {
    const prev = wps[(i - 1 + n) % n];
    const cur = wps[i];
    const next = wps[(i + 1) % n];
    const inX = cur.x - prev.x, inY = cur.y - prev.y;
    const outX = next.x - cur.x, outY = next.y - cur.y;
    const inLen = Math.hypot(inX, inY);
    const outLen = Math.hypot(outX, outY);
    if(inLen < remap.minSeg || outLen < remap.minSeg) {
      out.push({x: cur.x, y: cur.y});
      continue;
    }
    const turnAngle = getWaypointTurnAngle(prev, cur, next);
    if(turnAngle < remap.cornerThreshold) {
      out.push({x: cur.x, y: cur.y});
      continue;
    }
    const inNX = inX / inLen, inNY = inY / inLen;
    const outNX = outX / outLen, outNY = outY / outLen;
    const preDist = Math.min(remap.maxInsert, inLen * remap.cornerPull);
    const postDist = Math.min(remap.maxInsert, outLen * remap.cornerPull);
    out.push({x: cur.x - inNX * preDist, y: cur.y - inNY * preDist});
    out.push({x: cur.x, y: cur.y});
    out.push({x: cur.x + outNX * postDist, y: cur.y + outNY * postDist});
  }
  return out;
}

function insertTechnicalChicane(wps, segIdx, remap, sign, strength) {
  const n = wps.length;
  if(!n) return null;
  const a = wps[segIdx];
  const b = wps[(segIdx + 1) % n];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if(len < remap.straightThreshold) return null;
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  const offset = Math.min(remap.chicaneOffset * strength, len * 0.22);
  const p1 = { x: a.x + dx * 0.28 + px * offset * 0.95 * sign, y: a.y + dy * 0.28 + py * offset * 0.95 * sign };
  const p2 = { x: a.x + dx * 0.52 - px * offset * 1.15 * sign, y: a.y + dy * 0.52 - py * offset * 1.15 * sign };
  const p3 = { x: a.x + dx * 0.78 + px * offset * 0.82 * sign, y: a.y + dy * 0.78 + py * offset * 0.82 * sign };
  return [...wps.slice(0, segIdx + 1), p1, p2, p3, ...wps.slice(segIdx + 1)];
}

function getStraightSegmentCandidates(wps, remap) {
  const candidates = [];
  const n = wps.length;
  for(let i = 0; i < n; i++) {
    const a = wps[i];
    const b = wps[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if(len < remap.straightThreshold) continue;
    const prev = wps[(i - 1 + n) % n];
    const next = wps[(i + 2) % n];
    const straightness = len - (getWaypointTurnAngle(prev, a, b) + getWaypointTurnAngle(a, b, next)) * 180;
    candidates.push({ idx:i, score:straightness, len });
  }
  candidates.sort((a, b) => b.score - a.score || b.len - a.len);
  return candidates;
}

function addTechnicalCorners(wps, remap) {
  let out = wps.map(p => ({x:p.x, y:p.y}));
  let cornerCount = countWaypointCorners(out, remap.cornerCountAngle);
  const maxPasses = Math.max(4, remap.minCorners);
  for(let pass = 0; pass < maxPasses && cornerCount < remap.minCorners; pass++) {
    const candidates = getStraightSegmentCandidates(out, remap);
    let improved = false;
    for(const candidate of candidates) {
      const signOrder = (pass % 2 === 0) ? [1, -1] : [-1, 1];
      for(const strength of [1.0, 0.86, 0.72]) {
        for(const sign of signOrder) {
          const trial = insertTechnicalChicane(out, candidate.idx, remap, sign, strength);
          if(!trial || hasWaypointOverlapRisk(trial, remap.overlapGap)) continue;
          const trialCorners = countWaypointCorners(trial, remap.cornerCountAngle);
          if(trialCorners <= cornerCount) continue;
          out = trial;
          cornerCount = trialCorners;
          improved = true;
          break;
        }
        if(improved) break;
      }
      if(improved) break;
    }
    if(!improved) break;
  }
  return out;
}

function remapTrackWaypointsForBraking(wps, remap) {
  if(!wps || wps.length < 3) return wps;
  const base = wps.map(p => ({x:p.x, y:p.y}));
  let bestSafe = base;
  let bestSafeCorners = countWaypointCorners(base, remap.cornerCountAngle);
  let bestSafeClearance = minWaypointSegmentClearance(base);
  const scales = [1.0, 0.92, 0.84, 0.76, 0.68];
  for(const scale of scales) {
    const tuned = {
      ...remap,
      cornerPull: remap.cornerPull * scale,
      maxInsert: remap.maxInsert * scale,
      chicaneOffset: remap.chicaneOffset * scale
    };
    let candidate = insertCornerControlPoints(base, tuned);
    candidate = addTechnicalCorners(candidate, tuned);
    const clearance = minWaypointSegmentClearance(candidate);
    if(clearance < remap.overlapGap) continue;
    const cornerCount = countWaypointCorners(candidate, remap.cornerCountAngle);
    if(cornerCount > bestSafeCorners || (cornerCount === bestSafeCorners && clearance > bestSafeClearance)) {
      bestSafe = candidate;
      bestSafeCorners = cornerCount;
      bestSafeClearance = clearance;
    }
    if(cornerCount >= remap.minCorners) return candidate;
  }
  return bestSafe;
}

function densifyPolyline(path, spacing) {
  if(!path || path.length < 2) return path || [];
  const step = Math.max(12, spacing || 24);
  const out = [{ x: path[0].x, y: path[0].y }];
  for(let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for(let s = 1; s <= n; s++) {
      const t = s / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Bake authored racingLine polyline → per-spline lateral offsets (signed, track-normal).
 *  Racing-line nodes are Catmull-Rom control points (same as track waypoints), so corners curve smoothly. */
function bakeRacingLineOffsets(tr) {
  const line = tr.racingLine;
  const spl = tr.spline;
  if(!line || line.length < 3 || !spl || spl.length < 2) {
    tr.racingLineOffset = null;
    return;
  }
  // Smooth closed curve through authored nodes (not straight chords between them).
  const dense = buildSpline(line, 28);
  const maxOff = Math.max(20, (tr.trackWidth || 120) * 0.42);
  const offsets = new Array(spl.length);
  for(let i = 0; i < spl.length; i++) {
    const p = spl[i];
    let bestD = Infinity, bestX = p.x, bestY = p.y;
    for(let j = 0; j < dense.length; j++) {
      const q = dense[j];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if(d < bestD) { bestD = d; bestX = q.x; bestY = q.y; }
    }
    // Also check segments for slightly better nearest-point accuracy
    for(let j = 0; j < dense.length; j++) {
      const a = dense[j], b = dense[(j + 1) % dense.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if(lenSq > 0) t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
      const qx = a.x + dx * t, qy = a.y + dy * t;
      const d = Math.hypot(p.x - qx, p.y - qy);
      if(d < bestD) { bestD = d; bestX = qx; bestY = qy; }
    }
    const tang = splineTangent(spl, i);
    const nx = -tang.y, ny = tang.x;
    let lat = (bestX - p.x) * nx + (bestY - p.y) * ny;
    if(lat > maxOff) lat = maxOff;
    else if(lat < -maxOff) lat = -maxOff;
    offsets[i] = lat;
  }
  tr.racingLineOffset = offsets;
}

/** Normalize authored brake tags: 0 = none … 5 = maximum. */
function normalizeBrakeTag(v) {
  const n = Number(v);
  if(!isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

/**
 * Bake waypoint `brake` tags onto the dense spline.
 * Tags are placed on authored (pre-remap) points, then stretched into approach + hold zones.
 */
function bakeBrakePlan(tr) {
  const spl = tr.spline;
  const cum = tr.cum;
  const n = spl && spl.length;
  const plan = new Float32Array(n || 0);
  const authored = tr.authoredBrakePoints;
  if(!n || !cum || !authored || !authored.length) {
    tr.brakePlan = plan;
    tr.hasBrakePlan = false;
    return;
  }
  const totalLen = tr.totalLen || cum[n - 1] || 1;
  // Longer approach / hold for harder tags (world units along the centreline).
  const approachByTag = { 1: 160, 2: 220, 3: 300, 4: 400, 5: 520 };
  const holdByTag = { 1: 100, 2: 140, 3: 180, 4: 240, 5: 300 };

  function nearestSplineIdx(x, y) {
    let bestI = 0, bestD = Infinity;
    for(let i = 0; i < n; i++) {
      const d = Math.hypot(spl[i].x - x, spl[i].y - y);
      if(d < bestD) { bestD = d; bestI = i; }
    }
    return bestI;
  }

  function arcDist(fromIdx, toIdx) {
    let d = cum[toIdx] - cum[fromIdx];
    if(d < 0) d += totalLen;
    return d;
  }

  let any = false;
  for(let t = 0; t < authored.length; t++) {
    const tag = normalizeBrakeTag(authored[t].brake);
    if(tag <= 0) continue;
    any = true;
    const center = nearestSplineIdx(authored[t].x, authored[t].y);
    const approach = approachByTag[tag] || 240;
    const hold = holdByTag[tag] || 160;
    for(let i = 0; i < n; i++) {
      const ahead = arcDist(center, i);
      const behind = arcDist(i, center);
      let intensity = 0;
      if(behind <= approach && behind <= totalLen * 0.45) {
        // Ramp up into the brake point (1 at the point, softer far away).
        intensity = tag * (0.55 + 0.45 * (1 - behind / Math.max(1, approach)));
      } else if(ahead <= hold && ahead <= totalLen * 0.45) {
        // Short hold through the apex / exit.
        intensity = tag * (0.70 + 0.30 * (1 - ahead / Math.max(1, hold)));
      }
      if(intensity > plan[i]) plan[i] = intensity;
    }
  }
  tr.brakePlan = plan;
  tr.hasBrakePlan = any;
}


function cloneAuthoredPoint(p) {
  const o = { x: p.x, y: p.y };
  const b = normalizeBrakeTag(p.brake);
  if (b > 0) o.brake = b;
  else if (p.brake != null) o.brake = 0;
  return o;
}

function invalidateTrackBaseCache() {
  if (typeof clearTrackBaseCache === 'function') clearTrackBaseCache();
  else if (typeof _trackBaseCache !== 'undefined') _trackBaseCache = null;
}

/** Bake / re-bake a track from authored (pre-remap) data. Safe to call again after editor Apply. */
function finalizeTrack(tr) {
  if (!tr.authoredWaypoints) {
    tr.authoredWaypoints = (tr.waypoints || []).map(cloneAuthoredPoint);
  }
  if (tr.authoredRacingLine === undefined) {
    tr.authoredRacingLine = Array.isArray(tr.racingLine) && tr.racingLine.length
      ? tr.racingLine.map(p => ({ x: p.x, y: p.y }))
      : null;
  }
  if (tr.authoredBaseWidth == null) {
    tr.authoredBaseWidth = tr.trackWidth;
  }

  // Restore authored geometry before remap/densify so re-bake is idempotent.
  tr.waypoints = tr.authoredWaypoints.map(cloneAuthoredPoint);
  tr.trackWidth = tr.authoredBaseWidth;
  if (tr.authoredRacingLine && tr.authoredRacingLine.length >= 3) {
    tr.racingLine = tr.authoredRacingLine.map(p => ({ x: p.x, y: p.y }));
  } else {
    tr.racingLine = null;
  }
  if (tr.pitLane) {
    const raw = tr.pitLane.rawPath || tr.pitLane.path;
    if (raw && raw.length) {
      tr.pitLane.path = raw.map(p => ({ x: p.x, y: p.y }));
    }
  }

  // Capture brake tags before remap (remap rebuilds {x,y} only).
  tr.authoredBrakePoints = (tr.waypoints || []).map(p => ({
    x: p.x, y: p.y, brake: normalizeBrakeTag(p.brake)
  }));
  const remap = getTrackRemapProfile(tr);
  tr.trackWidth = Math.round(tr.trackWidth * remap.widthBoost);
  tr.aiBrakeLookaheadScale = Math.min(tr.aiBrakeLookaheadScale || 1, remap.aiBrakeLookaheadScale);
  tr.aiLaneSpreadScale = remap.aiLaneSpreadScale;
  tr.waypoints = remapTrackWaypointsForBraking(tr.waypoints, remap);
  tr.cornerCount = countWaypointCorners(tr.waypoints, remap.cornerCountAngle);
  tr.centerlineClearance = minWaypointSegmentClearance(tr.waypoints);
  tr.spline = buildSpline(tr.waypoints, 28);
  // Densify pit lane so AI/player routing follows the painted road, not sparse corner-cutting chords.
  if(tr.pitLane && tr.pitLane.path && tr.pitLane.path.length >= 2) {
    tr.pitLane.rawPath = tr.pitLane.path.map(p => ({ x: p.x, y: p.y }));
    tr.pitLane.path = densifyPolyline(tr.pitLane.path, 22);
  }

  const spl = tr.spline, n = spl.length;
  // cumulative distances
  const cum = [0];
  for(let i=1;i<n;i++) cum.push(cum[i-1]+Math.hypot(spl[i].x-spl[i-1].x,spl[i].y-spl[i-1].y));
  tr.totalLen = cum[n-1];
  tr.cum = cum;
  tr.lapDistance = Math.round(tr.totalLen);

  // Widen each track aggressively, but clamp width based on local geometry
  // so nearby sections and pit lane corridors do not overlap.
  const baseWidth = tr.trackWidth;
  const targetWidth = baseWidth * TRACK_WIDTH_SCALE;
  let maxSafeWidth = Infinity;

  let minCenterDist = Infinity;
  for(let i = 0; i < n; i += 6) {
    for(let j = i + 12; j < n; j += 6) {
      const arcA = Math.abs(cum[j] - cum[i]);
      const arcDist = Math.min(arcA, tr.totalLen - arcA);
      if(arcDist < 420) continue;
      const d = Math.hypot(spl[j].x - spl[i].x, spl[j].y - spl[i].y);
      if(d < minCenterDist) minCenterDist = d;
    }
  }
  if(isFinite(minCenterDist)) {
    // Keep a separation buffer between nearby centerlines.
    maxSafeWidth = Math.min(maxSafeWidth, Math.max(baseWidth, minCenterDist - TRACK_CENTERLINE_BUFFER));
  }

  if(tr.pitLane && tr.pitLane.path && tr.pitLane.path.length >= 2) {
    const pitPath = tr.pitLane.path;
    const pitHalf = (tr.pitLane.width || 60) * 0.5;
    let minPitDist = Infinity;
    for(let i = 0; i < n; i += 5) {
      const px = spl[i].x, py = spl[i].y;
      for(let p = 0; p < pitPath.length - 1; p++) {
        const d = distToSeg(px, py, pitPath[p].x, pitPath[p].y, pitPath[p+1].x, pitPath[p+1].y);
        if(d < minPitDist) minPitDist = d;
      }
    }
    if(isFinite(minPitDist)) {
      // Keep a small margin between main track edge and pit lane edge.
      const pitSafeWidth = (minPitDist - pitHalf - TRACK_PIT_BUFFER) * 2;
      maxSafeWidth = Math.min(maxSafeWidth, Math.max(baseWidth, pitSafeWidth));
    }
  }

  tr.trackWidth = Math.max(baseWidth, Math.min(targetWidth, maxSafeWidth));

  // Optional authored racing line → per-spline lateral offsets for AI (after final width).
  bakeRacingLineOffsets(tr);
  // Optional waypoint brake tags → stretched brake plan for AI speed targets.
  bakeBrakePlan(tr);

  // Spatial grid for fast on-track checks
  const cellSize = 200;
  tr.gridCell = cellSize;
  tr.grid = {};
  for(let i = 0; i < n; i++) {
    const cx = Math.floor(spl[i].x / cellSize);
    const cy = Math.floor(spl[i].y / cellSize);
    const key = cx + ',' + cy;
    if(!tr.grid[key]) tr.grid[key] = [];
    tr.grid[key].push(i);
  }
  // checkpoint lines (perpendicular to spline)
  // Optional sfGateHalfWidth overrides half-length of S/F (index 0) only.
  const sfHwAuthored = (tr.sfGateHalfWidth != null && isFinite(tr.sfGateHalfWidth) && tr.sfGateHalfWidth > 0)
    ? tr.sfGateHalfWidth : null;
  tr.cpLines = tr.cpFracs.map((frac, cpIdx) => {
    const target = frac * tr.totalLen;
    let idx = cum.findIndex(d => d >= target);
    if(idx < 0) idx = 0;
    const tang = splineTangent(spl, idx);
    const perp = {x: -tang.y, y: tang.x};
    const hw = (cpIdx === 0 && sfHwAuthored != null) ? sfHwAuthored : (tr.trackWidth * 0.7);
    const cx = spl[idx].x, cy = spl[idx].y;
    return {
      idx,
      cx, cy,
      x1: cx + perp.x*hw, y1: cy + perp.y*hw,
      x2: cx - perp.x*hw, y2: cy - perp.y*hw
    };
  });
  // Build a dedicated pit-lane start/finish gate so laps can count while in pit lane.
  tr.pitSfGate = null;
  if(tr.pitLane && tr.pitLane.path && tr.pitLane.path.length >= 2 && tr.cpLines.length) {
    const sf = tr.cpLines[0];
    const p = tr.pitLane.path;
    let best = null;
    for(let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx*dx + dy*dy;
      if(lenSq <= 0) continue;
      const t = Math.max(0, Math.min(1, ((sf.cx - a.x) * dx + (sf.cy - a.y) * dy) / lenSq));
      const qx = a.x + dx * t, qy = a.y + dy * t;
      const d = Math.hypot(qx - sf.cx, qy - sf.cy);
      if(!best || d < best.d) best = { i, d, qx, qy };
    }
    if(best) {
      const a = p[best.i], b = p[best.i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const tx = dx / len, ty = dy / len;
      const perp = { x: -ty, y: tx };
      const hw = sfHwAuthored != null ? sfHwAuthored : ((tr.pitLane.width || 60) * 0.78);
      tr.pitSfGate = {
        x1: best.qx + perp.x * hw, y1: best.qy + perp.y * hw,
        x2: best.qx - perp.x * hw, y2: best.qy - perp.y * hw
      };
    }
  }
  // DRS zone entry gates (perpendicular lines at start of each DRS zone)
  tr.drsZones = (tr.drsFracs || []).map(([sf, ef]) => {
    const sTarget = sf * tr.totalLen;
    let sIdx = cum.findIndex(d => d >= sTarget); if(sIdx < 0) sIdx = 0;
    const eTarget = ef * tr.totalLen;
    let eIdx = cum.findIndex(d => d >= eTarget); if(eIdx < 0) eIdx = n - 1;
    const tang = splineTangent(spl, sIdx);
    const perp = {x: -tang.y, y: tang.x};
    const hw = tr.trackWidth * 0.72;
    const cx = spl[sIdx].x, cy = spl[sIdx].y;
    return {
      sIdx, eIdx,
      cx, cy,
      x1: cx + perp.x * hw, y1: cy + perp.y * hw,
      x2: cx - perp.x * hw, y2: cy - perp.y * hw
    };
  });

  // Default race grid slots for all tracks (used by players and AI at race start).
  const gridCount = 14;
  const gridAng = tr.startAngle !== undefined ? tr.startAngle : 0;
  const gridBackX = -Math.cos(gridAng), gridBackY = -Math.sin(gridAng);
  const gridPerpX = -Math.sin(gridAng), gridPerpY = Math.cos(gridAng);
  tr.gridLayout = getTrackGridLayout(tr.trackWidth);
  const gridRowGap = tr.gridLayout.rowGap;
  const gridLaneGap = tr.gridLayout.laneGap;
  tr.gridSlots = [];
  for(let i = 0; i < gridCount; i++) {
    const row = Math.floor(i / 2);
    const lane = (i % 2 === 0) ? -1 : 1;
    tr.gridSlots.push({
      x: tr.startPos.x + gridBackX * gridRowGap * row + gridPerpX * gridLaneGap * lane,
      y: tr.startPos.y + gridBackY * gridRowGap * row + gridPerpY * gridLaneGap * lane,
      a: gridAng
    });
  }

  // ── SCENERY GENERATION ─────────────────────────────────
  // Deterministic seeded RNG per track so scenery is stable frame-to-frame
  let _seed = tr.id * 7919 + 1234;
  function srng() {
    _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
    return ((_seed >>> 0) / 4294967295);
  }

  // -- Grandstands: spaced banks with no overlaps, variety in size/side
  const stands = [];
  const adboards = [];
  const standFracs = [];
  // Main straight — alternating sides so stands don't collide across the track
  for(let fi = 0.02; fi <= 0.18; fi += 0.028) standFracs.push({fi, side: (standFracs.length % 2 === 0 ? 'outer' : 'inner'), scale:1.05 + (standFracs.length % 3) * 0.08});
  // Start/finish outer bank only (clear of pit lane)
  for(let fi = 0.93; fi <= 0.985; fi += 0.028) standFracs.push({fi, side:'outer', scale:1.0});
  // Back-straight / mid-lap outer bank
  for(let fi = 0.46; fi <= 0.54; fi += 0.032) standFracs.push({fi, side:'outer', scale:0.95});
  // Technical complex — sparse inner/outer mix
  for(let fi = 0.70; fi <= 0.76; fi += 0.030) standFracs.push({fi, side: (fi < 0.73 ? 'inner' : 'outer'), scale:0.82});

  const placedStands = [];
  const standsOverlap = (a, b) => {
    const minSep = (a.width + b.width) * 0.55 + 40;
    return Math.hypot(a.x - b.x, a.y - b.y) < minSep;
  };

  standFracs.forEach(({fi, side, scale}) => {
    const target = fi * tr.totalLen;
    let idx = cum.findIndex(d => d >= target); if(idx < 0) idx = 0;
    const tang = splineTangent(spl, idx);
    const perp = {x: -tang.y, y: tang.x};
    const cx = spl[idx].x, cy = spl[idx].y;
    // Push stands further off the racing surface for cleaner sight lines
    const standOff = tr.trackWidth / 2 + 175 + srng() * 36;
    const standW = (150 + srng() * 90) * (scale || 1);
    const rows = 3 + Math.round(srng() * 2);
    const candidates = [];
    if(side === 'both' || side === 'outer') {
      candidates.push({x: cx + perp.x*standOff, y: cy + perp.y*standOff, angle: Math.atan2(tang.y, tang.x) + Math.PI/2, width: standW, rows, perpSign: 1, isObstacle: true});
    }
    if(side === 'both' || side === 'inner') {
      candidates.push({x: cx - perp.x*standOff, y: cy - perp.y*standOff, angle: Math.atan2(tang.y, tang.x) - Math.PI/2, width: standW, rows, perpSign: -1, isObstacle: true});
    }
    candidates.forEach(st => {
      if(placedStands.some(prev => standsOverlap(prev, st))) return;
      // Keep clear of pit lane corridor
      if(tr.pitLane && tr.pitLane.path) {
        let nearPit = false;
        for(let pi = 0; pi < tr.pitLane.path.length; pi++) {
          const pp = tr.pitLane.path[pi];
          if(Math.hypot(st.x - pp.x, st.y - pp.y) < (tr.pitLane.width || 60) + st.width * 0.45 + 50) {
            nearPit = true; break;
          }
        }
        if(nearPit) return;
      }
      placedStands.push(st);
      stands.push(st);
    });
  });

  // -- Advertising boards: place on the inside/outside of sharp corners
  for(let i = 4; i < n; i += 7) {
    const prev2 = spl[(i-4+n)%n], next2 = spl[(i+4)%n];
    const tx = next2.x - prev2.x, ty = next2.y - prev2.y;
    const tlen = Math.hypot(tx,ty)||1;
    const tnx = tx/tlen, tny = ty/tlen;
    const px0 = spl[(i-2+n)%n];
    const tx0 = spl[i].x - px0.x, ty0 = spl[i].y - px0.y;
    const tl0 = Math.hypot(tx0,ty0)||1;
    const curvEst = tnx*(ty0/tl0) - tny*(tx0/tl0);
    if(Math.abs(curvEst) > 0.03) {
      const sign = Math.sign(curvEst);
      const nx = -tny, ny = tnx;
      const offDist = tr.trackWidth * 0.5 + 28;
      adboards.push({
        x: spl[i].x + nx*offDist*sign,
        y: spl[i].y + ny*offDist*sign,
        angle: Math.atan2(ty, tx),
        side: sign
      });
    }
  }

  // -- Trees: scatter in grass, avoiding track proximity
  const trees = [];
  // Get rough bounding box from waypoints
  const wxs = tr.waypoints.map(w=>w.x), wys = tr.waypoints.map(w=>w.y);
  const minX = Math.min(...wxs) - 200, maxX = Math.max(...wxs) + 200;
  const minY = Math.min(...wys) - 200, maxY = Math.max(...wys) + 200;
  const attempts = 160;
  for(let a = 0; a < attempts; a++) {
    const tx = minX + srng()*(maxX-minX);
    const ty = minY + srng()*(maxY-minY);
    // Check distance from all spline points (only add if far from track)
    let minDist = Infinity;
    const step = Math.max(1, Math.floor(n/80));
    for(let si = 0; si < n; si += step) {
      const d = Math.hypot(tx-spl[si].x, ty-spl[si].y);
      if(d < minDist) minDist = d;
    }
    if(minDist > tr.trackWidth/2 + 55) {
      trees.push({x:tx, y:ty, r: 14 + srng()*18, shade: srng()});
    }
  }

  tr.scenery = { stands, trees, adboards };

}

TRACKS.forEach(tr => finalizeTrack(tr));
