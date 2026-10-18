'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let state, tab='search', selected='', selectedRelation='', formBusy=false;
let searchTimer=0,reportListLimit=50,reportListKey='';
const narrowReportLayout=matchMedia('(max-width:850px)'),expandedLocalLinks=new Set();
let reportReaderOpen=false,reportListScroll=0,reportListFocus=null,reportDetailHadFocus=false;
let importedReports=[],localReportsRevision='',importError='',mergedSource=null,mergedCatalog=null,lastSyncState='',outlookImportState={};
let mergedImports=null,mergedVisibility=null,dailyRepresentatives=new Map(),dailyStatuses=new Map(),dailySearchMembers=new Map();
let local={available:false,reason:'',files:[],mails:[],sources:[]},localSel='',outlookStores=null,outlookFolders=null,linkedReport='';
let networkSources={outlook:true,daily:true,local:true,notes:true},networkSelection=null,currentDocuments={nodes:[],links:[]};
let noteNetworkState={loaded:false,loading:false,nodes:[],links:[],warnings:[],signature:'',error:''},noteNetworkRequest=0;
let localPDFPreview=null,dialogPDFPreview=null;
let pdfLinksID='',pdfLinkBusy=false;const deletingPDFs=new Set();
try{const saved=JSON.parse(localStorage.getItem('av_network_sources')||'null');for(const key of Object.keys(networkSources))if(typeof saved?.[key]==='boolean')networkSources[key]=saved[key]}catch(e){}
const networkView=()=>tab==='graph'||tab==='map';
const reportSource=r=>r.origin==='outlook-report'?'outlook':'daily';
const reportOriginLabel=r=>r.origin==='outlook-report'?'Outlook':r.origin==='markdown'?'직접 가져온 MD':'게시 리포트';
const reportLinkOption=r=>`<option value="${esc(r.id)}">${esc(reportOriginLabel(r))} · ${esc(r.date)} · ${esc(r.title)}</option>`;
const sourceLabel=source=>({outlook:'Outlook',daily:'데일리 리포트',local:'내 자료',notes:'내 노트'}[source]);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL=s=>{try{let u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:''}catch{return ''}};
const uiIconPaths={
 company:'M4 21V3h16v18M2 21h20M8 7h2m4 0h2M8 11h2m4 0h2M8 15h2m4 0h2M10 21v-3h4v3',
 person:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
 pin:'M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 0 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
 file:'M14 3H5v18h14V8l-5-5ZM14 3v6h5M8 13h8M8 17h6',
 lock:'M6 10h12v11H6ZM8 10V7a4 4 0 0 1 8 0v3M12 14v3',
 mail:'M3 5h18v14H3ZM3 6l9 7 9-7',
 image:'M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M9 7h.01',
 flask:'M9 3h6M10 3v6L4 19q-1 2 2 2h12q3 0 2-2L14 9V3M8 14h8'
};
const uiIcon=(name,inGraph=false)=>{
 const shape=`<path d="${uiIconPaths[name]||uiIconPaths.file}"/>`;
 return inGraph?`<g class="ui-icon" transform="translate(-12 -12)" aria-hidden="true">${shape}</g>`:`<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shape}</svg>`;
};
// kind 'company'|'tag' makes the chip a filter shortcut (see bindChips).
const chip=(s,c='',kind='',count=null)=>`<${kind?'button':'span'} class="chip ${c}${kind&&activeFilter(kind)===s?' active':''}"${kind?` type="button" data-${kind}="${esc(s)}" aria-pressed="${activeFilter(kind)===s}" title="이 ${kind==='company'?'기업':'분류'}로 필터"`:''}>${esc(s)}${count===null?'':`<b>${count}</b>`}</${kind?'button':'span'}>`;
const activeFilter=kind=>$(tab==='outlook'?'#outlook-query':kind==='company'?'#company':'#category').value;
// Graph/timeline items must themselves mention every query term, not just belong to a matching report.
const matches=(...fields)=>{let ts=terms().map(t=>t.toLocaleLowerCase());if(!ts.length)return true;let s=fields.flat().join(' ').toLocaleLowerCase();return ts.every(t=>s.includes(t))};
function bindChips(root){root.querySelectorAll('[data-company],[data-tag]').forEach(el=>{el.onclick=e=>{
 e.stopPropagation();const kind=el.dataset.company!==undefined?'company':'tag',v=el.dataset[kind],sel=$(tab==='outlook'?'#outlook-query':kind==='company'?'#company':'#category');
 const reportID=el.closest('.report-card-shell')?.querySelector('[data-report]')?.dataset.report;
 sel.value=sel.value===v?'':v;render();
 const chips=[...root.querySelectorAll('[data-'+kind+']')].filter(b=>b.dataset[kind]===v);
 const target=chips.find(b=>b.closest('.report-card-shell')?.querySelector('[data-report]')?.dataset.report===reportID)||chips[0];
 (target||$(tab==='outlook'?'#outlook-query':'#filter-toggle')).focus({preventScroll:true});
 }})}
function renderTagCloud(){let count=(xs)=>{let m=new Map();xs.forEach(x=>m.set(x,(m.get(x)||0)+1));return [...m].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))};
 let tags=count(catalog().reports.flatMap(r=>tab==='map'?mapReportTags(r):r.tags)),cos=count(catalog().reports.flatMap(r=>tab==='map'?mapReportCompanies(r):realCompanies(r))).slice(0,14);
 $('#tag-cloud').innerHTML=`<div><div class="cloud-title">분류</div><div class="chips">${tags.map(([t,n])=>chip(t,'','tag',n)).join('')}</div></div><div><div class="cloud-title">기업</div><div class="chips">${cos.map(([t,n])=>chip(t,'teal','company',n)).join('')}</div></div>`;bindChips($('#tag-cloud'))}
const sources=ss=>(ss||[]).map(s=>{let u=safeURL(s.url);return u?`<a class="source-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">↗ ${esc(s.title||u)}</a>`:''}).join('');
async function api(path,body,options={}){let opts=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-AV-Request':'1'},body:JSON.stringify(body)};let r=await fetch(path,{...opts,signal:options.signal});if(!r.ok)throw Error(await r.text());return r.json()}
function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,5000)}
const reportReading=window.createReportReading({api,identity:reportIdentity,changed:renderReportReading});
let readingCatalog=null,readingImports=null;
function refreshReportReading(){
 if(!state||state.setup)return Promise.resolve();
 const source=state.snapshot.catalog,imports=importedReports;
 const reports=source!==readingCatalog||imports!==readingImports?[...source.reports,...imports]:undefined;
 return reportReading.refresh(reports,{initialize:!importError}).then(()=>{readingCatalog=source;readingImports=imports}).catch(()=>{});
}
function markReportRead(id){
 const report=reportOf(id);
 if(report)reportReading.mark(report).catch(e=>toast(e.message));
}
function renderReportReading(){
 if(!state)return;
 const count=dailyCatalog().reports.filter(r=>reportReading.unread(r.id)).length;
 const badge=$('#report-unread-count'),status=$('#report-unread-status');
 badge.hidden=!count&&!reportReading.error;badge.textContent=reportReading.error?'!':count>99?'99+':String(count);
 const message=reportReading.error?`데일리리포트 · 새 문서 수 확인 필요: ${reportReading.error}`:!reportReading.ready?'데일리리포트 · 새 문서 수 확인 중':count?`데일리리포트 · 아직 열지 않은 새 문서 ${count}개`:'데일리리포트 · 새 문서 없음';
 if(status.textContent!==message)status.textContent=message;
 $('#tab-search').title=message;
 // Update the small labels in place; do not recreate focused list controls.
 $$('#results [data-report]').forEach(button=>{
  const meta=button.querySelector('.card-meta');if(!meta)return;
  const existing=meta.querySelector('.report-new'),unread=reportReading.unread(button.dataset.report);
  if(unread&&!existing){const label=document.createElement('span');label.className='report-new';label.textContent='새 문서';meta.prepend(label)}
  else if(!unread&&existing)existing.remove();
 });
}
// Catalog visibility policy also applies to older snapshots received by sync.
// Keep the title rule aligned with data/companies.json and import-history.py.
let catalogViews=new WeakMap(),hiddenReports=new Set(),deletedReports=new Set(),restoreSelection=new Set(),visibilityError='',visibilityBusy=false,refreshRequest=0;
function applyReportVisibility(v={}){
 const ids=v.hidden_reports||[],error=v.error||'';
 const deleted=v.deleted_reports||[];
 if(JSON.stringify([...hiddenReports])===JSON.stringify(ids)&&JSON.stringify([...deletedReports])===JSON.stringify(deleted)&&visibilityError===error)return false;
 deletedReports=new Set(deleted);
 hiddenReports=new Set(ids);restoreSelection=new Set([...restoreSelection].filter(id=>hiddenReports.has(id)));visibilityError=error;catalogViews=new WeakMap();return true;
}
function renderVisibilityControls(){
 $('#hidden-count').textContent=visibilityError||`내 화면에서 숨긴 리포트 ${hiddenReports.size}개`;
 $('#visibility-label').textContent=visibilityError?'숨김 관리 · 확인 필요':hiddenReports.size?`숨김 관리 · ${hiddenReports.size}`:'숨김 관리';
 $('#restore-reports').disabled=visibilityBusy||(!hiddenReports.size&&!visibilityError);
 $('#restore-reports').onclick=()=>{setTab('settings');$('#restore-section').scrollIntoView({block:'start'})};
 const hide=$('#hide-report');if(hide)hide.disabled=visibilityBusy||!!visibilityError;
 $$('[data-hide-report]').forEach(b=>{b.disabled=visibilityBusy||!!visibilityError;b.onclick=()=>{const id=b.dataset.hideReport,r=reportOf(id);window.AVSelection.remove(window.AVSelection.forItem({kind:'report',id,title:r?.title||id}))}});
 $('#restore-count').textContent=`총 ${hiddenReports.size}개 · ${restoreSelection.size}개 선택`;
 $('#restore-selected').disabled=visibilityBusy||!!visibilityError||!restoreSelection.size;
 $('#restore-all-settings').disabled=visibilityBusy||(!hiddenReports.size&&!visibilityError);
 const all=$('#restore-select-all');all.disabled=visibilityBusy||!!visibilityError||!hiddenReports.size;all.checked=hiddenReports.size>0&&restoreSelection.size===hiddenReports.size;all.indeterminate=restoreSelection.size>0&&restoreSelection.size<hiddenReports.size;
 $$('[data-restore-report]').forEach(c=>{c.checked=restoreSelection.has(c.dataset.restoreReport);c.disabled=visibilityBusy||!!visibilityError});
 $('#restore-selected').onclick=()=>changeReportVisibility('restore',[...restoreSelection]);
 $('#restore-all-settings').onclick=()=>changeReportVisibility('restore-all');
 all.onchange=()=>{restoreSelection=all.checked?new Set(hiddenReports):new Set();renderVisibilityControls()};
}
function renderRestoreList(){
 const reports=new Map([...(state.snapshot.catalog.reports||[]),...importedReports].map(r=>[r.id,r]));
 $('#restore-error').hidden=!visibilityError;$('#restore-error').textContent=visibilityError;
 $('#restore-list').innerHTML=[...hiddenReports].sort((a,b)=>(reports.get(b)?.date||b).localeCompare(reports.get(a)?.date||a)).map(id=>{const r=reports.get(id);return `<label class="restore-row"><input type="checkbox" data-restore-report="${esc(id)}" ${restoreSelection.has(id)?'checked':''}><span><b>${esc(r?.title||'현재 자료에 없는 리포트')}</b><small>${esc(r?.date||id)} · ${r?esc(r.origin==='outlook-report'?'Outlook':r.origin?'직접 가져온 리포트':'데일리 리포트'):'숨김 설정만 복원'}</small></span></label>`}).join('')||`<p class="small-note">${visibilityError?'전체 복원으로 숨김 설정을 초기화할 수 있습니다.':'삭제한 리포트가 없습니다.'}</p>`;
 $$('[data-restore-report]').forEach(c=>c.onchange=()=>{if(c.checked)restoreSelection.add(c.dataset.restoreReport);else restoreSelection.delete(c.dataset.restoreReport);renderVisibilityControls()});
 renderVisibilityControls();
}
async function changeReportVisibility(action,reportID){
 if(visibilityBusy)return;
 visibilityBusy=true;++refreshRequest;renderVisibilityControls();
 try{
  const v=await api('/api/report-visibility',action==='restore'||Array.isArray(reportID)?{action,report_ids:reportID}:{action,report_id:reportID});
  applyReportVisibility(v);updateCatalogView();
  toast(action==='hide'?'목록에서 삭제했습니다. 원본은 보관되며 설정에서 복원할 수 있습니다.':action==='restore'?'선택한 리포트를 복원했습니다. 검색 조건은 유지됩니다.':'숨긴 리포트를 모두 복원했습니다. 검색 조건은 유지됩니다.');
 }catch(e){toast(e.message)}finally{visibilityBusy=false;renderVisibilityControls()}
}
function visibleCatalog(source){
 if(catalogViews.has(source))return catalogViews.get(source);
 const compact=s=>String(s??'').replace(/\s+/g,'');
 const reports=source.reports.filter(r=>!hiddenReports.has(r.id)&&!deletedReports.has(r.id)&&compact(r.title)!=='주요신규업데이트없음')
  .map(r=>({...r,tags:(r.tags||[]).filter(t=>compact(t)!=='과거발송본')}));
 const ids=new Set(reports.map(r=>r.id));
 const view={...source,reports,
  events:source.events.filter(e=>ids.has(e.report_id)),
  relations:source.relations.filter(r=>ids.has(r.report_id)),
  related:source.related.filter(r=>ids.has(r.from)&&ids.has(r.to))};
 catalogViews.set(source,view);
 return view;
}
function reportIdentity(r){
 const body=String(r.body_markdown||'').replace(/\r\n?/g,'\n').trim().replace(/^---\n[\s\S]*?\n---\s*\n/,'').split('\n').map(line=>line.trimEnd()).join('\n').trim();
 return body?r.date+'\n'+body:r.id;
}
function dailyCatalog(){
 const source=state.snapshot.catalog;
 if(mergedSource!==source||mergedImports!==importedReports||mergedVisibility!==hiddenReports){
  // Imported MD/mail have already passed REPORT_FORMAT validation. Identical content appears once,
  // preferring published evidence. A hidden member hides its daily group even after sync changes its ID.
  const groups=new Map(),allReports=[...source.reports,...importedReports.filter(r=>reportSource(r)==='daily'),...importedReports.filter(r=>reportSource(r)==='outlook')];
  for(const r of allReports){
   const key=importedReports.length?reportIdentity(r):r.id;let group=groups.get(key);
   if(!group){group={report:r,ids:[],hidden:false};groups.set(key,group)}
   group.ids.push(r.id);group.hidden=group.hidden||hiddenReports.has(r.id);
  }
  const reports=[...groups.values()].filter(g=>!g.hidden).map(g=>g.report);
  const added=reports.filter(r=>r.origin);
  mergedCatalog=visibleCatalog({...source,reports,events:[...source.events,...added.map(r=>({id:'date-'+r.id,date:r.date,title:r.title,status:'보고일',report_id:r.id,detail:'가져온 리포트의 보고일',companies:r.companies,sources:r.sources}))]});
  const visibleIDs=new Set(mergedCatalog.reports.map(r=>r.id));
  dailyRepresentatives=new Map();dailyStatuses=new Map();
  for(const group of groups.values())for(const id of group.ids){
   const visible=visibleIDs.has(group.report.id);
   if(visible)dailyRepresentatives.set(id,group.report.id);
   dailyStatuses.set(id,visible?(id===group.report.id?'데일리에 추가됨':'중복 · 데일리에 있음'):'데일리 목록에서 숨김');
  }
  // Search the visible originals without merging their metadata into published evidence.
  dailySearchMembers=new Map(mergedCatalog.reports.map(r=>[r.id,[]]));
  for(const r of visibleCatalog({...source,reports:allReports}).reports)dailySearchMembers.get(dailyRepresentatives.get(r.id))?.push(r);
  mergedSource=source;mergedImports=importedReports;mergedVisibility=hiddenReports;
 }
 return mergedCatalog;
}
function outlookDailyStatus(r){dailyCatalog();return dailyStatuses.get(r.id)||'데일리 목록에서 숨김'}
function catalog(){
 const source=state.snapshot.catalog;
 if(tab==='map')return mapCatalog();
 // The relationship view keeps each source record with its original published evidence.
 if(networkView())return visibleCatalog({...source,reports:[...source.reports,...importedReports].filter(r=>networkSources[reportSource(r)])});
 if(tab==='outlook')return visibleCatalog({...source,reports:importedReports.filter(r=>reportSource(r)==='outlook')});
 if(['local','rag','settings'].includes(tab))return visibleCatalog({...source,reports:[...source.reports,...importedReports]});
 return dailyCatalog();
}
const reportOf=id=>visibleCatalog({...state.snapshot.catalog,reports:[...state.snapshot.catalog.reports,...importedReports]}).reports.find(r=>r.id===id);
// End catalog visibility policy
const terms=()=>$(tab==='outlook'?'#outlook-query':'#query').value.trim().split(/\s+/).filter(Boolean);
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
function searchText(r){return strict()?[r.title,...(r.origin?[...r.tags,r.mail?.subject||'']:[]),substantive(r)].join('\n').toLocaleLowerCase():[r.title,r.summary,r.body_markdown,...r.companies,...r.tags,r.mail?.subject||''].join(' ').toLocaleLowerCase()}
function mentions(r,co){if(r.origin)return r.companies.includes(co);return !strict()||r.title.toLocaleLowerCase().includes(co.toLocaleLowerCase())||substantive(r).includes(co.toLocaleLowerCase())}
const realCompanies=r=>r.companies.filter(c=>mentions(r,c));
function filtered(){
 const q=$('#query').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),co=$('#company').value,cat=$('#category').value,from=$('#from').value,to=$('#to').value,c=catalog();
 const match=r=>(!co||((r.companies||[]).includes(co)&&mentions(r,co)))&&(!cat||(r.tags||[]).includes(cat))&&(!from||r.date>=from)&&(!to||r.date<=to)&&q.every(t=>searchText(r).includes(t));
 return c.reports.filter(r=>(tab==='map'?mapReportMembers(r):c===mergedCatalog?dailySearchMembers.get(r.id)||[r]:[r]).some(match)).sort((a,b)=>$('#sort').value==='desc'?b.date.localeCompare(a.date):a.date.localeCompare(b.date));
}
const deleteIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
function reportCard(r,i=0){return `<div class="report-card-shell"><button type="button" class="report-card ${selected===r.id?'selected':''}" data-report="${esc(r.id)}" data-list-index="${i}"><div class="card-head"><span class="report-date">${esc(r.date)}</span><span class="card-meta">${tab==='outlook'?outlookDailyStatus(r):r.origin==='outlook-report'?'Outlook':r.attachments.length?'MD · PPTX':''}</span></div><h3>${esc(r.title)}</h3><p>${esc(r.summary)}</p></button><div class="chips">${r.companies.map(s=>mentions(r,s)?chip(s,'teal','company'):chip(s,'teal faint','company').replace('title="','title="점검 결과 ‘없음’으로만 언급 · ')).join('')}${r.tags.map(s=>chip(s,'','tag')).join('')}</div><button type="button" class="list-delete" data-hide-report="${esc(r.id)}" aria-label="${esc(r.title)} 목록에서 삭제" title="목록·관계·지도에서 숨기기 · 원본 보관 · 설정에서 복원">${deleteIcon}<span>삭제</span></button></div>`}
function renderStats(rs){let c=catalog(),ids=new Set(rs.map(r=>r.id));let cos=new Set(rs.flatMap(r=>tab==='map'?mapReportCompanies(r):realCompanies(r)));let ev=c.events.filter(e=>ids.has(e.report_id)).length,rel=c.relations.filter(r=>ids.has(r.report_id)).length;
 $('#stats').innerHTML=[['리포트',rs.length,c.reports.length],['기업',cos.size,null],['사건',ev,null],['관계',rel,null]].map(([k,v,t])=>`<span class="stat"><span>${k}</span><b>${v}${t!=null&&t!==v?` <em>/ ${t}</em>`:''}</b></span>`).join('')}
