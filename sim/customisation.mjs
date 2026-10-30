// Shared defaults, ownership migration and first-purchase transaction.
export const DEFAULT_COLOUR = 'white';
export const PAINT_COLORS = [
  {id:'white',label:'WHITE',body:'#FFFFFF',shadow:'#FFFFFF',cost:0},
  ...[['cyan','CYAN','#00ccff','#005f8f'],['orange','ORANGE','#ff6b35','#8f2f00'],['lime','LIME','#39ff14','#1a7000'],['pink','PINK','#ff00cc','#880066'],['gold','GOLD','#ffd700','#806800'],['red','RED','#ff2222','#880000'],['purple','PURPLE','#aa44ff','#550088'],['black','BLACK','#1a1a22','#050508'],['navy','NAVY','#1e3a8a','#0b1638']].map(([id,label,body,shadow])=>({id,label,body,shadow,cost:100}))
];
export const PAINT_PARTS = ['chassis','frontWing','rearWing','nose','accents'].map(id=>({id,label:({frontWing:'FRONT WING',rearWing:'REAR WING'})[id]||id.toUpperCase()}));
export function colourId(id) { return id==='stock' ? DEFAULT_COLOUR : PAINT_COLORS.some(c=>c.id===id) ? id : DEFAULT_COLOUR; }
export function defaultLivery(primary=DEFAULT_COLOUR,accent=DEFAULT_COLOUR) {return {chassis:colourId(primary),frontWing:DEFAULT_COLOUR,rearWing:colourId(primary),nose:colourId(primary),accents:colourId(accent)};}
export function normalizeLivery(raw,fallback=DEFAULT_COLOUR) {const base=defaultLivery(fallback);return Object.fromEntries(PAINT_PARTS.map(({id})=>[id,colourId(raw?.[id]??base[id])]));}
export function ownedColours(data={}) {
  const owned=new Set([DEFAULT_COLOUR]);
  if(Array.isArray(data.ownedPaints)) data.ownedPaints.forEach(id=>owned.add(colourId(id)));
  else { // Legacy saves had freely equipped paints; keep their existing customisation.
    for(const player of ['p1','p2']) {
      if(data[player+'paint'])owned.add(colourId(data[player+'paint']));
      for(const id of Object.values(data[player+'livery']||{}))owned.add(colourId(id));
    }
  }
  return [...owned];
}
export function equipColour(data,player,part,id,{purchase=false}={}) {
  if(!['p1','p2'].includes(player)||!PAINT_PARTS.some(p=>p.id===part)||!PAINT_COLORS.some(c=>c.id===id))return null;
  const owned=ownedColours(data), colour=PAINT_COLORS.find(c=>c.id===id);
  let coins=Number(data.coins)||0;
  if(!owned.includes(id)) {if(!purchase||coins<colour.cost)return null;coins-=colour.cost;owned.push(id);}
  const livery=normalizeLivery(data[player+'livery'],data[player+'paint']);livery[part]=id;
  return {...data,coins,ownedPaints:owned,[player+'livery']:livery,[player+'paint']:livery.chassis};
}
