'use strict';
// Deterministic document suggestions. No model, external fetch, or fact-graph mutation.
let documentConnections={documents:[],connections:[],aliases:[],loaded:false,error:'',busy:false};
let connectionRequest=0,connectionChecked='',connectionFilter='suggested',connectionQuery='',connectionLimit=30,connectionSaving=false;
let connectionDraft=[],connectionDraftDirty=false;
const connectionStatus=s=>({suggested:'추천',accepted:'확정',rejected:'제외'}[s]||s);
const connectionKind=k=>({report:'리포트',mail:'메일',pdf:'PDF'}[k]||k);
function connectionDocVisible(d){return !d.report_id||!hiddenReports.has(d.report_id)}
function invalidateDocumentConnections(){documentConnections.loaded=false;if(networkView()||$('#connections-dialog')?.open)loadDocumentConnections(true)}
function checkDocumentConnections(status){
 const checked=status?.checked||'';if(checked===connectionChecked)return;connectionChecked=checked;
 if(documentConnections.loaded||$('#connections-dialog')?.open){documentConnections.loaded=false;loadDocumentConnections()}
}
async function loadDocumentConnections(force=false){
 if(!state||state.setup||documentConnections.busy&&!force)return;
 const request=++connectionRequest;documentConnections.busy=true;documentConnections.error='';renderConnectionsList();
 try{
  const v=await api('/api/local/connections');if(request!==connectionRequest)return;
  documentConnections={...v,loaded:true,busy:false,error:''};
  if($('#connections-dialog')?.open&&!connectionDraftDirty){connectionDraft=structuredClone(v.aliases||[]);renderConnectionDictionary()}
 }catch(e){if(request!==connectionRequest)return;documentConnections={...documentConnections,loaded:true,busy:false,error:e.message}}
 if(request!==connectionRequest)return;
 renderConnectionsList();if(networkView())render();
}
async function openConnections(){
 const dialog=$('#connections-dialog');if(!dialog)return;
 if(dialog.open)return;
 if(!dialog.open)dialog.showModal();
 connectionDraftDirty=false;connectionLimit=30;connectionFeedback('');await loadDocumentConnections(true);
}
function closeConnections(){
 const dialog=$('#connections-dialog');if(!dialog?.open)return true;
 if(connectionSaving){connectionFeedback('저장 중입니다. 완료된 뒤 닫아 주세요.');return false}
 if(connectionDraftDirty&&!confirm('저장하지 않은 사전 변경을 버리고 닫을까요? 취소하면 계속 편집할 수 있습니다.'))return false;
 connectionDraftDirty=false;dialog.close();return true;
}
function connectionFeedback(message,error=false){const el=$('#connections-feedback');el.textContent=message;el.classList.toggle('error',error)}
function connectionDocButton(d){
 return `<button type="button" class="connection-doc" data-connection-open="${esc(d.id)}"><small>${esc(sourceLabel(d.source))} · ${connectionKind(d.kind)} · ${esc((d.date||'').slice(0,10))}</small><b>${esc(d.title||'(제목 없음)')}</b>${d.mail?`<small>${esc(d.mail.sender)} · ${esc(d.mail.folder)}</small>`:''}</button>`;
}
function bindConnectionDocuments(root){
 root.querySelectorAll('[data-connection-open]').forEach(b=>b.onclick=async()=>{
  const d=documentConnections.documents.find(d=>d.id===b.dataset.connectionOpen);if(!d)return;
  try{
   if(d.kind==='mail'){b.disabled=true;await api('/api/outlook/open',{mail:d.mail})}
   else if(d.kind==='pdf')window.open('/api/local/file?id='+encodeURIComponent(d.file_id)+'&view=1','_blank','noopener');
   else {if(!closeConnections())return;networkSelection=null;selectReport(d.report_id,{fromDetail:true,exactSource:true})}
  }catch(e){toast(e.message)}finally{b.disabled=false}
 });
}
function renderConnectionsList(){
 const root=$('#connections-list'),dialog=$('#connections-dialog');if(!root||!dialog?.open)return;
 const v=documentConnections,status=$('#connections-status');
 $('#connections-refresh').disabled=v.busy||connectionSaving;
 $('#connections-save-dictionary').disabled=v.busy||connectionSaving||!!v.error;
 if(v.busy){status.textContent='이 PC에 보관된 자료의 연결 근거를 확인하고 있습니다…';return}
 if(v.error){status.textContent=v.error;root.innerHTML='<p class="small-note">새로고침으로 다시 시도하세요. 저장된 판단은 유지됩니다.</p>';return}
 const byID=new Map(v.documents.filter(connectionDocVisible).map(d=>[d.id,d]));
 const all=v.connections.filter(c=>byID.has(c.from)&&byID.has(c.to));
 const words=connectionQuery.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
 const rows=all.filter(c=>c.status===connectionFilter&&words.every(w=>[byID.get(c.from).title,byID.get(c.to).title,...c.reasons.map(r=>r.text)].join(' ').toLocaleLowerCase().includes(w)));
 status.textContent=`자료 ${byID.size}개 · 메일 ${v.indexed_mails||0}개 · 추천 ${all.filter(c=>c.status==='suggested').length}개 · 확정 ${all.filter(c=>c.status==='accepted').length}개 · 제외 ${all.filter(c=>c.status==='rejected').length}개${v.truncated?' · 후보가 많아 근거가 강한 최대 300개를 우선 표시합니다.':''}`;
 root.innerHTML=rows.slice(0,connectionLimit).map(c=>`<article class="connection-card" data-connection="${esc(c.id)}"><div class="connection-card-head"><span class="chip ${c.status==='accepted'?'teal':''}">${connectionStatus(c.status)}</span><span class="small-note">${c.score>=85?'강한 일치 근거':'복합 일치 근거'}</span></div><div class="connection-pair">${connectionDocButton(byID.get(c.from))}<span aria-hidden="true">↔</span>${connectionDocButton(byID.get(c.to))}</div><ul class="connection-reasons">${c.reasons.map(r=>`<li>${esc(r.text)}</li>`).join('')}</ul>${c.decided?`<p class="small-note">판단 저장 ${esc(c.decided.slice(0,10))} · 당시 연결 근거</p>`:''}<div class="form-actions">${c.status==='suggested'?'<button type="button" class="primary" data-connection-action="accepted">연결 확정</button><button type="button" data-connection-action="rejected">추천 제외</button>':'<button type="button" data-connection-action="reset">판단 취소 · 다시 추천</button>'}</div></article>`).join('')||`<div class="empty">${connectionFilter==='suggested'?'현재 조건에 연결 후보가 없습니다.':'표시할 '+connectionStatus(connectionFilter)+' 기록이 없습니다.'}<br><small>Outlook에서 폴더를 선택해 가져오거나 기업·프로젝트 사전을 보완해 보세요.</small></div>`;
 if(rows.length>connectionLimit)root.insertAdjacentHTML('beforeend',`<button type="button" id="connections-more">더 보기 (${rows.length-connectionLimit}개 남음)</button>`);
 $('#connections-more')?.addEventListener('click',()=>{connectionLimit+=30;renderConnectionsList()});
 bindConnectionDocuments(root);
 root.querySelectorAll('[data-connection-action]').forEach(b=>{b.disabled=connectionSaving;b.onclick=()=>saveConnectionDecision(b.closest('[data-connection]').dataset.connection,b.dataset.connectionAction)});
}
async function saveConnectionDecision(id,status){
 if(connectionSaving)return;const c=documentConnections.connections.find(c=>c.id===id);if(!c)return;
 connectionSaving=true;renderConnectionsList();connectionFeedback('판단을 저장하고 있습니다…');
 try{
  await api('/api/local/connections',{action:'decision',from:c.from,to:c.to,status});
  await loadDocumentConnections(true);
  connectionFeedback(status==='accepted'?'연결을 확정했습니다. 관계·전체 지도에 자료 연결로 표시됩니다.':status==='rejected'?'추천에서 제외했습니다. 제외 목록에서 취소할 수 있습니다.':'판단을 취소했습니다. 현재 근거로 다시 추천합니다.');
 }catch(e){connectionFeedback(e.message,true)}
 finally{connectionSaving=false;renderConnectionsList();$('#connections-status').focus()}
}
function renderConnectionDictionary(){
 const root=$('#connection-dictionary-rows');if(!root)return;
 root.innerHTML=connectionDraft.map((a,i)=>`<div class="connection-alias-row"><label>구분<select data-alias-kind="${i}"><option value="company" ${a.kind==='company'?'selected':''}>기업</option><option value="project" ${a.kind==='project'?'selected':''}>프로젝트</option></select></label><label>대표 이름<input data-alias-name="${i}" value="${esc(a.name)}" maxlength="80"></label><label>다른 이름 · 쉼표로 구분<input data-alias-values="${i}" value="${esc(a.aliases.join(', '))}"></label><button type="button" data-alias-remove="${i}" aria-label="${esc(a.name||'새 항목')} 사전에서 삭제">삭제</button></div>`).join('');
 for(const key of ['kind','name','values'])root.querySelectorAll('[data-alias-'+key+']').forEach(el=>el.addEventListener('input',()=>{
  const a=connectionDraft[+el.dataset['alias'+key[0].toUpperCase()+key.slice(1)]];connectionDraftDirty=true;
  if(key==='values')a.aliases=el.value.split(',').map(s=>s.trim()).filter(Boolean);else a[key]=el.value;
 }));
 root.querySelectorAll('[data-alias-remove]').forEach(b=>b.onclick=()=>{connectionDraft.splice(+b.dataset.aliasRemove,1);connectionDraftDirty=true;renderConnectionDictionary();$('#connection-add-alias').focus()});
}
async function saveConnectionDictionary(){
 if(connectionSaving)return;connectionSaving=true;connectionFeedback('사전을 저장하고 있습니다…');
 $('#connection-dictionary').querySelectorAll('input,select,button').forEach(e=>e.disabled=true);
 try{await api('/api/local/connections',{action:'dictionary',aliases:connectionDraft});connectionDraftDirty=false;await loadDocumentConnections(true);connectionFeedback('사전을 저장하고 추천을 갱신했습니다. 확정·제외 기록은 유지됩니다.')}
 catch(e){connectionFeedback(e.message,true)}
 finally{connectionSaving=false;$('#connection-dictionary').querySelectorAll('input,select,button').forEach(e=>e.disabled=false);renderConnectionsList()}
}
function extendDocumentConnections(model,rs){
 if(!documentConnections.loaded&&!documentConnections.busy)loadDocumentConnections();
 if(documentConnections.error)return model;
 const ids=new Set(rs.map(r=>r.id)),nodes=new Map(model.nodes.map(n=>[n.id,n]));
 const docs=new Map(documentConnections.documents.filter(d=>connectionDocVisible(d)&&networkSources[d.source]&&(!d.report_id||ids.has(d.report_id))&&(d.kind==='report'||matches(d.title,d.mail?.sender,d.mail?.folder))).map(d=>[d.id,d]));
 const resolve=d=>{
  if(d.kind==='report')return nodes.get('r:'+d.report_id);
  if(d.kind==='mail'){const existing=model.nodes.find(n=>n.kind==='mail'&&n.ref.entry_id.toUpperCase()===d.mail.entry_id.toUpperCase()&&n.ref.store_id.toUpperCase()===d.mail.store_id.toUpperCase());if(existing)return existing}
  if(nodes.has(d.id))return nodes.get(d.id);
  const ref=d.kind==='mail'?d.mail:local.files.find(f=>f.id===d.file_id);if(!ref)return null;
  const node={id:d.id,kind:d.kind,label:d.title,ref,source:d.source,offline:true};nodes.set(d.id,node);model.nodes.push(node);return node;
 };
 for(const c of documentConnections.connections){
  if(c.status!=='accepted'||!docs.has(c.from)||!docs.has(c.to))continue;
  const a=resolve(docs.get(c.from)),b=resolve(docs.get(c.to));if(!a||!b||a.id===b.id)continue;
  model.links.push({id:'rule:'+c.id,from:a.id,to:b.id,label:'확정한 자료 연결',evidence:c.reasons.map(r=>r.text).join(' · '),offline:true,connection:c});
 }
 return model;
}
function renderConnectionNetworkDetail(link){
 if(!link?.offline)return false;
 const c=link.connection,docs=[c.from,c.to].map(id=>documentConnections.documents.find(d=>d.id===id));
 if(docs.some(d=>!d))return false;
 $('#detail').innerHTML=`<div class="eyebrow">이 PC의 확정한 자료 연결</div><h2>연결 근거</h2><p class="small-note">사용자가 관련 자료로 확정한 기록입니다. 기업 간 협력·투자 사실의 확인을 뜻하지 않습니다.</p><ul class="connection-reasons">${c.reasons.map(r=>`<li>${esc(r.text)}</li>`).join('')}</ul>${docs.map(connectionDocButton).join('')}<button type="button" id="connection-review">확정·제외 기록 관리</button>`;
 bindConnectionDocuments($('#detail'));$('#connection-review').onclick=()=>{connectionFilter='accepted';$('#connections-filter').value='accepted';openConnections()};return true;
}
$('#connections-open')?.addEventListener('click',openConnections);
$('#connections-close')?.addEventListener('click',closeConnections);
$('#connections-dialog')?.addEventListener('cancel',e=>{e.preventDefault();closeConnections()});
window.addEventListener('beforeunload',e=>{if(connectionDraftDirty||connectionSaving){e.preventDefault();e.returnValue=''}});
$('#connections-refresh')?.addEventListener('click',()=>loadDocumentConnections(true));
$('#connections-filter')?.addEventListener('change',e=>{connectionFilter=e.target.value;connectionLimit=30;renderConnectionsList()});
$('#connections-query')?.addEventListener('input',e=>{connectionQuery=e.target.value;connectionLimit=30;renderConnectionsList()});
$('#connection-add-alias')?.addEventListener('click',()=>{connectionDraft.push({kind:'project',name:'',aliases:[]});connectionDraftDirty=true;renderConnectionDictionary();$('#connection-dictionary-rows [data-alias-name="'+(connectionDraft.length-1)+'"]').focus()});
$('#connections-save-dictionary')?.addEventListener('click',saveConnectionDictionary);
