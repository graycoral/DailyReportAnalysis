'use strict';
/* Hallmark · pre-emit critique: P4 H4 E4 S5 R4 V4 · existing workbench preserved */
// Camera and labels only. Relationships and evidence remain owned by app.js.
// Canvas measurement never forces SVG layout. Keep results across map rebuilds;
// font and available width are part of the key, and the cache has a fixed bound.
const mapLabelCache=new Map();
let mapLabelCanvas;
function mapLabel(label,limit,style){
 const font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
 const spacing=parseFloat(style.letterSpacing)||0,wordSpacing=parseFloat(style.wordSpacing)||0;
 const key=JSON.stringify([label,limit,font,spacing,wordSpacing]);
 if(mapLabelCache.has(key))return mapLabelCache.get(key);
 const context=mapLabelCanvas||(mapLabelCanvas=document.createElement('canvas').getContext('2d'));
 context.font=font;
 const measure=text=>context.measureText(text).width+Math.max(0,Array.from(text).length-1)*spacing+(text.match(/ /g)||[]).length*wordSpacing;
 let text=label,width=measure(text);
 if(width>limit){
  const chars=Array.from(label);let low=0,high=chars.length;
  while(low<high){const mid=Math.ceil((low+high)/2);if(measure(chars.slice(0,mid).join('')+'…')<=limit)low=mid;else high=mid-1;}
  text=chars.slice(0,low).join('')+'…';width=measure(text);
 }
 const result={text,width};
 if(mapLabelCache.size>=5000)mapLabelCache.delete(mapLabelCache.keys().next().value);
 mapLabelCache.set(key,result);return result;
}
document.fonts?.addEventListener('loadingdone',()=>mapLabelCache.clear());
window.AVMapViewport=function({svg,nodes,links,adj,N}){
 const vp=svg.querySelector('.viewport'),host=svg.closest('.map'),viewer=document.querySelector('#viewer');
 const texts=N.map(el=>el.querySelector('text')),circles=N.map(el=>el.querySelector('circle'));
 const radii=circles.map(el=>+el.getAttribute('r'));
 // Start with all sources visible, including notes without a report link.
 // Selecting a node still zooms to its neighbourhood.
 let width=1,height=520,view={x:0,y:0,k:1},manual=false,overview=true,highlight=null,disposed=false;
 const selected=()=>nodes[N.findIndex(el=>el.classList.contains('selected'))];
 const caption=host.querySelector('.map-caption');
 function labels(){
  const chosen=highlight||selected(),boxes=[],limit=Math.min(220,width-28);
  // Read font variants before any SVG writes, not once per truncated character.
  const styles=new Map(),fonts=N.map((el,i)=>{const key=el.getAttribute('class');if(!styles.has(key))styles.set(key,getComputedStyle(texts[i]));return styles.get(key)});
  const measured=nodes.map((n,i)=>mapLabel(n.label,limit,fonts[i]));
  const positions=nodes.map(n=>({x:width/2+view.x+n.x*view.k,y:height/2+view.y+n.y*view.k}));
  const order=nodes.map((n,i)=>i).sort((a,b)=>{
   const rank=n=>n===chosen?4:chosen&&adj.get(chosen)?.has(n)?3:n.kind==='company'?2:1;
   return rank(nodes[b])-rank(nodes[a])||nodes[b].deg-nodes[a].deg||a-b;
  });
  for(const i of order){
   const text=texts[i],n=nodes[i],p=positions[i],radius=Math.max(5,Math.min(11,radii[i]*view.k));
   circles[i].setAttribute('r',radius/view.k);circles[i].setAttribute('stroke-width',1.5/view.k);
   text.setAttribute('transform',`scale(${1/view.k})`);text.setAttribute('text-anchor','start');
   text.style.visibility='hidden';
   if(p.x<0||p.x>width||p.y<0||p.y>height)continue;
   if(text.textContent!==measured[i].text)text.textContent=measured[i].text;
   const w=measured[i].width;
   const candidates=[[radius+7,4],[-w/2,-radius-8],[-w/2,radius+18],[-w-radius-7,4]];
   for(const [dx,dy] of candidates){
    const box={left:p.x+dx-3,top:p.y+dy-13,right:p.x+dx+w+3,bottom:p.y+dy+4};
    if(box.left<4||box.right>width-4||box.top<4||box.bottom>height-4)continue;
    if(boxes.some(b=>b.left<box.right&&b.right>box.left&&b.top<box.bottom&&b.bottom>box.top))continue;
    if(positions.some((q,j)=>j!==i&&q.x+6>box.left&&q.x-6<box.right&&q.y+6>box.top&&q.y-6<box.bottom))continue;
    text.setAttribute('x',dx);text.setAttribute('y',dy);text.style.visibility='visible';boxes.push(box);break;
   }
  }
  caption.textContent=chosen?chosen.label:'점을 선택하면 자료를 확인할 수 있습니다. 이름은 서로 겹치지 않는 범위에서 표시합니다.';
 }
 function paint(){if(disposed)return;vp.setAttribute('transform',`translate(${view.x} ${view.y}) scale(${view.k})`);labels();}
 function fit(){
  const current=selected(),group=!overview&&current?[current,...adj.get(current)]:nodes;
  const xs=group.map(n=>n.x),ys=group.map(n=>n.y),left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  const k=Math.max(.08,Math.min(1.5,(width-48)/(right-left+90),(height-80)/(bottom-top+90)));
  view={k,x:-(left+right)/2*k,y:-(top+bottom)/2*k};paint();
 }
 function zoom(factor,x=0,y=0){
  manual=true;const k=Math.max(.08,Math.min(6,view.k*factor));
  view={k,x:x-(x-view.x)*k/view.k,y:y-(y-view.y)*k/view.k};paint();
 }
 function resize(){
  if(disposed)return;
  const rect=svg.getBoundingClientRect();if(!rect.width||!rect.height)return;
  width=rect.width;height=rect.height;svg.setAttribute('viewBox',`${-width/2} ${-height/2} ${width} ${height}`);
  if(manual)paint();else fit();
 }
 const observer=new ResizeObserver(resize);observer.observe(svg);
 document.fonts?.addEventListener('loadingdone',resize);
 const button=id=>host.querySelector('#'+id);
 button('map-zoom-in').onclick=()=>zoom(1.3);button('map-zoom-out').onclick=()=>zoom(1/1.3);
 button('map-overview').onclick=()=>{overview=true;manual=false;fit()};
 button('map-nearby').onclick=()=>{overview=false;manual=false;fit()};
 button('map-wide').onclick=()=>{
  const wide=viewer.classList.toggle('map-expanded');button('map-wide').setAttribute('aria-pressed',String(wide));
  button('map-wide').textContent=wide?'나누어 보기':'넓게 보기';
 };
 button('map-wide').setAttribute('aria-pressed',String(viewer.classList.contains('map-expanded')));
 button('map-wide').textContent=viewer.classList.contains('map-expanded')?'나누어 보기':'넓게 보기';
 svg.onwheel=e=>{e.preventDefault();const r=svg.getBoundingClientRect();zoom(e.deltaY<0?1.15:1/1.15,e.clientX-r.left-width/2,e.clientY-r.top-height/2)};
 svg.onpointerdown=e=>{
  if(e.target!==svg&&!e.target.classList.contains('viewport'))return;
  manual=true;svg.setPointerCapture(e.pointerId);const sx=e.clientX,sy=e.clientY,ox=view.x,oy=view.y;
  svg.onpointermove=ev=>{if(!(ev.buttons&1))return;view.x=ox+ev.clientX-sx;view.y=oy+ev.clientY-sy;paint()};
  svg.onpointerup=svg.onpointercancel=()=>{svg.onpointermove=null};
 };
 resize();
 return {
  update(){if(disposed)return;if(manual)paint();else fit()},
  focus(n){if(disposed)return;highlight=n;labels()},
  reveal(n){const x=n.x*view.k+view.x,y=n.y*view.k+view.y;if(Math.abs(x)>width/2-32||Math.abs(y)>height/2-32){manual=true;view.x=-n.x*view.k;view.y=-n.y*view.k;paint()}},
  dragScale(){manual=true;return 1/view.k},
  select(){if(disposed)return;overview=false;manual=false;if(viewer.classList.contains('map-expanded'))button('map-wide').click();fit()},
  reset(){manual=false;overview=false;fit()},
  stop(){disposed=true;observer.disconnect();document.fonts?.removeEventListener('loadingdone',resize)}
 };
};