function saveStrict(){try{localStorage.setItem('av_strict',$('#strict').checked?'1':'0')}catch(e){}}
const reportListView=()=>['search','timeline','outlook'].includes(tab);
function updateReportReader(){
 $('#viewer').classList.toggle('report-reading',narrowReportLayout.matches&&reportListView()&&reportReaderOpen&&!!selected);
}
function focusReportTitle(){$('#report-title')?.focus({preventScroll:true})}
function selectReport(id,{fromDetail=false,exactSource=false}={}){
 const openReader=narrowReportLayout.matches&&reportListView();
 if(openReader&&!reportReaderOpen){reportListScroll=scrollY;reportListFocus=document.activeElement}
 selected=id;selectedRelation='';linkedReport=exactSource?id:'';networkSelection=null;
 if(openReader)reportReaderOpen=true;
 updateReportReader();
 // Keep list nodes mounted so focus and the list's scroll position survive selection.
 $$('[data-report]').forEach(b=>{const active=b.dataset.report===selected;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active))});
 renderDetail();renderVisibilityControls();
 markReportRead(id);
 if(openReader){window.scrollTo({top:0,behavior:'instant'});focusReportTitle()}
 else if(fromDetail)focusReportTitle();
}
function returnToReportList(){
 reportReaderOpen=false;updateReportReader();
 window.scrollTo({top:reportListScroll,behavior:'instant'});
 const target=reportListFocus?.isConnected&&$('#results').contains(reportListFocus)?reportListFocus:$$('#results [data-report]').find(b=>b.dataset.report===selected);
 (target||$('#view-panel')).focus({preventScroll:true});
}
narrowReportLayout.addEventListener('change',()=>{
 const wasReading=reportReaderOpen;reportReaderOpen=false;updateReportReader();
 if(!reportListView())return;
 // CSS can hide the focused reader before this media-query callback fires.
 const readerFocused=$('#detail').contains(document.activeElement)||(document.activeElement===document.body&&reportDetailHadFocus);
 if(narrowReportLayout.matches&&readerFocused)returnToReportList();
 else if(!narrowReportLayout.matches&&wasReading)focusReportTitle();
});
function renderSearchContext(){
 const notesView=tab==='notes',settings=tab==='settings',reports=!notesView&&!settings&&tab!=='local'&&tab!=='rag'&&tab!=='outlook';
 $('#viewer').setAttribute('data-view',tab);
 updateReportReader();
 $('#view-panel').setAttribute('aria-labelledby','tab-'+tab);
 $$('[data-tab]').forEach(b=>{const active=b.dataset.tab===tab;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1});
 $('#settings-page').hidden=!settings;$('.workspace').hidden=settings||notesView;if(!notesView)window.AVNotes?.hide();
 $('#search-toolbar').hidden=notesView||settings||tab==='rag';$('#report-import-panel').hidden=settings||tab==='rag'||tab==='outlook';$('#report-import-status').hidden=notesView||settings||tab==='rag'||tab==='outlook';
 $('#report-query').hidden=!reports;$('#local-query-bar').hidden=tab!=='local';$('#outlook-query-bar').hidden=tab!=='outlook';
 $('#report-filters').hidden=!reports;$('#stats').hidden=!reports;$('#visibility-menu').hidden=!reports&&tab!=='outlook';
 $('#sort').hidden=tab!=='search'&&tab!=='timeline';$('#filter-scope').hidden=!networkView();
 $('#source-controls').hidden=!networkView();
 for(const key of Object.keys(networkSources))$('#source-'+key).checked=networkSources[key];
 if(!reports)return;
 const invalidRange=!!($('#from').value&&$('#to').value&&$('#from').value>$('#to').value);
 $('#date-filter-error').hidden=!invalidRange;$('#to').setAttribute('aria-invalid',String(invalidRange));
 $('#to').setCustomValidity(invalidRange?'종료일은 시작일과 같거나 뒤여야 합니다.':'');
 const filters=[['query','검색어'],['company','기업'],['category','분류'],['from','시작일'],['to','종료일']].filter(([id])=>$('#'+id).value.trim()).map(([id,label])=>[id,`${label}: ${$('#'+id).value.trim()}`]);
 if(strict())filters.push(['strict','실제 언급만']);
 $('#active-filters').innerHTML=filters.map(([id,label])=>`<button type="button" class="active-filter" data-clear-filter="${id}" aria-label="${esc(label)} 해제">${esc(label)}<span aria-hidden="true">×</span></button>`).join('');
 $('#active-filters').querySelectorAll('[data-clear-filter]').forEach(b=>b.onclick=()=>{const id=b.dataset.clearFilter;if(id==='strict'){$('#strict').checked=false;saveStrict()}else $('#'+id).value='';render();$('#filter-toggle').focus()});
}
function reportPageMore(total){return total>reportListLimit?`<button type="button" id="reports-more">${tab==='timeline'?'사건':'리포트'} 더 보기 (${Math.min(reportListLimit,total)} / ${total})</button>`:''}
function render(){clearTimeout(searchTimer);if(!state)return;renderSearchContext();renderReportReading();if(tab==='notes'){window.AVNotes?.show();return}
 const listKey=JSON.stringify([tab,...['query','company','category','from','to','sort','outlook-query'].map(id=>$('#'+id).value),strict()]);
 if(listKey!==reportListKey){reportListKey=listKey;reportListLimit=50}
 if(tab!=='map'&&mapSim)mapSim.stop();
 if(tab!=='local'&&localPDFPreview){localPDFPreview.dispose();localPDFPreview=null}
 if(tab==='settings'){if(!state.setup&&!$('#settings-slot').querySelector('form'))mountForm('#settings-slot');renderRestoreList();return}
 let rs=filtered(),ids=new Set(rs.map(r=>r.id));$('#view-title').textContent={search:'데일리리포트',timeline:'이슈의 흐름',graph:'기업·사건과 자료의 연결',map:'리포트·자료 전체 지도',outlook:'Outlook',local:'내 자료 · 이 PC 전용',rag:'AI 검색 · 실험 기능'}[tab];$('#result-count').textContent=`${rs.length}개 리포트 · 원문 및 사전 분석 데이터`;if(tab!=='local'&&tab!=='rag'&&tab!=='outlook'){renderStats(rs);renderTagCloud()}
 if(tab==='search')$('#results').innerHTML=rs.slice(0,reportListLimit).map(reportCard).join('')+reportPageMore(rs.length)||`<div class="empty">${catalog().reports.length?'검색 결과가 없습니다.<br>검색어나 기간을 바꿔 보세요.':state.syncing?'GitHub 리포트를 가져오고 있습니다…':state.snapshot.commit?'아직 표시할 리포트가 없습니다.':'표시할 리포트가 없습니다.<br>설정에서 GitHub 자료 연동을 켜거나<br>Outlook·MD 리포트를 가져오세요.'}</div>`;
 if(tab==='timeline'){let es=catalog().events.filter(e=>ids.has(e.report_id)&&matches(e.title,e.detail,e.status,e.companies)).sort((a,b)=>$('#sort').value==='desc'?b.date.localeCompare(a.date):a.date.localeCompare(b.date));let month='';$('#results').innerHTML='<p class="small-note">사건 날짜와 보관 기록을 표시합니다. ‘보고일’은 사건 발생일이 아니며, 계획은 완료 사실과 구분합니다.</p><div class="timeline">'+es.slice(0,reportListLimit).map((e,i)=>{let m=e.date.slice(0,7),head=m!==month?`<div class="month">${esc(m.replace('-','년 '))}월</div>`:'';month=m;return head+`<div class="event ${e.status==='계획'?'plan':''}" data-list-index="${i}"><div class="report-card-shell"><button type="button" class="report-card ${selected===e.report_id?'selected':''}" data-report="${esc(e.report_id)}"><div class="card-head"><span class="report-date">${esc(e.date)}</span>${chip(e.status,e.status==='계획'?'amber':'teal')}</div><h3>${esc(e.title)}</h3><p>${esc(e.detail)}</p></button><div class="chips">${e.companies.map(c=>chip(c,'','company')).join('')}</div></div></div>`}).join('')+'</div>'+reportPageMore(es.length)+(es.length?'':'<div class="empty">이 조건에 미리 정리된 사건이 없습니다.</div>')}
 if(tab==='graph')renderGraph(ids);else if(tab==='map')renderMap(rs);else if(tab==='local')renderLocal();else if(tab==='outlook')renderOutlook();else if(tab==='rag')renderRag();else highlight($('#results'));
 bindChips($('#results'));
 $('#reports-more')?.addEventListener('click',()=>{const next=reportListLimit;reportListLimit+=50;render();const row=$('#results [data-list-index="'+next+'"]');(row?.matches('[data-report]')?row:row?.querySelector('[data-report]'))?.focus()});
 $$('[data-report]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.report===selected));b.onclick=()=>selectReport(b.dataset.report)});renderDetail();renderVisibilityControls();renderReportReading();if(pdfLinksID)renderPDFLinksDialog();
}
function invalidateNoteNetwork(){++noteNetworkRequest;noteNetworkState.loaded=false;noteNetworkState.loading=false}
async function loadNoteNetwork(force=false){
 if(!networkSources.notes||noteNetworkState.loading||noteNetworkState.loaded&&!force||!window.AVNotes)return;
 const request=++noteNetworkRequest,wasLoaded=noteNetworkState.loaded,oldError=noteNetworkState.error;
 noteNetworkState.loading=true;
 let changed=false;
 try{
  const model=await window.AVNotes.network();if(request!==noteNetworkRequest)return;
  const signature=JSON.stringify([model.nodes.map(n=>[n.id,n.ref.version,n.ref.path,n.ref.modified]),model.warnings]);
  changed=signature!==noteNetworkState.signature||!!oldError;
  noteNetworkState={...model,signature,error:'',loaded:true,loading:false};
 }catch(e){
  if(request!==noteNetworkRequest)return;
  changed=oldError!==e.message||noteNetworkState.nodes.length>0;
  noteNetworkState={loaded:true,loading:false,nodes:[],links:[],warnings:[],signature:'',error:e.message};
 }
 if(networkView()&&networkSources.notes&&(changed||!wasLoaded))render();
}
function noteNetworkStatusHTML(){
 if(!networkSources.notes)return '';
 const n=noteNetworkState;
 if(n.error)return `<p class="small-note error" role="status">노트를 불러오지 못했습니다: ${esc(n.error)} <button type="button" data-note-network-refresh>다시 시도</button></p>`;
 if(!n.loaded)return '<p class="small-note" role="status">노트 파일을 읽고 있습니다…</p>';
 return n.warnings.length?`<p class="small-note error" role="status">${esc(n.warnings.join(' / '))}</p>`:'';
}
function networkItemButton(n){return `<button class="related-card" data-network-node="${esc(n.id)}"><small>${esc(sourceLabel(n.source))}</small> ${esc(n.label)}</button>`}
function bindNetworkItems(){
 $$('[data-note-network-refresh]').forEach(b=>b.onclick=()=>loadNoteNetwork(true));
 $$('[data-network-node]').forEach(b=>b.onclick=()=>{const n=currentDocuments.nodes.find(n=>n.id===b.dataset.networkNode);if(!n)return;if(tab==='map'){selectMapNode(n.id);return}if(n.kind==='report'){networkSelection=null;selected=n.ref.id;selectedRelation='';renderDetail();markReportRead(selected)}else selectNetwork('node',n.id)});
 $$('[data-edit-network-note]').forEach(b=>b.onclick=()=>window.AVNotes.open(b.dataset.editNetworkNote).catch(e=>toast(e.message)));
}
// Saved source/reference edges are distinct from published company/event assertions.
function buildDocumentNetwork(rs){
 const representatives=rs;
 if(tab==='map')rs=rs.flatMap(mapReportMembers);
 const nodes=[],links=[],byID=new Map();
 const add=(id,kind,label,ref,source)=>{if(byID.has(id))return byID.get(id);const node={id,kind,label,ref,source};nodes.push(node);byID.set(id,node);return node};
 const link=(id,from,report,label,evidence)=>{const to=byID.get('r:'+report);if(to)links.push({id,from:from.id,to:to.id,label,evidence,report_id:report})};
 const mail=m=>add('mail:'+String(m.store_id||m.path||'')+':'+m.entry_id,'mail',m.subject||'(제목 없음)',m,'outlook');
 for(const r of rs)add('r:'+r.id,'report',r.title,r,reportSource(r));
 if(networkSources.outlook){
  for(const r of rs)if(reportSource(r)==='outlook'&&r.mail)link('origin:'+r.id,mail(r.mail),r.id,'원본 메일','이 메일의 REPORT_FORMAT 본문 또는 MD 첨부에서 가져온 리포트입니다. 기업·사건 관계를 자동 추론하지 않습니다.');
  for(const [i,m] of local.mails.entries())if(matches(m.subject,m.sender,m.folder))link('mail-link:'+i,mail(m),m.report,'직접 연결','사용자가 이 메일과 리포트를 연결한 기록입니다. 연결 자체가 기업·사건의 사실 관계를 뜻하지 않습니다.');
 }
 if(networkSources.local)for(const f of local.files)if(matches(f.name)){
  const node=add('pdf:'+f.id,'pdf',f.name,f,'local');
  for(const report of f.reports||[])link('pdf-link:'+f.id+':'+report,node,report,'직접 연결','사용자가 내 자료에서 이 PDF와 리포트를 연결한 기록입니다. 원문을 열어 근거를 확인할 수 있습니다.');
 }
 if(networkSources.notes){
  for(const n of noteNetworkState.nodes)if(matches(n.label,n.ref.path,n.ref.body,n.ref.tags))add(n.id,n.kind,n.label,n.ref,n.source);
  for(const e of noteNetworkState.links)if(byID.has(e.from)&&byID.has(e.to))links.push(e);
 }
 const model=typeof extendDocumentConnections==='function'?extendDocumentConnections({nodes,links},rs):{nodes,links};
 return tab==='map'?mergeMapDocuments(model,representatives):model;
}
function documentConnectionsHtml(model){
 const byID=new Map(model.nodes.map(n=>[n.id,n])),short=s=>esc(s.length>25?s.slice(0,24)+'…':s);
 const unlinked=model.nodes.filter(n=>n.kind!=='report'&&!model.links.some(l=>l.from===n.id||l.to===n.id)),unlinkedNotes=unlinked.filter(n=>n.kind==='note');
 const diagram=model.links.length?`<div class="reference-graph"><svg viewBox="0 0 760 ${model.links.length*90+20}" role="img" aria-label="노트 링크와 직접 연결한 자료"><g>${model.links.map((l,i)=>{const a=byID.get(l.from),b=byID.get(l.to),y=i*90+10;return `<g class="reference-row" data-reference="${esc(l.id)}" role="button" tabindex="0" aria-label="${esc(a.label)} → ${esc(b.label)} · ${l.label}"><title>${esc(a.label)} → ${esc(b.label)} · ${l.label}</title><rect x="12" y="${y}" width="292" height="66" rx="10"/><rect x="456" y="${y}" width="292" height="66" rx="10"/><path d="M304 ${y+34}H446m-7-5 7 5-7 5"/><text x="380" y="${y+22}" text-anchor="middle">${l.label}</text><text class="reference-kind" x="26" y="${y+22}">${esc(sourceLabel(a.source))} · ${a.kind==='pdf'?'PDF':a.kind==='mail'?'메일':a.kind==='note'?'노트':'리포트'}</text><text x="26" y="${y+47}">${short(a.label)}</text><text class="reference-kind" x="470" y="${y+22}">${esc(sourceLabel(b.source))} · ${esc(b.ref.date||(b.ref.received||b.ref.added||b.ref.modified||'').slice(0,10))}</text><text x="470" y="${y+47}">${short(b.label)}</text></g>`}).join('')}</g></svg></div>`:'<p class="small-note">현재 조건에 표시할 연결이 없습니다. 노트에 [[노트 이름]]을 쓰거나 노트·PDF·메일을 리포트에 연결하면 여기에 표시됩니다.</p>';
 return `<section class="document-connections"><h2>자료 연결 <span>${model.links.length}</span></h2><p class="small-note">노트 본문 링크, 원본 메일, 직접 연결하거나 추천에서 확정한 자료입니다. 연결을 누르면 출처와 연결 근거가 열립니다.</p>${noteNetworkStatusHTML()}${diagram}${unlinkedNotes.length?`<h3>연결 없는 노트 · ${unlinkedNotes.length}개</h3><div class="unlinked-notes">${unlinkedNotes.map(networkItemButton).join('')}</div>`:''}${unlinked.length?`<p class="small-note">현재 조건에서 연결이 없는 자료 ${unlinked.length}개도 전체 지도에 표시됩니다.</p>`:''}</section>`;
}
function selectNetwork(kind,id){networkSelection={kind,id};mapMediaSelected='';mapMediaEdge=null;selectedRelation='';renderDetail()}
function bindDocumentConnections(){
 $$('[data-reference]').forEach(b=>{const pick=()=>selectNetwork('link',b.dataset.reference);b.onclick=pick;b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}}});
 bindNetworkItems();
}
function renderNetworkDetail(){
 if(!networkSelection)return false;
 const {kind,id}=networkSelection,link=kind==='link'?currentDocuments.links.find(l=>l.id===id):null;
 if(typeof renderConnectionNetworkDetail==='function'&&renderConnectionNetworkDetail(link))return true;
 const node=currentDocuments.nodes.find(n=>n.id===(link?link.from:id)),target=link?currentDocuments.nodes.find(n=>n.id===link.to):null;
 if(!node||kind==='link'&&!link){networkSelection=null;return false}
 const item=node.ref;
 let body='';
 if(node.kind==='pdf')body=`<p class="small-note">PDF · ${fmtSize(item.size)} · ${esc((item.added||'').slice(0,10))} 추가</p><div class="downloads"><a href="/api/local/file?id=${encodeURIComponent(item.id)}&view=1" target="_blank" rel="noopener">PDF 원문 보기</a><a href="/api/local/file?id=${encodeURIComponent(item.id)}">다운로드</a></div>`;
 if(node.kind==='mail'){mailPool[item.entry_id]=item;body=`<p class="small-note">${esc(item.sender)} · ${esc(item.received)}<br>${esc(item.folder)}</p><button type="button" data-mail-open="${esc(item.entry_id)}">Outlook 원문 열기</button>`}
 if(node.kind==='note'){
  const related=new Set(currentDocuments.links.filter(e=>e.from===node.id||e.to===node.id).map(e=>e.from===node.id?e.to:e.from));
  body=`<p class="small-note">${esc(item.path)} · 수정 ${esc(item.modified.slice(0,10))}</p><button type="button" data-edit-network-note="${esc(item.id)}">노트 열기 · 편집</button><article class="markdown network-note-preview">${window.AVNotes.preview(item,noteNetworkState.nodes.map(n=>n.ref))}</article>`;
  if(!link)body+=`<h3>연결된 자료</h3>${currentDocuments.nodes.filter(n=>related.has(n.id)).map(networkItemButton).join('')||'<p class="small-note">아직 표시할 연결이 없습니다. 본문에 [[노트 이름]]을 쓰거나 노트 아래에서 리포트를 연결하세요. 연결된 자료의 표시 스위치와 검색 조건도 확인할 수 있습니다.</p>'}`;
 }
 delete $('#detail').dataset.reportKey;
 $('#detail').innerHTML=`<div class="eyebrow">${esc(sourceLabel(node.source))} · ${link?'자료 연결 근거':'원본 자료'}</div><h2>${esc(node.label)}</h2>${link?`<div class="summary"><b>${esc(link.label)}</b><p>${esc(link.evidence)}</p></div>`:''}${body}${target?`<h3>연결된 ${target.kind==='note'?'노트':'리포트'}</h3>${networkItemButton(target)}${target.kind==='report'?sources(target.ref.sources):''}`:''}`;
 bindNetworkItems();
 if(node.kind==='note')$('#detail').querySelectorAll('[data-note-link]').forEach(b=>b.onclick=e=>{e.preventDefault();window.AVNotes.open(item.id,b.dataset.noteLink).catch(e=>toast(e.message))});
 return true;
}
// Entities on a circle, edges as curved arrows; hovering or selecting a node/edge dims the rest.
function renderGraph(ids){const label=id=>catalog().entities.find(n=>n.id===id)?.label||id;
 loadNoteNetwork();
 currentDocuments=buildDocumentNetwork(catalog().reports.filter(r=>ids.has(r.id)));
 if(!Object.values(networkSources).some(Boolean)){$('#results').innerHTML='<div class="empty">표시할 자료를 위에서 켜 주세요.</div>';$('#result-count').textContent='표시할 자료 없음';return}
 let rel=catalog().relations.filter(r=>ids.has(r.report_id)&&matches(label(r.from),label(r.to),r.label,r.evidence,r.status));let nodeIDs=new Set(rel.flatMap(r=>[r.from,r.to]));let ns=catalog().entities.filter(e=>nodeIDs.has(e.id));
 const W=760,H=Math.max(540,ns.length*72),cx=W/2,cy=H/2,R=Math.min(W,H)/2-82,positions={};ns.forEach((n,i)=>{let a=-Math.PI/2+i*2*Math.PI/ns.length;positions[n.id]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)}});
 let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="근거가 연결된 관계 그래프"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>`;
 for(let r of rel){let a=positions[r.from],b=positions[r.to],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1,ux=dx/d,uy=dy/d;let x1=a.x+ux*34,y1=a.y+uy*34,x2=b.x-ux*36,y2=b.y-uy*36;let bend=Math.min(70,d*.18);let mx=(x1+x2)/2-uy*bend,my=(y1+y2)/2+ux*bend;let lx=(x1+2*mx+x2)/4,ly=(y1+2*my+y2)/4;
  svg+=`<g class="edge ${r.status==='계획'?'planned':''} ${selectedRelation===r.id?'selected':''}" data-edge="${esc(r.id)}" data-from="${esc(r.from)}" data-to="${esc(r.to)}" tabindex="0" role="button" aria-label="${esc(label(r.from))} → ${esc(label(r.to))}: ${esc(r.label)}"><path class="hit" d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}"/><path class="line" d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}" marker-end="url(#arrow)"/><rect class="label-bg" x="${lx-r.label.length*5.6-7}" y="${ly-10}" width="${r.label.length*11.2+14}" height="20" rx="10"/><text class="graph-label" text-anchor="middle" x="${lx}" y="${ly+4}">${esc(r.label)}</text></g>`}
 for(let n of ns){let p=positions[n.id];svg+=`<g class="node kind-${esc(n.kind)}" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.label)}" transform="translate(${p.x} ${p.y})"><circle r="30"/>${uiIcon(n.kind==='인물'?'person':n.kind==='지역'?'pin':'company',true)}<text class="name" text-anchor="middle" y="48">${esc(n.label)}</text><text class="kind" text-anchor="middle" y="62">${esc(n.kind)}</text></g>`}svg+='</svg>';
 $('#results').innerHTML=`<p class="small-note">${terms().length?`검색어 <b>${esc(terms().join(' '))}</b>와 일치하는 관계만 표시합니다. `:'공통 기업명만으로 관계를 만들지 않습니다. '}노드나 연결을 가리키면 관련 항목만 강조되고, 선택하면 오른쪽에 근거가 열립니다.</p>`+(ns.length?`<div class="graph">${svg}<div class="legend"><span><i class="lg solid"></i>확인된 관계</span><span><i class="lg dashed"></i>발표된 계획</span><span>${uiIcon('company')} 기업</span><span>${uiIcon('person')} 인물</span><span>${uiIcon('pin')} 지역</span></div></div><div class="relation-list">${rel.map(r=>`<button class="related-card ${selectedRelation===r.id?'selected':''}" data-relation="${esc(r.id)}"><span class="rel-path">${esc(label(r.from))} <i>→</i> ${esc(label(r.to))}</span><small>${esc(r.label)} · ${chip(r.status,r.status==='계획'?'amber':'teal')}</small></button>`).join('')}</div>`:`<div class="empty">${terms().length?'검색어와 일치하는 관계가 없습니다.<br>검색어를 지우면 현재 필터의 모든 관계를 봅니다.':currentDocuments.links.length||currentDocuments.nodes.some(n=>n.kind==='note')?'현재 리포트에 확인된 기업·사건 관계가 없습니다.<br>노트와 자료 연결은 아래에서 확인하세요.':'이 조건에 근거가 확인된 관계가 없습니다.'}</div>`);
 $('#results').innerHTML+=documentConnectionsHtml(currentDocuments);bindDocumentConnections();
 $('#result-count').textContent=`확인된 사실·계획 ${rel.length}개 · 자료 연결 ${currentDocuments.links.length}개 · 노트 ${currentDocuments.nodes.filter(n=>n.kind==='note').length}개`;
 const g=$('#results .graph svg');const focus=(nodes,edges)=>{if(!g)return;g.classList.toggle('focus',!!nodes);g.querySelectorAll('[data-node]').forEach(n=>n.classList.toggle('on',!!nodes&&nodes.has(n.dataset.node)));g.querySelectorAll('[data-edge]').forEach(e=>e.classList.toggle('on',!!edges&&edges.has(e.dataset.edge)))};
 const pickRel=id=>{networkSelection=null;selectedRelation=id;selected=catalog().relations.find(r=>r.id===id).report_id;$$('[data-relation],[data-edge]').forEach(b=>b.classList.toggle('selected',b.dataset.relation===id||b.dataset.edge===id));renderDetail();markReportRead(selected)};
 $$('[data-relation]').forEach(b=>{b.onclick=()=>pickRel(b.dataset.relation);b.onmouseenter=()=>{let r=rel.find(x=>x.id===b.dataset.relation);focus(new Set([r.from,r.to]),new Set([r.id]))};b.onmouseleave=()=>focus(null)});
 $$('[data-edge]').forEach(b=>{const r=rel.find(x=>x.id===b.dataset.edge);b.onclick=()=>pickRel(r.id);b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pickRel(r.id)}};b.onmouseenter=()=>focus(new Set([r.from,r.to]),new Set([r.id]));b.onmouseleave=()=>focus(null)});
 $$('[data-node]').forEach(b=>{const id=b.dataset.node,mine=rel.filter(r=>r.from===id||r.to===id);const pick=()=>{if(mine[0])pickRel(mine[0].id)};b.onclick=pick;b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}};b.onmouseenter=()=>focus(new Set([id,...mine.flatMap(r=>[r.from,r.to])]),new Set(mine.map(r=>r.id)));b.onmouseleave=()=>focus(null)});
}
// Local indexed sources are a separate layer; similarities never become catalog facts.
let mapMedia={loaded:false,loading:false,ok:false,docs:[],links:[]},mapMediaSelected='',mapMediaPage=1,mapMediaEdge=null;
// Long local tasks return immediately; each poll fits within the server deadline.
async function ragResult(result,onProgress=()=>{}){
 while(result.job){
  if(result.error||result.state==='error')throw Error(result.error||'작업에 실패했습니다.');
  if(result.state==='done')return result.result;
  onProgress(result);
  await new Promise(resolve=>setTimeout(resolve,750));
  result=await api('/api/rag/job?id='+encodeURIComponent(result.job));
 }
 if(result.error)throw Error(result.error);
 return result;
}
async function loadMapMedia(force=false){
 if(mapMedia.loading||mapMedia.loaded&&!force)return;
 mapMedia.loading=true;
 try{const result=await ragResult(await api('/api/rag/map'));mapMedia={loaded:true,loading:false,ok:!!result.ok,docs:result.docs||[],links:result.links||[]}}
 catch(e){mapMedia={loaded:true,loading:false,ok:false,docs:[],links:[]}}
 if(mapMediaSelected&&!mapMedia.docs.some(d=>d.id===mapMediaSelected))mapMediaSelected='';
 if(mapMediaEdge&&!mapMedia.links.some(e=>e.from===mapMediaEdge.from&&e.to===mapMediaEdge.to))mapMediaEdge=null;
 if(tab==='map')render();
}
function invalidateMapMedia(){mapMedia.loaded=false;if(tab==='map')loadMapMedia()}
function selectMapMedia(id,page=1){if(tab==='map'){if(!mapSelection)mapSelection='m:'+id;mapOpenItem='m:'+id}networkSelection=null;mapMediaSelected=id;mapMediaPage=page;mapMediaEdge=null;renderDetail()}
function renderMapMediaDetail(){
 const doc=mapMedia.docs.find(d=>d.id===mapMediaSelected),edge=mapMediaEdge;
 const preview=(id,page)=>`/api/rag/page?doc=${encodeURIComponent(id)}&page=${page}`;
 if(edge){
  const a=mapMedia.docs.find(d=>d.id===edge.from),b=mapMedia.docs.find(d=>d.id===edge.to);
  if(!a||!b)return;
  $('#detail').innerHTML=`<div class="eyebrow">이 PC의 자료 · 임베딩 유사도</div><h2>유사도 ${edge.similarity.toFixed(4)}</h2><p class="small-note">두 자료의 페이지 이미지 중 가장 비슷한 쌍입니다. 모델의 코사인 유사도이며 기업·사건의 사실 관계를 뜻하지 않습니다.</p>${[[a,edge.from_page],[b,edge.to_page]].map(([d,p])=>`<button class="related-card" data-map-source="${esc(d.id)}" data-page="${p}">${esc(d.name)} · ${ragPageLabel(d,p)}</button><img class="rag-page" src="${preview(d.id,p)}" alt="${esc(d.name)} ${ragPageLabel(d,p)}">`).join('')}`;
 }else if(doc){
  mapMediaPage=Math.max(1,Math.min(doc.pages,mapMediaPage));
  const related=mapMedia.links.filter(e=>e.from===doc.id||e.to===doc.id);
  $('#detail').innerHTML=`<div class="eyebrow">이 PC의 색인 자료 · ${doc.kind==='image'?'이미지':'PDF'}</div><h2>${esc(doc.name)}</h2><p class="small-note">${doc.pages}개 페이지 · ${fmtSize(doc.size)} · ${esc(doc.added||'')}</p><div class="form-actions"><button data-map-page="${mapMediaPage-1}" ${mapMediaPage<=1?'disabled':''}>이전</button><span>${ragPageLabel(doc,mapMediaPage)} / ${doc.pages}</span><button data-map-page="${mapMediaPage+1}" ${mapMediaPage>=doc.pages?'disabled':''}>다음</button></div><img class="rag-page" src="${preview(doc.id,mapMediaPage)}" alt="${esc(doc.name)}"><h3>비슷한 색인 자료</h3><p class="small-note">페이지 이미지의 코사인 유사도 0.6 이상, 자료마다 최대 3개 연결입니다. 연결을 선택하면 비교한 원본 페이지를 봅니다.</p>${related.map(e=>{const other=mapMedia.docs.find(d=>d.id===(e.from===doc.id?e.to:e.from));return `<button class="related-card" data-map-evidence="${mapMedia.links.indexOf(e)}">${esc(other?.name||'')} · 유사도 ${e.similarity.toFixed(4)}</button>`}).join('')||'<p class="small-note">기준을 충족하는 유사 자료가 없습니다.</p>'}`;
 }else{return}
 $$('[data-map-page]').forEach(b=>b.onclick=()=>selectMapMedia(doc.id,+b.dataset.mapPage));
 $$('[data-map-source]').forEach(b=>b.onclick=()=>selectMapMedia(b.dataset.mapSource,+b.dataset.page));
 $$('[data-map-evidence]').forEach(b=>b.onclick=()=>{mapMediaEdge=mapMedia.links[+b.dataset.mapEvidence];renderDetail()});
}
// Map identity is shared content, while source records and their evidence remain unchanged.
let mapCatalogCache=null;
function mapCatalog(){
 const source=state.snapshot.catalog,flags=JSON.stringify(networkSources),cached=mapCatalogCache;
 if(cached&&cached.source===source&&cached.imports===importedReports&&cached.hidden===hiddenReports&&cached.flags===flags)return cached.catalog;
 const all=[...source.reports,...importedReports.filter(r=>reportSource(r)==='daily'),...importedReports.filter(r=>reportSource(r)==='outlook')],groups=new Map();
 for(const r of all){const key=reportIdentity(r);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r)}
 const visible=new Map(visibleCatalog({...source,reports:all}).reports.map(r=>[r.id,r])),members=new Map(),aliases=new Map(),reports=[];
 for(const group of groups.values()){
  if(group.some(r=>hiddenReports.has(r.id)))continue;
  const enabled=group.filter(r=>visible.has(r.id)&&networkSources[reportSource(r)]).map(r=>visible.get(r.id));
  if(!enabled.length)continue;
  const representative=enabled[0];reports.push(representative);members.set(representative.id,enabled);
  for(const r of enabled)aliases.set(r.id,representative.id);
 }
 // Published assertions are retained only when their published report is visible.
 const catalog=visibleCatalog({...source,reports});
 mapCatalogCache={source,imports:importedReports,hidden:hiddenReports,flags,catalog,members,aliases};return catalog;
}
function mapReportMembers(r){mapCatalog();return mapCatalogCache.members.get(r.id)||[r]}
function mapReportCompanies(r){return [...new Set(mapReportMembers(r).flatMap(realCompanies))]}
function mapReportTags(r){return [...new Set(mapReportMembers(r).flatMap(r=>r.tags))]}
function mapReportSources(r){return [...new Set(mapReportMembers(r).map(r=>reportSource(r)==='daily'?'데일리':'Outlook'))].join(' · ')}
function mergeMapDocuments(model,reports){
 const canonical=id=>id.startsWith('r:')?'r:'+(mapCatalogCache.aliases.get(id.slice(2))||id.slice(2)):id;
 const nodes=[...reports.map(r=>({id:'r:'+r.id,kind:'report',label:r.title,ref:r,source:reportSource(r)})),...model.nodes.filter(n=>n.kind!=='report')];
 const ids=new Set(nodes.map(n=>n.id)),seen=new Set(),links=[];
 for(const edge of model.links){
  const from=canonical(edge.from),to=canonical(edge.to),key=JSON.stringify([from,to,edge.label]);
  if(from===to||!ids.has(from)||!ids.has(to)||seen.has(key))continue;
  seen.add(key);links.push({...edge,from,to,source_report_id:edge.report_id,report_id:mapCatalogCache.aliases.get(edge.report_id)||edge.report_id});
 }
 return {nodes,links};
}
let mapSelection='',mapOpenItem='',mapListLimit=40,mapListScroll=0,mapDetailRendering=false,mapGraph={nodes:[],links:[]};
function resetMapSelection(){mapSelection='';mapOpenItem='';mapListLimit=40;mapListScroll=0}
function updateMapGraph(nodes,links){
 mapGraph={nodes,links};
 if(!nodes.some(n=>n.id===mapSelection))resetMapSelection();
 if(!nodes.some(n=>n.id===mapOpenItem))mapOpenItem='';
}
const mapItemDate=n=>String(n.ref.date||n.ref.received||n.ref.modified||n.ref.added||'').slice(0,10);
const mapItemKind=n=>({report:'리포트',mail:'원본 메일',pdf:'PDF',media:'색인 자료',note:'노트',company:'기업',tag:'분류'}[n.kind]||'자료');
function mapSelectionItems(node){
 const ids=new Set(['company','tag'].includes(node.kind)?[]:[node.id]);
 for(const edge of mapGraph.links){if(edge.a.id===node.id)ids.add(edge.b.id);if(edge.b.id===node.id)ids.add(edge.a.id)}
 return mapGraph.nodes.filter(n=>ids.has(n.id)&&!['company','tag'].includes(n.kind)).sort((a,b)=>mapItemDate(b).localeCompare(mapItemDate(a))||a.label.localeCompare(b.label));
}
function selectMapNode(id){
 mapSelection=id;mapOpenItem=mapGraph.nodes.find(n=>n.id===id)?.kind==='note'?id:'';mapListLimit=40;mapListScroll=0;
 networkSelection=null;mapMediaSelected='';mapMediaEdge=null;selectedRelation='';linkedReport='';
 renderDetail();$('#detail').scrollTop=0;
}
function renderMapExplorer(){
 if(mapDetailRendering||networkSelection?.kind==='link'||mapMediaEdge)return false;
 const node=mapGraph.nodes.find(n=>n.id===mapSelection),detail=$('#detail');
 if(!node){detail.innerHTML='<div class="empty">지도에서 기업·분류·자료를 선택하면<br>연결된 자료 목록이 여기에 표시됩니다.</div>';return true}
 const items=mapSelectionItems(node),opened=mapGraph.nodes.find(n=>n.id===mapOpenItem);
 if(opened){
  networkSelection=null;mapMediaSelected='';mapMediaEdge=null;
  if(opened.kind==='report'){selected=opened.ref.id;linkedReport='';selectedRelation=''}
  else if(opened.kind==='media')mapMediaSelected=opened.ref.id;
  else networkSelection={kind:'node',id:opened.id};
  mapDetailRendering=true;
  try{renderDetail()}finally{mapDetailRendering=false}
  detail.insertAdjacentHTML('afterbegin','<button type="button" class="map-list-back" id="map-list-back">← 관련 자료 목록</button>');
  const openReport=id=>{if(!mapGraph.nodes.some(n=>n.id==='r:'+id))return;mapOpenItem='r:'+id;networkSelection=null;renderDetail();markReportRead(id);detail.scrollTop=0;$('#map-list-back')?.focus({preventScroll:true})};
  detail.querySelectorAll('[data-related]').forEach(b=>b.onclick=()=>openReport(b.dataset.related));
  $('#map-list-back').onclick=()=>{mapOpenItem='';networkSelection=null;mapMediaSelected='';renderDetail();detail.scrollTop=mapListScroll;[...detail.querySelectorAll('[data-map-open]')].find(b=>b.dataset.mapOpen===opened.id)?.focus({preventScroll:true})};
  return true;
 }
 mapOpenItem='';networkSelection=null;mapMediaSelected='';
 detail.innerHTML=`<div class="eyebrow">지도에서 선택한 ${mapItemKind(node)}</div><h2>${esc(node.label)}</h2>${node.kind==='report'?`<p class="small-note">${esc(node.ref.date)} · ${esc(mapReportSources(node.ref))}</p><p class="map-report-summary">${esc(node.ref.summary)}</p>`:''}<p class="small-note" role="status">관련 자료 ${items.length}개 · 최신순</p><div class="map-related-list">${items.slice(0,mapListLimit).map(n=>`<button type="button" class="map-related-item" data-map-open="${esc(n.id)}"><span class="map-item-meta">${esc(mapItemKind(n))} · ${esc(mapItemDate(n))}${n.kind==='report'?' · '+esc(mapReportSources(n.ref)):''}</span><strong>${esc(n.label)}</strong>${n.kind==='report'?`<span>${esc(n.ref.summary)}</span>`:''}</button>`).join('')||'<p class="small-note">현재 검색 조건에서 연결된 자료가 없습니다.</p>'}</div>${items.length>mapListLimit?'<button type="button" id="map-list-more">자료 더 보기</button>':''}`;
 detail.querySelectorAll('[data-map-open]').forEach(b=>b.onclick=()=>{mapListScroll=detail.scrollTop;mapOpenItem=b.dataset.mapOpen;renderDetail();if(mapOpenItem.startsWith('r:'))markReportRead(mapOpenItem.slice(2));detail.scrollTop=0;$('#map-list-back')?.focus({preventScroll:true})});
 if($('#map-list-more'))$('#map-list-more').onclick=()=>{const firstNew=items[mapListLimit]?.id,scroll=detail.scrollTop;mapListLimit+=40;renderDetail();detail.scrollTop=scroll;[...detail.querySelectorAll('[data-map-open]')].find(b=>b.dataset.mapOpen===firstNew)?.focus({preventScroll:true})};
 return true;
}
// Force-directed map: reports, companies, tags and explicitly indexed local media.
let mapSim=null;const mapPos={};
function renderMap(rs){
 loadNoteNetwork();
 if(networkSources.local&&!mapMedia.loaded)loadMapMedia();
 if(mapSim)mapSim.stop();
 currentDocuments=buildDocumentNetwork(rs);
 let nodes=[],links=[],idx={};
 const add=(id,kind,label,ref)=>{if(idx[id]!==undefined)return nodes[idx[id]];idx[id]=nodes.length;let p=mapPos[id]||{x:(Math.random()-.5)*300,y:(Math.random()-.5)*300};let n={id,kind,label,ref,x:p.x,y:p.y,vx:0,vy:0,deg:0,fixed:false};nodes.push(n);return n};
 const link=(a,b,kind,evidence=null)=>{if(a===b)return;links.push({a,b,kind,evidence});a.deg++;b.deg++};
 for(let r of rs){let n=add('r:'+r.id,'report',r.title,r);n.source=reportSource(r);for(let c of mapReportCompanies(r))link(n,add('c:'+c,'company',c,c),'company');for(let t of mapReportTags(r))link(n,add('t:'+t,'tag',t,t),'tag')}
 for(let x of catalog().related){let a=idx['r:'+x.from],b=idx['r:'+x.to];if(a!==undefined&&b!==undefined)link(nodes[a],nodes[b],'related')}
 for(const d of currentDocuments.nodes)if(d.kind!=='report')add(d.id,d.kind,d.label,d.ref).source=d.source;
 for(const e of currentDocuments.links)link(nodes[idx[e.from]],nodes[idx[e.to]],'reference',e);
 const mediaDocs=networkSources.local?mapMedia.docs.filter(d=>matches(d.name)):[];
 const mediaIDs=new Set(mediaDocs.map(d=>d.id));
 if(!mediaIDs.has(mapMediaSelected))mapMediaSelected='';
 if(mapMediaEdge&&(!mediaIDs.has(mapMediaEdge.from)||!mediaIDs.has(mapMediaEdge.to)))mapMediaEdge=null;
 for(const d of mediaDocs)add('m:'+d.id,'media',d.name,d).source='local';
 for(const e of mapMedia.links){const a=idx['m:'+e.from],b=idx['m:'+e.to];if(a!==undefined&&b!==undefined)link(nodes[a],nodes[b],'similarity',e)}
 $('#result-count').textContent=`${rs.length}개 리포트 · 색인 자료 ${mediaDocs.length}개 · 보관 PDF ${nodes.filter(n=>n.kind==='pdf').length}개 · 메일 ${nodes.filter(n=>n.kind==='mail').length}개 · 노트 ${nodes.filter(n=>n.kind==='note').length}개`;
 updateMapGraph(nodes,links);
 const adj=new Map(nodes.map(n=>[n,new Set()]));links.forEach(l=>{adj.get(l.a).add(l.b);adj.get(l.b).add(l.a)});
 const W=1000,H=700;
 const edgeDescription=l=>l.kind==='similarity'?`${l.a.label} p.${l.evidence.from_page} ↔ ${l.b.label} p.${l.evidence.to_page} · 유사도 ${l.evidence.similarity.toFixed(4)}`:l.kind==='reference'?`${l.a.label} → ${l.b.label} · ${l.evidence.label}`:`${l.a.label} · ${l.b.label}`;
 $('#results').innerHTML=`<p class="small-note">점을 선택하면 우측에서 관련 자료를 확인할 수 있습니다. 같은 보고일·본문의 리포트는 하나로 표시합니다. 파란 점선은 노트 링크·원본 메일·직접 연결·확정한 추천, 주황색 점선은 페이지 이미지의 유사도입니다. 기업·분류 선은 리포트의 태그이며 확인된 사실 관계는 관계 그래프에서 봅니다.</p>${noteNetworkStatusHTML()}<div class="form-actions" ${networkSources.local?'':'hidden'}><span class="small-note">${mapMedia.loading?'색인 자료 확인 중…':mapMedia.ok?'보관 PDF와 색인 자료는 별도로 표시됩니다.':'검색 서비스를 켜면 색인 자료도 표시됩니다. 보관 PDF는 서비스 없이 표시됩니다.'}</span><button class="text-button" id="map-media-refresh" ${mapMedia.loading?'disabled':''}>색인 자료 새로고침</button></div>`+(nodes.length?`<div class="map"><div class="map-controls" role="group" aria-label="지도 보기"><button type="button" id="map-zoom-in" aria-label="지도 확대">+ 확대</button><button type="button" id="map-zoom-out" aria-label="지도 축소">− 축소</button><button type="button" id="map-nearby">선택 주변</button><button type="button" id="map-overview">전체 보기</button><button type="button" id="map-wide" aria-pressed="false">넓게 보기</button></div><svg viewBox="${-W/2} ${-H/2} ${W} ${H}" role="img" aria-label="노트·리포트·기업·분류·색인 자료 연결 지도"><g class="viewport"><g class="links">${links.map((l,i)=>`<line class="ml ${l.kind}" data-l="${i}" ${l.evidence?`tabindex="0" role="button" aria-label="${esc(edgeDescription(l))}"`:''}><title>${esc(edgeDescription(l))}</title></line>`).join('')}</g><g class="nodes">${nodes.map((n,i)=>`<g class="mn ${n.kind} ${n.source==='outlook'?'outlook ':''}${mapSelection===n.id?'selected':''}" aria-pressed="${mapSelection===n.id}" data-n="${i}" data-item-id="${esc(n.id)}" data-source="${n.source||'metadata'}" tabindex="0" role="button" aria-label="${esc(n.label)}"><circle r="${n.kind==='company'||n.kind==='tag'?5+Math.min(n.deg,14)*.9:7+Math.min(n.deg,10)*.6}"/><title>${esc(n.label)}${n.kind==='report'?' · '+mapReportSources(n.ref):n.source?' · '+sourceLabel(n.source):''}</title><text y="22" text-anchor="middle">${esc(n.label.length>24?n.label.slice(0,23)+'…':n.label)}</text></g>`).join('')}</g></g></svg><p class="map-caption"></p><div class="legend"><span><i class="dot report"></i>데일리 리포트</span><span><i class="dot outlook"></i>Outlook</span><span><i class="dot note"></i>내 노트</span><span><i class="dot pdf"></i>보관 PDF</span><span><i class="dot media"></i>색인 자료</span><span><i class="dot company"></i>기업</span><span><i class="dot tag"></i>분류</span><span><i class="lg reference"></i>노트 링크·원본·직접 연결</span><span><i class="lg related"></i>연결된 이슈</span><span><i class="lg similarity"></i>임베딩 유사도</span><button class="text-button" id="map-reset">배치 다시</button></div></div>`:`<div class="empty">${Object.values(networkSources).some(Boolean)?'표시할 자료가 없습니다. 검색 조건을 확인하세요.':'표시할 자료를 위에서 켜 주세요.'}</div>`);
 $('#map-media-refresh').onclick=()=>loadMapMedia(true);bindNetworkItems();
 if(!nodes.length)return;
 const svg=$('#results svg'),L=$$('#results .ml'),N=$$('#results .mn');
 const camera=window.AVMapViewport?.({svg,nodes,links,adj,N});
 L.forEach((el,i)=>{if(!links[i].evidence)return;const choose=()=>{resetMapSelection();if(links[i].kind==='reference')return selectNetwork('link',links[i].evidence.id);networkSelection=null;mapMediaEdge=links[i].evidence;mapMediaSelected='';renderDetail()};el.onclick=choose;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose()}}});
 const draw=()=>{links.forEach((l,i)=>{let e=L[i];e.setAttribute('x1',l.a.x);e.setAttribute('y1',l.a.y);e.setAttribute('x2',l.b.x);e.setAttribute('y2',l.b.y)});nodes.forEach((n,i)=>{N[i].setAttribute('transform',`translate(${n.x} ${n.y})`);mapPos[n.id]={x:n.x,y:n.y}});camera?.update()};
 // Layout runs off the UI thread; draw at most once per animation frame.
 let worker=null,raf=0;
 const stop=()=>{worker?.terminate();worker=null;cancelAnimationFrame(raf);raf=0;camera?.stop()};
 mapSim={stop};draw();
 if(typeof Worker!=='undefined'){
  worker=new Worker('/map-layout.js');
  worker.onmessage=({data})=>{
   nodes.forEach((n,i)=>{if(!n.fixed){n.x=data[i*2];n.y=data[i*2+1]}});
   if(!raf)raf=requestAnimationFrame(()=>{raf=0;draw()});
  };
  worker.onerror=()=>{worker?.terminate();worker=null};
  worker.postMessage({type:'init',nodes:nodes.map(n=>({x:n.x,y:n.y,vx:0,vy:0,fixed:false})),links:links.map(l=>({a:idx[l.a.id],b:idx[l.b.id],kind:l.kind}))});
 }
 // Hover: keep the neighbourhood, dim the rest.
 const focus=n=>{n=n||nodes.find(n=>n.id===mapSelection);svg.classList.toggle('focus',!!n);N.forEach((el,i)=>el.classList.toggle('on',!!n&&(nodes[i]===n||adj.get(n).has(nodes[i]))));L.forEach((el,i)=>el.classList.toggle('on',!!n&&(links[i].a===n||links[i].b===n)));camera?.focus(n)};
 N.forEach((el,i)=>{const n=nodes[i];el.onmouseenter=()=>focus(n);el.onmouseleave=()=>focus(null);el.onfocus=()=>{camera?.reveal(n);focus(n)};el.onblur=()=>focus(null);
  const act=()=>{selectMapNode(n.id);N.forEach((x,j)=>{x.classList.toggle('selected',nodes[j]===n);x.setAttribute('aria-pressed',String(nodes[j]===n))});focus(n)};
  const pick=()=>{act();camera?.select()};
  let moved=false;el.onpointerdown=e=>{e.stopPropagation();moved=false;n.fixed=true;el.setPointerCapture(e.pointerId);let sx=e.clientX,sy=e.clientY,ox=n.x,oy=n.y;const scale=()=>camera?.dragScale()||1;
   el.onpointermove=ev=>{if(!(ev.buttons&1))return;let s=scale();n.x=ox+(ev.clientX-sx)*s;n.y=oy+(ev.clientY-sy)*s;if(Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>3)moved=true;worker?.postMessage({type:'drag',index:i,x:n.x,y:n.y,fixed:true});draw()};
   el.onpointerup=()=>{el.onpointermove=null;n.fixed=false;worker?.postMessage({type:'drag',index:i,x:n.x,y:n.y,fixed:false});if(!moved)pick()};
   el.onpointercancel=()=>{el.onpointermove=null;n.fixed=false;worker?.postMessage({type:'drag',index:i,x:n.x,y:n.y,fixed:false})}};
  el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}}});
 $('#map-reset').onclick=()=>{nodes.forEach(n=>{n.x=(Math.random()-.5)*300;n.y=(Math.random()-.5)*300;n.vx=n.vy=0});camera?.reset();worker?.postMessage({type:'reset'});draw()};
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
function renderDetail(){if(tab==='map'&&renderMapExplorer())return;if(tab==='local')return renderLocalDetail();if(tab==='rag')return renderRagDetail();if(networkView()&&renderNetworkDetail())return;if(tab==='map'&&networkSources.local&&(mapMediaEdge||mapMedia.docs.some(d=>d.id===mapMediaSelected)))return renderMapMediaDetail();let r=linkedReport===selected?reportOf(selected):catalog().reports.find(r=>r.id===selected);if(tab==='outlook'&&r&&reportSource(r)!=='outlook'&&linkedReport!==selected)r=null;if(networkView()&&r&&!filtered().some(x=>x.id===r.id))r=null;if(!r){delete $('#detail').dataset.reportKey;reportReaderOpen=false;updateReportReader();$('#detail').innerHTML=tab==='outlook'?'<div class="empty">가져온 Outlook 리포트를 선택하면<br>본문과 원본 메일을 확인할 수 있습니다.</div>':'<div class="empty">리포트나 그래프의 연결을 선택하면<br>본문과 관련 내용을 볼 수 있습니다.</div>';return}
 const detail=$('#detail'),reportKey=`${tab}:${r.id}:${selectedRelation}`,changed=detail.dataset.reportKey!==reportKey;
 detail.dataset.reportKey=reportKey;
 let rel=catalog().relations.find(x=>x.id===selectedRelation);let related=catalog().related.filter(x=>x.from===r.id||x.to===r.id).map(x=>({r:catalog().reports.find(z=>z.id===(x.from===r.id?x.to:x.from)),reason:x.reason})).filter(x=>x.r);
 let same=catalog().reports.filter(x=>x.id!==r.id&&!related.some(t=>t.r.id===x.id)&&x.companies.some(c=>r.companies.includes(c))).slice(0,4);
 // Body first and fully expanded; linked issues follow as title-only cards (reason shown on hover).
 $('#detail').innerHTML=(reportListView()?'<div class="report-reader-bar"><button type="button" id="report-back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>목록으로</button></div>':'')+(rel?`<div class="eyebrow">선택한 관계 · ${esc(rel.status)}</div><h2>${esc(rel.label)}</h2><div class="summary">${esc(rel.evidence)}</div>${sources(rel.sources)}<hr>`:'')+`<div class="report-actions"><span class="report-date">${esc(r.date)}</span><button type="button" class="text-button" id="hide-report" title="이 PC의 내 화면에서만 숨깁니다. 원본은 보관되며 전체 복원할 수 있습니다." ${visibilityBusy||visibilityError?'disabled':''}>내 화면에서 숨기기</button></div><h2 id="report-title" tabindex="-1">${esc(r.title)}</h2><div class="chips">${r.companies.map(s=>chip(s,'teal')).join('')}</div><div class="downloads">${r.attachments.map((a,i)=>`<a href="/api/download?id=${encodeURIComponent(r.id)}&index=${i}">${esc(a.name.endsWith('.md')?'MD 다운로드':a.name.endsWith('.pptx')?'PPTX 다운로드':a.name)}</a>`).join('')}</div><article class="markdown">${markdown(r.body_markdown)}</article><hr><h3>연결된 이슈</h3>${related.length?related.map(x=>`<button class="related-card" data-related="${esc(x.r.id)}" title="${esc(x.reason)}"><span class="report-date">${esc(x.r.date)}</span> ${esc(x.r.title)}</button>`).join(''):'<p class="small-note">게시자가 확인한 후속 연결이 아직 없습니다.</p>'}${same.length?'<h3>같은 기업이 등장한 리포트</h3>'+same.map(x=>`<button class="related-card" data-related="${esc(x.id)}" title="기업 태그가 같은 자료입니다. 같은 사건을 뜻하지 않습니다."><span class="report-date">${esc(x.date)}</span> ${esc(x.title)}</button>`).join(''):''}<h3>원문 출처</h3>${sources(r.sources)}`;
 if($('#report-back'))$('#report-back').onclick=returnToReportList;
 $('#hide-report').onclick=()=>changeReportVisibility('hide',r.id);
 if(r.origin){
  const downloads=$('#detail .downloads');
  downloads.insertAdjacentHTML('beforebegin',`<p class="small-note">이 PC에서 가져온 ${r.origin==='markdown'?'MD 리포트':'Outlook 리포트'} · ${r.tags.map(esc).join(' · ')}</p>`);
  if(r.body_markdown)downloads.insertAdjacentHTML('beforeend',`<a href="/api/local/reports/download?id=${encodeURIComponent(r.id)}">MD 다운로드</a>`);
  if(r.mail){mailPool[r.mail.entry_id]=r.mail;downloads.insertAdjacentHTML('beforeend',`<button type="button" data-mail-open="${esc(r.mail.entry_id)}">Outlook 원문 열기</button>`)}
 }
 highlight($('#detail'));renderReportLocal(r);window.AVNotes?.attachReport(r,$('#detail'));
 if(changed)detail.scrollTop=0;
 $$('[data-related]').forEach(b=>b.onclick=()=>selectReport(b.dataset.related,{fromDetail:true}));
}
function syncGitHubSettings(config,force=false){
 if(typeof config?.offline!=='boolean')return;
 if(state)Object.assign(state.config,{offline:config.offline,offline_reason:config.offline_reason||''});
 $$('.settings-form').forEach(f=>{
  const saved=JSON.stringify([config.offline,config.offline_reason||'']);
  if(force||f.dataset.connection!==saved){f.elements.github_enabled.checked=!config.offline;f.dataset.connection=saved}
  f.querySelector('.github-state').textContent=state?.github_choice_required?'이 버전의 GitHub 연동 여부를 선택하고 저장하세요. 선택 전에는 연결을 보류합니다.':f.elements.github_enabled.checked===config.offline?'연동 설정 변경됨 · 아래 저장 버튼을 눌러 적용하세요.':config.offline_reason==='connection_failed'?'연결 실패로 자동 꺼짐 · 다시 켠 뒤 저장하면 연결을 확인합니다.':config.offline?'연동 꺼짐 · GitHub 리포트는 표시하지 않습니다. Outlook·직접 가져온 자료는 계속 사용할 수 있습니다.':'연동 켜짐 · 시작할 때와 설정한 시각에 자료를 확인합니다.';
 });
}
function mountForm(target){let host=$(target);host.replaceChildren($('#settings-form').content.cloneNode(true));let f=host.querySelector('form');for(let k of ['owner','repo','branch','sync_time'])f.elements[k].value=state.config[k];syncGitHubSettings(state.config);f.querySelector('#data-location').textContent='자료 저장 위치: '+state.data_dir;f.querySelector('.save-settings').textContent=state.setup?'검사하고 설치':'검사하고 저장';
 const input=()=>({owner:f.elements.owner.value.trim(),repo:f.elements.repo.value.trim(),branch:f.elements.branch.value.trim(),sync_time:f.elements.sync_time.value,token:f.elements.token.value,clear_token:f.elements.clear_token.checked,offline:!f.elements.github_enabled.checked});
 f.elements.github_enabled.onchange=()=>syncGitHubSettings(state.config);
 async function run(path){if(formBusy)return;formBusy=true;let box=f.querySelector('.checks');box.classList.remove('error');box.textContent='환경을 확인하고 있습니다…';f.querySelectorAll('button').forEach(b=>b.disabled=true);try{let v=await api(path,input());box.textContent=(v.checks||[]).map(s=>'✓ '+s).join('\n');if(!v.ok){box.classList.add('error');box.textContent+='\n'+(v.error||'설정을 확인하세요.')}else if(path==='/api/install'){syncGitHubSettings(v.config,true);f.elements.token.value='';f.elements.clear_token.checked=false;if(state.setup){f.querySelector('.launch').hidden=false;box.textContent+='\n설치 완료. 리포트 시작 버튼을 누르세요.'}else{toast('설정이 저장되었습니다.');await refresh(true)}}}catch(e){box.classList.add('error');box.textContent=e.message}finally{formBusy=false;f.querySelectorAll('button').forEach(b=>b.disabled=false)}}
 f.querySelector('.check-env').onclick=()=>{if(f.reportValidity())run('/api/check')};f.onsubmit=e=>{e.preventDefault();run('/api/install')};f.querySelector('.launch').onclick=async()=>{try{await api('/api/launch',{});f.querySelector('.checks').textContent='리포트가 열렸습니다. 이 설정 창은 닫아도 됩니다.'}catch(e){toast(e.message)}};
}
function showStatus(s){
 if(s.version)$$('[data-app-version]').forEach(el=>{el.textContent='v'+s.version});
 lastSyncState=s.sync_state||'';
 if(typeof updateGitHubChoice==='function')updateGitHubChoice(s);
 syncGitHubSettings(s.config||s);
 const disabled=['offline','auto_disabled','choice_required'].includes(lastSyncState),unavailable=['unavailable','offline','auto_disabled','choice_required','unconfigured'].includes(lastSyncState),button=$('#sync');
 button.disabled=!!(s.syncing||s.setup||disabled);
 button.textContent=s.syncing?'확인 중…':'↻ 지금 업데이트';
 button.title=disabled?'설정에서 GitHub 자료 연동을 켜고 저장하세요.':lastSyncState==='unconfigured'?'GitHub 연결 설정이 필요합니다.':unavailable?`${s.status||'GitHub 연결 불가'} · 눌러서 다시 확인`:'GitHub의 최신 자료를 확인합니다.';
 const signal=s.syncing?'checking':lastSyncState==='ready'?'ready':['unavailable','auto_disabled'].includes(lastSyncState)?'error':'idle';
 const message=s.syncing?'최신 자료 확인 중…':lastSyncState==='choice_required'?'GitHub 연동 선택 대기':lastSyncState==='auto_disabled'?'GitHub 연동 자동 꺼짐':lastSyncState==='offline'?'GitHub 연동 꺼짐':lastSyncState==='unconfigured'?'GitHub 연결 미설정':signal==='error'?'최신 자료 확인 실패':signal==='ready'?'최신 자료 확인 완료':'업데이트 확인 대기';
 const stamp=s.synced_at?new Date(s.synced_at):null,valid=stamp&&!Number.isNaN(stamp.getTime());
 const time=valid?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(stamp):'GitHub 확인 기록 없음';
 $('#sync-indicator').setAttribute('data-state',signal);$('#sync-symbol').textContent={checking:'↻',ready:'✓',error:'!',idle:'−'}[signal];
 $('#sync-status').textContent=message;$('#sync-message').textContent=message;
 $('#sync-summary').title=message+' · 눌러서 자세히 보기';
 $('#sync-time').textContent=time;$('#sync-time').setAttribute('datetime',valid?stamp.toISOString():'');
 $('#sync-time').title='마지막으로 GitHub 자료 확인에 성공한 시간입니다. 자료 변경이 없어도 갱신됩니다.';
 $('#sync-detail').textContent=lastSyncState==='auto_disabled'?'GitHub 연결 실패로 연동을 자동으로 껐습니다. GitHub 리포트는 표시하지 않습니다. Outlook·직접 가져온 자료는 계속 사용할 수 있습니다. 설정에서 GitHub 자료 연동을 켜고 저장하면 다시 연결합니다.':lastSyncState==='offline'?'GitHub 자료 연동이 꺼져 있습니다. 설정에서 켜고 저장하면 최신 자료를 확인할 수 있습니다.':signal==='error'?s.status||'연결을 확인한 뒤 지금 업데이트를 눌러 다시 시도하세요.':lastSyncState==='unconfigured'?'왼쪽 설정 탭에서 GitHub 연결을 설정하세요.':signal==='checking'?'GitHub의 최신 자료를 확인하고 있습니다.':signal==='ready'?'GitHub의 최신 게시 자료와 일치합니다.':s.status||'보관한 자료를 표시하고 있습니다.';
 if(s.outlook_import)outlookImportState=s.outlook_import;
 if(typeof checkDocumentConnections==='function')checkDocumentConnections(s.outlook_import);
 if(lastSyncState==='choice_required')$('#sync-detail').textContent='이 버전에서 GitHub 자료 연동 여부를 선택해 주세요. 설정에서 연동을 켜거나 끄고 저장할 수도 있습니다. 선택 전에는 GitHub 리포트를 표시하지 않습니다. Outlook·직접 가져온 자료는 계속 사용할 수 있습니다.';
 updateOutlookImportStatus();
}
function updateOutlookImportStatus(){
 const el=$('#outlook-import-status');if(el)el.textContent=outlookImportState.message||'폴더를 선택하면 자동으로 가져옵니다.';
 const button=$('#outlook-import-now');if(button)button.disabled=!!outlookImportState.busy||!local.sources.some(s=>s.folder_id);
}
async function loadImportedReports(){
 try{const v=await api('/api/local/reports');importedReports=v.reports||[];localReportsRevision=v.revision||'';importError=''}
 catch(e){importError=e.message}
 mergedSource=null;catalogViews=new WeakMap();
 const note=$('#report-import-status');if(note&&importError)note.textContent=importError;
 if(typeof invalidateDocumentConnections==='function')invalidateDocumentConnections();
}
function updateCatalogView(){
 const options=visibleCatalog({...state.snapshot.catalog,reports:[...state.snapshot.catalog.reports,...importedReports]}).reports;
 for(let [id,values,label] of [['company',options.flatMap(r=>r.companies),'전체 기업'],['category',options.flatMap(r=>r.tags),'전체 분류']]){
  let el=$('#'+id),value=el.value;el.innerHTML=`<option value="">${label}</option>`+[...new Set(values)].sort().map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');el.value=values.includes(value)?value:'';
 }
 if(!catalog().reports.some(r=>r.id===selected)&&!(linkedReport&&linkedReport===selected&&reportOf(selected))){
  const representative=(tab==='search'||tab==='timeline')?dailyRepresentatives.get(selected):'';
  selected=representative||filtered()[0]?.id||'';selectedRelation='';linkedReport='';
 }
 render();refreshReportReading();
}
// The status poll also picks up preferences changed in another window. Ignore
// responses started before a hide/restore so they cannot undo the saved choice.
async function refresh(force=false){
 if(visibilityBusy)return;
 const request=++refreshRequest,old=state?.snapshot.commit;
 if(!force&&state){
  const s=await api('/api/status');if(request!==refreshRequest||visibilityBusy)return;
  showStatus(s);const changed=applyReportVisibility(s.report_visibility);
  if(s.commit===old){if((s.local_revision||'')!==localReportsRevision){await loadImportedReports();if(request!==refreshRequest)return;updateCatalogView()}else if(changed)updateCatalogView();else refreshReportReading();return}
 }
 const next=await api('/api/state');if(request!==refreshRequest||visibilityBusy)return;
 state=next;if(!state.setup)await loadImportedReports();if(request!==refreshRequest)return;applyReportVisibility(state.report_visibility);showStatus({...state,synced_at:state.snapshot.synced_at});updateCatalogView();
}
// Tab is mirrored in the URL hash (#timeline, #graph, #map) so a view can be bookmarked or reloaded.
document.addEventListener('focusin',e=>{if(e.target!==document.body)reportDetailHadFocus=$('#detail').contains(e.target)});
function setTab(t,reportID='',notesReady=false){if(tab==='notes'&&t!=='notes'&&!notesReady&&window.AVNotes?.hasPending()){window.AVNotes.flush().then(ok=>{if(ok)setTab(t,reportID,true)});return}let b=$(`[data-tab="${t}"]`);if(!b)return;if(tab!==t)delete $('#detail').dataset.reportKey;resetMapSelection();tab=t;reportReaderOpen=!!reportID&&narrowReportLayout.matches&&reportListView();reportListScroll=0;reportListFocus=null;networkSelection=null;linkedReport=reportID;$('#visibility-menu').open=false;history.replaceState(null,'',t==='search'?location.pathname:'#'+t);if(t==='map')mapMedia.loaded=false;if(networkView())invalidateNoteNetwork();updateCatalogView();if(reportID)markReportRead(reportID);if(reportReaderOpen){window.scrollTo({top:0,behavior:'instant'});focusReportTitle()}}
$$('[data-tab]').forEach((b,i)=>{b.onclick=()=>setTab(b.dataset.tab);b.onkeydown=e=>{const tabs=$$('[data-tab]');let next;if(e.key==='ArrowDown')next=(i+1)%tabs.length;else if(e.key==='ArrowUp')next=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();setTab(tabs[next].dataset.tab);tabs[next].focus()}});
$('#filter-toggle').onclick=()=>{const panel=$('#filter-panel');panel.hidden=!panel.hidden;$('#filter-toggle').setAttribute('aria-expanded',String(!panel.hidden))};
$('#filter-panel').onkeydown=e=>{if(e.key==='Escape'){$('#filter-panel').hidden=true;$('#filter-toggle').setAttribute('aria-expanded','false');$('#filter-toggle').focus()}};
$('#visibility-menu').onkeydown=e=>{if(e.key==='Escape'){$('#visibility-menu').open=false;$('#visibility-label').focus()}};
$('#help').onclick=()=>{$('#help-current').href='/help.html#'+tab;$('#help-dialog').showModal()};
$('#close-help').onclick=()=>$('#help-dialog').close();
$('#sync-indicator').onkeydown=e=>{if(e.key==='Escape'){$('#sync-indicator').open=false;$('#sync-summary').focus()}};
// Theme: applied early by theme.js; settings changes and remembers it (per browser, never synced).
$('#theme').value=document.documentElement.dataset.theme||'apple';
$('#theme').onchange=e=>{document.documentElement.dataset.theme=e.target.value;try{localStorage.setItem('av_theme',e.target.value)}catch(x){}if(tab==='graph'||tab==='map')render()};
{let h=location.hash.slice(1).split('&')[0];if(h&&$(`[data-tab="${h}"]`)){tab=h;$$('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.tab===tab)))}}
// Keep IME composition intact; coalesce full-list searches only for larger libraries.
for(const id of ['query','local-query','outlook-query']){
 const input=$('#'+id);let composing=false;
 const search=()=>{clearTimeout(searchTimer);if(composing)return;const size=(state?.snapshot?.catalog?.reports?.length||0)+importedReports.length+local.files.length+local.mails.length;if(size>50)searchTimer=setTimeout(render,150);else render()};
 input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(searchTimer)});
 input.addEventListener('compositionend',()=>{composing=false;search()});
 input.addEventListener('input',e=>{if(!e.isComposing)search()});
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&!composing){clearTimeout(searchTimer);render()}});
}
for(const id of ['company','category','from','to','sort'])$('#'+id).addEventListener('change',render);
try{$('#strict').checked=localStorage.getItem('av_strict')!=='0'}catch(e){}
$('#strict').onchange=()=>{saveStrict();render()};
$('#clear').onclick=()=>{$('#query').value='';render();$('#query').focus()};$('#reset').onclick=()=>{for(let id of ['query','company','category','from','to'])$('#'+id).value='';$('#strict').checked=true;saveStrict();render()};
$('#local-clear').onclick=()=>{$('#local-query').value='';render();$('#local-query').focus()};
$('#outlook-clear').onclick=()=>{$('#outlook-query').value='';render();$('#outlook-query').focus()};
for(const key of Object.keys(networkSources))$('#source-'+key).onchange=e=>{
 networkSources[key]=e.target.checked;if(key==='notes'&&e.target.checked)invalidateNoteNetwork();
 try{localStorage.setItem('av_network_sources',JSON.stringify(networkSources))}catch(x){}
 resetMapSelection();networkSelection=null;mapMediaSelected='';mapMediaEdge=null;selected='';selectedRelation='';render();
};
$('#sync').onclick=async()=>{if(['offline','auto_disabled','unconfigured'].includes(lastSyncState)){setTab('settings');$('#tab-settings').focus();return}try{await api('/api/sync',{});toast('GitHub 연결과 최신 자료를 다시 확인합니다.');setTimeout(()=>refresh(),400)}catch(e){toast(e.message)}};
$('#exit').onclick=async()=>{if(window.AVNotes&&!await window.AVNotes.flush())return;if(!confirm('프로그램을 종료할까요? 다음 실행 전까지 자동 갱신이 멈춥니다.'))return;try{await api('/api/exit',{});document.body.innerHTML='<main class="empty"><h1>AV 리포트를 종료했습니다.</h1><p>이 브라우저 창을 닫아도 됩니다.</p></main>'}catch(e){toast(e.message)}};
(async()=>{try{await refresh(true);await loadLocal();if(state.setup){$('#viewer').hidden=true;$('#setup-home').hidden=false;mountForm('#setup-slot');await autoInstall()}else if(!state.config.configured){setTab('settings')}setInterval(()=>{refresh().catch(()=>{});if(networkView()&&!document.hidden)loadNoteNetwork(true)},4000)}catch(e){toast(e.message)}})();

