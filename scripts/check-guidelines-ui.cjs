// UI audit regressions in an isolated offline profile. RAG/connection fixtures never call a model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/guidelines-ui');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-guidelines-')),wait=ms=>new Promise(r=>setTimeout(r,ms));
let viewer,browser,releaseSave,releaseDelete;
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',configured:true,offline:true,sync_time:'08:00',github_choice_version:version}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/guidelines-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const instanceFile=path.join(profile,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(instanceFile);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(instanceFile,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:'reduce'}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort()});
 await require('./ui-catalog-fixture.cjs')(page);
 let aliases=[],deletes=0,docs=[{id:'audit-pdf',name:'삭제 확인 자료.pdf',kind:'pdf',pages:2,size:100}];
 await page.route('**/api/local/connections',async route=>{
  if(route.request().method()==='POST'){aliases=route.request().postDataJSON().aliases;await new Promise(r=>releaseSave=r);return route.fulfill({json:{ok:true}})}
  return route.fulfill({json:{documents:[],connections:[],aliases}});
 });
 await page.route('**/api/rag/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname.split('/').pop();
  if(endpoint==='environment')return route.fulfill({json:{state:'ready',ready:true,supported:true}});
  if(endpoint==='status')return route.fulfill({json:{ok:true,docs}});
  if(endpoint==='map')return route.fulfill({json:{ok:false,docs:[],links:[]}});
  if(endpoint==='page')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="780"><rect width="600" height="780" fill="white"/></svg>'});
  if(endpoint==='delete'){deletes++;await new Promise(r=>releaseDelete=r);docs=[];return route.fulfill({json:{ok:true}})}
  throw Error('Unexpected RAG request: '+endpoint);
 });
 await page.goto(instance.address+'/open?key='+encodeURIComponent(instance.key));
 const cards=page.locator('#results .report-card');await cards.first().waitFor();
 await page.locator('.skip-link').focus();await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'view-panel','skip link focuses main content');
 assert.equal(await page.locator('#result-count').getAttribute('role'),'status');
 for(const tab of ['search','timeline']){
  await page.locator('#tab-'+tab).click();
  assert.equal(await page.locator('#results button button, #results button [role="button"], #results button a, #results button input').count(),0,'no nested interactive controls in '+tab);
  const filter=page.locator('#results button[data-company]').first();const company=await filter.getAttribute('data-company');
  await filter.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#company').inputValue(),company);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.company),company,'filter focus survives render');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-pressed')),'true');
  await page.keyboard.press('Space');assert.equal(await page.locator('#company').inputValue(),'','native keyboard toggle fires once');
 }
 await page.locator('#tab-search').click();await page.locator('#filter-toggle').click();
 await page.locator('#from').fill('2026-10-10');await page.locator('#to').fill('2026-10-01');
 assert.ok(await page.locator('#date-filter-error').isVisible());assert.equal(await page.locator('#to').getAttribute('aria-invalid'),'true');
 await page.locator('#to').fill('2026-10-11');assert.equal(await page.locator('#to').getAttribute('aria-invalid'),'false');
 await page.locator('#reset').click();await page.locator('#filter-toggle').click();
 for(const width of [1280,320]){
  await page.setViewportSize({width,height:800});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'layout fits '+width);
  await page.screenshot({path:path.join(out,'reports-'+width+'.png'),fullPage:true});
 }
 await page.setViewportSize({width:1280,height:800});
 // Closing, Escape, report navigation and unload cannot silently discard a dictionary draft.
 await page.locator('#connections-open').click();await page.waitForFunction(()=>documentConnections.loaded&&!documentConnections.busy);
 await page.locator('#connection-dictionary summary').click();await page.locator('#connection-add-alias').click();
 await page.locator('[data-alias-name]').last().fill('보호할 사전');
 for(const action of [()=>page.locator('#connections-close').click(),()=>page.keyboard.press('Escape')]){
  page.once('dialog',d=>d.dismiss());await action();assert.ok(await page.locator('#connections-dialog').isVisible());
  assert.equal(await page.locator('[data-alias-name]').last().inputValue(),'보호할 사전');
 }
 await page.evaluate(()=>{
  documentConnections.documents=[{id:'draft-navigation',kind:'report',source:'daily',report_id:state.snapshot.catalog.reports[0].id,title:'리포트 열기'}];
  const root=document.querySelector('#connections-list');root.innerHTML=connectionDocButton(documentConnections.documents[0]);bindConnectionDocuments(root);
 });
 page.once('dialog',d=>d.dismiss());await page.locator('[data-connection-open]').click();assert.ok(await page.locator('#connections-dialog').isVisible());
 assert.equal(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}),true);
 await page.locator('#connections-save-dictionary').click();await page.waitForFunction(()=>connectionSaving);
 await page.locator('#connections-close').click();assert.ok(await page.locator('#connections-dialog').isVisible(),'save in progress stays open');
 for(let i=0;i<100&&!releaseSave;i++)await wait(10);releaseSave();await page.waitForFunction(()=>!connectionSaving);
 await page.locator('#connections-close').click();assert.equal(await page.locator('#connections-dialog').isVisible(),false);
 await page.locator('#connections-open').click();await page.waitForFunction(()=>!documentConnections.busy);
 assert.equal(await page.locator('[data-alias-name]').last().inputValue(),'보호할 사전');
 await page.locator('[data-alias-name]').last().fill('버릴 사전');page.once('dialog',d=>d.accept());await page.keyboard.press('Escape');
 assert.equal(await page.locator('#connections-dialog').isVisible(),false);
 // Delete confirmation has both a cancellation path and protection against duplicate requests.
 await page.locator('#tab-rag').click();const del=page.locator('[data-rag-del]');await del.waitFor();
 const selection=await page.evaluate(()=>!!window.AVSelection);
 if(selection)await page.locator('[data-rag-open]').click();
 const remove=()=>selection?page.keyboard.press('Shift+Delete'):del.click();
 page.once('dialog',d=>d.dismiss());await remove();assert.equal(deletes,0);assert.equal(await del.count(),1);
 page.once('dialog',d=>d.accept());await remove();
 const pending=selection?page.locator('#selection-delete'):del;
 await page.waitForFunction(selection=>document.querySelector(selection?'#selection-delete':'[data-rag-del]').disabled,selection);
 await page.evaluate(()=>render());assert.ok(await pending.isDisabled(),'delete stays guarded across status renders');
 for(let i=0;i<100&&!releaseDelete;i++)await wait(10);assert.equal(deletes,1);releaseDelete();await del.waitFor({state:'detached'});
 // Large report libraries stay bounded; IME composition does not render partial text.
 await page.locator('#tab-search').click();
 const renderMS=await page.evaluate(()=>{
  window.auditCatalog=state.snapshot.catalog;const seed=state.snapshot.catalog.reports[0];
  state.snapshot.catalog={...state.snapshot.catalog,reports:Array.from({length:210},(_,i)=>({...seed,id:'audit-'+i,title:'대량 검색 '+i,body_markdown:seed.body_markdown+'\n서로 다른 본문 '+i,summary:'검색 성능 검증 '+i})),events:[],relations:[]};
  mergedSource=null;const start=performance.now();render();return performance.now()-start;
 });
 assert.equal(await cards.count(),50);assert.match(await page.locator('#result-count').innerText(),/210개/);
 await page.locator('#reports-more').click();assert.equal(await cards.count(),100);
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.listIndex),'50','more focuses the first new report');
 await page.evaluate(()=>{
  window.auditRenders=0;window.auditRender=render;render=function(){window.auditRenders++;return window.auditRender()};
  const input=document.querySelector('#query');input.dispatchEvent(new CompositionEvent('compositionstart'));input.value='대';input.dispatchEvent(new InputEvent('input',{isComposing:true,bubbles:true}));
 });
 await wait(200);assert.equal(await page.evaluate(()=>window.auditRenders),0);
 await page.evaluate(()=>{const input=document.querySelector('#query');input.value='대량';input.dispatchEvent(new CompositionEvent('compositionend'))});
 await page.waitForFunction(()=>window.auditRenders===1);assert.equal(await cards.count(),50,'new search resets pagination');
 await page.locator('#query').fill('없음');await page.locator('#clear').click();await wait(200);
 assert.equal(await cards.count(),50,'clear cancels queued search');assert.equal(await page.locator('#query').inputValue(),'');
 await page.evaluate(()=>{render=window.auditRender;state.snapshot.catalog=window.auditCatalog;mergedSource=null;render()});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify({reports:210,initialCards:50,renderMS,errors,external},null,2));
 console.log('PASS: skip link, live count, native chips/focus, date errors, responsive layout, dirty/save guards, confirmed deletion, bounded rendering, IME and search cancellation');
 console.log('Evidence: '+out);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{releaseSave?.();releaseDelete?.();await browser?.close();viewer?.kill()});
