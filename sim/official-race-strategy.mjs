/** Mirror makeRaceAIInput's existing pit wrapper during native learning/checks. */
export function withNativePitStrategy(kart,track,difficulty,mode,input,aiIndex=0){
  let lastPitLap=0;
  return dt=>{
    if(mode==='ai'&&!['qualifying','quali-turn'].includes(race?.phase)){
      const strategy=getAiPitStrategyId(aiIndex,difficulty,kart.totalLaps||3);kart.aiPitPlan=strategy;
      const call=getPitCallStatus(kart,kart.totalLaps||3,strategy,window._raceWeather||'dry'),entry=track.pitLane?.entryPt;
      if(call&&call.level!=='window'&&kart.lap>lastPitLap&&entry&&Math.hypot(kart.x-entry.x,kart.y-entry.y)<1100&&!kart.inPit&&kart.pitPhase===null&&!kart._pitExiting&&(kart._pitCooldown||0)<=0){
        kart._pitIntentActive=true;kart._pitEntryConfirmed=false;lastPitLap=kart.lap;
      }
    }
    return input(dt);
  };
}