async function autoInstall(){
 const slot=$('#setup-slot');slot.hidden=true;const status=document.createElement('p');status.className='checks';status.setAttribute('role','status');slot.before(status);
 status.textContent='환경 검사 · 실행 파일 · 바로가기를 자동으로 준비합니다…';
 try{const result=await api('/api/install',{...state.config,automatic:true,token:''});if(!result.ok)throw Error(result.error);status.textContent=result.checks.join('\n')+'\n설치 완료. 리포트를 자동으로 엽니다…';await api('/api/launch',{});status.textContent='설치가 끝났습니다. 리포트가 새 탭에서 열렸고 바탕화면에 AV Report Hub 바로가기가 생겼습니다.\n이 탭은 닫아도 됩니다.';}catch(e){status.textContent='자동 준비를 완료하지 못했습니다: '+e.message+'\n아래에서 설정을 확인한 뒤 다시 시도하거나, 「GitHub 자료 연동」을 끄고 설치하세요.';slot.hidden=false;}
}

// 내 자료: PDFs and Outlook links stay on this PC (the server DPAPI-encrypts them; nothing goes to GitHub).
// Ordinary mail keeps metadata only; selected daily reports use a separate encrypted archive.
const mailCache={},mailPool={};
const fmtSize=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
async function loadLocal(){if(!state||state.setup)return;try{let v=await api('/api/local');local={available:v.available,reason:v.reason||'',files:v.files||[],mails:v.mails||[],sources:v.sources||[]}}catch(e){local={...local,available:false,reason:e.message}}if(typeof invalidateDocumentConnections==='function')invalidateDocumentConnections();render()}
async function localDo(path,body,msg){try{let v=await api(path,body);if(msg)toast(msg);await loadLocal();return v}catch(e){toast(e.message)}}
async function addFiles(list){if(!local.available)return toast(local.reason||'내 자료를 사용할 수 없습니다.');let ok=0,msgs=[];
 for(let f of list){if(/\.(pst|ost|nst|msg|olm)$/i.test(f.name)){msgs.push(`${f.name}: 아웃룩 데이터는 복사하지 않습니다. Outlook 탭의 ‘Outlook 연동’에서 위치를 지정하세요.`);continue}
  if(!/\.pdf$/i.test(f.name)&&f.type!=='application/pdf'){msgs.push(`${f.name}: PDF만 추가할 수 있습니다.`);continue}
  if(f.size>50*1048576){msgs.push(`${f.name}: 50MB를 넘습니다.`);continue}
  try{let r=await fetch('/api/local/add?name='+encodeURIComponent(f.name),{method:'POST',headers:{'X-AV-Request':'1','Content-Type':'application/pdf'},body:f});if(!r.ok)throw Error(await r.text());localSel=(await r.json()).id;ok++}catch(e){msgs.push(`${f.name}: ${e.message}`)}}
 await loadLocal();if(ok)setTab('local');toast([ok?`PDF ${ok}개를 이 PC에만 보관했습니다.`:'',...msgs].filter(Boolean).join('\n'))}
