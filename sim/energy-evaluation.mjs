/** Shared deterministic native acceptance cases and promotion rules. */
export function isolationCases(){return [{mode:'shootout',raceLaps:1,energy:1,scenario:'solo',seed:81271},{mode:'ai',raceLaps:3,energy:.5,scenario:'solo',seed:81271}];}
export function evaluationCases(smoke=false){
  if(smoke)return [{mode:'shootout',raceLaps:1,energy:1,scenario:'solo',seed:81271},{mode:'ai',raceLaps:3,energy:.5,scenario:'passing',seed:81272}];
  const cases=[];for(const seed of [81271,91517]){
    for(const energy of [.25,.5,1])cases.push({mode:'shootout',raceLaps:1,energy,scenario:'solo',seed});
    [1,2,3,5,8,10].forEach((raceLaps,i)=>cases.push({mode:'ai',raceLaps,energy:[.25,.5,1][i%3],scenario:'solo',seed}));
    for(const scenario of ['passing','defending','recovery','mixed'])cases.push({mode:'ai',raceLaps:3,energy:.5,scenario,seed});
  }return cases;
}
export function acceptance(rows,hasV1){
  const candidate=rows.filter(r=>r.arm==='V2'),reasons=[];
  if(!hasV1)reasons.push('A matched V1 baseline is required for promotion');
  if(!candidate.length||candidate.some(r=>!r.finished||!r.valid||r.offTrackRate>=.01))reasons.push('V2 must complete every held-out race/lap cleanly');
  if(candidate.some(r=>r.defensiveReversalFlags))reasons.push('Defensive lane-deviation flags require review; they are not proof of a second blocking move');
  const peers=(arm,mode)=>rows.filter(r=>r.arm===arm&&r.mode===mode);
  const sum=(a,key)=>a.reduce((n,r)=>n+(r[key]??Infinity),0);
  const styleTie=(a,b)=>a.length===b.length&&a.length>0&&a.every((r,i)=>Math.abs(r.raceTime-b[i].raceTime)<=.05)&&sum(a,'styleScore')>sum(b,'styleScore')+1e-6;
  for(const arm of ['Legacy',...(hasV1?['V1']:[]),...(rows.some(r=>r.arm==='Research seed')?['Research seed']:[]),...(rows.some(r=>r.arm==='Unguided')?['Unguided']:[])])for(const mode of ['ai','shootout']){
    const a=peers('V2',mode),b=peers(arm,mode);
    if(!b.length||b.length!==a.length){reasons.push(`Missing matched ${arm} ${mode} cases`);continue;}
    const finishedBaseline=b.every(r=>r.finished&&r.valid);
    if(finishedBaseline&&sum(a,'raceTime')>sum(b,'raceTime')+1e-6&&!styleTie(a,b))reasons.push(`V2 is slower than ${arm} in ${mode}`);
    if(mode==='ai'&&finishedBaseline&&sum(a,'racePosition')>sum(b,'racePosition'))reasons.push(`V2 finishes behind ${arm}`);
    if(sum(a,'contacts')>sum(b,'contacts'))reasons.push(`V2 has more contact than ${arm} in ${mode}`);
    if(a.some(r=>r.scenario==='recovery'&&(r.recoveryTime===null||r.recoveryTime>10)))reasons.push('Recovery exceeded 10 seconds');
  }
  if(hasV1){
    const improved=['ai','shootout'].some(mode=>{
      const a=peers('V2',mode),b=peers('V1',mode);
      return a.length===b.length&&a.length>0&&(b.some(r=>!r.finished||!r.valid)||sum(a,'raceTime')<sum(b,'raceTime')-.05||
        sum(a,'contacts')<sum(b,'contacts')||(mode==='ai'&&sum(a,'racePosition')<sum(b,'racePosition'))||styleTie(a,b));
    });
    if(!improved)reasons.push('No measured pace, position, reliability or contact improvement over V1');
  }
  return {approved:reasons.length===0,reasons};
}
