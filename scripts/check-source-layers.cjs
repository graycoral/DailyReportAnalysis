// Source visibility and evidence boundaries; no Outlook, browser, or AI service required.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const elements=new Map();
const element=()=>({value:'',checked:false,innerHTML:'',textContent:'',setAttribute(){},classList:{toggle(){}},querySelector(){return element()},querySelectorAll(){return[]}});
const get=s=>{if(!elements.has(s))elements.set(s,element());return elements.get(s)};
const context=vm.createContext({document:{querySelector:get,querySelectorAll:()=>[],createTreeWalker:()=>({nextNode:()=>false})},URL,NodeFilter:{SHOW_TEXT:4},renderReportLocal(){},setTimeout(){},clearTimeout(){},localStorage:{getItem:()=>'{"local":false,"outlook":true,"daily":true}'},matchMedia:()=>({matches:false,addEventListener(){}})});
vm.runInContext(app.slice(0,app.indexOf('// Tab is mirrored')),context);
const evaluate=code=>vm.runInContext(code,context),plain=v=>JSON.parse(JSON.stringify(v));
assert.deepEqual(plain(evaluate('networkSources')),{outlook:true,daily:true,local:false,notes:true});
const report=(id,title,origin)=>({id,title,date:'2026-10-14',origin,summary:'운행',body_markdown:'Uber 운행 확대',companies:['Uber'],tags:['동향'],sources:[{title:'공식 발표',url:'https://example.com/source'}],attachments:[]});
context.raw={reports:[report('published','게시 리포트')],entities:[{id:'a',label:'Uber'},{id:'b',label:'Partner'}],events:[],relations:[{id:'fact',report_id:'published',from:'a',to:'b',label:'협력',evidence:'게시된 원문 근거',sources:[{url:'https://example.com/source'}],status:'확정'}],related:[]};
context.imports=[{...report('outlook','Outlook 리포트','outlook-report'),mail:{entry_id:'A1',store_id:'B1',subject:'원본 메일',folder:'동향',sender:'분석팀'}},{...report('manual','직접 가져온 MD','markdown'),date:'2026-10-15'}];
context.saved={available:true,files:[{id:'pdf',name:'참고 <PDF>.pdf',reports:['published','outlook'],size:100},{id:'unlinked',name:'연결 없는 PDF.pdf',reports:[]}],mails:[{entry_id:'A2',store_id:'B1',subject:'사용자가 연결한 메일',report:'published'}],sources:[]};
evaluate('state={snapshot:{catalog:raw}};importedReports=imports;local=saved');
context.noteModel={nodes:[{id:'note:a',kind:'note',label:'노트 <A>',source:'notes',ref:{id:'a',path:'노트 A.md',title:'노트 <A>',body:'[[노트 B]]',tags:['분석']}},{id:'note:b',kind:'note',label:'노트 B',source:'notes',ref:{id:'b',path:'노트 B.md',title:'노트 B',body:'유일한검색어',tags:[]}}],links:[{id:'note-link:a:b',from:'note:a',to:'note:b',label:'노트 링크',evidence:'노트 A.md 본문: [[노트 B]]'},{id:'note-report:a:published',from:'note:a',to:'r:published',report_id:'published',label:'리포트 연결',evidence:'직접 연결'}]};
evaluate('Object.assign(noteNetworkState,noteModel,{loaded:true})');
const original=JSON.stringify({raw:context.raw,imports:context.imports,saved:context.saved});
// The daily list deduplicates content; Outlook retains the imported source record.
assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['published','manual']);
evaluate('tab="outlook"');
assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['outlook']);
get('#sort').value='desc';
for(const view of ['graph','map'])for(let mask=0;mask<16;mask++){
 evaluate(`tab='${view}';networkSources={daily:${!!(mask&1)},outlook:${!!(mask&2)},local:${!!(mask&4)},notes:${!!(mask&8)}}`);
 const catalog=plain(evaluate('catalog()')),model=plain(evaluate('buildDocumentNetwork(filtered())'));
 const merged=view==='map'&&!!(mask&1)&&!!(mask&2);
 assert.deepEqual(catalog.reports.map(r=>r.id).sort(),[...(mask&1?['published','manual']:[]),...(mask&2&&!merged?['outlook']:[])].sort());
 assert.equal(catalog.relations.length,mask&1?1:0,'only the published report supplies the published fact');
 const ids=new Set(model.nodes.map(n=>n.id));
 assert.ok(model.links.every(l=>ids.has(l.from)&&ids.has(l.to)&&l.evidence),'no dangling or unsupported source links');
 assert.equal(model.nodes.some(n=>n.kind==='pdf'),!!(mask&4));
 assert.equal(model.nodes.some(n=>n.kind==='mail'),!!(mask&2));
 assert.equal(model.links.some(l=>l.id==='origin:outlook'),!!(mask&2));
 assert.equal(model.links.some(l=>l.id==='pdf-link:pdf:published'),!!(mask&1)&&!!(mask&4));
 assert.equal(model.links.some(l=>l.id==='pdf-link:pdf:outlook'),!!(mask&2)&&!!(mask&4)&&!merged);
 assert.equal(model.nodes.some(n=>n.kind==='note'),!!(mask&8));
 assert.equal(model.links.some(l=>l.id==='note-link:a:b'),!!(mask&8));
 assert.equal(model.links.some(l=>l.id==='note-report:a:published'),!!(mask&1)&&!!(mask&8));
 if(merged)assert.equal(model.links.find(l=>l.id==='origin:outlook').to,'r:published','original mail stays connected to the shared report');
}
get('#query').value='유일한검색어';
assert.deepEqual(plain(evaluate('buildDocumentNetwork(filtered()).nodes.map(n=>n.id)')),['note:b']);
assert.equal(evaluate('buildDocumentNetwork(filtered()).links.length'),0,'search cannot leave dangling note links');
get('#query').value='';
evaluate('tab="graph";networkSources={daily:true,outlook:true,local:true}');
assert.match(evaluate('documentConnectionsHtml(buildDocumentNetwork(filtered()))'),/참고 &lt;PDF&gt;/);
assert.doesNotMatch(evaluate('documentConnectionsHtml(buildDocumentNetwork(filtered()))'),/<PDF>/);
// Date/company filters never invent links to excluded reports; unlinked source files remain independently visible.
get('#from').value='2026-10-15';
assert.equal(evaluate('buildDocumentNetwork(filtered()).links.length'),0);
assert.equal(evaluate('buildDocumentNetwork(filtered()).nodes.filter(n=>n.kind==="pdf").length'),2);
get('#from').value='';
evaluate('applyReportVisibility({hidden_reports:["published"]})');
assert.equal(evaluate('catalog().relations.length'),0);
assert.equal(evaluate('buildDocumentNetwork(filtered()).links.some(l=>l.report_id==="published")'),false);
assert.equal(JSON.stringify({raw:context.raw,imports:context.imports,saved:context.saved}),original,'source filtering must not mutate originals or saved links');
// Disabling a selected source cannot leave its detail visible.
evaluate('networkSources={daily:true,outlook:true,local:true};currentDocuments=buildDocumentNetwork(filtered());networkSelection={kind:"node",id:"pdf:pdf"};networkSources.local=false;currentDocuments=buildDocumentNetwork(filtered())');
assert.equal(evaluate('renderNetworkDetail()'),false);
assert.equal(evaluate('networkSelection'),null);
// A background catalog refresh must not erase filters merely because their source is switched off.
get('#company').value='Uber';
evaluate('render=()=>{};networkSources={daily:false,outlook:false,local:true};updateCatalogView()');
assert.equal(get('#company').value,'Uber');
console.log('PASS: persisted defaults, all sixteen source combinations in both maps, note content search, evidence boundaries, hidden/filtered endpoints, escaping and stale detail removal');