const mailRow=(m,act='')=>(mailPool[m.entry_id]=m,`<div class="mail-row"><button class="mail-open" data-mail-open="${esc(m.entry_id)}" title="Outlook에서 열기"><b>${uiIcon('mail')} ${esc(m.subject||'(제목 없음)')}</b><small>${esc(m.sender)} · ${esc((m.received||'').slice(0,10))} · ${esc(m.folder)}</small></button>${act}</div>`);
function renderLocal(){$('#result-count').textContent=`PDF ${local.files.length}개 · 이 PC에만 보관`;
 if(!local.available){$('#results').innerHTML=`<div class="empty">${esc(local.reason||'내 자료를 불러오는 중입니다.')}</div>`;return}
 let q=$('#local-query').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),fs=local.files.filter(f=>q.every(t=>f.name.toLocaleLowerCase().includes(t))).sort((a,b)=>b.added.localeCompare(a.added));
 $('#result-count').textContent=`PDF ${fs.length}${fs.length!==local.files.length?' / '+local.files.length:''}개 · 이 PC에만 보관`;
 $('#results').innerHTML=`<p class="local-note">${uiIcon('lock')} PDF를 이 PC의 현재 Windows 계정으로 암호화해 보관합니다. 리포트에 직접 연결하면 관계 그래프와 전체 지도에도 표시됩니다.</p>
 <div class="dropzone compact-dropzone" id="dropzone" tabindex="0" role="button" aria-label="PDF 추가"><b>＋ PDF 추가</b><span>파일 선택 또는 끌어다 놓기 · 최대 50MB</span></div>
 <div class="pdf-list">${fs.length?`<table class="pdf-table" aria-label="보관한 PDF 파일"><thead><tr><th scope="col">이름</th><th scope="col" class="pdf-date">추가일</th><th scope="col" class="pdf-size">크기</th><th scope="col" class="pdf-links-cell">연결</th><th scope="col" class="pdf-actions-cell"><span class="sr-only">삭제</span></th></tr></thead><tbody>${fs.map(f=>`<tr class="pdf-list-row ${localSel===f.id?'selected':''}"><td><button type="button" class="pdf-file" data-local="${esc(f.id)}" title="${esc(f.name)} · ${esc(f.added.slice(0,10))} 추가 · ${fmtSize(f.size)} · PDF 미리보기" aria-pressed="${localSel===f.id}"><span class="pdf-file-icon" aria-hidden="true">PDF</span><span class="pdf-file-text"><b>${esc(f.name)}</b></span></button></td><td class="pdf-date">${esc(f.added.slice(0,10))}</td><td class="pdf-size">${fmtSize(f.size)}</td><td class="pdf-links-cell"><button type="button" class="pdf-links-button" data-local-links="${esc(f.id)}" aria-label="${esc(f.name)} 연결 리포트" title="연결 리포트 보기"><span>${f.reports.filter(id=>!hiddenReports.has(id)).length}</span></button></td><td class="pdf-actions-cell"><button type="button" class="list-delete" data-delete-pdf="${esc(f.id)}" aria-label="${esc(f.name)} 이 PC에서 삭제" title="휴지통으로 이동 · Shift+Delete 완전 삭제" ${deletingPDFs.has(f.id)?'disabled':''}>${deleteIcon}</button></td></tr>`).join('')}</tbody></table>`:`<p class="small-note">${local.files.length?'파일명과 일치하는 PDF가 없습니다.':'아직 추가한 PDF가 없습니다.'}</p>`}</div>`;
 const dz=$('#dropzone');dz.onclick=()=>$('#local-input').click();dz.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();dz.click()}};
 $$('[data-local]').forEach(b=>b.onclick=()=>{localSel=b.dataset.local;$$('[data-local]').forEach(x=>{x.setAttribute('aria-pressed',String(x===b));x.closest('.pdf-list-row').classList.toggle('selected',x===b)});renderLocalDetail()});
 $$('.pdf-list-row').forEach(row=>row.onclick=e=>{if(!e.target.closest('button'))row.querySelector('[data-local]').click()});
 $$('[data-local-links]').forEach(b=>b.onclick=()=>{pdfLinksID=b.dataset.localLinks;renderPDFLinksDialog();$('#pdf-links-dialog').showModal()});
 $$('[data-delete-pdf]').forEach(b=>b.onclick=()=>deleteLocalPDF(local.files.find(f=>f.id===b.dataset.deletePdf)));
}
async function deleteLocalPDF(f){
 if(window.AVSelection){if(f)await window.AVSelection.remove(window.AVSelection.forItem({kind:'pdf',id:f.id,title:f.name}));return}

 if(!f||deletingPDFs.has(f.id)||!confirm(`‘${f.name}’을(를) 이 PC에서 삭제할까요? PDF와 리포트 연결이 삭제되며 되돌릴 수 없습니다.`))return;
 deletingPDFs.add(f.id);$$('[data-delete-pdf]').forEach(b=>b.disabled=deletingPDFs.has(b.dataset.deletePdf));if($('#pdf-delete'))$('#pdf-delete').disabled=true;
 try{await api('/api/local/delete',{id:f.id});if(localSel===f.id)localSel='';if(pdfLinksID===f.id)$('#pdf-links-dialog').close();await loadLocal();toast('PDF를 이 PC에서 삭제했습니다.')}
 catch(e){toast(e.message)}finally{deletingPDFs.delete(f.id);if(tab==='local'){renderLocal();renderLocalDetail()}}
}
function renderPDFLinksDialog(){
 const f=local.files.find(x=>x.id===pdfLinksID),host=$('#pdf-links-content');if(!f){$('#pdf-links-dialog').close();return}
 const linked=f.reports.filter(id=>!hiddenReports.has(id)),choices=catalog().reports.filter(r=>!f.reports.includes(r.id));
 $('#pdf-links-name').textContent=f.name;
 host.innerHTML=`<div class="pdf-linked-list">${linked.map(id=>`<div class="pdf-linked-row"><span><b>${esc(reportOf(id)?.title||id)}</b><small>${esc(reportOf(id)?.date||'')}</small></span><button type="button" data-dialog-unlink="${esc(id)}" aria-label="${esc(reportOf(id)?.title||id)} 연결 해제">해제</button></div>`).join('')||'<p class="small-note">연결된 리포트가 없습니다.</p>'}</div>${f.reports.length>linked.length?'<p class="note">목록에서 숨긴 연결 리포트는 설정에서 복원할 수 있습니다.</p>':''}<form id="pdf-links-form" class="link-form"><select id="pdf-dialog-target" aria-label="연결할 리포트" required><option value="">리포트 선택…</option>${choices.map(reportLinkOption).join('')}</select><button class="primary" ${choices.length?'':'disabled'}>연결</button></form><p id="pdf-links-feedback" class="small-note" role="status"></p>`;
 async function save(report,remove=false){if(pdfLinkBusy)return;pdfLinkBusy=true;host.querySelectorAll('button,select').forEach(b=>b.disabled=true);try{await api('/api/local/link',{id:f.id,report,remove});await loadLocal();if(pdfLinksID===f.id)$('#pdf-links-feedback').textContent=remove?'연결을 해제했습니다.':'리포트에 연결했습니다.'}catch(e){if(pdfLinksID===f.id)$('#pdf-links-feedback').textContent=e.message}finally{pdfLinkBusy=false;host.querySelectorAll('button,select').forEach(b=>b.disabled=false)}}
 $('#pdf-links-form').onsubmit=e=>{e.preventDefault();const id=$('#pdf-dialog-target').value;if(id)save(id)};
 host.querySelectorAll('[data-dialog-unlink]').forEach(b=>b.onclick=()=>save(b.dataset.dialogUnlink,true));
}
$('#pdf-links-close').onclick=()=>$('#pdf-links-dialog').close();
$('#pdf-links-dialog').addEventListener('close',()=>{pdfLinksID='';$('#pdf-links-content').replaceChildren()});
let outlookConnectOpen=false,outlookConnectBusy=false,outlookConnectError='';
function toggleOutlookConnection(open=!outlookConnectOpen){outlookConnectOpen=open;$('#outlook-connection-panel').hidden=!open;$('#outlook-import-toggle').setAttribute('aria-expanded',String(open));if(!open)$('#outlook-import-toggle').focus()}
function renderOutlook(){
 const q=$('#outlook-query').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),match=(...fields)=>q.every(t=>fields.filter(Boolean).join(' ').toLocaleLowerCase().includes(t));
 const reports=catalog().reports.filter(r=>reportSource(r)==='outlook'&&match(r.title,r.mail?.subject,r.mail?.sender,r.mail?.folder,...r.tags)).sort((a,b)=>b.date.localeCompare(a.date));
 const mails=local.mails.filter(m=>match(m.subject,m.sender,m.folder));
 $('#result-count').textContent=`가져온 리포트 ${reports.length}개 · 연결된 메일 ${mails.length}개 · 연결 폴더 ${local.sources.filter(s=>s.folder_id).length}개`;
 if(!local.available){$('#results').innerHTML=`<div class="empty">${esc(local.reason||'Outlook 연결 정보를 불러오는 중입니다.')}</div>`;return}
 const has=s=>local.sources.some(x=>(x.folder_id||'')===(s.folder_id||'')&&((s.store_id&&x.store_id===s.store_id)||(s.path&&x.path&&x.path.toLowerCase()===s.path.toLowerCase())));
 $('#results').innerHTML=`<section class="outlook-import-area"><div class="outlook-import-bar"><button type="button" class="filter-toggle" id="outlook-import-toggle" aria-expanded="${outlookConnectOpen}" aria-controls="outlook-connection-panel">메일함에서 리포트 가져오기 <span aria-hidden="true">⌄</span></button><span class="outlook-folder-count">연결 폴더 ${local.sources.filter(s=>s.folder_id).length}개</span><button id="outlook-import-now" ${local.sources.some(s=>s.folder_id)?'':'disabled'}>지금 가져오기</button></div><p id="outlook-import-status" class="small-note" role="status"></p>
 <section id="outlook-connection-panel" class="outlook-connection-panel" ${outlookConnectOpen?'':'hidden'}><p class="small-note">클래식 Outlook의 선택한 폴더만 5분마다 확인합니다. 데일리리포트 형식의 본문·MD 첨부를 가져옵니다. 일반 메일은 자료 연결 추천을 위해 제목·발신자·날짜·대화 ID와 문서 첨부의 이름·지문만 보관합니다. 자료는 이 PC에 암호화해 보관합니다.</p><h3>연결된 메일함·폴더</h3>
 ${local.sources.map((s,i)=>`<div class="mail-row"><span class="source-name">${uiIcon('mail')} <b>${esc(s.name)}</b><small>${s.folder_id?'자동 가져오기 · 태그: '+esc(s.folder_name):'메일 검색 연결 · 자동 가져오기는 폴더 선택 필요'}</small>${s.path?`<small>${esc(s.path)}</small>`:''}</span>${!s.folder_id?`<button class="text-button" data-source-folders="${i}">폴더 선택</button>`:''}<button class="text-button" data-src-remove="${i}">연결 해제</button></div>`).join('')||'<p class="small-note">지정된 메일 자료가 없습니다. 아래에서 메일함을 불러오거나 PST·OST 경로를 추가하세요.</p>'}
 <h3>연결할 메일함·파일 선택</h3><p class="small-note">아래는 연결 가능한 후보입니다. 연결을 해제해도 Outlook 원본과 이미 가져온 리포트는 보관되며, 메일함은 후보 목록에 남습니다.</p><button id="outlook-connect" ${outlookConnectBusy?'disabled':''}>${outlookConnectBusy?'Outlook 확인 중…':'Outlook 메일함 불러오기'}</button><p class="small-note" role="status">${outlookConnectBusy?'메일함을 확인하고 있습니다.':esc(outlookConnectError)}</p>
 ${outlookStores?outlookStores.map((s,i)=>`<div class="mail-row"><span class="source-name">${esc(s.name)}${s.path?`<small>${esc(s.path)}</small>`:''}</span><button class="text-button" data-store-folders="${i}">폴더 선택</button></div>`).join('')||'<p class="small-note">연결할 메일함이 없습니다. 아래에서 PST·OST 파일을 지정할 수 있습니다.</p>':''}
 ${outlookFolders?`<div class="outlook-folders"><h4>가져올 폴더 선택</h4>${outlookFolders.map((s,i)=>`<div class="mail-row"><span class="source-name">${esc(s.name)}</span><button class="text-button" data-folder-add="${i}" ${has(s)?'disabled':''}>${has(s)?'연결됨':'이 폴더 추가'}</button></div>`).join('')||'<p>메일 폴더가 없습니다.</p>'}</div>`:''}
 ${outlookPathHtml()}<button id="outlook-connect-close" class="text-button">연결 설정 접기</button></section></section>
 <h3 class="local-h">Outlook에서 가져온 리포트</h3><p class="small-note">데일리리포트 형식의 자료는 데일리리포트에도 표시합니다. 보고일과 본문이 같은 자료는 한 번만 표시하며, 가져온 내역과 원본 메일은 여기서 확인합니다.</p>${importError?`<p class="small-note error">${esc(importError)}</p>`:''}${reports.slice(0,reportListLimit).map(reportCard).join('')+reportPageMore(reports.length)||'<p class="small-note">표시할 Outlook 리포트가 없습니다. 위의 ‘메일함에서 리포트 가져오기’를 열어 폴더를 설정하거나 검색어를 확인하세요.</p>'}
 <h3 class="local-h">리포트에 연결한 메일</h3>${mails.map(m=>mailRow(m,`<button class="text-button" data-goto-report="${esc(m.report)}">${esc(reportOf(m.report)?.title||m.report)}</button>`)).join('')||'<p class="small-note">표시할 연결 메일이 없습니다. 리포트 본문에서 관련 메일을 찾아 연결할 수 있습니다.</p>'}`;
 $$('[data-src-remove]').forEach(b=>b.onclick=()=>localDo('/api/outlook/source',{source:local.sources[+b.dataset.srcRemove],remove:true},'메일함 연결을 해제했습니다. Outlook 원본과 가져온 리포트는 보관됩니다.'));
 $$('[data-store-folders]').forEach(b=>b.onclick=()=>loadOutlookFolders(outlookStores[+b.dataset.storeFolders],b));
 $$('[data-source-folders]').forEach(b=>b.onclick=()=>loadOutlookFolders(local.sources[+b.dataset.sourceFolders],b));
 $$('[data-folder-add]').forEach(b=>b.onclick=()=>localDo('/api/outlook/source',{source:outlookFolders[+b.dataset.folderAdd]},'폴더를 추가했습니다. 자동으로 가져옵니다.'));
 $('#outlook-import-now').onclick=async()=>{try{await api('/api/outlook/import',{});outlookImportState={busy:true,message:'Outlook 폴더 확인을 요청했습니다…'};updateOutlookImportStatus()}catch(e){toast(e.message)}};
 updateOutlookImportStatus();
 $('#outlook-import-toggle').onclick=()=>toggleOutlookConnection();
 $('#outlook-connection-panel').onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();toggleOutlookConnection(false)}};
 $('#outlook-connect').onclick=connectOutlook;
 $('#outlook-connect-close').onclick=()=>toggleOutlookConnection(false);
 bindOutlookPathForm();
}
async function connectOutlook(){
 if(outlookConnectBusy)return;
 outlookConnectOpen=true;outlookConnectBusy=true;outlookConnectError='';render();
 try{outlookStores=(await api('/api/outlook/stores',{})).stores||[]}catch(e){outlookConnectError=e.message}
 finally{outlookConnectBusy=false;render()}
}
async function loadOutlookFolders(source,button){
 outlookConnectOpen=true;
 button.disabled=true;button.textContent='폴더 확인 중…';
 try{outlookFolders=(await api('/api/outlook/folders',{source})).folders||[]}catch(e){toast(e.message)}render();
}
// Use the browser's local PDF viewer: no external service, conversion, or plaintext disk copy.
function mountPDFPreview(host,f,expanded=false){
 const u='/api/local/file?id='+encodeURIComponent(f.id);
 host.innerHTML=`<section class="pdf-preview" aria-label="PDF 미리보기"><div class="pdf-preview-toolbar"><strong>PDF 미리보기</strong>${expanded?'':'<button type="button" class="pdf-expand">크게 보기</button>'}<a href="${u}&view=1" target="_blank" rel="noopener">새 탭에서 열기</a><a href="${u}">다운로드</a></div><p class="pdf-preview-status" role="status">PDF를 불러오는 중…</p><button type="button" class="pdf-preview-retry" hidden>다시 시도</button><iframe class="pdf-frame" title="${esc(f.name)} PDF 미리보기" hidden></iframe><p class="pdf-preview-note">페이지 이동·확대/축소는 PDF 도구 모음에서 할 수 있습니다. 표시되지 않으면 새 탭에서 열거나 다운로드하세요.</p></section>`;
 const frame=host.querySelector('iframe'),status=host.querySelector('[role="status"]'),retry=host.querySelector('.pdf-preview-retry');
 let request;
 const fail=message=>{frame.hidden=true;frame.removeAttribute('src');status.hidden=false;status.classList.add('error');status.textContent=message;retry.hidden=false};
 async function load(){
  request?.abort();request=new AbortController();const signal=request.signal;
  status.hidden=false;status.classList.remove('error');status.textContent='PDF를 불러오는 중…';retry.hidden=true;
  if(navigator.pdfViewerEnabled===false){status.textContent='이 브라우저에서는 PDF 미리보기를 지원하지 않습니다. 새 탭에서 열거나 다운로드하세요.';return}
  try{
   // HEAD catches missing/decryption failures before handing the document to the native viewer.
   const response=await fetch(u+'&view=1',{method:'HEAD',cache:'no-store',signal});
   if(!response.ok)throw Error(response.status===404?'PDF를 열 수 없습니다. 파일이 삭제되었거나 현재 계정에서 읽을 수 없습니다.':'PDF를 불러오지 못했습니다. 다시 시도하거나 프로그램을 다시 실행하세요.');
   if(!response.headers.get('Content-Type')?.startsWith('application/pdf'))throw Error('PDF 응답을 확인할 수 없습니다. 프로그램을 다시 실행하세요.');
   if(signal.aborted||!host.isConnected)return;
   frame.onload=()=>{status.hidden=true};frame.onerror=()=>fail('PDF 미리보기를 불러오지 못했습니다. 새 탭에서 열거나 다운로드하세요.');
   frame.hidden=false;frame.src=u+'&view=1#toolbar=1&navpanes=0&view=FitH';
  }catch(e){if(!signal.aborted&&host.isConnected)fail(e.message)}
 }
 retry.onclick=load;
 if(!expanded)host.querySelector('.pdf-expand').onclick=()=>openPDFDialog(f);
 load();return {id:f.id,host,dispose(){request?.abort();frame.onload=null;frame.onerror=null;frame.removeAttribute('src')}};
}
function openPDFDialog(f){
 dialogPDFPreview?.dispose();
 $('#pdf-dialog-title').textContent=f.name;
 $('#pdf-dialog').showModal();
 dialogPDFPreview=mountPDFPreview($('#pdf-dialog-preview'),f,true);
}
$('#pdf-dialog-close').onclick=()=>$('#pdf-dialog').close();
$('#pdf-dialog').addEventListener('close',()=>{dialogPDFPreview?.dispose();dialogPDFPreview=null;$('#pdf-dialog-preview').replaceChildren()});
function renderLocalDetail(){let f=local.available&&local.files.find(x=>x.id===localSel);if(!f){localPDFPreview?.dispose();localPDFPreview=null;$('#detail').innerHTML='<div class="empty">PDF를 선택하면<br>미리보기·리포트 연결·삭제를 할 수 있습니다.</div>';return}
 let rs=catalog().reports,linked=f.reports.filter(id=>!hiddenReports.has(id));
 // Keep the iframe mounted during filename searches, linking and background refreshes,
 // so the native viewer retains the current page and zoom.
 if(localPDFPreview?.id!==f.id||!localPDFPreview.host.isConnected){
  localPDFPreview?.dispose();
  $('#detail').innerHTML=`<div class="local-file-heading"><span class="report-date">${esc(f.added.slice(0,10))} 추가 · ${fmtSize(f.size)} · 이 PC 전용</span><h2>${uiIcon('file')} ${esc(f.name)}</h2></div><div id="local-pdf-preview"></div><div id="local-pdf-links"></div>`;
  $('#detail').scrollTop=0;
  localPDFPreview=mountPDFPreview($('#local-pdf-preview'),f);
 }
 $('#local-pdf-links').innerHTML=`<h3>연결된 리포트</h3>${linked.map(id=>`<div class="mail-row"><button class="related-card" data-goto-report="${esc(id)}">${esc(reportOf(id)?.title||id)}<small>${esc(reportOf(id)?.date||'')}</small></button><button class="text-button" data-pdf-unlink="${esc(id)}">해제</button></div>`).join('')||'<p class="small-note">연결된 리포트가 없습니다.</p>'}
 <div class="link-form"><select id="pdf-target" aria-label="연결할 리포트"><option value="">리포트 선택…</option>${rs.filter(r=>!f.reports.includes(r.id)).map(reportLinkOption).join('')}</select><button id="pdf-link" class="primary">연결</button></div>
 <h3>삭제</h3><button id="pdf-delete" class="danger">이 PC에서 삭제</button>`;
 $('#pdf-link').onclick=()=>{let v=$('#pdf-target').value;if(v)localDo('/api/local/link',{id:f.id,report:v},'리포트에 연결했습니다.')};
 $$('[data-pdf-unlink]').forEach(b=>b.onclick=()=>localDo('/api/local/link',{id:f.id,report:b.dataset.pdfUnlink,remove:true}));
 $('#pdf-delete').disabled=deletingPDFs.has(f.id);$('#pdf-delete').onclick=()=>deleteLocalPDF(f);
}
// Report detail: linked PDFs/mail, Outlook suggestions from the report's companies (±30 days), and a manual search.
function renderReportLocal(r){if(state.setup||!local.available)return;
 if(networkView())return;
 if(r.origin)return;
 let pdfs=local.files.filter(f=>f.reports.includes(r.id)),linked=local.mails.filter(m=>m.report===r.id),sug=mailCache[r.id],empty=!pdfs.length&&!linked.length,box=document.createElement(empty?'details':'section');box.className='local-links'+(empty?' local-links-empty':'');
 let list=sug===undefined?(r.companies.length?'':'<p class="small-note">기업 태그가 없어 자동 제안이 없습니다. 직접 검색하세요.</p>'):sug.loading?'<p class="small-note">Outlook에서 찾는 중…</p>':sug.error?`<p class="small-note error">${esc(sug.error)}</p>`:(sug.mails.filter(m=>!linked.some(x=>x.entry_id===m.entry_id)).map(m=>mailRow(m,`<button class="text-button" data-mail-link="${esc(m.entry_id)}">연결</button>`)).join('')||'<p class="small-note">찾은 메일이 없습니다.</p>');
 box.innerHTML=(empty?'<summary>내 자료 · 연결 없음</summary><div class="local-links-content">':`<h3>${uiIcon('lock')} 내 자료 <small>이 PC 전용</small></h3>`)+`${pdfs.map(f=>`<div class="mail-row"><a class="mail-open" href="/api/local/file?id=${encodeURIComponent(f.id)}&view=1" target="_blank" rel="noopener"><b>${uiIcon('file')} ${esc(f.name)}</b><small>${fmtSize(f.size)}</small></a></div>`).join('')}${linked.map(m=>mailRow(m,`<button class="text-button" data-mail-unlink="${esc(m.entry_id)}">해제</button>`)).join('')}
 ${local.sources.length?`<div class="cloud-title">${sug?.q?`‘${esc(sug.q)}’ 검색 결과`:`관련 메일 제안 · ${esc(r.companies.slice(0,6).join(', '))} · 리포트 전후 30일`}</div>${list}<form class="link-form"><input name="q" placeholder="메일 직접 검색 (제목·본문)" aria-label="메일 직접 검색" value="${esc(sug?.q||'')}"><button class="primary">검색</button></form>`:'<p class="small-note">Outlook 탭의 ‘Outlook 연동’으로 메일함이나 PST를 지정하면 관련 메일을 찾아 연결할 수 있습니다.</p>'}`+(empty?'</div>':'');
 if(empty){box.open=expandedLocalLinks.has(r.id);box.addEventListener('toggle',()=>{if(box.isConnected){if(box.open)expandedLocalLinks.add(r.id);else expandedLocalLinks.delete(r.id)}})}
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
 let g=e.target.closest('[data-goto-report]');if(g){if(tab==='outlook')selectReport(g.dataset.gotoReport,{fromDetail:true,exactSource:true});else{selected=g.dataset.gotoReport;selectedRelation='';setTab(reportSource(reportOf(selected)||{})==='outlook'?'outlook':'search',selected)}}});
