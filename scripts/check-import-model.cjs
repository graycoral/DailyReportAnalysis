// Fast browser-model regressions; no browser dependency required in Windows CI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const elements=new Map();
const element=()=>({value:'',checked:true,textContent:'',innerHTML:'',attributes:{},dataset:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v},querySelectorAll(){return[]},insertAdjacentHTML(){}});
const get=selector=>{if(!elements.has(selector))elements.set(selector,element());return elements.get(selector)};
const context=vm.createContext({window:{},document:{querySelector:get,querySelectorAll:()=>[]},URL,matchMedia:()=>({matches:false,addEventListener(){}})});
vm.runInContext(source.slice(0,source.indexOf('// Tab is mirrored')),context);
const evaluate=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
for(const state of ['unavailable','offline','unconfigured']){
 evaluate(`showStatus({sync_state:'${state}',status:'GitHub 연결 불가',syncing:false})`);
 assert.match(get('#sync').textContent,/지금 업데이트/);assert.equal(get('#sync').disabled,state==='offline');
 assert.equal(get('#sync-indicator').attributes['data-state'],state==='unavailable'?'error':'idle');
}
evaluate('showStatus({sync_state:"checking",syncing:true})');assert.equal(get('#sync').disabled,true);assert.equal(get('#sync-indicator').attributes['data-state'],'checking');
evaluate('showStatus({sync_state:"ready",syncing:false,synced_at:"2026-10-16T02:45:00Z"})');assert.match(get('#sync').textContent,/지금 업데이트/);assert.ok(!get('#sync').disabled);
assert.equal(get('#sync-indicator').attributes['data-state'],'ready');assert.match(get('#sync-time').textContent,/2026.*10.*16.*11:45/,'timestamp must use Korean time regardless of the browser timezone');
evaluate('showStatus({sync_state:"unknown",synced_at:"bad-date"})');assert.equal(get('#sync-indicator').attributes['data-state'],'idle');assert.match(get('#sync-time').textContent,/확인 기록 없음/);
const report={id:'2026-10-15',date:'2026-10-15',title:'게시 리포트',summary:'',body_markdown:'old',companies:[],tags:[],sources:[],attachments:[]};
context.raw={reports:[report],entities:[],events:[{report_id:report.id,title:'이전 사건'}],relations:[{report_id:report.id,evidence:'이전 본문 근거'}],related:[]};
context.localReport={...report,id:'local-2026-10-15',title:'지역 운행 확대',body_markdown:'Tesla는 본문에만 등장',companies:['Uber'],tags:['자율주행'],origin:'outlook-report',mail:{subject:'Uber 매일 보고'}};
evaluate('state={snapshot:{catalog:raw}};importedReports=[localReport]');
const view=plain(evaluate('catalog()'));
assert.deepEqual(view.reports.map(r=>r.id),[report.id,'local-2026-10-15'],'different bodies on the same date remain available');
assert.equal(view.relations.length,1);assert.equal(view.relations[0].report_id,report.id,'published evidence stays with the published body');
assert.equal(view.events.length,2);assert.equal(view.events[1].status,'보고일');
assert.equal(context.raw.reports[0].body_markdown,'old','public snapshot must stay immutable');
assert.equal(evaluate('mentions(localReport,"Uber")'),true,'mail subject tag must survive strict filtering');
assert.equal(evaluate('mentions(localReport,"Tesla")'),false,'body mention must not create a tag');
get('#query').value='자율주행';assert.equal(evaluate('filtered().length'),1,'folder tag must be searchable');
get('#query').value='매일 보고';assert.equal(evaluate('filtered().length'),1,'mail subject must be searchable');
get('#query').value='';
evaluate('tab="outlook"');
assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['local-2026-10-15']);
assert.equal(evaluate('catalog().relations.length'),0,'Outlook must never inherit published evidence');
context.duplicate={...context.localReport,body_markdown:'---\r\ntitle: Different mail metadata\r\n---\r\nold  \r\n'};
evaluate('tab="search";importedReports=[duplicate];mergedSource=null');
assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),[report.id],'same date/body is listed once despite frontmatter and line endings');
// Deduplication keeps each original's complete search/filter conditions.
const originalSnapshot=JSON.stringify(context.raw),originalImport=JSON.stringify(context.duplicate);
for(const strict of [true,false])for(const tab of ['search','timeline']){
 get('#strict').checked=strict;evaluate('tab='+JSON.stringify(tab));
 for(const query of ['자율주행','매일 보고','지역 운행 확대']){
  get('#query').value=query;
  assert.deepEqual(plain(evaluate('filtered().map(r=>r.id)')),[report.id],`${tab}: duplicate metadata remains searchable (strict=${strict})`);
 }
 get('#company').value='Uber';get('#category').value='자율주행';get('#query').value='매일 보고';
 assert.deepEqual(plain(evaluate('filtered().map(r=>r.id)')),[report.id],'company, category and mail subject match the imported original');
 get('#from').value='2026-10-16';assert.equal(evaluate('filtered().length'),0,'date filters still apply');get('#from').value='';
 get('#to').value='2026-10-14';assert.equal(evaluate('filtered().length'),0);get('#to').value='';
 get('#query').value='게시 리포트';assert.equal(evaluate('filtered().length'),0,'conditions must match one original, not unrelated metadata across copies');
 get('#query').value='';get('#company').value='';get('#category').value='';
}
get('#strict').checked=true;
for(const tab of ['graph','outlook']){
 evaluate('tab='+JSON.stringify(tab));get('#query').value='매일 보고';
 assert.deepEqual(plain(evaluate('filtered().map(r=>r.id)')),[context.duplicate.id],'source views must retain the matching original ID');
}
evaluate('tab="map"');
assert.deepEqual(plain(evaluate('filtered().map(r=>r.id)')),[report.id],'map search resolves matching original metadata to the shared report');
assert.ok(plain(evaluate('mapReportMembers(filtered()[0]).map(r=>r.id)')).includes(context.duplicate.id),'map keeps the matching source record');
get('#query').value='';
assert.equal(JSON.stringify(context.raw),originalSnapshot,'search must not alter published evidence');
assert.equal(JSON.stringify(context.duplicate),originalImport,'search must not alter imported metadata');
evaluate('tab="search";importedReports=[{...duplicate,tags:["과거 발송본"]}]');
get('#query').value='과거 발송본';assert.equal(evaluate('filtered().length'),0,'obsolete tags stay excluded in duplicate groups');
get('#query').value='';evaluate('importedReports=[duplicate]');
evaluate('tab="outlook"');
assert.equal(evaluate('catalog().reports.length'),1,'duplicate mail remains in its source history');
evaluate('tab="search";applyReportVisibility({hidden_reports:[raw.reports[0].id]})');
assert.equal(evaluate('catalog().reports.length'),0,'a hidden report must not reappear through a duplicate');
get('#query').value='매일 보고';assert.equal(evaluate('filtered().length'),0,'matching duplicate metadata cannot reveal a hidden group');
evaluate('applyReportVisibility({hidden_reports:[]})');
assert.deepEqual(plain(evaluate('filtered().map(r=>r.id)')),[report.id],'restoring a group also restores its searchable metadata');
evaluate('importedReports=[]');assert.equal(evaluate('filtered().length'),0,'removed imports must not leave stale search metadata');
get('#query').value='';
evaluate('applyReportVisibility({hidden_reports:[]});importedReports=[localReport,{...localReport,id:"manual",origin:"markdown"},{...localReport,id:"next-day",date:"2026-10-16"}];mergedSource=null');
assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),[report.id,'manual','next-day'],'manual/Outlook duplicates merge, but a different date remains');

