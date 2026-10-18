// Content identity, source switches and saved links must agree in the map.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const elements=new Map(),get=s=>{if(!elements.has(s))elements.set(s,{value:'',checked:true});return elements.get(s)};
const context=vm.createContext({document:{querySelector:get},URL});
const app=fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
vm.runInContext(app.slice(0,app.indexOf('// Tab is mirrored')),context);
const run=s=>vm.runInContext(s,context),plain=x=>JSON.parse(JSON.stringify(x));
const published={id:'published',date:'2026-10-19',title:'운행 확대',summary:'Uber 운행',body_markdown:'Uber 운행 확대\n',companies:['Uber'],tags:['운행'],attachments:[],sources:[]};
const imported={...published,id:'outlook',title:'메일 제목',origin:'outlook-report',tags:['임원보고'],body_markdown:'---\r\ntitle: Mail\r\n---\r\nUber 운행 확대  \r\n',mail:{entry_id:'AA',store_id:'BB',subject:'메일로만 찾는 제목'}};
context.raw={reports:[published],events:[{report_id:published.id}],relations:[{report_id:published.id,evidence:'게시 근거'}],related:[],entities:[]};
context.imports=[imported,{...imported,id:'manual',origin:'markdown',mail:undefined},{...imported,id:'changed',body_markdown:'다른 내용'},{...imported,id:'next-day',date:'2026-10-20'}];
context.saved={files:[{id:'pdf',name:'PDF',reports:['outlook','published'],size:20}],mails:[{entry_id:'CC',store_id:'BB',subject:'직접 연결 메일',report:'outlook'}],sources:[]};
run('state={snapshot:{catalog:raw}};importedReports=imports;local=saved;tab="map"');
const original=JSON.stringify({raw:context.raw,imports:context.imports,saved:context.saved});
assert.deepEqual(plain(run('catalog().reports.map(r=>r.id)')),['published','changed','next-day']);
assert.equal(run('mapReportSources(catalog().reports[0])'),'데일리 · Outlook');
for(const strict of [true,false]){
 get('#strict').checked=strict;get('#query').value='메일로만';
 assert.deepEqual(plain(run('filtered().map(r=>r.id).sort()')),['changed','next-day','published']);
 get('#category').value='임원보고';get('#query').value='운행 확대';
 assert.deepEqual(plain(run('filtered().map(r=>r.id).sort()')),['next-day','published']);
 get('#category').value='';get('#query').value='';
}
const model=plain(run('buildDocumentNetwork(filtered())'));
assert.equal(model.nodes.filter(n=>n.kind==='report').length,3);
assert.equal(model.links.filter(l=>l.from==='pdf:pdf'&&l.to==='r:published').length,1);
assert.ok(model.links.some(l=>l.id==='origin:outlook'&&l.to==='r:published'));
assert.ok(model.links.some(l=>l.id==='mail-link:0'&&l.to==='r:published'));
run('networkSources.daily=false');
assert.deepEqual(plain(run('catalog().reports.map(r=>r.id)')),['outlook','changed','next-day']);
assert.equal(run('catalog().relations.length'),0,'a mail copy never inherits published assertions');
assert.equal(run('mapReportSources(catalog().reports[0])'),'Outlook');
run('networkSources.daily=true;networkSources.outlook=false');
assert.deepEqual(plain(run('catalog().reports.map(r=>r.id)')),['published']);
assert.equal(run('buildDocumentNetwork(filtered()).nodes.some(n=>n.kind==="mail")'),false);
run('networkSources.outlook=true;applyReportVisibility({hidden_reports:["outlook"]})');
assert.deepEqual(plain(run('catalog().reports.map(r=>r.id)')),['changed','next-day'],'hiding one copy hides its shared report');
run('applyReportVisibility({hidden_reports:[]})');
assert.equal(run('catalog().reports.length'),3);
assert.equal(JSON.stringify({raw:context.raw,imports:context.imports,saved:context.saved}),original);
context.nodes=[{id:'c:Uber',kind:'company',label:'Uber',ref:'Uber'},...model.nodes];
run('updateMapGraph(nodes,[{a:nodes[0],b:nodes[1]},{a:nodes[0],b:nodes[2]}])');
assert.deepEqual(plain(run('mapSelectionItems(nodes[0]).map(n=>n.id).sort()')),['r:changed','r:published'].sort());
// Cached identities are reused on repeated paints, but refreshed on import changes.
run('const identity=reportIdentity;let identityCalls=0;reportIdentity=r=>{identityCalls++;return identity(r)};mapCatalogCache=null;mapCatalog();mapCatalog();mapCatalog()');
assert.equal(run('identityCalls'),5);
run('importedReports=[...importedReports];mapCatalog()');
assert.equal(run('identityCalls'),10);
console.log('PASS: map content deduplication, original metadata search, source switches, saved links, hidden groups, immutability and identity cache');