// Files dropped anywhere become 내 자료; the browser must never open or navigate to a dropped file.
let dragDepth=0;const dragFiles=e=>[...(e.dataTransfer?.types||[])].includes('Files');
addEventListener('dragenter',e=>{if(!dragFiles(e))return;e.preventDefault();if(state&&!state.setup&&tab!=='rag'&&tab!=='notes'){dragDepth++;$('#drop-overlay').hidden=false}});
addEventListener('dragover',e=>{if(dragFiles(e))e.preventDefault()});
addEventListener('dragleave',e=>{if(dragFiles(e)&&--dragDepth<=0){dragDepth=0;$('#drop-overlay').hidden=true}});
addEventListener('drop',e=>{if(!dragFiles(e))return;e.preventDefault();dragDepth=0;$('#drop-overlay').hidden=true;if(state&&!state.setup&&tab!=='rag'&&tab!=='notes')routeDroppedFiles([...e.dataTransfer.files])});
$('#local-input').onchange=e=>{addFiles([...e.target.files]);e.target.value=''};

let reportImportBusy=false;
async function routeDroppedFiles(files){
 const md=files.filter(f=>/\.md$/i.test(f.name)),other=files.filter(f=>!/\.md$/i.test(f.name));
 if(other.length)await addFiles(other);if(md.length)await importReportFiles(md);
}
async function importReportFiles(files){
 if(reportImportBusy)return toast('MD를 가져오는 중입니다. 완료 후 다시 놓아 주세요.');
 reportImportBusy=true;$('#report-import-button').disabled=true;
 const messages=[];let chosen='';$('#report-import-status').textContent='MD 형식을 확인하고 있습니다…';
 try{
 const accepted=[];
 for(const file of files){
  if(!/\.md$/i.test(file.name)||file.size>2*1048576)messages.push(`${file.name}: UTF-8 MD 파일(최대 2MB)을 선택하세요.`);
  else accepted.push(file);
 }
 while(accepted.length){
  const batch=[],body=new FormData();let bytes=0;
  while(accepted.length&&batch.length<256&&bytes+accepted[0].size<=24*1048576){const file=accepted.shift();batch.push(file);bytes+=file.size;body.append('files',file,file.name)}
  try{
   const response=await fetch('/api/local/reports/import-batch',{method:'POST',headers:{'X-AV-Request':'1'},body});
   if(!response.ok)throw Error(await response.text());
   for(const result of (await response.json()).results){messages.push(`${result.name}: ${result.message||({added:'가져왔습니다.',updated:'같은 날짜의 로컬 리포트를 갱신했습니다.',unchanged:'이미 가져온 내용입니다.',kept:'기존 자료를 유지했습니다.'}[result.status]||result.status)}`);if(result.id)chosen=result.id}
  }catch(e){for(const file of batch)messages.push(`${file.name}: ${e.message}`)}
 }
 await loadImportedReports();if(chosen){selected=chosen;selectedRelation='';for(const id of ['query','company','category','from','to'])$('#'+id).value='';setTab('search',chosen)}updateCatalogView();
 }finally{reportImportBusy=false;$('#report-import-button').disabled=false;$('#report-import-status').textContent=messages.join('\n')}
}
$('#report-import-button').onclick=()=>$('#report-input').click();
$('#report-input').onchange=e=>{importReportFiles([...e.target.files]);e.target.value=''};

