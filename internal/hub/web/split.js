'use strict';
// Keep resizing independent of report rendering, PDF loading, and scroll positions.
(()=>{
 const workspace=document.querySelector('.workspace'),divider=document.querySelector('#workspace-divider');
 const desktop=matchMedia('(min-width:851px)'),defaultRatio=.54,cookieName='avhub_workspace_split';
 let ratio=defaultRatio,drag=null;
 // This non-sensitive preference survives the loopback server's changing port.
 // Authentication remains in the separate HttpOnly session cookie.
 try{const saved=Number(document.cookie.split('; ').find(s=>s.startsWith(cookieName+'='))?.split('=')[1]);if(Number.isFinite(saved)&&saved>0&&saved<1)ratio=saved}catch(e){}
 const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
 function bounds(){
  if(!desktop.matches||workspace.hidden)return null;
  const rect=workspace.getBoundingClientRect(),available=rect.width-divider.offsetWidth;
  return available>600?{left:rect.left,available,min:280,max:available-320}:null;
 }
 function apply(){
  const b=bounds();if(!b)return;
  const width=clamp(b.available*ratio,b.min,b.max),percent=Math.round(width/b.available*100);
  workspace.style.setProperty('--workspace-list-width',width+'px');
  divider.setAttribute('aria-valuemin',Math.floor(b.min/b.available*100));
  divider.setAttribute('aria-valuemax',Math.ceil(b.max/b.available*100));
  divider.setAttribute('aria-valuenow',percent);
  divider.setAttribute('aria-valuetext',`목록 ${percent}%, 본문 ${100-percent}%`);
 }
 function save(){try{document.cookie=`${cookieName}=${ratio.toFixed(5)}; Path=/; Max-Age=31536000; SameSite=Strict`}catch(e){}}
 function setWidth(width,b){ratio=clamp(width,b.min,b.max)/b.available;apply()}
 function finish(commit){
  if(!drag)return;
  const previous=drag;drag=null;
  document.body.classList.remove('workspace-resizing');
  if(divider.hasPointerCapture(previous.pointerId))divider.releasePointerCapture(previous.pointerId);
  if(commit)save();else{ratio=previous.ratio;apply()}
 }
 divider.addEventListener('pointerdown',e=>{
  if(e.button!==0||drag||!bounds())return;
  e.preventDefault();divider.focus({preventScroll:true});
  drag={pointerId:e.pointerId,offset:e.clientX-divider.getBoundingClientRect().left,ratio};
  divider.setPointerCapture(e.pointerId);document.body.classList.add('workspace-resizing');
 });
 divider.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.pointerId)return;
  const b=bounds();if(b)setWidth(e.clientX-b.left-drag.offset,b);else finish(false);
 });
 divider.addEventListener('pointerup',e=>{if(e.pointerId===drag?.pointerId)finish(true)});
 divider.addEventListener('pointercancel',()=>finish(false));
 divider.addEventListener('lostpointercapture',()=>finish(true));
 window.addEventListener('blur',()=>finish(true));
 divider.addEventListener('dblclick',()=>{if(bounds()){ratio=defaultRatio;apply();save()}});
 divider.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&drag){e.preventDefault();finish(false);return}
  const b=bounds();if(!b||drag)return;
  const width=clamp(b.available*ratio,b.min,b.max),step=e.shiftKey?60:20;
  if(e.key==='ArrowLeft')setWidth(width-step,b);
  else if(e.key==='ArrowRight')setWidth(width+step,b);
  else if(e.key==='Home')setWidth(b.min,b);
  else if(e.key==='End')setWidth(b.max,b);
  else if(e.key==='Enter'){ratio=defaultRatio;apply()}
  else return;
  e.preventDefault();save();
 });
 desktop.addEventListener('change',()=>{finish(false);apply()});
 new ResizeObserver(apply).observe(workspace);
 apply();
})();
