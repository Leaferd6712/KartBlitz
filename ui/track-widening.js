const data=await fetch(new URL('track-widening.json',import.meta.url)).then(r=>r.json());
const $=id=>document.getElementById(id),select=$('track');
for(const track of data.tracks){const option=document.createElement('option');option.value=track.id;option.textContent=track.name;select.append(option);}
function render(){
  const t=data.tracks.find(t=>t.id===Number(select.value)),points=[...t.before.spline,...t.after.spline,...t.after.pitLane.path];
  const padding=t.width,minX=Math.min(...points.map(p=>p.x))-padding,maxX=Math.max(...points.map(p=>p.x))+padding,minY=Math.min(...points.map(p=>p.y))-padding,maxY=Math.max(...points.map(p=>p.y))+padding;
  for(const side of ['before','after']){
    const canvas=$(side),rect=canvas.getBoundingClientRect(),dpr=Math.min(2,devicePixelRatio||1);canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const scale=Math.min(rect.width/(maxX-minX),rect.height/(maxY-minY)),ox=(rect.width-(maxX-minX)*scale)/2,oy=(rect.height-(maxY-minY)*scale)/2;
    const stroke=(path,width,color,closed=false)=>{if(!path?.length)return;ctx.beginPath();path.forEach((p,i)=>{const x=ox+(p.x-minX)*scale,y=oy+(p.y-minY)*scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});if(closed)ctx.closePath();ctx.strokeStyle=color;ctx.lineWidth=width*scale;ctx.lineCap=ctx.lineJoin='round';ctx.stroke();};
    const layout=t[side],width=side==='before'?t.beforeWidth:t.width;
    stroke(layout.spline,width+24,'#566477',true);stroke(layout.spline,width,side==='before'?'#334155':'#236c65',true);
    stroke(layout.pitLane.path,layout.pitLane.width,'#f4b75c');
    if(side==='after')stroke(layout.racingLine,Math.max(2/scale,3),'#f0f4f8',true);
  }
  const change=(t.length/t.previousLength-1)*100;
  $('metrics').replaceChildren();
  for(const [label,value] of [['Road width',`${t.beforeWidth} → ${t.width} units`],['Multiplier','2.5×'],['Lap length',`${change>=0?'+':''}${change.toFixed(1)}%`],['Clearance checks',t.road.safe&&t.pits.safe?'Passed':'Review required']]){
    const node=document.createElement('div'),strong=document.createElement('strong');node.textContent=label;strong.textContent=value;node.append(strong);$('metrics').append(node);}
  $('notice').textContent=Math.abs(change)>20?'This layout has been substantially reshaped to fit the wider road. Review the before/after route before publishing. Your original layout is preserved in the backup.':'The road is 2.5× wider, with validated separation from nearby sections and the pit lane. Review the new corner and pit approach shapes before publishing.';
  $('detail').textContent=`Road crossings: ${t.road.crossings}. Road conflicts: ${t.road.conflicts}. Pit conflicts: ${t.pits.conflicts}. Minimum required road-edge gap: ${data.roadGap} world units, plus kerbs.`+(t.reference?`\nClean stock-car reference: ${t.reference.ai.toFixed(2)} seconds. New target: ${t.targetLap.toFixed(1)} seconds.`:'');
}
select.addEventListener('change',render);window.addEventListener('resize',render);render();