// A local report hidden before publication must stay hidden when sync adds its identical copy.
context.hiddenMail={...report,id:'outlook-hidden',origin:'outlook-report'};
evaluate('state={snapshot:{catalog:{...raw,reports:[]}}};importedReports=[hiddenMail];applyReportVisibility({hidden_reports:[hiddenMail.id]})');
assert.equal(evaluate('dailyCatalog().reports.length'),0);
evaluate('state={snapshot:{catalog:raw}}');
assert.equal(evaluate('dailyCatalog().reports.length'),0,'publication must not resurrect hidden Outlook content');
assert.match(evaluate('outlookDailyStatus(hiddenMail)'),/숨김/);
evaluate('applyReportVisibility({hidden_reports:[]})');
assert.deepEqual(plain(evaluate('dailyCatalog().reports.map(r=>r.id)')),[report.id],'restoring the original reveals its published representative');
assert.match(evaluate('outlookDailyStatus(hiddenMail)'),/중복/);

// Explicit links retain the imported original, including its title and saved associations.
context.linkedMD={...report,id:'manual-linked',title:'연결한 MD 원본',origin:'markdown'};
context.newest={...report,id:'newest',date:'2026-10-20',title:'관련 없는 최신 리포트',body_markdown:'different'};
context.renderReportLocal=()=>{};
get('#sort').value='desc';
evaluate('render=()=>{};highlight=()=>{};state={snapshot:{catalog:{...raw,reports:[newest,...raw.reports]}}};importedReports=[linkedMD];tab="search";selected=linkedMD.id;linkedReport=selected;updateCatalogView();renderDetail()');
assert.equal(evaluate('selected'),context.linkedMD.id,'a PDF link must not select the newest unrelated report');
assert.match(get('#detail').innerHTML,/연결한 MD 원본/,'detail must show the linked source, not only its published copy');
evaluate('updateCatalogView()');
assert.equal(evaluate('selected'),context.linkedMD.id,'refresh preserves explicit source selection');
evaluate('linkedReport="";selected=linkedMD.id;updateCatalogView()');
assert.equal(evaluate('selected'),report.id,'ordinary selection follows the same content when its representative changes');

// Bound work by the number of reports, rather than rescanning every body for every card.
context.many=Array.from({length:500},(_,i)=>({...report,id:'mail-'+i,date:new Date(Date.UTC(2024,0,i+1)).toISOString().slice(0,10),body_markdown:'Long report body\n'.repeat(600),origin:'outlook-report'}));
evaluate('state={snapshot:{catalog:{...raw,reports:[]}}};importedReports=many;const originalIdentity=reportIdentity;let identityCalls=0;reportIdentity=r=>{identityCalls++;return originalIdentity(r)}');
evaluate('importedReports.forEach(outlookDailyStatus)');
assert.equal(evaluate('identityCalls'),500,'normalize each report once for the catalog');
evaluate('importedReports.forEach(outlookDailyStatus)');
assert.equal(evaluate('identityCalls'),500,'rerendering status labels reuses the catalog index');
evaluate('importedReports=[...many,{...many[0],id:"changed",date:"2030-01-01"}];dailyCatalog()');
assert.equal(evaluate('dailyCatalog().reports.length'),501,'new import arrays invalidate cached representatives');
evaluate('reportIdentity=originalIdentity');
console.log('PASS: update status, content deduplication, hidden publication/restore, exact linked-source selection, representative changes, bounded status work and source provenance');