// ---- AI 검색 (optional): proxied to rag/rag_server.py on this PC; nothing here touches catalog/sync.
let rag={status:null,demo:null,hits:[],busy:'',warned:false,hit:null,q:'',uploading:false,toolsOpen:false,queryRequest:0,highlightRequest:0};
const deletingRagDocs=new Set();
const ragFilePattern=/\.(pdf|png|jpe?g|jfif|webp|gif|bmp|tiff?|avif|heic|heif|ico)$/i;
const ragPageLabel=(item,page)=>item.kind==='image'&&item.pages!==undefined&&item.pages===1?'이미지':item.kind==='image'?`이미지 ${page}`:`p.${page}`;
const fmtS=s=>s==null?'-':`${s}초`,fmtN=n=>n==null?'-':Number(n).toLocaleString('ko-KR');
async function ragStatus(){try{rag.status=await api('/api/rag/status')}catch(e){rag.status={available:false,error:e.message}}}
async function renderRag(){if(!ragEnvironmentState)await pollRagEnvironment();if(!rag.status)await ragStatus();const s=rag.status;$('#result-count').textContent=s&&s.ok?'이 PC의 PDF·이미지 검색':'서비스 연결 안 됨';
 if(tab!=='rag')return;
 if(!s||!s.ok){$('#results').innerHTML='<div id="rag-environment">'+ragEnvironmentHtml()+'</div><div class="empty">환경 설정 후 검색 서비스를 시작하면 PDF·이미지를 올려 검색할 수 있습니다.</div>';bindRagEnvironment();scheduleRagEnvironment();return}
 const m=s.model||{};
 $('#results').innerHTML=`<div id="rag-environment">${ragEnvironmentHtml()}</div>
 <section class="rag-library" id="rag-drop" aria-labelledby="rag-library-title">
 <div class="rag-library-heading"><h2 id="rag-library-title">색인된 자료 <span>${(s.docs||[]).length}</span></h2><button type="button" id="rag-add" aria-describedby="rag-add-help" ${rag.uploading?'disabled':''}><span aria-hidden="true">+</span> PDF·이미지 추가</button></div>
 <form class="link-form" id="rag-query"><input name="q" placeholder="색인된 자료에서 검색" aria-label="AI 검색" maxlength="2000" value="${esc(rag.q)}"><button class="primary">검색</button></form>
 <p id="rag-job-progress" class="small-note" role="status">${rag.uploading?esc(rag.busy):''}</p><div id="rag-out">${rag.busy&&!rag.uploading?`<p class="small-note" role="status">${esc(rag.busy)}</p>`:''}${ragHitsHtml()}</div>
 <div class="rag-document-list">${(s.docs||[]).map(d=>`<div class="rag-document"><button class="rag-document-open" data-rag-open="${esc(d.id)}">${uiIcon(d.kind==='image'?'image':'file')}<span><b>${ragMarkedText(d.name)}</b><small>${d.kind==='image'&&d.pages===1?'이미지':`${d.pages}페이지`} · ${fmtSize(d.size)}</small></span></button><button class="text-button" data-rag-del="${esc(d.id)}" aria-label="${esc(d.name)} 삭제" ${rag.uploading||deletingRagDocs.has(d.id)?'disabled':''}>삭제</button></div>`).join('')||'<div class="rag-library-empty"><b>아직 색인된 자료가 없습니다.</b><p>PDF·이미지를 추가하거나 여기에 놓으세요.</p></div>'}</div>
 <div class="rag-library-footer"><p class="small-note" id="rag-add-help">목록에 파일 끌어놓기 · 파일당 50MB<br>이 PC에 암호화 없이 저장</p><button class="text-button" id="rag-show-map">전체 지도에서 보기</button></div>
 </section>
 <details class="rag-tools" id="rag-tools" ${rag.toolsOpen?'open':''}><summary>색인·모델 정보</summary>
 <p class="small-note">PDF·TIFF는 모든 페이지, 움직이는 이미지는 첫 프레임을 색인합니다.<br>지원 이미지: PNG · JPG · WebP · GIF · BMP · TIFF · AVIF · HEIC · ICO</p>
 <p class="small-note">원본 파일과 변환 결과 저장 위치: <code>${esc(s.index_dir||'%LOCALAPPDATA%\\AVReportHub\\rag\\index')}</code></p>
 <p class="small-note">색인된 자료는 전체 지도에 자동으로 표시됩니다. 자료 간 유사도는 확인된 기업·사건 관계와 구분합니다.</p>
 <p class="small-note"><b>${esc(m.model||'')}</b> · ${esc(m.device||'')}<br>파라미터 ${fmtN(m.parameters)} · 차원 ${m.dimensions||'-'} · 불러오기 ${fmtS(m.load_seconds)} · 오디오 인코더 미적재</p>
 <div class="form-actions"><button type="button" class="text-button" id="rag-demo">임베딩·유사도 확인</button><button type="button" class="text-button" id="rag-demo-fresh">다시 계산</button></div>${ragDemoHtml()}</details>`;
 bindRagEnvironment();scheduleRagEnvironment();
 $('#rag-add').onclick=()=>$('#rag-input').click();
 const drop=$('#rag-drop');
 drop.ondragover=e=>{if(!dragFiles(e))return;e.preventDefault();e.stopPropagation();if(!rag.uploading)drop.classList.add('over')};drop.ondragleave=e=>{if(!drop.contains(e.relatedTarget))drop.classList.remove('over')};drop.ondrop=e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('over');ragAdd([...e.dataTransfer.files])};
 $('#rag-input').onchange=e=>{ragAdd([...e.target.files]);e.target.value=''};
 $('#rag-query').onsubmit=e=>{e.preventDefault();ragSearch(e.target.elements.q.value.trim())};
 $('#rag-demo').onclick=()=>ragDemo(false);$('#rag-demo-fresh').onclick=()=>ragDemo(true);
 $('#rag-tools').ontoggle=e=>{rag.toolsOpen=e.target.open};
 $('#rag-show-map').onclick=()=>setTab('map');
 $$('[data-rag-open]').forEach(b=>b.onclick=()=>{const d=s.docs.find(d=>d.id===b.dataset.ragOpen);rag.hit={...d,doc:d.id,page:1};renderDetail()});
 $$('[data-rag-del]').forEach(b=>b.onclick=async()=>{
  const id=b.dataset.ragDel,doc=rag.status?.docs?.find(d=>d.id===id);
  if(window.AVSelection){await window.AVSelection.remove(window.AVSelection.forItem({kind:'rag',id,title:doc?.name||id}));return}
  if(b.disabled||deletingRagDocs.has(id)||!confirm(`“${doc?.name||'이 자료'}”의 색인과 검색용 사본을 삭제할까요?\n검색에 다시 사용하려면 자료를 다시 추가해야 합니다. 원본 파일은 유지됩니다.`))return;
  deletingRagDocs.add(id);b.disabled=true;
  try{await api('/api/rag/delete',{doc:id});rag.hits=rag.hits.filter(h=>h.doc!==id);if(rag.hit?.doc===id)rag.hit=null;invalidateMapMedia();await ragStatus();render();if(tab==='rag')($('[data-rag-open]')||$('#rag-add'))?.focus()}
  catch(x){toast(x.message)}finally{deletingRagDocs.delete(id);$$('[data-rag-del]').forEach(button=>button.disabled=rag.uploading||deletingRagDocs.has(button.dataset.ragDel))}
 })}
