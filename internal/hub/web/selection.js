'use strict';
// A single keyboard/selection policy for every document surface. Selection is
// distinct from the preview and is limited to the currently visible tab.
(() => {
 const chosen = new Map(); let scope = tab, busy = false, scheduled = false, multiMode = false;
 const key = x => x.kind + ':' + x.id;
 const mailID = m => JSON.stringify([m.store_id || '', m.path || '', m.entry_id]);
 const report = id => { const r = reportOf(id); const ids=tab==='map'&&r?mapReportMembers(r).map(member=>member.id):['search','timeline'].includes(tab)?[...dailyRepresentatives].filter(([,representative])=>representative===id).map(([member])=>member):[id]; return r && {kind:'report',id,ids:ids.length?ids:[id],title:r.title}; };
 const pdf = id => { const f = local.files.find(f => f.id === id); return f && {kind:'pdf',id,title:f.name}; };
 const media = id => { const d = (rag.status?.docs || []).find(d => d.id === id) || mapMedia.docs.find(d => d.id === id); return d && {kind:'rag',id,title:d.name}; };
 const mail = m => m && {kind:'mail',id:mailID(m),title:m.subject || '(제목 없음)',mail:m};
 const node = id => {
  if (id.startsWith('r:')) return report(id.slice(2));
  if (id.startsWith('pdf:')) return pdf(id.slice(4));
  if (id.startsWith('m:')) return media(id.slice(2));
  const n = currentDocuments.nodes.find(n => n.id === id);
  if (n?.kind === 'note') return {kind:'note',id:n.ref.id,title:n.label};
  if (n?.kind === 'mail' && local.mails.some(m => mailID(m) === mailID(n.ref))) return mail(n.ref);
  return null;
 };
 const selector = '[data-report],[data-local],[data-note-id],[data-rag-open],[data-rag-hit],[data-item-id],[data-network-node],[data-relation],[data-edge],[data-reference],[data-mail-open]';
 function item(el) {
  const d = el.dataset;
  if (d.report) return report(d.report);
  if (d.local) return pdf(d.local);
  if (d.noteId) return window.AVNotes.item(d.noteId);
  if (d.ragOpen) return media(d.ragOpen);
  if (d.ragHit !== undefined) return media(rag.hits[+d.ragHit]?.doc);
  if (d.itemId || d.networkNode) return node(d.itemId || d.networkNode);
  if (d.reference) { const link=currentDocuments.links.find(l=>l.id===d.reference); return link && node(link.from); }
  if (d.relation || d.edge) return report(catalog().relations.find(r => r.id === (d.relation || d.edge))?.report_id);
  if (d.mailOpen) return mail(local.mails.find(m => m.entry_id === d.mailOpen));
  return null;
 }
 function elements() { return [...document.querySelectorAll(tab === 'notes' ? '#note-list [data-note-id]' : '#results '+selector.split(',').join(',#results '))]; }
 const toolbar = document.createElement('div'); toolbar.id = 'selection-toolbar'; toolbar.className = 'selection-toolbar';
 toolbar.innerHTML = '<span id="selection-count" role="status"></span><span id="selection-hint" class="selection-hint">Ctrl+클릭 여러 개 선택 · Delete 휴지통 · Shift+Delete 완전 삭제</span><button id="selection-mode" type="button" aria-pressed="false" aria-describedby="selection-hint">여러 개 선택</button><button id="selection-delete" type="button">선택 삭제</button><button id="selection-clear" type="button">선택 해제</button><button id="selection-trash" type="button">휴지통</button>';
 document.querySelector('#view-panel').prepend(toolbar);
 function paint(prune = false) {
  if (scope !== tab) { chosen.clear(); scope = tab; multiMode = false; }
  toolbar.hidden = tab === 'settings' || !state || state.setup;
  const entries = elements().map(el => [el,item(el)]).filter(([,x]) => x);
  if (prune && !busy) { const visible = new Set(entries.map(([,x]) => key(x))); for (const k of chosen.keys()) if (!visible.has(k)) chosen.delete(k); }
  for (const [el,x] of entries) {
   const yes = chosen.has(key(x));
   el.classList.toggle('multi-selected',yes); el.classList.toggle('selected',yes);
   el.setAttribute('aria-pressed',String(yes));
   el.closest('.pdf-list-row')?.classList.toggle('selected',yes);
  }
  const label = `${chosen.size}개 선택`;
  if ($('#selection-count').textContent !== label) $('#selection-count').textContent = label;
  $('#selection-count').hidden = !chosen.size;
  $('#selection-delete').hidden = $('#selection-clear').hidden = !chosen.size;
  $('#selection-hint').hidden = !multiMode;
  $('#selection-mode').disabled=busy;$('#selection-mode').setAttribute('aria-pressed',String(multiMode));
  const hint=multiMode?'자료를 누르거나 Enter·Space로 선택·해제 · 선택을 마치면 여러 개 선택을 끄세요.':'Ctrl+클릭 여러 개 선택 · Delete 휴지통 · Shift+Delete 완전 삭제';
  if($('#selection-hint').textContent!==hint)$('#selection-hint').textContent=hint;
  $('#selection-delete').disabled = busy || !chosen.size; $('#selection-clear').disabled = busy || !chosen.size;
 }
 function schedule() { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; paint(true); }); }
 const observer = new MutationObserver(records => {
  if(records.some(r=>r.type==='attributes'||r.target.id==='results'||r.target.id==='notes-page'||r.target.closest?.('#note-list')||[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.matches?.(selector)||n.querySelector?.(selector)))))schedule();
 });
 observer.observe($('#results'),{childList:true,subtree:true});
 observer.observe($('#notes-page'),{childList:true,subtree:true});
 observer.observe($('#viewer'),{attributes:true,attributeFilter:['data-view']});
 function pick(x, additive) {
  if (scope !== tab) { chosen.clear(); scope = tab; }
  if (!additive) chosen.clear();
  const k = key(x); if (additive && chosen.has(k)) chosen.delete(k); else chosen.set(k,x);
  paint();
 }
 document.addEventListener('click', e => {
  if (busy || e.target.closest('dialog')) return;
  const el = e.target.closest(selector) || (!e.target.closest('button') && e.target.closest('.pdf-list-row')?.querySelector('[data-local]'));
  if (!el || !el.closest(tab === 'notes' ? '#note-list' : '#results')) return;
  const x = item(el); if (!x) { chosen.clear(); paint(); return; }
  const additive=multiMode || e.ctrlKey || e.metaKey;
  pick(x,additive);
  if (additive) { e.preventDefault(); e.stopImmediatePropagation(); el.focus({preventScroll:true}); }
  queueMicrotask(() => paint());
 },true);
 const editing = target => !!target?.closest('input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable]:not([contenteditable="false"]),.cm-editor,[role="textbox"]');
 document.addEventListener('keydown', e => {
  if (busy || e.defaultPrevented || e.repeat || e.isComposing || e.altKey || editing(e.target) || document.querySelector('dialog[open]')) return;
  if((e.key==='Enter'||e.key===' ')&&(e.target.closest('#results svg')||e.ctrlKey||e.metaKey)){
   const el=e.target.closest(selector),x=el&&item(el);
   if(x){const additive=multiMode||e.ctrlKey||e.metaKey;pick(x,additive);if(additive){e.preventDefault();e.stopImmediatePropagation();return}}
   else if(el){chosen.clear();paint()}
  }
  if(e.key==='Delete'&&tab==='settings'&&restoreSelection.size&&!busy){e.preventDefault();remove([...restoreSelection].map(id=>report(id)||{kind:'report',id,title:id}),true);return;}
  if (e.key === 'Delete' && chosen.size && scope === tab && !busy) {
   e.preventDefault(); e.stopPropagation(); remove([...chosen.values()],e.shiftKey);
  } else if (e.key === 'Escape' && chosen.size) {
   const focusTool = e.target.matches('#selection-clear,#selection-delete');
   chosen.clear(); paint(); if (focusTool) $('#selection-mode').focus();
  }
 },true);
 async function change(x, action) {
  if (x.kind === 'report') {
   const ids=x.ids||[x.id];
   const v = await api(action === 'delete' ? '/api/reports/delete' : '/api/report-visibility',action === 'delete' ? {report_ids:ids} : {action:action === 'restore' ? 'restore' : 'hide',report_ids:ids});
   applyReportVisibility(v);
  } else if (x.kind === 'pdf' || x.kind === 'mail') await api('/api/local/trash',{kind:x.kind,id:x.id,mail:x.mail,action});
  else if (x.kind === 'note') {
   if (action === 'restore') { await api('/api/notes/restore-trash',{id:x.id}); await window.AVNotes.refresh(); }
   else await window.AVNotes.removeItem(x.id,action === 'delete');
   invalidateNoteNetwork();
  } else if (x.kind === 'rag') {
   const result = await api('/api/rag/'+action,{doc:x.id});
   if (!result.ok) throw Error(result.error || '검색 서비스를 확인하세요.');
   rag.hits = rag.hits.filter(h => h.doc !== x.id); if (rag.hit?.doc === x.id) rag.hit = null;
   invalidateMapMedia();
  }
 }
 async function refreshItems(items) {
  if (items.some(x => x.kind === 'report')) await refresh(true);
  if (items.some(x => x.kind === 'pdf' || x.kind === 'mail')) { localSel=''; await loadLocal(); }
  if (items.some(x => x.kind === 'rag')) await ragStatus();
  if (networkView()) invalidateNoteNetwork();
  render();
 }
 async function remove(items, permanent = false) {
  if (busy || !items.length) return;
  items = [...new Map(items.map(x => [key(x),x])).values()];
  if (permanent && !confirm(`${items.length}개 항목을 완전히 삭제할까요?\n${items.slice(0,8).map(x => '• '+x.title).join('\n')}${items.length>8?'\n…':''}\n휴지통과 이전 저장본에서도 복원할 수 없습니다. 이 앱에 보관한 자료만 삭제하며 GitHub·Outlook 원본은 유지됩니다.`)) return;
  const origin=document.activeElement,originTab=tab,index=elements().indexOf(origin.closest(selector));
  busy = true; paint(); ++refreshRequest; visibilityBusy = true;
  const done = [], errors = [];
  try {
   for (const x of items) {
    try { await change(x,permanent ? 'delete' : 'trash'); done.push(x); chosen.delete(key(x)); }
    catch(e) { errors.push(items.length===1?e.message:`${x.title}: ${e.message}`); }
   }
  } finally {
   visibilityBusy = false;
   try { await refreshItems(done); } catch(e) { errors.push('목록 새로고침: '+e.message); }
   busy = false; paint();
   if(tab===originTab&&!document.querySelector('dialog[open]')&&(document.activeElement===document.body||document.activeElement===origin&&origin.disabled)){
    const remaining=elements();(remaining[Math.min(Math.max(index,0),remaining.length-1)]||$('#selection-trash')).focus();
   }
  }
  toast([done.length ? `${done.length}개를 ${permanent?'완전히 삭제했습니다.':'휴지통으로 이동했습니다.'}` : '',...errors].filter(Boolean).join('\n'));
 }
 $('#selection-delete').onclick = () => remove([...chosen.values()]);
 $('#selection-mode').onclick = () => {multiMode=!multiMode;paint()};
 $('#selection-clear').onclick = () => { chosen.clear(); paint(); $('#selection-mode').focus(); };
 $('#selection-trash').onclick = () => openTrash().catch(e => toast(e.message));

 const dialog = document.createElement('dialog'); dialog.id = 'data-trash-dialog'; dialog.setAttribute('aria-labelledby','data-trash-title');
 dialog.innerHTML = '<div class="dialog-title"><h2 id="data-trash-title">휴지통</h2><button id="data-trash-close">닫기</button></div><p class="small-note">항목을 누르거나 Enter·Space로 선택·해제 · Delete로 완전 삭제</p><div class="form-actions"><button id="data-trash-all">모두 선택</button><button id="data-trash-restore">선택 복원</button><button id="data-trash-delete" class="danger">완전 삭제</button><span id="data-trash-count" role="status"></span></div><p id="data-trash-error" role="status"></p><div id="data-trash-list"></div>';
 document.body.append(dialog); let trashed = [], trashSelected = new Set(), trashBusy = false, trashLoading = false, trashRequest = 0;
 function paintTrash() {
  for (const b of dialog.querySelectorAll('[data-trash-key]')) { const yes=trashSelected.has(b.dataset.trashKey); b.classList.toggle('multi-selected',yes);b.setAttribute('aria-pressed',String(yes));b.disabled=trashBusy; }
  $('#data-trash-count').textContent = trashLoading?'휴지통을 불러오는 중…':`${trashSelected.size}개 선택`;
  $('#data-trash-list').setAttribute('aria-busy',String(trashLoading||trashBusy));
  $('#data-trash-restore').disabled = $('#data-trash-delete').disabled = trashBusy || trashLoading || !trashSelected.size;
  $('#data-trash-close').disabled = trashBusy;$('#data-trash-all').disabled=trashBusy||trashLoading||!trashed.length;
 }
 async function openTrash() {
  if(trashBusy)return;
  const request=++trashRequest;trashLoading=true;
  if (!dialog.open) dialog.showModal();
  $('#data-trash-list').textContent = '휴지통을 불러오는 중…'; trashed=[];trashSelected.clear();paintTrash();
  const results = await Promise.allSettled([api('/api/status'),api('/api/local/trash'),api('/api/notes/trash'),api('/api/rag/status')]);
  if(request!==trashRequest||!dialog.open)return;
  trashLoading=false;
  const messages = [], labels=['리포트','내 자료','노트','AI 검색'];
  results.forEach((result,i) => {
   if (result.status !== 'fulfilled') { messages.push(labels[i]+': '+result.reason.message);return; }
   const v=result.value;
   if (i===0) for (const id of v.report_visibility.hidden_reports || []) { if (!(v.report_visibility.deleted_reports || []).includes(id)) trashed.push(report(id)||{kind:'report',id,title:id}); }
   if (i===1) { for (const f of v.files||[]) trashed.push({kind:'pdf',id:f.id,title:f.name}); for (const m of v.mails||[]) trashed.push(mail(m)); }
   if (i===2) for (const n of v) trashed.push({kind:'note',id:n.id,title:n.path});
   if (i===3) { for (const d of v.trash||[]) trashed.push({kind:'rag',id:d.id,title:d.name}); if (!v.ok) messages.push('AI 검색: 서비스를 켜면 휴지통을 확인할 수 있습니다.'); }
  });
  trashed=[...new Map(trashed.map(x=>[key(x),x])).values()];
  $('#data-trash-error').textContent=messages.join('\n');
  const names={report:'리포트',pdf:'PDF',mail:'메일 연결',note:'노트',rag:'AI 검색 자료'};
  $('#data-trash-list').innerHTML=trashed.map(x=>`<button class="trash-item" data-trash-key="${esc(key(x))}" aria-pressed="false"><b>${esc(x.title)}</b><small>${names[x.kind]}</small></button>`).join('')||'<p>휴지통이 비어 있습니다.</p>';
  for (const b of dialog.querySelectorAll('[data-trash-key]')) b.onclick=()=>{const k=b.dataset.trashKey;if(trashSelected.has(k))trashSelected.delete(k);else trashSelected.add(k);paintTrash();};
  paintTrash();
 }
 async function trashAction(action) {
  if (trashBusy || !trashSelected.size) return;
  const items=trashed.filter(x=>trashSelected.has(key(x)));
  if(action==='delete'&&!confirm(`${items.length}개 항목을 완전히 삭제할까요?\n${items.slice(0,8).map(x=>x.title).join('\n')}\n이 작업은 되돌릴 수 없습니다.`))return;
  trashBusy=true;paintTrash();const errors=[],done=[];
  try { for(const x of items) {try {await change(x,action);done.push(x)}catch(e){errors.push(x.title+': '+e.message)}} await refreshItems(done); }
  catch(e){errors.push(e.message)}
  finally {trashBusy=false;await openTrash();if(dialog.open)(dialog.querySelector('[data-trash-key]')||$('#data-trash-close')).focus();}
  if(errors.length)$('#data-trash-error').textContent=errors.join('\n');
 }
 $('#data-trash-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{++trashRequest;trashLoading=false});
 dialog.addEventListener('cancel',e=>{if(trashBusy)e.preventDefault()});
 $('#data-trash-all').onclick=()=>{trashSelected=new Set(trashSelected.size===trashed.length?[]:trashed.map(key));paintTrash()};
 $('#data-trash-restore').onclick=()=>trashAction('restore');$('#data-trash-delete').onclick=()=>trashAction('delete');
 dialog.addEventListener('keydown',e=>{if(e.key==='Delete'&&!e.repeat&&!editing(e.target)){e.preventDefault();trashAction('delete')}});
 window.AVSelection={remove,openTrash,clear(){chosen.clear();paint()},items:()=>[...chosen.values()],forItem(x){return chosen.has(key(x))?[...chosen.values()]:[x]}};
 paint();
})();
