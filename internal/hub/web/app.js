'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let state, tab='search', selected='', selectedRelation='', formBusy=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL=s=>{try{let u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:''}catch{return ''}};
// kind 'company'|'tag' makes the chip a filter shortcut (see bindChips).
const chip=(s,c='',kind='')=>`<span class="chip ${c}${kind&&activeFilter(kind)===s?' active':''}"${kind?` data-${kind}="${esc(s)}" role="button" tabindex="0" title="이 ${kind==='company'?'기업':'분류'}로 필터"`:''}>${esc(s)}</span>`;
const activeFilter=kind=>$(kind==='company'?'#company':'#category').value;
// Graph/timeline items must themselves mention every query term, not just belong to a matching report.
const matches=(...fields)=>{let ts=terms().map(t=>t.toLocaleLowerCase());if(!ts.length)return true;let s=fields.flat().join(' ').toLocaleLowerCase();return ts.every(t=>s.includes(t))};
function bindChips(root){root.querySelectorAll('[data-company],[data-tag]').forEach(el=>{const apply=e=>{e.stopPropagation();e.preventDefault();let kind=el.dataset.company!==undefined?'company':'tag',sel=$(kind==='company'?'#company':'#category'),v=el.dataset[kind];sel.value=sel.value===v?'':v;render()};el.onclick=apply;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')apply(e)}})}
function renderTagCloud(){let count=(xs)=>{let m=new Map();xs.forEach(x=>m.set(x,(m.get(x)||0)+1));return [...m].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))};
 let tags=count(catalog().reports.flatMap(r=>r.tags)),cos=count(catalog().reports.flatMap(realCompanies)).slice(0,14);
 $('#tag-cloud').innerHTML=`<div class="cloud-title">분류</div><div class="chips">${tags.map(([t,n])=>chip(t,'','tag').replace('</span>',`<b>${n}</b></span>`)).join('')}</div><div class="cloud-title">기업</div><div class="chips">${cos.map(([t,n])=>chip(t,'teal','company').replace('</span>',`<b>${n}</b></span>`)).join('')}</div>`;bindChips($('#tag-cloud'))}
const sources=ss=>(ss||[]).map(s=>{let u=safeURL(s.url);return u?`<a class="source-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">↗ ${esc(s.title||u)}</a>`:''}).join('');
async function api(path,body){let opts=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-AV-Request':'1'},body:JSON.stringify(body)};let r=await fetch(path,opts);if(!r.ok)throw Error(await r.text());return r.json()}
function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,5000)}
function catalog(){return state.snapshot.catalog}
const terms=()=>$('#query').value.trim().split(/\s+/).filter(Boolean);
// Wrap query terms in <mark> by walking text nodes, so markup and attributes are never touched.
function highlight(root){let ts=terms();if(!ts.length||!root)return;let re=new RegExp(ts.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gi');let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];while(walker.nextNode())if(re.test(walker.currentNode.data)){nodes.push(walker.currentNode)}
 for(let n of nodes){let frag=document.createDocumentFragment(),s=n.data,last=0;re.lastIndex=0;for(let m;(m=re.exec(s));){frag.append(s.slice(last,m.index));let mk=document.createElement('mark');mk.textContent=m[0];frag.append(mk);last=m.index+m[0].length}frag.append(s.slice(last));n.replaceWith(frag)}}
// Daily reports re-list the designated companies with "신규 확인 사항 없음" even when nothing happened, so a plain
// substring search for "Avride" hits every report. In strict mode (default) lines that only say "no news"
// are dropped from the searchable text, and a company counts as mentioned only if it survives that cut.
// Reference lists ("[R5] Avride 공식 사이트: https://…", "7. Avride, Official Site") are dropped too, and URLs are
// stripped so a domain name never counts as a mention.
const noNews=/없음|없었다|없다\.|미확인|확인되지 않았다|반복하지 않았다|다루지 않았다|제외|점검 출처|Official Site|공식 사이트|공식 뉴스|뉴스룸|Newsroom/i;
const urlRe=/https?:\/\/\S+/g,hasURL=/https?:\/\//,refLine=/^\s*(-\s*)?\[R?\d+\]|^\s*\d+\.\s|^\s*\*{0,2}(출처|References?|참고|Reference)\s*\*{0,2}\s*[:：]/i;
const strict=()=>$('#strict').checked;
const subCache={};
function substantive(r){if(subCache[r.id]&&subCache[r.id].src===r.body_markdown)return subCache[r.id].text;
 let ls=(r.summary+'\n'+r.body_markdown).split(/\r?\n/);
 // A numbered line whose next line is just a URL ("7. Avride, Official Site" ⏎ "   https://…") is a reference entry.
 let text=ls.filter((l,i)=>!(hasURL.test(l)&&refLine.test(l))&&!(/^\s*\d+\.\s/.test(l)&&/^\s*https?:\/\//.test(ls[i+1]||''))&&!/^\s*(-\s*)?\[R?\d+\]/.test(l)&&!noNews.test(l.replace(urlRe,''))).map(l=>l.replace(urlRe,'')).join('\n').toLocaleLowerCase();
 subCache[r.id]={src:r.body_markdown,text};return text}
function searchText(r){return strict()?r.title.toLocaleLowerCase()+'\n'+substantive(r):[r.title,r.summary,r.body_markdown,...r.companies,...r.tags].join(' ').toLocaleLowerCase()}
function mentions(r,co){return !strict()||r.title.toLocaleLowerCase().includes(co.toLocaleLowerCase())||substantive(r).includes(co.toLocaleLowerCase())}
const realCompanies=r=>r.companies.filter(c=>mentions(r,c));
function filtered(){let q=$('#query').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),co=$('#company').value,cat=$('#category').value,from=$('#from').value,to=$('#to').value;return catalog().reports.filter(r=>(!co||((r.companies||[]).includes(co)&&mentions(r,co)))&&(!cat||(r.tags||[]).includes(cat))&&(!from||r.date>=from)&&(!to||r.date<=to)&&q.every(t=>searchText(r).includes(t))).sort((a,b)=>$('#sort').value==='desc'?b.date.localeCompare(a.date):a.date.localeCompare(b.date))}
function reportCard(r,i=0){return `<button class="report-card ${selected===r.id?'selected':''}" data-report="${esc(r.id)}" style="--i:${i}"><div class="card-head"><span class="report-date">${esc(r.date)}</span><span class="card-meta">${r.attachments.length?'MD · PPTX':''}</span></div><h3>${esc(r.title)}</h3><p>${esc(r.summary)}</p><div class="chips">${r.companies.map(s=>mentions(r,s)?chip(s,'teal','company'):chip(s,'teal faint','company').replace('title="','title="점검 결과 ‘없음’으로만 언급 · ')).join('')}${r.tags.map(s=>chip(s,'','tag')).join('')}</div></button>`}
function renderStats(rs){let c=catalog(),ids=new Set(rs.map(r=>r.id));let cos=new Set(rs.flatMap(realCompanies));let ev=c.events.filter(e=>ids.has(e.report_id)).length,rel=c.relations.filter(r=>ids.has(r.report_id)).length;
 $('#stats').innerHTML=[['리포트',rs.length,c.reports.length],['기업',cos.size,null],['사건',ev,null],['관계',rel,null]].map(([k,v,t])=>`<div class="stat"><b>${v}</b><span>${k}${t!=null&&t!==v?` <em>/ ${t}</em>`:''}</span></div>`).join('')}
function render(){if(!state)return;let rs=filtered(),ids=new Set(rs.map(r=>r.id));$('#view-title').textContent={search:'리포트 검색',timeline:'이슈의 흐름',graph:'기업과 사건의 연결',map:'리포트·기업·분류 지도',local:'내 자료 · 이 PC 전용',rag:'멀티모달 검색 · 실험 기능'}[tab];$('#result-count').textContent=`${rs.length}개 리포트 · 원문 및 사전 분석 데이터`;renderStats(rs);renderTagCloud();
 if(tab==='search')$('#results').innerHTML=rs.map(reportCard).join('')||'<div class="empty">검색 결과가 없습니다.<br>검색어나 기간을 바꿔 보세요.</div>';
 if(tab==='timeline'){let es=catalog().events.filter(e=>ids.has(e.report_id)&&matches(e.title,e.detail,e.status,e.companies)).sort((a,b)=>$('#sort').value==='desc'?b.date.localeCompare(a.date):a.date.localeCompare(b.date));let month='';$('#results').innerHTML='<p class="small-note">사건 날짜와 보관 기록을 표시합니다. ‘보고일’은 사건 발생일이 아니며, 계획은 완료 사실과 구분합니다.</p><div class="timeline">'+es.map((e,i)=>{let m=e.date.slice(0,7),head=m!==month?`<div class="month">${esc(m.replace('-','년 '))}월</div>`:'';month=m;return head+`<div class="event ${e.status==='계획'?'plan':''}" style="--i:${i}"><button class="report-card ${selected===e.report_id?'selected':''}" data-report="${esc(e.report_id)}"><div class="card-head"><span class="report-date">${esc(e.date)}</span>${chip(e.status,e.status==='계획'?'amber':'teal')}</div><h3>${esc(e.title)}</h3><p>${esc(e.detail)}</p><div class="chips">${e.companies.map(c=>chip(c,'','company')).join('')}</div></button></div>`}).join('')+'</div>'+(es.length?'':'<div class="empty">이 조건에 미리 정리된 사건이 없습니다.</div>')}
 if(tab==='graph')renderGraph(ids);else if(tab==='map')renderMap(rs);else if(tab==='local')renderLocal();else if(tab==='rag')renderRag();else highlight($('#results'));
 if(tab!=='map'&&mapSim)mapSim.stop();
 bindChips($('#results'));
 $$('[data-report]').forEach(b=>b.onclick=()=>{selected=b.dataset.report;selectedRelation='';render()});renderDetail();
}
// Entities on a circle, edges as curved arrows; hovering or selecting a node/edge dims the rest.
function renderGraph(ids){const label=id=>catalog().entities.find(n=>n.id===id)?.label||id;
 let rel=catalog().relations.filter(r=>ids.has(r.report_id)&&matches(label(r.from),label(r.to),r.label,r.evidence,r.status));let nodeIDs=new Set(rel.flatMap(r=>[r.from,r.to]));let ns=catalog().entities.filter(e=>nodeIDs.has(e.id));
 const W=760,H=Math.max(540,ns.length*72),cx=W/2,cy=H/2,R=Math.min(W,H)/2-82,positions={};ns.forEach((n,i)=>{let a=-Math.PI/2+i*2*Math.PI/ns.length;positions[n.id]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)}});
 let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="근거가 연결된 관계 그래프"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>`;
 for(let r of rel){let a=positions[r.from],b=positions[r.to],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,ux=dx/d,uy=dy/d;let x1=a.x+ux*34,y1=a.y+uy*34,x2=b.x-ux*36,y2=b.y-uy*36;let bend=Math.min(70,d*.18);let mx=(x1+x2)/2-uy*bend,my=(y1+y2)/2+ux*bend;let lx=(x1+2*mx+x2)/4,ly=(y1+2*my+y2)/4;
  svg+=`<g class="edge ${r.status==='계획'?'planned':''} ${selectedRelation===r.id?'selected':''}" data-edge="${esc(r.id)}" data-from="${esc(r.from)}" data-to="${esc(r.to)}" tabindex="0" role="button" aria-label="${esc(label(r.from))} → ${esc(label(r.to))}: ${esc(r.label)}"><path class="hit" d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}"/><path class="line" d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}" marker-end="url(#arrow)"/><rect class="label-bg" x="${lx-r.label.length*5.6-7}" y="${ly-10}" width="${r.label.length*11.2+14}" height="20" rx="10"/><text class="graph-label" text-anchor="middle" x="${lx}" y="${ly+4}">${esc(r.label)}</text></g>`}
 for(let n of ns){let p=positions[n.id];svg+=`<g class="node kind-${esc(n.kind)}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.label)}" transform="translate(${p.x} ${p.y})"><circle r="30"/><text class="icon" text-anchor="middle" y="5">${n.kind==='인물'?'👤':n.kind==='지역'?'📍':'🏢'}</text><text class="name" text-anchor="middle" y="48">${esc(n.label)}</text><text class="kind" text-anchor="middle" y="62">${esc(n.kind)}</text></g>`}svg+='</svg>';
 $('#results').innerHTML=`<p class="small-note">${terms().length?`검색어 <b>${esc(terms().join(' '))}</b>와 일치하는 관계만 표시합니다. `:'공통 기업명만으로 관계를 만들지 않습니다. '}노드나 연결을 가리키면 관련 항목만 강조되고, 선택하면 오른쪽에 근거가 열립니다.</p>`+(ns.length?`<div class="graph">${svg}<div class="legend"><span><i class="lg solid"></i>확인된 관계</span><span><i class="lg dashed"></i>발표된 계획</span><span>🏢 기업 · 👤 인물 · 📍 지역</span></div></div><div class="relation-list">${rel.map(r=>`<button class="related-card ${selectedRelation===r.id?'selected':''}" data-relation="${esc(r.id)}"><span class="rel-path">${esc(label(r.from))} <i>→</i> ${esc(label(r.to))}</span><small>${esc(r.label)} · ${chip(r.status,r.status==='계획'?'amber':'teal')}</small></button>`).join('')}</div>`:`<div class="empty">${terms().length?'검색어와 일치하는 관계가 없습니다.<br>검색어를 지우면 현재 필터의 모든 관계를 봅니다.':'이 조건에 근거가 확인된 관계가 없습니다.'}</div>`);
 const g=$('#results svg');const focus=(nodes,edges)=>{if(!g)return;g.classList.toggle('focus',!!nodes);g.querySelectorAll('[data-node]').forEach(n=>n.classList.toggle('on',!!nodes&&nodes.has(n.dataset.node)));g.querySelectorAll('[data-edge]').forEach(e=>e.classList.toggle('on',!!edges&&edges.has(e.dataset.edge)))};
 const pickRel=id=>{selectedRelation=id;selected=catalog().relations.find(r=>r.id===id).report_id;$$('[data-relation],[data-edge]').forEach(b=>b.classList.toggle('selected',b.dataset.relation===id||b.dataset.edge===id));renderDetail()};
 $$('[data-relation]').forEach(b=>{b.onclick=()=>pickRel(b.dataset.relation);b.onmouseenter=()=>{let r=rel.find(x=>x.id===b.dataset.relation);focus(new Set([r.from,r.to]),new Set([r.id]))};b.onmouseleave=()=>focus(null)});
 $$('[data-edge]').forEach(b=>{const r=rel.find(x=>x.id===b.dataset.edge);b.onclick=()=>pickRel(r.id);b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pickRel(r.id)}};b.onmouseenter=()=>focus(new Set([r.from,r.to]),new Set([r.id]));b.onmouseleave=()=>focus(null)});
 $$('[data-node]').forEach(b=>{const id=b.dataset.node,mine=rel.filter(r=>r.from===id||r.to===id);const pick=()=>{if(mine[0])pickRel(mine[0].id)};b.onclick=pick;b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}};b.onmouseenter=()=>focus(new Set([id,...mine.flatMap(r=>[r.from,r.to])]),new Set(mine.map(r=>r.id)));b.onmouseleave=()=>focus(null)});
}
// Obsidian-style force-directed map: reports, companies and tags as nodes; no library, ~60 nodes.
let mapSim=null;const mapPos={};
function renderMap(rs){
 if(mapSim)mapSim.stop();
 let nodes=[],links=[],idx={};
 const add=(id,kind,label,ref)=>{if(idx[id]!==undefined)return nodes[idx[id]];idx[id]=nodes.length;let p=mapPos[id]||{x:(Math.random()-.5)*300,y:(Math.random()-.5)*300};let n={id,kind,label,ref,x:p.x,y:p.y,vx:0,vy:0,deg:0,fixed:false};nodes.push(n);return n};
 const link=(a,b,kind)=>{if(a===b)return;links.push({a,b,kind});a.deg++;b.deg++};
 for(let r of rs){let n=add('r:'+r.id,'report',r.title,r);for(let c of realCompanies(r))link(n,add('c:'+c,'company',c,c),'company');for(let t of r.tags)link(n,add('t:'+t,'tag',t,t),'tag')}
 for(let x of catalog().related){let a=idx['r:'+x.from],b=idx['r:'+x.to];if(a!==undefined&&b!==undefined)link(nodes[a],nodes[b],'related')}
 const adj=new Map(nodes.map(n=>[n,new Set()]));links.forEach(l=>{adj.get(l.a).add(l.b);adj.get(l.b).add(l.a)});
 const W=1000,H=700;
 $('#results').innerHTML='<p class="small-note">리포트(●)와 그 안에 등장한 기업·분류를 연결한 지도입니다. 끌어서 옮기고, 휠로 확대하고, 기업·분류를 누르면 필터가 적용됩니다.</p>'+(nodes.length?`<div class="map"><svg viewBox="${-W/2} ${-H/2} ${W} ${H}" role="img" aria-label="리포트·기업·분류 연결 지도"><g class="viewport"><g class="links">${links.map((l,i)=>`<line class="ml ${l.kind}" data-l="${i}"/>`).join('')}</g><g class="nodes">${nodes.map((n,i)=>`<g class="mn ${n.kind} ${n.kind==='report'&&selected===n.ref.id?'selected':''}" data-n="${i}" tabindex="0" role="button" aria-label="${esc(n.label)}"><circle r="${n.kind==='report'?7+Math.min(n.deg,10)*.6:5+Math.min(n.deg,14)*.9}"/><text y="${n.kind==='report'?22:20}" text-anchor="middle">${esc(n.kind==='report'?n.label.length>18?n.label.slice(0,17)+'…':n.label:n.label)}</text></g>`).join('')}</g></g></svg><div class="legend"><span><i class="dot report"></i>리포트</span><span><i class="dot company"></i>기업</span><span><i class="dot tag"></i>분류</span><span><i class="lg related"></i>연결된 이슈</span><button class="text-button" id="map-reset">배치 다시</button></div></div>`:'<div class="empty">표시할 리포트가 없습니다.</div>');
 if(!nodes.length)return;
 const svg=$('#results svg'),vp=svg.querySelector('.viewport'),L=$$('#results .ml'),N=$$('#results .mn');
 let view={x:0,y:0,k:1},alpha=1,userView=false;const setView=()=>vp.setAttribute('transform',`translate(${view.x} ${view.y}) scale(${view.k})`);
 // Keep the whole graph in frame while it settles, until the user zooms or pans.
 const fit=()=>{let xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y),minx=Math.min(...xs)-60,maxx=Math.max(...xs)+60,miny=Math.min(...ys)-40,maxy=Math.max(...ys)+50;let k=Math.min(1.3,W/(maxx-minx),H/(maxy-miny));view={k,x:-(minx+maxx)/2*k,y:-(miny+maxy)/2*k};setView()};
 const draw=()=>{links.forEach((l,i)=>{let e=L[i];e.setAttribute('x1',l.a.x);e.setAttribute('y1',l.a.y);e.setAttribute('x2',l.b.x);e.setAttribute('y2',l.b.y)});nodes.forEach((n,i)=>{N[i].setAttribute('transform',`translate(${n.x} ${n.y})`);mapPos[n.id]={x:n.x,y:n.y}});if(!userView)fit()};
 const step=()=>{for(let i=0;i<nodes.length;i++){let a=nodes[i];for(let j=i+1;j<nodes.length;j++){let b=nodes[j],dx=b.x-a.x,dy=b.y-a.y;if(dx===0&&dy===0){dx=Math.random()-.5;dy=Math.random()-.5}let d2=Math.max(dx*dx+dy*dy,400),d=Math.sqrt(d2);let f=7000/d2;if(d<90)f*=2.5;let fx=dx/d*f,fy=dy/d*f;a.vx-=fx;a.vy-=fy;b.vx+=fx;b.vy+=fy}}
  for(let l of links){let dx=l.b.x-l.a.x,dy=l.b.y-l.a.y,d=Math.hypot(dx,dy)||1,rest=l.kind==='related'?120:l.kind==='tag'?150:105;let f=(d-rest)*.012,fx=dx/d*f,fy=dy/d*f;l.a.vx+=fx;l.a.vy+=fy;l.b.vx-=fx;l.b.vy-=fy}
  for(let n of nodes){n.vx-=n.x*.007;n.vy-=n.y*.007;if(n.fixed){n.vx=n.vy=0;continue}n.vx*=.82;n.vy*=.82;let sp=Math.hypot(n.vx,n.vy);if(sp>40){n.vx*=40/sp;n.vy*=40/sp}n.x+=n.vx*alpha;n.y+=n.vy*alpha}};
 let raf=0;const loop=()=>{step();draw();alpha=Math.max(alpha*.985,.08);raf=requestAnimationFrame(loop)};const stop=()=>{cancelAnimationFrame(raf);raf=0};const start=()=>{if(!raf)loop()};
 mapSim={stop};for(let i=0;i<60;i++)step();draw();start();setTimeout(stop,6000);
 // Hover: keep the neighbourhood, dim the rest.
 const focus=n=>{svg.classList.toggle('focus',!!n);N.forEach((el,i)=>el.classList.toggle('on',!!n&&(nodes[i]===n||adj.get(n).has(nodes[i]))));L.forEach((el,i)=>el.classList.toggle('on',!!n&&(links[i].a===n||links[i].b===n)))};
 N.forEach((el,i)=>{const n=nodes[i];el.onmouseenter=()=>focus(n);el.onmouseleave=()=>focus(null);
  const act=()=>{if(n.kind==='report'){selected=n.ref.id;selectedRelation='';N.forEach((x,j)=>x.classList.toggle('selected',nodes[j]===n));renderDetail()}else{let sel=$(n.kind==='company'?'#company':'#category');sel.value=sel.value===n.ref?'':n.ref;render()}};
  let moved=false;el.onpointerdown=e=>{e.stopPropagation();moved=false;n.fixed=true;el.setPointerCapture(e.pointerId);let sx=e.clientX,sy=e.clientY,ox=n.x,oy=n.y;const pt=svg.createSVGPoint();const scale=()=>{let r=svg.getBoundingClientRect();return W/r.width/view.k};
   el.onpointermove=ev=>{if(!(ev.buttons&1))return;let s=scale();n.x=ox+(ev.clientX-sx)*s;n.y=oy+(ev.clientY-sy)*s;if(Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>3)moved=true;alpha=Math.max(alpha,.6);start();draw()};
   el.onpointerup=()=>{el.onpointermove=null;n.fixed=false;setTimeout(stop,2500);if(!moved)act()}};
  el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();act()}}});
 svg.onwheel=e=>{e.preventDefault();userView=true;let r=svg.getBoundingClientRect(),mx=(e.clientX-r.left)/r.width*W-W/2,my=(e.clientY-r.top)/r.height*H-H/2;let k=Math.min(4,Math.max(.3,view.k*(e.deltaY<0?1.15:1/1.15)));view.x=mx-(mx-view.x)*k/view.k;view.y=my-(my-view.y)*k/view.k;view.k=k;setView()};
 svg.onpointerdown=e=>{if(e.target!==svg&&!e.target.classList.contains('viewport'))return;svg.setPointerCapture(e.pointerId);userView=true;let sx=e.clientX,sy=e.clientY,ox=view.x,oy=view.y,r=svg.getBoundingClientRect();svg.onpointermove=ev=>{if(!(ev.buttons&1))return;view.x=ox+(ev.clientX-sx)*W/r.width;view.y=oy+(ev.clientY-sy)*W/r.width;setView()};svg.onpointerup=()=>svg.onpointermove=null};
 $('#map-reset').onclick=()=>{nodes.forEach(n=>{n.x=(Math.random()-.5)*300;n.y=(Math.random()-.5)*300;n.vx=n.vy=0});alpha=1;userView=false;start();setTimeout(stop,6000)};
}
function markdown(text){
 text=String(text||'').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/<!--[\s\S]*?-->/g,'');let refs={};text=text.replace(/^\[([^\]]+)\]:\s*(https?:\/\/\S+)\s*$/gm,(_,id,u)=>{refs[id]=u;return ''});
 function inline(s){s=esc(s);s=s.replace(/`([^`]+)`/g,'<code>$1</code>');s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,t,u)=>`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);s=s.replace(/\[([^\]]+)\]\[([^\]]+)\]/g,(_,t,id)=>refs[id]?`<a href="${esc(refs[id])}" target="_blank" rel="noopener noreferrer">${t}</a>`:t);s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');return s}
 const cells=l=>l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
 const lines=text.split(/\r?\n/),out=[];
 for(let i=0;i<lines.length;i++){let l=lines[i];
  if(/^```/.test(l)){let code=[];for(i++;i<lines.length&&!/^```/.test(lines[i]);i++)code.push(lines[i]);out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);continue}
  if(/^\s*\|.*\|\s*$/.test(l)&&i+1<lines.length&&/^\s*\|?\s*:?-{2,}/.test(lines[i+1])){let head=cells(l);i+=2;let rows=[];for(;i<lines.length&&/^\s*\|.*\|\s*$/.test(lines[i]);i++)rows.push(cells(lines[i]));i--;out.push(`<table><thead><tr>${head.map(c=>`<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);continue}
  if(/^[-*] /.test(l)){let items=[];for(;i<lines.length&&/^[-*] /.test(lines[i]);i++)items.push(lines[i].slice(2));i--;out.push(`<ul>${items.map(t=>`<li>${inline(t)}</li>`).join('')}</ul>`);continue}
  if(/^\d+\. /.test(l)){let items=[];for(;i<lines.length&&/^\d+\. /.test(lines[i]);i++)items.push(lines[i].replace(/^\d+\. /,''));i--;out.push(`<ol>${items.map(t=>`<li>${inline(t)}</li>`).join('')}</ol>`);continue}
  if(/^> ?/.test(l)){let q=[];for(;i<lines.length&&/^> ?/.test(lines[i]);i++)q.push(lines[i].replace(/^> ?/,''));i--;out.push(`<blockquote><p>${inline(q.join(' '))}</p></blockquote>`);continue}
  if(/^---+$/.test(l.trim())){out.push('<hr>');continue}
  let m=l.match(/^(#{1,4})\s+(.+)/);if(m){out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);continue}
  if(l.trim())out.push(`<p>${inline(l)}</p>`)}
 return out.join('');
}
function renderDetail(){if(tab==='local')return renderLocalDetail();if(tab==='rag')return renderRagDetail();let r=catalog().reports.find(r=>r.id===selected);if(!r){$('#detail').innerHTML='<div class="empty">리포트나 그래프의 연결을 선택하면<br>본문과 관련 내용을 볼 수 있습니다.</div>';return}
 let rel=catalog().relations.find(x=>x.id===selectedRelation);let related=catalog().related.filter(x=>x.from===r.id||x.to===r.id).map(x=>({r:catalog().reports.find(z=>z.id===(x.from===r.id?x.to:x.from)),reason:x.reason})).filter(x=>x.r);
 let same=catalog().reports.filter(x=>x.id!==r.id&&!related.some(t=>t.r.id===x.id)&&x.companies.some(c=>r.companies.includes(c))).slice(0,4);
 // Body first and fully expanded; linked issues follow as title-only cards (reason shown on hover).
 $('#detail').innerHTML=(rel?`<div class="eyebrow">선택한 관계 · ${esc(rel.status)}</div><h2>${esc(rel.label)}</h2><div class="summary">${esc(rel.evidence)}</div>${sources(rel.sources)}<hr>`:'')+`<span class="report-date">${esc(r.date)}</span><h2>${esc(r.title)}</h2><div class="chips">${r.companies.map(s=>chip(s,'teal')).join('')}</div><div class="downloads">${r.attachments.map((a,i)=>`<a href="/api/download?id=${encodeURIComponent(r.id)}&index=${i}">${esc(a.name.endsWith('.md')?'MD 다운로드':a.name.endsWith('.pptx')?'PPTX 다운로드':a.name)}</a>`).join('')}</div><article class="markdown">${markdown(r.body_markdown)}</article><hr><h3>연결된 이슈</h3>${related.length?related.map(x=>`<button class="related-card" data-related="${esc(x.r.id)}" title="${esc(x.reason)}"><span class="report-date">${esc(x.r.date)}</span> ${esc(x.r.title)}</button>`).join(''):'<p class="small-note">게시자가 확인한 후속 연결이 아직 없습니다.</p>'}${same.length?'<h3>같은 기업이 등장한 리포트</h3>'+same.map(x=>`<button class="related-card" data-related="${esc(x.id)}" title="기업 태그가 같은 자료입니다. 같은 사건을 뜻하지 않습니다."><span class="report-date">${esc(x.date)}</span> ${esc(x.title)}</button>`).join(''):''}<h3>원문 출처</h3>${sources(r.sources)}`;
 highlight($('#detail'));renderReportLocal(r);
 $$('[data-related]').forEach(b=>b.onclick=()=>{selected=b.dataset.related;selectedRelation='';render()});
}
function mountForm(target){let host=$(target);host.replaceChildren($('#settings-form').content.cloneNode(true));let f=host.querySelector('form');for(let k of ['owner','repo','branch','sync_time'])f.elements[k].value=state.config[k];f.elements.offline.checked=state.config.offline;f.querySelector('#data-location').textContent='자료 저장 위치: '+state.data_dir;f.querySelector('.save-settings').textContent=state.setup?'검사하고 설치':'검사하고 저장';
 const input=()=>({owner:f.elements.owner.value.trim(),repo:f.elements.repo.value.trim(),branch:f.elements.branch.value.trim(),sync_time:f.elements.sync_time.value,token:f.elements.token.value,clear_token:f.elements.clear_token.checked,offline:f.elements.offline.checked});
 async function run(path){if(formBusy)return;formBusy=true;let box=f.querySelector('.checks');box.classList.remove('error');box.textContent='환경을 확인하고 있습니다…';f.querySelectorAll('button').forEach(b=>b.disabled=true);try{let v=await api(path,input());box.textContent=(v.checks||[]).map(s=>'✓ '+s).join('\n');if(!v.ok){box.classList.add('error');box.textContent+='\n'+(v.error||'설정을 확인하세요.')}else if(path==='/api/install'){f.elements.token.value='';if(state.setup){f.querySelector('.launch').hidden=false;box.textContent+='\n설치 완료. 리포트 시작 버튼을 누르세요.'}else{toast('설정이 저장되었습니다.');$('#settings-dialog').close();await refresh(true)}}}catch(e){box.classList.add('error');box.textContent=e.message}finally{formBusy=false;f.querySelectorAll('button').forEach(b=>b.disabled=false)}}
 f.querySelector('.check-env').onclick=()=>{if(f.reportValidity())run('/api/check')};f.onsubmit=e=>{e.preventDefault();run('/api/install')};f.querySelector('.launch').onclick=async()=>{try{await api('/api/launch',{});f.querySelector('.checks').textContent='리포트가 열렸습니다. 이 설정 창은 닫아도 됩니다.'}catch(e){toast(e.message)}};
}
function showStatus(s){$('#sync-status').textContent=s.syncing?'최신 자료 확인 중…':s.status;$('#sync').disabled=s.syncing||s.setup;$('#published').textContent='마지막 확인: '+(s.synced_at?new Date(s.synced_at).toLocaleString('ko-KR'):'포함된 자료')}
// Poll the small /api/status; pull the full catalog via /api/state only when the commit changes.
async function refresh(force=false){let old=state?.snapshot.commit;if(!force&&state){let s=await api('/api/status');showStatus(s);if(s.commit===old)return}state=await api('/api/state');showStatus({...state,synced_at:state.snapshot.synced_at});if(force||old!==state.snapshot.commit){for(let [id,values,label] of [['company',catalog().reports.flatMap(r=>r.companies),'전체 기업'],['category',catalog().reports.flatMap(r=>r.tags),'전체 분류']]){let el=$('#'+id),value=el.value;el.innerHTML=`<option value="">${label}</option>`+[...new Set(values)].sort().map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');el.value=value}if(!selected)selected=catalog().reports[0]?.id||'';render()}}
// Tab is mirrored in the URL hash (#timeline, #graph, #map) so a view can be bookmarked or reloaded.
function setTab(t){let b=$(`[data-tab="${t}"]`);if(!b)return;tab=t;$$('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));history.replaceState(null,'',t==='search'?location.pathname:'#'+t);render()}
$$('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
// Theme: applied early by theme.js; the header select changes and remembers it (per browser, never synced).
$('#theme').value=document.documentElement.dataset.theme||'apple';
$('#theme').onchange=e=>{document.documentElement.dataset.theme=e.target.value;try{localStorage.setItem('av_theme',e.target.value)}catch(x){}if(tab==='graph'||tab==='map')render()};
{let h=location.hash.slice(1).split('&')[0];if(h&&$(`[data-tab="${h}"]`)){tab=h;$$('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.tab===tab)))}}
for(let id of ['query','company','category','from','to','sort'])$('#'+id).addEventListener(id==='query'?'input':'change',render);
try{$('#strict').checked=localStorage.getItem('av_strict')!=='0'}catch(e){}
$('#strict').onchange=e=>{try{localStorage.setItem('av_strict',e.target.checked?'1':'0')}catch(x){}render()};
$('#clear').onclick=()=>{$('#query').value='';render()};$('#reset').onclick=()=>{for(let id of ['query','company','category','from','to'])$('#'+id).value='';render()};
$('#settings').onclick=()=>{if(state.setup)return;mountForm('#dialog-slot');$('#settings-dialog').showModal()};$('#close-settings').onclick=()=>$('#settings-dialog').close();
$('#sync').onclick=async()=>{try{await api('/api/sync',{});toast('최신 자료를 확인합니다.');setTimeout(()=>refresh(),400)}catch(e){toast(e.message)}};
$('#exit').onclick=async()=>{if(!confirm('프로그램을 종료할까요? 다음 실행 전까지 자동 갱신이 멈춥니다.'))return;try{await api('/api/exit',{});document.body.innerHTML='<main class="empty"><h1>AV 리포트를 종료했습니다.</h1><p>이 브라우저 창을 닫아도 됩니다.</p></main>'}catch(e){toast(e.message)}};
(async()=>{try{await refresh(true);await loadLocal();if(state.setup){$('#viewer').hidden=true;$('#setup-home').hidden=false;$('#settings').hidden=true;mountForm('#setup-slot');await autoInstall()}else if(!state.config.configured){mountForm('#dialog-slot');$('#settings-dialog').showModal()}setInterval(()=>refresh().catch(()=>{}),4000)}catch(e){toast(e.message)}})();

async function autoInstall(){
 const slot=$('#setup-slot');slot.hidden=true;const status=document.createElement('p');status.className='checks';status.setAttribute('role','status');slot.before(status);
 status.textContent='환경 검사 · 실행 파일 · 기본 DB · 바로가기를 자동으로 준비합니다…';
 try{const result=await api('/api/install',{...state.config,automatic:true,token:''});if(!result.ok)throw Error(result.error);status.textContent=result.checks.join('\n')+'\n설치 완료. 리포트를 자동으로 엽니다…';await api('/api/launch',{});status.textContent='설치가 끝났습니다. 리포트가 새 탭에서 열렸고 바탕화면에 AV Report Hub 바로가기가 생겼습니다.\n이 탭은 닫아도 됩니다.';}catch(e){status.textContent='자동 준비를 완료하지 못했습니다: '+e.message+'\n아래에서 설정을 확인한 뒤 다시 시도하거나, 「지금은 오프라인으로 시작」을 선택하세요.';slot.hidden=false;}
}

// 내 자료: PDFs and Outlook links stay on this PC (the server DPAPI-encrypts them; nothing goes to GitHub).
// Outlook mail is never copied: dropped .pst/.ost/.msg files are refused and mail is searched in place via Outlook.
let local={available:false,reason:'',files:[],mails:[],sources:[]},localSel='',outlookStores=null;const mailCache={},mailPool={};
const fmtSize=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
const reportOf=id=>catalog().reports.find(r=>r.id===id);
async function loadLocal(){if(!state||state.setup)return;try{let v=await api('/api/local');local={available:v.available,reason:v.reason||'',files:v.files||[],mails:v.mails||[],sources:v.sources||[]}}catch(e){local={...local,available:false,reason:e.message}}render()}
async function localDo(path,body,msg){try{let v=await api(path,body);if(msg)toast(msg);await loadLocal();return v}catch(e){toast(e.message)}}
async function addFiles(list){if(!local.available)return toast(local.reason||'내 자료를 사용할 수 없습니다.');let ok=0,msgs=[];
 for(let f of list){if(/\.(pst|ost|nst|msg|olm)$/i.test(f.name)){msgs.push(`${f.name}: 아웃룩 데이터는 복사하지 않습니다. 내 자료 탭의 ‘Outlook 연결’에서 위치를 지정하세요.`);continue}
  if(!/\.pdf$/i.test(f.name)&&f.type!=='application/pdf'){msgs.push(`${f.name}: PDF만 추가할 수 있습니다.`);continue}
  if(f.size>50*1048576){msgs.push(`${f.name}: 50MB를 넘습니다.`);continue}
  try{let r=await fetch('/api/local/add?name='+encodeURIComponent(f.name),{method:'POST',headers:{'X-AV-Request':'1','Content-Type':'application/pdf'},body:f});if(!r.ok)throw Error(await r.text());localSel=(await r.json()).id;ok++}catch(e){msgs.push(`${f.name}: ${e.message}`)}}
 await loadLocal();if(ok)setTab('local');toast([ok?`PDF ${ok}개를 이 PC에만 보관했습니다.`:'',...msgs].filter(Boolean).join('\n'))}
const mailRow=(m,act='')=>(mailPool[m.entry_id]=m,`<div class="mail-row"><button class="mail-open" data-mail-open="${esc(m.entry_id)}" title="Outlook에서 열기"><b>✉ ${esc(m.subject||'(제목 없음)')}</b><small>${esc(m.sender)} · ${esc((m.received||'').slice(0,10))} · ${esc(m.folder)}</small></button>${act}</div>`);
function renderLocal(){$('#result-count').textContent=`PDF ${local.files.length}개 · 연결된 메일 ${local.mails.length}개 · 이 PC에만 보관`;
 if(!local.available){$('#results').innerHTML=`<div class="empty">${esc(local.reason||'내 자료를 불러오는 중입니다.')}</div>`;return}
 let q=terms().map(t=>t.toLocaleLowerCase()),fs=local.files.filter(f=>q.every(t=>f.name.toLocaleLowerCase().includes(t))).sort((a,b)=>b.added.localeCompare(a.added));
 const has=s=>local.sources.some(x=>(s.store_id&&x.store_id===s.store_id)||(s.path&&x.path&&x.path.toLowerCase()===s.path.toLowerCase()));
 $('#results').innerHTML=`<p class="local-note">🔒 내 자료는 이 PC의 현재 Windows 계정으로 암호화해 보관하며 GitHub 동기화·게시와 무관합니다. 외부로 전송하지 않습니다. 아웃룩 메일은 복사하지 않고 위치만 연결합니다.</p>
 <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="PDF 추가"><b>PDF를 여기로 끌어다 놓으세요</b><span>또는 눌러서 파일 선택 · 최대 50MB</span></div>
 <h3 class="local-h">PDF</h3>${fs.map(f=>`<button class="report-card ${localSel===f.id?'selected':''}" data-local="${esc(f.id)}"><div class="card-head"><span class="report-date">${esc(f.added.slice(0,10))}</span><span class="card-meta">${fmtSize(f.size)}</span></div><h3>📄 ${esc(f.name)}</h3><p>${f.reports.length?`연결된 리포트 ${f.reports.length}개`:'연결된 리포트 없음'}</p></button>`).join('')||'<p class="small-note">아직 추가한 PDF가 없습니다.</p>'}
 <h3 class="local-h">Outlook 연결</h3><p class="small-note">클래식 Outlook으로 메일을 검색합니다. 검색할 메일함(OST)이나 PST 파일을 지정하세요. 지정한 PST는 Outlook 폴더 목록에 추가됩니다.</p>
 ${local.sources.map((s,i)=>`<div class="mail-row"><span class="source-name">📬 <b>${esc(s.name)}</b>${s.path?`<small>${esc(s.path)}</small>`:''}</span><button class="text-button" data-src-remove="${i}">제거</button></div>`).join('')||'<p class="small-note">지정된 메일 자료가 없습니다.</p>'}
 <div class="link-form"><button id="load-stores">Outlook 메일함 불러오기</button></div>
 ${outlookStores?outlookStores.map((s,i)=>has(s)?'':`<div class="mail-row"><span class="source-name">${esc(s.name)}${s.path?`<small>${esc(s.path)}</small>`:''}</span><button class="text-button" data-store-add="${i}">추가</button></div>`).join('')||'<p class="small-note">추가할 메일함이 없습니다.</p>':''}
 <form id="pst-form" class="link-form"><input name="path" placeholder="PST·OST 파일 전체 경로 (예: D:\\메일\\보관.pst)" aria-label="PST·OST 파일 경로"><button class="primary">경로 추가</button></form>
 <h3 class="local-h">연결된 메일</h3>${local.mails.map(m=>mailRow(m,`<button class="text-button" data-goto-report="${esc(m.report)}">${esc(reportOf(m.report)?.title||m.report)}</button>`)).join('')||'<p class="small-note">리포트를 열면 관련 메일을 제안합니다. 그중 연결한 메일이 여기에 모입니다.</p>'}`;
 const dz=$('#dropzone');dz.onclick=()=>$('#local-input').click();dz.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();dz.click()}};
 $$('[data-local]').forEach(b=>b.onclick=()=>{localSel=b.dataset.local;$$('[data-local]').forEach(x=>x.classList.toggle('selected',x===b));renderLocalDetail()});
 $$('[data-src-remove]').forEach(b=>b.onclick=()=>localDo('/api/outlook/source',{source:local.sources[+b.dataset.srcRemove],remove:true},'메일 자료 지정을 해제했습니다.'));
 $$('[data-store-add]').forEach(b=>b.onclick=()=>localDo('/api/outlook/source',{source:outlookStores[+b.dataset.storeAdd]},'메일함을 추가했습니다.'));
 $('#load-stores').onclick=async e=>{e.target.disabled=true;e.target.textContent='Outlook 확인 중…';try{outlookStores=(await api('/api/outlook/stores',{})).stores||[]}catch(x){toast(x.message)}render()};
 $('#pst-form').onsubmit=e=>{e.preventDefault();let p=e.target.elements.path.value.trim().replace(/^"|"$/g,'');if(p)localDo('/api/outlook/source',{source:{path:p}},'Outlook 파일을 추가했습니다.')};
}
function renderLocalDetail(){let f=local.files.find(x=>x.id===localSel);if(!f){$('#detail').innerHTML='<div class="empty">PDF를 선택하면<br>보기·리포트 연결·삭제를 할 수 있습니다.</div>';return}
 let rs=catalog().reports,u='/api/local/file?id='+encodeURIComponent(f.id);
 $('#detail').innerHTML=`<span class="report-date">${esc(f.added.slice(0,10))} 추가 · ${fmtSize(f.size)} · 이 PC 전용</span><h2>📄 ${esc(f.name)}</h2><div class="downloads"><a href="${u}&view=1" target="_blank" rel="noopener">보기</a><a href="${u}">다운로드</a></div>
 <h3>연결된 리포트</h3>${f.reports.map(id=>`<div class="mail-row"><button class="related-card" data-goto-report="${esc(id)}">${esc(reportOf(id)?.title||id)}<small>${esc(reportOf(id)?.date||'')}</small></button><button class="text-button" data-pdf-unlink="${esc(id)}">해제</button></div>`).join('')||'<p class="small-note">연결된 리포트가 없습니다.</p>'}
 <div class="link-form"><select id="pdf-target" aria-label="연결할 리포트"><option value="">리포트 선택…</option>${rs.filter(r=>!f.reports.includes(r.id)).map(r=>`<option value="${esc(r.id)}">${esc(r.date)} · ${esc(r.title)}</option>`).join('')}</select><button id="pdf-link" class="primary">연결</button></div>
 <h3>삭제</h3><button id="pdf-delete" class="danger">이 PC에서 삭제</button>`;
 $('#pdf-link').onclick=()=>{let v=$('#pdf-target').value;if(v)localDo('/api/local/link',{id:f.id,report:v},'리포트에 연결했습니다.')};
 $$('[data-pdf-unlink]').forEach(b=>b.onclick=()=>localDo('/api/local/link',{id:f.id,report:b.dataset.pdfUnlink,remove:true}));
 $('#pdf-delete').onclick=async()=>{if(!confirm(`‘${f.name}’을(를) 이 PC에서 삭제할까요? 되돌릴 수 없습니다.`))return;localSel='';await localDo('/api/local/delete',{id:f.id},'삭제했습니다.')};
}
// Report detail: linked PDFs/mail, Outlook suggestions from the report's companies (±30 days), and a manual search.
function renderReportLocal(r){if(state.setup||!local.available)return;
 let pdfs=local.files.filter(f=>f.reports.includes(r.id)),linked=local.mails.filter(m=>m.report===r.id),sug=mailCache[r.id],box=document.createElement('section');box.className='local-links';
 let list=sug===undefined?(r.companies.length?'':'<p class="small-note">기업 태그가 없어 자동 제안이 없습니다. 직접 검색하세요.</p>'):sug.loading?'<p class="small-note">Outlook에서 찾는 중…</p>':sug.error?`<p class="small-note error">${esc(sug.error)}</p>`:(sug.mails.filter(m=>!linked.some(x=>x.entry_id===m.entry_id)).map(m=>mailRow(m,`<button class="text-button" data-mail-link="${esc(m.entry_id)}">연결</button>`)).join('')||'<p class="small-note">찾은 메일이 없습니다.</p>');
 box.innerHTML=`<h3>🔒 내 자료 <small>이 PC 전용</small></h3>${pdfs.map(f=>`<div class="mail-row"><a class="mail-open" href="/api/local/file?id=${encodeURIComponent(f.id)}&view=1" target="_blank" rel="noopener"><b>📄 ${esc(f.name)}</b><small>${fmtSize(f.size)}</small></a></div>`).join('')}${linked.map(m=>mailRow(m,`<button class="text-button" data-mail-unlink="${esc(m.entry_id)}">해제</button>`)).join('')}${pdfs.length||linked.length?'':'<p class="small-note">연결된 PDF·메일이 없습니다.</p>'}
 ${local.sources.length?`<div class="cloud-title">${sug?.q?`‘${esc(sug.q)}’ 검색 결과`:`관련 메일 제안 · ${esc(r.companies.slice(0,6).join(', '))} · 리포트 전후 30일`}</div>${list}<form class="link-form"><input name="q" placeholder="메일 직접 검색 (제목·본문)" aria-label="메일 직접 검색" value="${esc(sug?.q||'')}"><button class="primary">검색</button></form>`:'<p class="small-note">내 자료 탭에서 Outlook 메일함이나 PST를 지정하면 관련 메일을 찾아 연결할 수 있습니다.</p>'}`;
 let at=$('#detail .downloads');at?at.after(box):$('#detail').append(box);
 box.querySelectorAll('[data-mail-link]').forEach(b=>b.onclick=()=>localDo('/api/outlook/link',{report:r.id,mail:mailPool[b.dataset.mailLink]},'메일을 연결했습니다.'));
 box.querySelectorAll('[data-mail-unlink]').forEach(b=>b.onclick=()=>localDo('/api/outlook/link',{report:r.id,mail:mailPool[b.dataset.mailUnlink],remove:true}));
 let form=box.querySelector('form');if(form)form.onsubmit=e=>{e.preventDefault();findMails(r,form.elements.q.value.trim())};
 if(local.sources.length&&sug===undefined&&r.companies.length)findMails(r);
}
async function findMails(r,q=''){let d=Date.parse(r.date+'T00:00:00Z'),iso=t=>new Date(t).toISOString().slice(0,10);
 let body=q?{terms:q.split(/\s+/).filter(Boolean).slice(0,12),all:true}:{terms:r.companies.slice(0,12),all:false,from:iso(d-30*864e5),to:iso(d+30*864e5)};
 const redraw=()=>{if(selected===r.id&&tab!=='local')renderDetail()};mailCache[r.id]={loading:true,q,mails:[]};redraw();
 try{mailCache[r.id]={q,mails:(await api('/api/outlook/search',body)).mails||[]}}catch(e){mailCache[r.id]={q,mails:[],error:e.message}}redraw()}
document.addEventListener('click',e=>{let o=e.target.closest('[data-mail-open]');if(o){api('/api/outlook/open',{mail:mailPool[o.dataset.mailOpen]}).then(()=>toast('Outlook에서 메일을 엽니다.'),x=>toast(x.message));return}
 let g=e.target.closest('[data-goto-report]');if(g){selected=g.dataset.gotoReport;selectedRelation='';setTab('search')}});
// Files dropped anywhere become 내 자료; the browser must never open or navigate to a dropped file.
let dragDepth=0;const dragFiles=e=>[...(e.dataTransfer?.types||[])].includes('Files');
addEventListener('dragenter',e=>{if(!dragFiles(e))return;e.preventDefault();if(state&&!state.setup&&tab!=='rag'){dragDepth++;$('#drop-overlay').hidden=false}});
addEventListener('dragover',e=>{if(dragFiles(e))e.preventDefault()});
addEventListener('dragleave',e=>{if(dragFiles(e)&&--dragDepth<=0){dragDepth=0;$('#drop-overlay').hidden=true}});
addEventListener('drop',e=>{if(!dragFiles(e))return;e.preventDefault();dragDepth=0;$('#drop-overlay').hidden=true;if(state&&!state.setup&&tab!=='rag')addFiles([...e.dataTransfer.files])});
$('#local-input').onchange=e=>{addFiles([...e.target.files]);e.target.value=''};

// ---- 멀티모달 검색 (optional): proxied to rag/rag_server.py on this PC; nothing here touches catalog/sync.
let rag={status:null,demo:null,hits:[],busy:'',warned:false,hit:null,q:''};
const fmtS=s=>s==null?'-':`${s}초`,fmtN=n=>n==null?'-':Number(n).toLocaleString('ko-KR');
async function ragStatus(){try{rag.status=await api('/api/rag/status')}catch(e){rag.status={available:false,error:e.message}}}
async function renderRag(){if(!rag.status)await ragStatus();const s=rag.status;$('#result-count').textContent=s&&s.ok?`문서 ${(s.docs||[]).length}개 색인 · 이 PC의 임베딩 서비스`:'서비스 연결 안 됨';
 if(!s||!s.ok){$('#results').innerHTML=`<p class="local-note">🧪 실험 기능입니다. 이 PC에서 <b>rag/rag_server.py</b>를 실행한 경우에만 동작하며, 일반 배포본에서는 이 안내만 표시됩니다.</p><div class="empty">${esc((s&&s.error)||'멀티모달 검색 서비스가 실행 중이 아닙니다.')}<br><br><small>준비 방법은 docs/RAG_GUIDE.md를 참고하세요.</small></div><p class="form-actions"><button class="text-button" id="rag-retry">다시 확인</button></p>`;$('#rag-retry').onclick=async()=>{await ragStatus();render()};return}
 const m=s.model||{};
 $('#results').innerHTML=`<p class="local-note">🧪 <b>${esc(m.model||'')}</b> · 오디오 인코더 미적재 · 파라미터 ${fmtN(m.parameters)} · 차원 ${m.dimensions||'-'} · 불러오기 ${fmtS(m.load_seconds)} · ${esc(m.device||'')}<br>올린 PDF와 변환 결과는 <code>${esc(s.index_dir||'%LOCALAPPDATA%\\AVReportHub\\rag\\index')}</code>에 암호화 없이 저장됩니다.</p>
 <div class="dropzone" id="rag-drop" tabindex="0" role="button" aria-label="PDF 색인"><b>PDF를 여기로 끌어다 놓거나 눌러서 선택</b><span>페이지마다 이미지로 변환해 임베딩합니다 · 최대 50MB · 올리기 전 경고를 확인합니다</span></div>
 <form class="link-form" id="rag-query"><input name="q" placeholder="문장으로 검색 (예: 안전요원 없는 무인 운행 허가)" aria-label="멀티모달 검색" value="${esc(rag.q)}"><button class="primary">검색</button></form>
 <div class="form-actions"><button type="button" class="text-button" id="rag-demo">보여 줘 · 모델·첫 페이지 임베딩·유사도</button><button type="button" class="text-button" id="rag-demo-fresh">다시 계산</button></div>
 <div id="rag-out">${rag.busy?`<p class="small-note">${esc(rag.busy)}</p>`:''}${ragDemoHtml()}${ragHitsHtml()}</div>
 <h3 class="local-h">색인된 문서</h3>${(s.docs||[]).map(d=>`<div class="mail-row"><span><b>📄 ${esc(d.name)}</b><small> ${d.pages}쪽 · ${fmtSize(d.size)} · 색인 ${fmtS(d.seconds)}</small></span><button class="text-button" data-rag-del="${esc(d.id)}">삭제</button></div>`).join('')||'<p class="small-note">아직 색인된 PDF가 없습니다.</p>'}`;
 const drop=$('#rag-drop');drop.onclick=()=>$('#rag-input').click();drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#rag-input').click()}};
 drop.ondragover=e=>{e.preventDefault();e.stopPropagation();drop.classList.add('over')};drop.ondragleave=()=>drop.classList.remove('over');drop.ondrop=e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('over');ragAdd([...e.dataTransfer.files])};
 $('#rag-input').onchange=e=>{ragAdd([...e.target.files]);e.target.value=''};
 $('#rag-query').onsubmit=async e=>{e.preventDefault();const q=e.target.elements.q.value.trim();if(!q)return;rag.q=q;rag.busy='검색 중…';render();try{rag.hits=(await api('/api/rag/query',{text:q,top_k:6})).hits||[]}catch(x){toast(x.message)}rag.busy='';render()};
 $('#rag-demo').onclick=()=>ragDemo(false);$('#rag-demo-fresh').onclick=()=>ragDemo(true);
 $$('[data-rag-del]').forEach(b=>b.onclick=async()=>{try{await api('/api/rag/delete',{doc:b.dataset.ragDel});await ragStatus();render()}catch(x){toast(x.message)}})}
function ragDemoHtml(){const d=rag.demo;if(!d)return'';const m=d.model||{},p=d.first_page;
 return`<section class="rag-demo"><h3 class="local-h">모델</h3><table class="rag-table"><tr><th>불러오는 시간</th><td>${fmtS(m.load_seconds)}</td></tr><tr><th>파라미터 수</th><td>${fmtN(m.parameters)}</td></tr><tr><th>임베딩 차원</th><td>${m.dimensions||'-'}</td></tr></table>
 ${p?`<h3 class="local-h">첫 페이지 임베딩 · ${esc(d.pdf||'')}</h3><table class="rag-table"><tr><th>이미지 변환</th><td>${fmtS(p.render_seconds)}</td></tr><tr><th>임베딩</th><td>${fmtS(p.embed_seconds)}</td></tr><tr><th>합계</th><td><b>${fmtS(p.total_seconds)}</b></td></tr><tr><th>크기</th><td>${p.width}×${p.height}px</td></tr></table>`:''}
 ${d.note?`<p class="small-note">${esc(d.note)}</p>`:''}
 ${(d.similarities||[]).length?`<h3 class="local-h">페이지 이미지와 문장의 유사도</h3><table class="rag-table">${d.similarities.map(x=>`<tr><th>${esc(x.label)}</th><td><b>${x.similarity.toFixed(4)}</b></td><td>${esc(x.sentence)}</td></tr>`).join('')}</table>`:''}</section>`}
function ragHitsHtml(){if(!rag.hits.length)return rag.q&&!rag.busy?`<p class="small-note">‘${esc(rag.q)}’에 맞는 페이지가 없습니다.</p>`:'';
 return`<h3 class="local-h">‘${esc(rag.q)}’ 검색 결과</h3><div class="rag-hits">${rag.hits.map((h,i)=>`<button class="rag-hit" data-rag-hit="${i}"><img src="${h.thumb}" alt=""><span><b>${esc(h.name)}</b> p.${h.page}<small>유사도 ${h.similarity.toFixed(4)}</small></span></button>`).join('')}</div>`}
async function ragDemo(fresh){rag.busy=fresh?'모델과 첫 페이지를 다시 계산하는 중… (CPU에서 수십 초)':'계산 결과를 불러오는 중…';render();try{const d=await api('/api/rag/demo'+(fresh?'?fresh=1':''));if(d.error)throw Error(d.error);rag.demo=d}catch(x){toast(x.message)}rag.busy='';render()}
function ragWarn(){return new Promise(res=>{if(rag.warned)return res(true);const dlg=$('#rag-warning');const done=ok=>{dlg.close();if(ok&&$('#rag-warning-skip').checked)rag.warned=true;res(ok)};$('#rag-warning-ok').onclick=()=>done(true);$('#rag-warning-cancel').onclick=()=>done(false);dlg.oncancel=e=>{e.preventDefault();done(false)};dlg.showModal()})}
async function ragAdd(files){files=files.filter(f=>/\.pdf$/i.test(f.name)||f.type==='application/pdf');if(!files.length)return toast('PDF만 올릴 수 있습니다.');
 if(!await ragWarn())return toast('취소했습니다. 아무것도 전송하지 않았습니다.');
 for(const f of files){if(f.size>50*1048576){toast(`${f.name}: 50MB를 넘습니다.`);continue}rag.busy=`${f.name} 색인 중… 페이지 수에 따라 몇 분 걸릴 수 있습니다.`;render();
  try{const r=await fetch('/api/rag/index?name='+encodeURIComponent(f.name),{method:'POST',headers:{'X-AV-Request':'1','Content-Type':'application/pdf'},body:f});if(!r.ok)throw Error(await r.text());const v=await r.json();if(v.error)throw Error(v.error);toast(v.created?`${f.name}: ${v.pages}쪽 색인 완료 (${v.seconds}초)`:`${f.name}: 이미 색인된 문서입니다.`)}catch(x){toast(`${f.name}: ${x.message}`)}}
 rag.busy='';await ragStatus();render()}
function renderRagDetail(){const h=rag.hit;if(!h){$('#detail').innerHTML='<div class="empty">검색 결과의 페이지를 누르면<br>여기에 크게 표시됩니다.</div>';return}
 $('#detail').innerHTML=`<div class="detail-head"><h2>${esc(h.name)} · p.${h.page}</h2><p class="small-note">유사도 ${h.similarity.toFixed(4)} · 이 PC의 임베딩 서비스 결과</p></div><img class="rag-page" src="/api/rag/page?doc=${encodeURIComponent(h.doc)}&page=${h.page}" alt="">`}
addEventListener('click',e=>{const b=e.target.closest('[data-rag-hit]');if(b){rag.hit=rag.hits[+b.dataset.ragHit];renderDetail()}});
