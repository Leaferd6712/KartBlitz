/** A package contains two independent actors; control semantics remain V2. */
import * as v2 from './official-policy-v2.mjs';
export * from './official-policy-v2.mjs';
export const modeKey=mode=>mode==='shootout'?'shootout':mode==='ai'?'race':null;
export function specialistPackage(pack,difficulty,mode){
  const key=modeKey(mode);if(!key)throw Error('V3 supports AI Race and One Lap Shootout only');
  const variant=pack.variants?.[difficulty],specialist=variant?.policies?.[key];
  if(!specialist?.policy)throw Error('Missing '+key+' specialist');
  return {...pack,format:'kartblitz-official-track-v2',modelGeneration:2,variants:{[difficulty]:{...specialist,id:specialist.id||variant.id}}};
}
export function validatePackage(pack){
  if(pack?.format!=='kartblitz-official-track-v3'||pack.modelGeneration!==3||!pack.variants||!Object.keys(pack.variants).length)throw Error('Invalid V3 specialist package');
  for(const difficulty of Object.keys(pack.variants))for(const mode of ['shootout','ai'])v2.validatePackage(specialistPackage(pack,difficulty,mode));
  return true;
}
export function makeController(track,pack,difficulty,context={}){
  validatePackage(pack);return v2.makeController(track,specialistPackage(pack,difficulty,context.mode),difficulty,context);
}
