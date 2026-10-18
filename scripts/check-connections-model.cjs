// Fast model checks for the offline UI, independent of browser and optional features.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({
 $:()=>({addEventListener(){},open:false}),state:{setup:false},hiddenReports:new Set(),
 networkSources:{daily:true,outlook:true,local:true},networkView:()=>false,matches:()=>true,
 local:{files:[{id:'p1',name:'one.pdf'},{id:'p2',name:'two.pdf'}]},
 esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 sourceLabel:s=>s,structuredClone,render(){},
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../internal/hub/web/connections.js'),'utf8'),context);
const run=code=>vm.runInContext(code,context),plain=x=>JSON.parse(JSON.stringify(x));
run(`
const report={id:'r1',title:'report',date:'2026-10-18'};
const mailA={entry_id:'00AA',store_id:'00BB',subject:'one'},mailB={entry_id:'00AA',store_id:'00CC',subject:'two'};
documentConnections={loaded:true,documents:[
 {id:'r:r1',kind:'report',source:'daily',report_id:'r1',title:'report'},
 {id:'pdf:p1',kind:'pdf',source:'local',file_id:'p1',title:'one.pdf'},
 {id:'pdf:p2',kind:'pdf',source:'local',file_id:'p2',title:'two.pdf'},
 {id:'mail:a',kind:'mail',source:'outlook',title:'one',mail:mailA},
 {id:'mail:b',kind:'mail',source:'outlook',title:'two',mail:mailB}
],connections:[
 {id:'pdfs',from:'pdf:p1',to:'pdf:p2',status:'accepted',reasons:[{text:'same file'}]},
 {id:'mails',from:'mail:a',to:'mail:b',status:'accepted',reasons:[{text:'same project'}]},
 {id:'report',from:'r:r1',to:'pdf:p1',status:'accepted',reasons:[{text:'same project'}]},
 {id:'no',from:'r:r1',to:'pdf:p2',status:'rejected',reasons:[]}
]};
const base=()=>({nodes:[{id:'r:r1',kind:'report',source:'daily',ref:report},{id:'legacy-mail',kind:'mail',source:'outlook',ref:mailA}],links:[]});
`);
let model=plain(run('extendDocumentConnections(base(),[report])'));
assert.equal(model.links.length,3);assert.equal(model.nodes.filter(n=>n.kind==='mail').length,2,'same EntryID in different stores stays distinct');
assert.ok(model.links.every(l=>model.nodes.some(n=>n.id===l.from)&&model.nodes.some(n=>n.id===l.to)));
assert.equal(model.links.find(l=>l.id==='rule:mails').from,'legacy-mail','existing mail nodes are reused');
run('networkSources.local=false');model=plain(run('extendDocumentConnections(base(),[report])'));assert.deepEqual(model.links.map(l=>l.id),['rule:mails']);
run('networkSources.local=true;hiddenReports.add("r1")');model=plain(run('extendDocumentConnections(base(),[report])'));assert.equal(model.links.some(l=>l.id==='rule:report'),false);
context.unsafeDoc={id:'a" onclick="oops',source:'local',kind:'pdf',title:'<img src=x onerror=oops>',date:''};
const html=run('connectionDocButton(unsafeDoc)');assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(!html.includes(' onclick="oops'));
(async()=>{
 const pending=[];context.api=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 run('renderConnectionsList=()=>{};renderConnectionDictionary=()=>{}');
 const old=run('loadDocumentConnections(true)'),fresh=run('loadDocumentConnections(true)');
 pending[1].resolve({documents:[],connections:[],aliases:[],marker:'new'});await fresh;
 pending[0].reject(Error('stale failure'));await old;
 assert.equal(run('documentConnections.marker'),'new');assert.equal(run('documentConnections.error'),'');assert.equal(run('documentConnections.busy'),false);
 console.log('PASS: confirmed links only, all source endpoints, store identity, hidden reports, escaped metadata and stale request isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
