'use strict';
// Barnes-Hut repulsion: distant groups act as one mass instead of visiting every pair.
function layoutStep(nodes,links,alpha){
 if(!nodes.length)return;
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(const n of nodes){minX=Math.min(minX,n.x);minY=Math.min(minY,n.y);maxX=Math.max(maxX,n.x);maxY=Math.max(maxY,n.y)}
 const cell=(x,y,size)=>({x,y,size,count:0,sx:0,sy:0,points:[],children:null});
 const root=cell(minX-1,minY-1,Math.max(maxX-minX,maxY-minY,1)+2);
 function insert(q,n,depth=0){
  q.count++;q.sx+=n.x;q.sy+=n.y;
  if(!q.children&&(q.points.length<4||depth>=20)){q.points.push(n);return}
  if(!q.children){
   const h=q.size/2;q.children=[cell(q.x,q.y,h),cell(q.x+h,q.y,h),cell(q.x,q.y+h,h),cell(q.x+h,q.y+h,h)];
   const old=q.points;q.points=[];for(const p of old)insert(child(q,p),p,depth+1);
  }
  insert(child(q,n),n,depth+1);
 }
 const child=(q,n)=>q.children[(n.x>=q.x+q.size/2?1:0)+(n.y>=q.y+q.size/2?2:0)];
 for(const n of nodes)insert(root,n);
 function push(n,x,y,mass){
  let dx=x-n.x,dy=y-n.y;if(dx===0&&dy===0){dx=.01;dy=.01}
  const d2=Math.max(dx*dx+dy*dy,400),d=Math.sqrt(d2),f=7000*mass/d2*(d<90?2.5:1);
  n.vx-=dx/d*f;n.vy-=dy/d*f;
 }
 function visit(q,n){
  if(!q.count)return;
  if(!q.children){for(const p of q.points)if(p!==n)push(n,p.x,p.y,1);return}
  const x=q.sx/q.count,y=q.sy/q.count,d2=(x-n.x)**2+(y-n.y)**2;
  const contains=n.x>=q.x&&n.x<=q.x+q.size&&n.y>=q.y&&n.y<=q.y+q.size;
  if(!contains&&q.size*q.size<.64*d2){push(n,x,y,q.count);return}
  for(const c of q.children)visit(c,n);
 }
 for(const n of nodes)visit(root,n);
 for(const l of links){
  const a=nodes[l.a],b=nodes[l.b],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
  const rest=l.kind==='related'?120:l.kind==='tag'?150:105,f=(d-rest)*.012,fx=dx/d*f,fy=dy/d*f;
  a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;
 }
 for(const n of nodes){
  n.vx-=n.x*.007;n.vy-=n.y*.007;
  if(n.fixed){n.vx=n.vy=0;continue}
  n.vx*=.82;n.vy*=.82;const speed=Math.hypot(n.vx,n.vy);
  if(speed>40){n.vx*=40/speed;n.vy*=40/speed}
  n.x+=n.vx*alpha;n.y+=n.vy*alpha;
 }
}

if(typeof module!=='undefined')module.exports={layoutStep};
else{
 let nodes=[],links=[],alpha=1,timer=null,until=0;
 const schedule=()=>{if(timer===null)timer=setTimeout(tick,16)};
 function tick(){
  timer=null;
  if(Date.now()>=until)return;
  layoutStep(nodes,links,alpha);alpha=Math.max(alpha*.985,.08);
  const positions=new Float64Array(nodes.length*2);
  nodes.forEach((n,i)=>{positions[i*2]=n.x;positions[i*2+1]=n.y});
  postMessage(positions,[positions.buffer]);schedule();
 }
 onmessage=({data})=>{
  if(data.type==='init'){nodes=data.nodes;links=data.links;alpha=1;until=Date.now()+6000;schedule()}
  if(data.type==='stop'){clearTimeout(timer);timer=null;until=0}
  if(data.type==='drag'){
   const n=nodes[data.index];if(!n)return;
   n.x=data.x;n.y=data.y;n.fixed=data.fixed;n.vx=n.vy=0;alpha=Math.max(alpha,.6);
   until=Date.now()+(data.fixed?6000:2500);schedule();
  }
  if(data.type==='reset'){
   nodes.forEach(n=>{n.x=(Math.random()-.5)*300;n.y=(Math.random()-.5)*300;n.vx=n.vy=0;n.fixed=false});
   alpha=1;until=Date.now()+6000;schedule();
  }
 };
}
