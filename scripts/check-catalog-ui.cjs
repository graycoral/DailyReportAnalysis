// Run with: node scripts/check-catalog-ui.cjs
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const prefix=app.slice(0,app.indexOf('// Tab is mirrored'));
assert.ok(prefix.length>1000);
const elements=new Map();
function element(){return {value:'',checked:false,innerHTML:'',textContent:'',dataset:{},setAttribute(){},setCustomValidity(){},addEventListener(){},classList:{toggle(){}},querySelector(){return element()},querySelectorAll(){return []}}}
function get(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector)}
function all(selector){
 const pattern=selector==='#results .ml'?/class="ml /g:selector==='#results .mn'?/class="mn /g:null;
 return pattern?[...get('#results').innerHTML.matchAll(pattern)].map(()=>element()):[];
}
const context=vm.createContext({window:{},
 document:{querySelector:get,querySelectorAll:all,createTreeWalker:()=>({nextNode:()=>false})},
 NodeFilter:{SHOW_TEXT:4},URL,setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
 renderReportLocal(){},matchMedia:()=>({matches:false,addEventListener(){}}),
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../internal/hub/web/report-reading.js'),'utf8'),context);
vm.runInContext(prefix,context);
const evaluate=code=>vm.runInContext(code,context);
const plain=value=>JSON.parse(JSON.stringify(value));
const report=(id,title,tags=['과거 발송본','동향'])=>({id,date:'2026-10-14',title,tags,summary:'새로운 운행 소식',body_markdown:'자율주행 서비스 개시',companies:['기업A'],sources:[],attachments:[]});
const noUpdate=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/companies.json'),'utf8')).no_update_title;
const raw={
 reports:[report('kept','기존 보고서'),report('empty',noUpdate),{...report('body','안내 문구 개선'),body_markdown:noUpdate}],
 entities:[{id:'a',label:'기업A'},{id:'b',label:'기업B'}],
 events:[{id:'e1',report_id:'kept',date:'2026-10-14',title:'유지할 사건',detail:'개시',status:'확정',companies:[]},{id:'e2',report_id:'empty',date:'2026-10-14',title:'숨길 사건',detail:'',status:'보고일',companies:[]}],
 relations:[{id:'keep-rel',report_id:'kept',from:'a',to:'b',label:'유지 관계',evidence:'협력',status:'확정',sources:[]},{id:'hide-rel',report_id:'empty',from:'a',to:'b',label:'숨길 관계',evidence:'',status:'확정',sources:[]}],
 related:[{from:'kept',to:'body',reason:'유지 연결'},{from:'kept',to:'empty',reason:'숨길 연결'}],
};
context.raw=raw;
get('#sort').value='desc';
evaluate('state={snapshot:{catalog:raw,commit:"one"}}');
let visible=plain(evaluate('catalog()'));
assert.deepEqual(visible.reports.map(r=>r.id),['kept','body']);
assert.deepEqual(visible.reports[0].tags,['동향']);
assert.equal(visible.events.length,1);
assert.equal(visible.relations.length,1);
assert.equal(visible.related.length,1);
assert.deepEqual(raw.reports[0].tags,['과거 발송본','동향'],'must not mutate the downloaded snapshot');
for(const view of ['search','timeline','graph','map']){
 evaluate('tab='+JSON.stringify(view)+';render()');
 const html=get('#results').innerHTML;
 assert.doesNotMatch(html,/과거 발송본|주요 신규 업데이트 없음|숨길 사건|hide-rel|숨길 관계/);
 assert.doesNotMatch(get('#tag-cloud').innerHTML,/과거 발송본/);
 assert.match(get('#stats').innerHTML,/<b>2<\/b>/);
}
get('#query').value='과거 발송본';
assert.equal(evaluate('filtered().length'),0,'obsolete category must not match loose search');
get('#query').value='기존 보고서';
assert.deepEqual(plain(evaluate('filtered().map(r=>r.id)')),['kept']);
get('#query').value='';
get('#category').value='동향';
assert.equal(evaluate('filtered().length'),2);
get('#category').value='';
// The next sync must apply the same rule and clear a deleted selection.
(async()=>{
 const next=structuredClone(raw);
 next.reports.push(report('future-empty','  주요   신규 업데이트 없음\\n'.replace('\\n','\n')),report('future','새 소식',['과거발송본','새 분류']));
 context.nextState={snapshot:{catalog:next,commit:'two'}};
 evaluate('selected="empty";selectedRelation="hide-rel";tab="search";api=async()=>nextState');
 await evaluate('refresh(true)');
 assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['kept','body','future']);
 assert.equal(evaluate('selected'),'kept');
 assert.equal(evaluate('selectedRelation'),'');
 assert.doesNotMatch(get('#category').innerHTML,/과거\s*발송본/);
 assert.match(get('#category').innerHTML,/새 분류/);
 assert.deepEqual(plain(evaluate('catalog().reports.find(r=>r.id==="future").tags')),['새 분류']);
 // An exact title rule must not hide a substantial report merely quoting the phrase.
 assert.ok(evaluate('catalog().reports.some(r=>r.id==="body")'));
 // Hiding must remove every path to the report, without changing the source.
 evaluate('state={snapshot:{catalog:raw,commit:"one"}};selected="kept";selectedRelation="keep-rel";applyReportVisibility({hidden_reports:[]});updateCatalogView()');
 const original=JSON.stringify(raw);
 const calls=[];
 context.visibilityAPI=async(url,body)=>{calls.push({url,body});return {hidden_reports:body.action==='hide'?[body.report_id]:[]}};
 evaluate('api=visibilityAPI');
 await evaluate('changeReportVisibility("hide","kept")');
 assert.equal(calls[0].url,'/api/report-visibility');
 assert.equal(evaluate('selected'),'body');
 assert.equal(evaluate('selectedRelation'),'');
 assert.equal(get('#restore-reports').disabled,false);
 assert.match(get('#hidden-count').textContent,/1개/);
 assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['body']);
 assert.equal(evaluate('catalog().events.length+catalog().relations.length+catalog().related.length'),0);
 for(const view of ['search','timeline','graph','map']){
  evaluate('tab='+JSON.stringify(view)+';render()');
  assert.doesNotMatch(get('#results').innerHTML,/기존 보고서|유지할 사건|유지 관계/);
  assert.doesNotMatch(get('#detail').innerHTML,/기존 보고서/);
 }
 assert.equal(JSON.stringify(raw),original,'personal hiding must not mutate the catalog');
 // Reload/sync and another window's status changes use the saved preference.
 context.nextState={snapshot:{catalog:structuredClone(raw),commit:'two'},report_visibility:{hidden_reports:['kept']}};
 evaluate('api=async()=>nextState');
 await evaluate('refresh(true)');
 assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['body']);
 context.nextStatus={commit:'two',report_visibility:{hidden_reports:[]}};
 evaluate('api=async()=>nextStatus');
 await evaluate('refresh()');
 assert.equal(evaluate('catalog().reports.length'),2);
 // Restoring all keeps search conditions and cannot resurrect policy exclusions.
 evaluate('api=visibilityAPI;applyReportVisibility({hidden_reports:["kept","body","empty","old-id"]});updateCatalogView()');
 assert.equal(evaluate('selected'),'');
 get('#query').value='새로운';
 await get('#restore-all-settings').onclick();
 assert.equal(get('#query').value,'새로운');
 assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['kept','body']);
 assert.equal(get('#restore-reports').disabled,true);
 get('#query').value='';
 // A failed save keeps both visibility and selection, with actionable feedback.
 evaluate('selected="kept";api=async()=>{throw Error("쓰기 실패")}');
 await evaluate('changeReportVisibility("hide","kept")');
 assert.equal(evaluate('selected'),'kept');
 assert.equal(evaluate('catalog().reports.length'),2);
 assert.equal(get('#toast').textContent,'쓰기 실패');
 assert.equal(evaluate('visibilityBusy'),false);
 // An old poll must not undo a later successful hide.
 let releasePoll;
 context.delayedStatus=new Promise(resolve=>releasePoll=resolve);
 evaluate('api=async()=>delayedStatus');
 const pending=evaluate('refresh()');
 evaluate('api=visibilityAPI');
 await evaluate('changeReportVisibility("hide","kept")');
 releasePoll({commit:'two',report_visibility:{hidden_reports:[]}});
 await pending;
 assert.deepEqual(plain(evaluate('catalog().reports.map(r=>r.id)')),['body']);
 evaluate('applyReportVisibility({hidden_reports:[]})');
 const empty={...raw,reports:[raw.reports[1]]};
 context.empty=empty;
 evaluate('state={snapshot:{catalog:empty}};selected=""');
 for(const view of ['search','timeline','graph','map'])evaluate('tab='+JSON.stringify(view)+';render()');
 console.log('PASS: catalog policy, personal hide/restore, all views, persistence, cross-window updates, failed saves, stale polls, selection and empty results');
})().catch(error=>{console.error(error);process.exitCode=1});
