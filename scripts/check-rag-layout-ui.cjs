// Exercise the AI search UI with local fixtures; never install or run an AI model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/rag-layout-ui');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-rag-layout-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let browser,viewer,releaseUpload;
const evidence={layouts:[],errors:[]},posts=[];
let environment={state:'ready',ready:true,supported:true,message:'패키지와 모델 검증 완료'},running=true,uploads=0;
let docs=[
 {id:'pdf-1',name:'자율주행 산업 동향.pdf',kind:'pdf',pages:12,size:1240000,seconds:8.2},
 {id:'image-1',name:'운행 구역.png',kind:'image',pages:1,size:326000,seconds:1.5},
 {id:'pdf-2',name:'안전요원 없는 무인 운행 허가와 지역별 운영 조건 비교.pdf',kind:'pdf',pages:8,size:850000,seconds:4.7}
];
async function signal(page,state){await page.waitForFunction(s=>document.querySelector('.rag-environment')?.dataset.state===s,state);}
async function poll(page){await page.evaluate(()=>pollRagEnvironment());}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',configured:true,offline:true,sync_time:'08:00',github_choice_version:version}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/rag-layout-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const file=path.join(profile,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await context.route('**/api/rag/**',async route=>{
  const url=new URL(route.request().url()),endpoint=url.pathname.split('/').pop();
  if(route.request().method()==='POST')posts.push(endpoint);
  if(endpoint==='environment')return route.fulfill({json:environment});
  if(endpoint==='status')return route.fulfill({json:running?{ok:true,docs,model:{model:'Local fixture model',device:'cpu',parameters:1000,dimensions:768,load_seconds:2},index_dir:'C:\\LocalData\\rag\\index'}:{ok:false}});
  if(endpoint==='map')return route.fulfill({json:{ok:false,docs:[],links:[]}});
  if(endpoint==='start'){environment={...environment,state:'starting',busy:true};return route.fulfill({json:{ok:true}});}
  if(endpoint==='setup'){environment={state:'installing',busy:true,supported:true,message:'패키지 설치 중'};return route.fulfill({json:{ok:true}});}
  if(endpoint==='query')return route.fulfill({json:{hits:[{...docs[2],doc:docs[2].id,page:2,similarity:.88,thumb:'/api/rag/page?doc=pdf-2&page=2'}]}});
  if(endpoint==='highlights')return route.fulfill({json:{ok:true,rects:[],matches:0,reason:'no_match'}});
  if(endpoint==='page')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="780"><rect width="600" height="780" fill="white"/><text x="40" y="70" font-size="24">Local preview fixture</text></svg>'});
  if(endpoint==='index'){
   uploads++;await new Promise(resolve=>{releaseUpload=resolve});
   docs.push({id:'upload-1',name:url.searchParams.get('name'),kind:'pdf',pages:1,size:100,seconds:1});
   return route.fulfill({json:{created:true,pages:1}});
  }
  if(endpoint==='delete'||endpoint==='trash'){const id=route.request().postDataJSON().doc;docs=docs.filter(d=>d.id!==id);return route.fulfill({json:{ok:true}});}
  if(endpoint==='demo')return route.fulfill({json:{model:{parameters:1000,dimensions:768,load_seconds:2}}});
  throw Error('Unexpected RAG API: '+endpoint);
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>evidence.errors.push(error.message));
 await page.goto(instance.address+'/open?key='+encodeURIComponent(instance.key));
 await page.waitForFunction(()=>typeof state!=='undefined'&&state&&!state.setup);
 if(await page.locator('#github-choice-dialog').isVisible())await page.locator('#github-choice-later').click();
 await page.locator('#tab-rag').click();await signal(page,'ready');await page.locator('#rag-library-title').waitFor();
 assert.equal(await page.locator('#rag-environment-info').isVisible(),false);
 assert.equal(await page.locator('#rag-demo').isVisible(),false);
 assert.equal(await page.locator('[data-rag-open]').count(),3);
 for(const theme of ['apple','apple-dark','classic']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const width of [1280,768,414,375,320]){
   await page.setViewportSize({width,height:800});await page.locator('#results-pane').evaluate(el=>el.scrollTop=0);
   const metrics=await page.evaluate(()=>{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect();
    const pane=document.querySelector('#results-pane'),heading=document.querySelector('#rag-library-title');
    return {width:innerWidth,rootWidth:document.documentElement.scrollWidth,paneWidth:pane.clientWidth,paneScrollWidth:pane.scrollWidth,firstDocumentBottom:rect('.rag-document').bottom,uploadHeight:rect('#rag-add').height,environmentHeight:rect('.rag-environment').height,titleSize:parseFloat(getComputedStyle(heading).fontSize),statusSize:parseFloat(getComputedStyle(document.querySelector('.rag-environment-status')).fontSize)};
   });
   assert.ok(metrics.rootWidth<=width+1,theme+' root fits '+width);
   assert.ok(metrics.paneScrollWidth<=metrics.paneWidth+1,theme+' pane fits '+width);
   assert.ok(metrics.firstDocumentBottom<800,'indexed files appear in the first viewport');
   assert.ok(metrics.uploadHeight<=44,'upload stays compact');
   assert.ok(metrics.titleSize>metrics.statusSize,'indexed library has visual priority');
   if(width===1280)assert.ok(metrics.environmentHeight<70,'ready environment is a compact row');
   evidence.layouts.push({theme,...metrics});
   if(width===1280||width===320)await page.screenshot({path:path.join(out,theme+'-'+width+'.png'),fullPage:true});
  }
 }
 await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>document.documentElement.dataset.theme='apple');
 await page.locator('#rag-environment-toggle').click();
 await page.locator('#rag-query input').fill('입력 중인 검색어');await poll(page);
 assert.equal(await page.locator('#rag-query input').inputValue(),'입력 중인 검색어');
 assert.equal(await page.locator('#rag-environment-toggle').getAttribute('aria-expanded'),'true');
 await page.locator('#rag-environment-toggle').click();
 assert.equal(await page.evaluate(()=>document.activeElement.id),'rag-environment-toggle','toggle retains keyboard focus');
 await page.locator('[data-rag-open="pdf-1"]').click();
 assert.match(await page.locator('#detail').innerText(),/자율주행 산업 동향.pdf/);
 await page.locator('#rag-next').click();assert.match(await page.locator('#detail').innerText(),/2 \/ 12/);
 await page.locator('#rag-query button').click();await page.locator('[data-rag-hit]').waitFor();
 await page.locator('[data-rag-hit]').click();assert.match(await page.locator('#detail').innerText(),/유사도 0.8800/);
 for(const width of [768,414,375,320]){
  await page.setViewportSize({width,height:800});
  assert.ok(await page.locator('#results-pane').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'long search results fit '+width);
 }
 await page.setViewportSize({width:1280,height:800});
 await page.locator('#rag-tools summary').click();await page.locator('#rag-demo').click();await page.locator('.rag-demo').waitFor();
 assert.equal(await page.locator('#rag-tools').getAttribute('open'),'');
 // A real keyboard file-picker action still requires consent; cancellation sends nothing.
 await page.locator('#rag-add').focus();
 const chooserPromise=page.waitForEvent('filechooser');await page.keyboard.press('Enter');const chooser=await chooserPromise;
 await chooser.setFiles({name:'추가 자료.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 fixture')});
 await page.locator('#rag-warning-cancel').click();assert.equal(uploads,0);
 await page.waitForFunction(()=>!rag.uploading);
 // Drag/drop shares the same consent and upload path, with visible progress and disabled actions.
 await page.locator('#rag-drop').evaluate(el=>{
  const transfer=new DataTransfer();transfer.items.add(new File(['%PDF-1.4 fixture'],'추가 자료.pdf',{type:'application/pdf'}));
  el.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  if(!el.classList.contains('over'))throw Error('drop target is not highlighted');
  el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
 });
 await page.locator('#rag-warning-ok').click();await page.waitForFunction(()=>document.querySelector('#rag-add').disabled);
 for(let i=0;i<100&&!releaseUpload;i++)await wait(20);
 assert.equal(uploads,1);assert.ok(await page.locator('#rag-job-progress').isVisible());
 assert.ok(await page.locator('[data-rag-del]').first().isDisabled());releaseUpload();
 await page.waitForFunction(()=>document.querySelectorAll('[data-rag-open]').length===4&&!document.querySelector('#rag-add').disabled);
 if(!await page.evaluate(()=>!!window.AVSelection))page.once('dialog',dialog=>dialog.accept());
 await page.locator('[data-rag-del="upload-1"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-rag-open]').length===3);
 // Stop/start, install and error are represented separately, without real model requests.
 running=false;await poll(page);await signal(page,'ready');
 assert.ok(await page.locator('#rag-start').isVisible());assert.match(await page.locator('.rag-environment-status').innerText(),/서비스 꺼짐/);
 await page.locator('#rag-start').click();await signal(page,'checking');assert.ok(await page.locator('#rag-start').isDisabled());
 environment={state:'error',ready:true,supported:true,message:'서비스를 시작하지 못했습니다.'};await poll(page);await signal(page,'error');
 assert.ok(await page.locator('#rag-environment-info').isVisible());
 await page.screenshot({path:path.join(out,'start-error.png')});
 environment={state:'missing',ready:false,supported:true,message:'환경 설정이 필요합니다.'};await poll(page);await signal(page,'idle');
 await page.locator('#rag-setup').click();await signal(page,'checking');assert.ok(await page.locator('#rag-setup').isDisabled());
 await page.screenshot({path:path.join(out,'installing.png')});
 environment={state:'ready',ready:true,supported:true};running=true;docs=[];await poll(page);await signal(page,'ready');
 await page.locator('.rag-library-empty').waitFor();assert.ok(await page.locator('#rag-add').isEnabled());
 await page.screenshot({path:path.join(out,'empty.png')});
 assert.equal(posts.filter(p=>p==='start').length,1);assert.equal(posts.filter(p=>p==='setup').length,1);
 assert.deepEqual(evidence.errors,[]);
 console.log('PASS: indexed-library hierarchy in three themes/five widths; environment signals, polling/focus, search/preview, model details, picker/cancel/drop/upload/delete and empty state');
 console.log('Evidence: '+out);
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[^\s]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(releaseUpload)releaseUpload();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(evidence,null,2));
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done;}
 const relative=path.relative(os.tmpdir(),profile);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(profile).startsWith('avhub-rag-layout-'))fs.rmSync(profile,{recursive:true,force:true});
});
