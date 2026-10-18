// Regression coverage for image upload, local map nodes and similarity evidence.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../internal/hub/web/index.html'),'utf8');
const elements=new Map(),lists=new Map(),calls=[],messages=[];
function element(){return {value:'',checked:false,innerHTML:'',textContent:'',dataset:{},setAttribute(){},classList:{toggle(){}},querySelector(){return element()},querySelectorAll(){return []}}}
function get(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector)}
function all(selector){
 const pattern=selector==='#results .ml'?/class="ml /g:selector==='#results .mn'?/class="mn /g:null;
 const result=pattern?[...get('#results').innerHTML.matchAll(pattern)].map(()=>element()):[];
 lists.set(selector,result);return result;
}
const context=vm.createContext({window:{},document:{querySelector:get,querySelectorAll:all,createTreeWalker:()=>({nextNode:()=>false})},
 NodeFilter:{SHOW_TEXT:4},URL,setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
 addEventListener(){},renderReportLocal(){},fmtSize:n=>`${n} bytes`,matchMedia:()=>({matches:false,addEventListener(){}}),
 fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({created:true,pages:1})}},
});
vm.runInContext(app.slice(0,app.indexOf('// Tab is mirrored')),context);
vm.runInContext(app.slice(app.indexOf('// ---- AI 검색'),app.indexOf('// Environment setup is separate')),context);
const evaluate=code=>vm.runInContext(code,context);
const raw={reports:[{id:'r',date:'2026-10-14',title:'기존 리포트',tags:[],summary:'새 소식',body_markdown:'본문',companies:[],sources:[],attachments:[]}],entities:[],events:[],relations:[],related:[]};
context.raw=raw;
context.graph={ok:true,docs:[{id:'a',name:'한글 사진.png',kind:'image',pages:1,size:100},{id:'b',name:'<unsafe>.pdf',kind:'pdf',pages:3,size:200}],links:[{from:'a',to:'b',from_page:1,to_page:2,similarity:0.85}]};
context.notify=message=>messages.push(message);
evaluate('state={snapshot:{catalog:raw}};api=async()=>graph;toast=notify;tab="map"');
get('#sort').value='desc';
(async()=>{
 await evaluate('loadMapMedia()');
 assert.equal((get('#results').innerHTML.match(/class="mn media /g)||[]).length,2);
 assert.match(get('#results').innerHTML,/class="ml similarity"/);
 assert.match(get('#results').innerHTML,/한글 사진.png/);
 assert.match(get('#results').innerHTML,/&lt;unsafe&gt;/);
 assert.match(get('#result-count').textContent,/1개 리포트 · 색인 자료 2개/);
 // Keyboard selection must open source pages, not treat a file as a category filter.
 lists.get('#results .mn')[1].onkeydown({key:'Enter',preventDefault(){}});
 assert.match(get('#detail').innerHTML,/한글 사진.png/);
 assert.match(get('#detail').innerHTML,/doc=a&amp;page=1|doc=a&amppage=1|doc=a&page=1/);
 lists.get('#results .ml')[0].onkeydown({key:'Enter',preventDefault(){}});
 assert.match(get('#detail').innerHTML,/유사도 0.8500/);
 assert.match(get('#detail').innerHTML,/doc=b&page=2/);
 assert.match(get('#detail').innerHTML,/사실 관계를 뜻하지 않습니다/);
 get('#query').value='한글';evaluate('render()');
 assert.equal((get('#results').innerHTML.match(/class="mn media /g)||[]).length,1);
 assert.doesNotMatch(get('#results').innerHTML,/class="ml similarity"/);
 get('#query').value='';
 evaluate('api=async()=>({available:false})');await evaluate('loadMapMedia(true)');
 assert.match(get('#results').innerHTML,/기존 리포트/);
 assert.match(get('#results').innerHTML,/검색 서비스를 켜면/);
 assert.doesNotMatch(get('#results').innerHTML,/class="mn media /);
 assert.equal(calls.length,0,'opening the map must never install/start a service');
 // File picker and upload handlers must agree, including a browser with no image MIME.
 const accept=html.match(/id="rag-input" accept="([^"]+)"/)[1];
 for(const ext of ['.pdf','.png','.jpg','.webp','.gif','.bmp','.tiff','.avif','.heic','.ico'])assert.ok(accept.includes(ext));
 evaluate('render=()=>{};ragStatus=async()=>{};ragWarn=async()=>true');
 context.files=[{name:'한글 사진.PNG',type:'',size:100},{name:'shot.HEIC',type:'image/heic',size:100},{name:'report.pdf',type:'application/pdf',size:100},{name:'bad.svg',type:'image/svg+xml',size:100},{name:'huge.png',type:'image/png',size:51*1048576}];
 await evaluate('ragAdd(files)');
 assert.equal(calls.length,3);
 assert.equal(calls[0].options.headers['Content-Type'],'application/octet-stream');
 assert.equal(calls[1].options.headers['Content-Type'],'image/heic');
 assert.ok(messages.some(m=>m.includes('bad.svg')));
 assert.ok(messages.some(m=>m.includes('50MB')));
 assert.equal(evaluate('rag.uploading'),false);
 evaluate('ragWarn=async()=>false');await evaluate('ragAdd([files[0]])');
 assert.equal(calls.length,3,'cancelled uploads must send nothing');
 console.log('PASS: image picker/upload, mixed files, limits/cancel, map nodes, source evidence, filters and offline fallback');
})().catch(error=>{console.error(error);process.exitCode=1});