function ragDemoHtml(){const d=rag.demo;if(!d)return'';const m=d.model||{},p=d.first_page;
 return`<section class="rag-demo"><h3 class="local-h">모델</h3><table class="rag-table"><tr><th>불러오는 시간</th><td>${fmtS(m.load_seconds)}</td></tr><tr><th>파라미터 수</th><td>${fmtN(m.parameters)}</td></tr><tr><th>임베딩 차원</th><td>${m.dimensions||'-'}</td></tr></table>
 ${p?`<h3 class="local-h">첫 페이지 임베딩 · ${esc(d.pdf||'')}</h3><table class="rag-table"><tr><th>이미지 변환</th><td>${fmtS(p.render_seconds)}</td></tr><tr><th>임베딩</th><td>${fmtS(p.embed_seconds)}</td></tr><tr><th>합계</th><td><b>${fmtS(p.total_seconds)}</b></td></tr><tr><th>크기</th><td>${p.width}×${p.height}px</td></tr></table>`:''}
 ${d.note?`<p class="small-note">${esc(d.note)}</p>`:''}
 ${(d.similarities||[]).length?`<h3 class="local-h">페이지 이미지와 문장의 유사도</h3><table class="rag-table">${d.similarities.map(x=>`<tr><th>${esc(x.label)}</th><td><b>${x.similarity.toFixed(4)}</b></td><td>${esc(x.sentence)}</td></tr>`).join('')}</table>`:''}</section>`}
