// Fast browser-model regressions; no browser dependency required in Windows CI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const elements=new Map();
const element=()=>({value:'',checked:true,textContent:'',innerHTML:'',attributes:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v},querySelectorAll(){return[]},insertAdjacentHTML(){}});
const get=selector=>{if(!elements.has(selector))elements.set(selector,element());return elements.get(selector)};
const context=vm.createContext({document:{querySelector:get,querySelectorAll:()=>[]},URL});
vm.runInContext(source.slice(0,source.indexOf('// Tab is mirrored')),context);
const evaluate=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
for(const state of ['unavailable','offline','unconfigured']){
 evaluate(`showStatus({sync_state:'${state}',status:'GitHub 연결 불가',syncing:false})`);
 assert.match(get('#sync').textContent,/지금 업데이트/);assert.ok(!get('#sync').disabled);
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
assert.equal(view.reports.length,1);assert.equal(view.reports[0].id,'local-2026-10-15');
assert.equal(view.relations.length,0,'old-body evidence must not be attached to a locally replaced report');
assert.equal(view.events.length,1);assert.equal(view.events[0].status,'보고일');
assert.equal(context.raw.reports[0].body_markdown,'old','public snapshot must stay immutable');
assert.equal(evaluate('mentions(localReport,"Uber")'),true,'mail subject tag must survive strict filtering');
assert.equal(evaluate('mentions(localReport,"Tesla")'),false,'body mention must not create a tag');
get('#query').value='자율주행';assert.equal(evaluate('filtered().length'),1,'folder tag must be searchable');
get('#query').value='매일 보고';assert.equal(evaluate('filtered().length'),1,'mail subject must be searchable');
console.log('PASS: update failure/recovery, local overlay, provenance isolation, folder/subject search and title-only company tags');