async function ragSearch(q){
 if(!q)return;
 const request=++rag.queryRequest;rag.q=q;rag.hits=[];rag.hit=null;rag.busy='검색 중…';render();
 try{const result=await api('/api/rag/query',{text:q,top_k:6});if(request!==rag.queryRequest)return;rag.hits=(result.hits||[]).map(h=>({...h,_query:q}));rag.hit=rag.hits[0]||null}catch(x){if(request===rag.queryRequest)toast(x.message)}
 if(request===rag.queryRequest){rag.busy='';render()}
}
function ragMarkedText(value){
 const text=String(value||''),terms=[...new Set(rag.q.slice(0,2000).split(/\s+/).map(t=>t.replace(/^[.,!?;:"'()[\]{}<>“”‘’。！？]+|[.,!?;:"'()[\]{}<>“”‘’。！？]+$/g,'' )).filter(t=>t&&t.length<=128))].slice(0,32).sort((a,b)=>b.length-a.length);
 if(!terms.length)return esc(text);
 const re=new RegExp(terms.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'giu');let html='',last=0;
 for(const match of text.matchAll(re)){html+=esc(text.slice(last,match.index))+'<mark class="rag-text-match">'+esc(match[0])+'</mark>';last=match.index+match[0].length}
 return html+esc(text.slice(last));
}
function ragHighlightRects(data){
 return (Array.isArray(data?.rects)?data.rects:[]).slice(0,300).filter(r=>['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=1.00001&&r.y+r.height<=1.00001).map(r=>`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`).join('');
}
function ragPageOverlay(data,id=''){return `<svg ${id?`id="${id}"`:''} class="rag-page-highlights" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">${rag.q?ragHighlightRects(data):''}</svg>`}
function ragHitsHtml(){if(!rag.hits.length)return rag.q&&!rag.busy?`<p class="small-note">‘${esc(rag.q)}’에 맞는 페이지가 없습니다.</p>`:'';
 return`<h3 class="local-h">‘${esc(rag.q)}’ 검색 결과</h3><div class="rag-hits">${rag.hits.map((h,i)=>`<button class="rag-hit" data-rag-hit="${i}"><span class="rag-page-frame"><img src="${esc(h.thumb)}" alt="">${ragPageOverlay(h._query===rag.q?h.highlight:null)}</span><span><b>${ragMarkedText(h.name)}</b> ${ragPageLabel(h,h.page)}<small>유사도 ${h.similarity.toFixed(4)}</small></span></button>`).join('')}</div>`}
async function ragDemo(fresh){rag.toolsOpen=true;rag.busy=fresh?'모델과 첫 페이지를 다시 계산하는 중… (CPU에서 수십 초)':'계산 결과를 불러오는 중…';render();try{const d=await ragResult(await api('/api/rag/demo'+(fresh?'?fresh=1':'')));if(d.error)throw Error(d.error);rag.demo=d}catch(x){toast(x.message)}rag.busy='';render()}
function ragWarn(){return new Promise(res=>{if(rag.warned)return res(true);const dlg=$('#rag-warning');const done=ok=>{dlg.close();if(ok&&$('#rag-warning-skip').checked)rag.warned=true;res(ok)};$('#rag-warning-ok').onclick=()=>done(true);$('#rag-warning-cancel').onclick=()=>done(false);dlg.oncancel=e=>{e.preventDefault();done(false)};dlg.showModal()})}
async function ragAdd(files){
 if(rag.uploading)return toast('현재 파일의 색인이 끝난 뒤 추가해 주세요.');
 const rejected=files.filter(f=>!ragFilePattern.test(f.name));files=files.filter(f=>ragFilePattern.test(f.name));
 if(rejected.length)toast(`지원하지 않는 파일: ${rejected.map(f=>f.name).join(', ')}. PDF 또는 지원 이미지 형식을 선택하세요.`);
 if(!files.length)return;
 rag.uploading=true;
 try{
  if(!await ragWarn())return toast('취소했습니다. 아무것도 전송하지 않았습니다.');
  for(const f of files){if(f.size>50*1048576){toast(`${f.name}: 50MB를 넘습니다.`);continue}rag.busy=`${f.name} 색인 중… 페이지 수에 따라 몇 분 걸릴 수 있습니다.`;render();
   try{const r=await fetch('/api/rag/index?name='+encodeURIComponent(f.name),{method:'POST',headers:{'X-AV-Request':'1','Content-Type':f.type||'application/octet-stream'},body:f});if(!r.ok)throw Error(await r.text());const v=await ragResult(await r.json(),job=>{const note=$('#rag-job-progress');if(note)note.textContent=`${f.name} · ${job.pages_done||0}개 페이지 처리 완료`;});if(v.error)throw Error(v.error);invalidateMapMedia();toast(v.created?`${f.name}: ${v.pages}개 페이지 색인 완료 · 전체 지도에 표시됩니다.`:`${f.name}: 이미 색인된 자료입니다.`)}catch(x){toast(`${f.name}: ${x.message}`)}}
 }finally{rag.uploading=false;rag.busy='';await ragStatus();render()}
}
function renderRagDetail(){const request=++rag.highlightRequest,h=rag.hit;if(!h){$('#detail').innerHTML='<div class="empty">자료나 검색 결과를 누르면<br>여기에 페이지가 표시됩니다.</div>';return}
 const doc=rag.status?.docs?.find(d=>d.id===h.doc)||h;
 $('#detail').innerHTML=`<div class="detail-head"><h2>${ragMarkedText(h.name)} · ${ragPageLabel(doc,h.page)}</h2><p class="small-note">${Number.isFinite(h.similarity)?`유사도 ${h.similarity.toFixed(4)} · `:''}이 PC의 색인 자료</p></div>${doc.pages>1?`<div class="form-actions"><button id="rag-prev" ${h.page<=1?'disabled':''}>이전</button><span>${h.page} / ${doc.pages}</span><button id="rag-next" ${h.page>=doc.pages?'disabled':''}>다음</button></div>`:''}${rag.q?'<p class="small-note rag-highlight-note" id="rag-highlight-status" role="status">검색어 위치 확인 중…</p>':''}<div class="rag-page-frame"><img class="rag-page" src="/api/rag/page?doc=${encodeURIComponent(h.doc)}&page=${h.page}" alt="${esc(h.name)}">${ragPageOverlay(null,'rag-page-highlights')}</div>`;
 if($('#rag-prev'))$('#rag-prev').onclick=()=>{rag.hit={...h,page:h.page-1,similarity:undefined,highlight:undefined};renderRagDetail()};
 if($('#rag-next'))$('#rag-next').onclick=()=>{rag.hit={...h,page:h.page+1,similarity:undefined,highlight:undefined};renderRagDetail()};
 if(rag.q)loadRagHighlights(h,doc,request);
}
async function loadRagHighlights(hit,doc,request){
 const q=rag.q,overlay=$('#rag-page-highlights'),note=$('#rag-highlight-status');
 try{
  const cached=rag.hits.find(h=>h.doc===hit.doc&&h.page===hit.page&&h._query===q)?.highlight;
  const data=cached||(doc.kind==='image'?{reason:'image'}:await api('/api/rag/highlights',{doc:hit.doc,page:hit.page,text:q}));
  if(tab!=='rag'||request!==rag.highlightRequest||q!==rag.q||$('#rag-page-highlights')!==overlay)return;
  overlay.innerHTML=ragHighlightRects(data);
  const count=Number.isInteger(data.matches)?Math.max(0,data.matches):0;
  note.textContent=overlay.childElementCount?`검색어 일치 ${count}곳${data.truncated?' 이상':''} · 노란색 표시`:({image:'이미지는 검색 위치 표시를 지원하지 않습니다.',no_text:'텍스트가 없는 PDF는 검색 위치를 표시할 수 없습니다.',no_match:'이 페이지에 일치하는 검색어가 없습니다. 의미가 비슷한 결과일 수 있습니다.',unavailable:'이 페이지의 검색어 위치를 읽을 수 없습니다.'}[data.reason]||'검색어 위치를 불러오지 못했습니다. 검색 서비스를 다시 시작해 주세요.');
  note.classList.toggle('has-matches',!!overlay.childElementCount);
 }catch(error){if(tab==='rag'&&request===rag.highlightRequest&&$('#rag-page-highlights')===overlay)note.textContent='검색어 위치를 불러오지 못했습니다. 검색 서비스를 다시 시작해 주세요.'}
}
addEventListener('click',e=>{const b=e.target.closest('[data-rag-hit]');if(b){rag.hit=rag.hits[+b.dataset.ragHit];renderDetail()}});

// Environment setup is separate from service availability: closing the service does not undo setup.
let ragEnvironmentState=null,ragEnvironmentTimer=null,ragEnvironmentPolling=false,ragEnvironmentAction=false,ragEnvironmentInfoOpen=false;
function ragEnvironmentHtml(){
 const e=ragEnvironmentState||{state:'checking',busy:true,message:'환경 상태를 확인하고 있습니다.'};
 const running=!!rag.status?.ok,ready=running||e.ready,busy=e.busy||ragEnvironmentAction;
 const signal=running?'ready':busy?'checking':e.state==='error'?'error':ready?'ready':'idle';
 const title=signal==='error'?'환경 확인 필요':signal==='checking'?(e.state==='installing'?'환경 설정 중':e.state==='starting'?'서비스 시작 중':'환경 확인 중'):ready?'환경 설정 완료':'환경 설정 필요';
 const expandable=ready&&!busy&&signal!=='error',expanded=!expandable||ragEnvironmentInfoOpen;
 const message=running?'검색 서비스가 실행 중입니다. PDF·이미지를 올려 검색하고 전체 지도에서 볼 수 있습니다.':e.message;
 return `<section class="rag-environment" data-state="${signal}" aria-label="AI 검색 환경">
 <div class="rag-environment-heading"><p class="rag-environment-status" role="status"><span class="rag-environment-light" aria-hidden="true">${{ready:'✓',checking:'…',error:'!',idle:'−'}[signal]}</span><span><b>${title}</b>${ready&&signal!=='checking'?`<small>${running?'서비스 실행 중':'서비스 꺼짐'}</small>`:''}</span></p>
 <div class="rag-environment-actions">
 ${!ready&&e.supported!==false?`<button class="primary" id="rag-setup" ${busy?'disabled':''}>${e.state==='installing'?'환경 설정 중…':e.state==='error'?'환경 설정 다시 시도':'환경 설정'}</button>`:''}
 ${ready&&!running&&e.supported!==false?`<button class="primary" id="rag-start" ${busy?'disabled':''}>${e.state==='starting'?'서비스 시작 중…':'검색 서비스 시작'}</button>`:''}
 ${expandable?`<button class="text-button" id="rag-environment-toggle" aria-expanded="${expanded}" aria-controls="rag-environment-info">환경 정보 <span aria-hidden="true">${expanded?'−':'+'}</span></button>`:''}</div></div>
 <div id="rag-environment-info" ${expanded?'':'hidden'}>
 <p class="small-note ${e.state==='error'&&!running?'error':''}" role="status" aria-live="polite">${esc(message||'')}</p>
 ${!ready&&!busy?`<p class="small-note">Python 3.10 64비트가 필요합니다. 환경 설정을 누르면 필요한 패키지와 검색 모델을 이 PC에 내려받습니다. 인터넷 연결과 여유 공간 5GB 이상을 준비해 주세요.</p>`:''}
 ${e.python_required&&!running?'<p class="small-note"><a href="https://www.python.org/downloads/release/python-31011/" target="_blank" rel="noopener noreferrer">Python 공식 설치 페이지 열기</a> · Windows installer (64-bit)를 설치한 뒤 다시 눌러 주세요.</p>':''}
 <div class="form-actions">
 ${ready&&!running&&e.supported!==false?`<button class="text-button" id="rag-setup" ${busy?'disabled':''}>환경 다시 설정</button>`:''}
 <button class="text-button" id="rag-environment-refresh" ${busy?'disabled':''}>상태 새로고침</button></div>
 ${busy?'<p class="small-note">작업이 끝날 때까지 앱을 종료하지 마세요.</p>':''}
 </div></section>`;
}
function bindRagEnvironment(){
 const setup=$('#rag-setup'),start=$('#rag-start'),refresh=$('#rag-environment-refresh');
 if(setup)setup.onclick=()=>ragEnvironmentTask('setup');
 if(start)start.onclick=()=>ragEnvironmentTask('start');
 if(refresh)refresh.onclick=()=>pollRagEnvironment();
 const toggle=$('#rag-environment-toggle');
 if(toggle)toggle.onclick=()=>{ragEnvironmentInfoOpen=!ragEnvironmentInfoOpen;updateRagEnvironment()};
}
function updateRagEnvironment(){
 const slot=$('#rag-environment');
 if(slot){const focused=typeof document!=='undefined'&&slot.contains?.(document.activeElement)?document.activeElement.id:null;slot.innerHTML=ragEnvironmentHtml();bindRagEnvironment();if(focused)$('#'+focused)?.focus({preventScroll:true})}
}
async function ragEnvironmentTask(action){
 if(ragEnvironmentAction||ragEnvironmentState?.busy)return;
 ragEnvironmentAction=true;updateRagEnvironment();
 try{await api('/api/rag/'+action,{});await pollRagEnvironment()}
 catch(e){toast(e.message)}
 finally{ragEnvironmentAction=false;updateRagEnvironment()}
}
function scheduleRagEnvironment(){
 clearTimeout(ragEnvironmentTimer);
 if(tab==='rag')ragEnvironmentTimer=setTimeout(()=>pollRagEnvironment(),ragEnvironmentState?.busy?1500:10000);
}
async function pollRagEnvironment(){
 clearTimeout(ragEnvironmentTimer);
 if(tab!=='rag'||ragEnvironmentPolling)return;
 ragEnvironmentPolling=true;
 const wasRunning=!!rag.status?.ok;
 try{
  const [environment]=await Promise.all([api('/api/rag/environment'),ragStatus()]);
  ragEnvironmentState=environment;
  if(tab==='rag'){
   if(wasRunning!==!!rag.status?.ok)render();
   else updateRagEnvironment();
  }
 }catch(e){
  if(tab==='rag'){ragEnvironmentState={state:'error',supported:true,message:'환경 상태를 확인하지 못했습니다. 상태 새로고침으로 다시 확인해 주세요.'};updateRagEnvironment()}
 }finally{ragEnvironmentPolling=false;scheduleRagEnvironment()}
}

// Outlook path form: keep feedback and the draft across renders; never silently ignore a submit.
let outlookPath={value:'',busy:false,picking:false,message:'',error:false,invalid:false};
function outlookPathHtml(){
 return `<div class="link-form"><button id="pst-browse" type="button" class="primary" aria-describedby="pst-help pst-status">경로 추가</button></div>
 <form id="pst-form" class="link-form" novalidate>
 <input name="path" value="${esc(outlookPath.value)}" placeholder="또는 PST·OST 파일 전체 경로 직접 입력" aria-label="PST·OST 파일 경로" aria-describedby="pst-help pst-status" required autocomplete="off" spellcheck="false">
 <button type="submit">입력 경로 추가</button></form>
 <p id="pst-help" class="small-note">‘경로 추가’를 누르면 파일 선택 창이 열립니다. PST·OST 파일을 선택하고 ‘열기’를 누르면 경로가 추가됩니다. 전체 경로를 직접 입력해 추가할 수도 있습니다. 현재 Outlook 메일함은 위의 ‘Outlook 메일함 불러오기’를 사용하세요.</p>
 <p id="pst-status" class="small-note" role="status" aria-live="polite"></p>`;
}
function updateOutlookPathForm(){
 const form=$('#pst-form'),status=$('#pst-status'),browse=$('#pst-browse');
 if(!form||!status)return;
 const input=form.elements.namedItem('path'),button=form.querySelector('button[type="submit"]');
 input.value=outlookPath.value;input.readOnly=outlookPath.busy;
 input.setAttribute('aria-invalid',String(outlookPath.invalid));
 button.disabled=outlookPath.busy;button.textContent=outlookPath.busy&&!outlookPath.picking?'추가 중…':'입력 경로 추가';
 browse.disabled=outlookPath.busy;browse.textContent=outlookPath.picking?'파일 선택 중…':'경로 추가';
 form.setAttribute('aria-busy',String(outlookPath.busy));
 status.textContent=outlookPath.message;status.hidden=!outlookPath.message;status.classList.toggle('error',outlookPath.error);
}
function bindOutlookPathForm(){
 const form=$('#pst-form');if(!form)return;
 form.elements.namedItem('path').oninput=e=>{
  outlookPath.value=e.target.value;
  outlookPath.message='';outlookPath.error=false;outlookPath.invalid=false;
  updateOutlookPathForm();
 };
 $('#pst-browse').onclick=browseOutlookPath;
 form.onsubmit=addOutlookPath;updateOutlookPathForm();
}
async function browseOutlookPath(){
 if(outlookPath.busy)return;
 outlookPath.busy=true;outlookPath.picking=true;outlookPath.error=false;outlookPath.invalid=false;
 outlookPath.message='파일 선택 창에서 PST·OST 파일을 선택하세요.';updateOutlookPathForm();
 let path='';
 try{
  const result=await api('/api/outlook/pick',{});
  if(result.cancelled){outlookPath.message='파일 선택을 취소했습니다.';return}
  if(!result.path)throw Error('선택한 파일 경로를 가져오지 못했습니다. 다시 선택해 주세요.');
  path=result.path;
 }catch(error){outlookPath.error=true;outlookPath.message=error.message}
 finally{outlookPath.busy=false;outlookPath.picking=false;updateOutlookPathForm()}
 if(path)await saveOutlookPath(path);
}
function addOutlookPath(event){
 event.preventDefault();
 return saveOutlookPath(event.currentTarget.elements.namedItem('path').value);
}
async function saveOutlookPath(value){
 if(outlookPath.busy)return;
 const path=value.trim().replace(/^"|"$/g,'').trim();
 outlookPath.value=path;outlookPath.error=false;outlookPath.invalid=false;
 if(!path||!/\.(pst|ost)$/i.test(path)){
  outlookPath.message=path?'PST 또는 OST 파일의 전체 경로를 입력하세요. 폴더 경로만으로는 추가할 수 없습니다.':'추가할 PST·OST 파일의 전체 경로를 먼저 입력하세요.';
  outlookPath.error=true;outlookPath.invalid=true;updateOutlookPathForm();$('#pst-form')?.elements.namedItem('path').focus();return;
 }
 if(local.sources.some(s=>s.path&&s.path.toLowerCase()===path.toLowerCase())){
  outlookPath.message='이미 추가된 Outlook 경로입니다.';updateOutlookPathForm();return;
 }
 outlookPath.busy=true;outlookPath.message='파일 경로를 확인하고 저장하고 있습니다…';updateOutlookPathForm();
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),20000);
 let saved=false;
 try{
  const result=await api('/api/outlook/source',{source:{path}},{signal:controller.signal});
  if(!result.ok)throw Error(result.error||'Outlook 경로를 저장하지 못했습니다.');
  saved=true;outlookPath.value='';
  const resultLocal=await api('/api/local',undefined,{signal:controller.signal});
  if(!resultLocal.available)throw Error(resultLocal.reason||'내 자료 목록을 불러오지 못했습니다.');
  local={available:true,reason:'',files:resultLocal.files||[],mails:resultLocal.mails||[],sources:resultLocal.sources||[]};
  outlookPath.message='Outlook 경로를 추가했습니다. 위의 연결 목록에서 확인할 수 있습니다.';
  render();
 }catch(error){
  outlookPath.error=true;
  outlookPath.message=saved?'경로는 저장됐지만 목록을 새로 불러오지 못했습니다. 페이지를 새로고침해 확인해 주세요.':
   controller.signal.aborted?'경로 확인 시간이 초과되었습니다. 파일이나 네트워크 드라이브에 접근할 수 있는지 확인한 뒤 다시 시도하세요.':error.message;
 }finally{
  clearTimeout(timer);outlookPath.busy=false;updateOutlookPathForm();
 }
}

window.AVNotes?.configure({reports:()=>state?[...state.snapshot.catalog.reports,...importedReports]:[],openNotes:()=>setTab('notes'),openReport:id=>{selected=id;setTab('search',id)}});
