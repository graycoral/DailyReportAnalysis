// UI review regressions with isolated local fixtures; no Outlook or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/audit-ui'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-audit-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let viewer,browser,releaseSave,releaseTrash;
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',configured:true,offline:true,sync_time:'08:00',github_choice_version:version}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/audit-accessibility-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const file=path.join(profile,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[],external=[];page.setDefaultTimeout(12000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();external.push(r.request().url());return r.abort()});
 await require('./ui-catalog-fixture.cjs')(page);
 let files=Array.from({length:120},(_,i)=>({id:'pdf-'+i,name:'보관 자료 '+i+'.pdf',added:'2026-10-19',size:100,reports:[]}));
 const mails=Array.from({length:120},(_,i)=>({entry_id:'mail-'+i,store_id:'fixture',subject:'연결 메일 '+i,received:'2026-10-19',sender:'분석팀',folder:'동향',report:'fixture'}));
 const docs=Array.from({length:120},(_,i)=>({id:'rag-'+i,name:'색인 자료 '+i+'.pdf',kind:'pdf',pages:1,size:100}));
 await page.route('**/api/local',r=>r.fulfill({json:{available:true,files,mails,sources:[]}}));
 let trashReads=0;
 await page.route('**/api/local/trash',async r=>{
  if(r.request().method()==='POST'){files=files.filter(f=>f.id!==r.request().postDataJSON().id);return r.fulfill({json:{ok:true}})}
  if(++trashReads===1){await new Promise(resolve=>releaseTrash=resolve);return r.fulfill({json:{files:[{id:'stale',name:'오래된 응답.pdf'}],mails:[]}})}
  return r.fulfill({json:{files:[{id:'fresh-a',name:'최신 자료 A.pdf'},{id:'fresh-b',name:'최신 자료 B.pdf'}],mails:[]}});
 });
 await page.route('**/api/rag/environment',r=>r.fulfill({json:{state:'ready',ready:true,supported:true}}));
 await page.route('**/api/rag/status',r=>r.fulfill({json:{ok:true,docs,trash:[]}}));
 await page.route('**/api/rag/map',r=>r.fulfill({json:{ok:true,docs:[],links:[]}}));
 let failSave=true,saves=0;
 await page.route('**/api/install',async r=>{saves++;await new Promise(resolve=>releaseSave=resolve);return r.fulfill({json:failSave?{ok:false,error:'저장 실패 · 다시 시도하세요.'}:{ok:true,checks:['저장 완료'],config:{...r.request().postDataJSON(),offline:false}}})});
 await page.goto(instance.address+'/open?key='+encodeURIComponent(instance.key));await page.locator('#results .report-card').first().waitFor();
 // Settings remain a recoverable draft, and cannot change underneath an in-flight save.
 await page.locator('#tab-settings').click();const form=page.locator('#settings-slot form');
 assert.equal(await page.evaluate(()=>hasPendingSettings()),false);
 await form.locator('[name=owner]').fill('audit-draft');await form.locator('[name=token]').fill('synthetic-placeholder');
 assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}),true);
 await form.locator('.save-settings').click();await page.waitForFunction(()=>formBusy);
 assert.equal(await form.locator('input:not(:disabled),select:not(:disabled)').count(),0);
 for(let i=0;i<100&&!releaseSave;i++)await wait(10);releaseSave();await page.waitForFunction(()=>!formBusy);
 assert.equal(await form.locator('[name=token]').inputValue(),'synthetic-placeholder');
 assert.equal(await page.evaluate(()=>document.activeElement.matches('.checks.error')),true);
 failSave=false;releaseSave=null;await form.locator('.save-settings').click();for(let i=0;i<100&&!releaseSave;i++)await wait(10);releaseSave();await page.waitForFunction(()=>!formBusy);
 assert.equal(saves,2);assert.equal(await form.locator('[name=token]').inputValue(),'');assert.equal(await page.evaluate(()=>hasPendingSettings()),false);
 // Multiple items can be selected with touch/click or keyboard, without modifier keys.
 await page.locator('#tab-search').click();await page.locator('#selection-mode').click();const cards=page.locator('#results .report-card');
 await cards.nth(0).focus();await page.keyboard.press('Space');await cards.nth(1).focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#selection-count').innerText(),'2개 선택');
 await page.setViewportSize({width:375,height:800});await cards.nth(2).click();assert.equal(await page.locator('#selection-count').innerText(),'3개 선택');
 assert.equal(await page.locator('#detail').isVisible(),false,'selection mode does not unexpectedly open the mobile reader');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:path.join(out,'selection-mobile.png')});await page.setViewportSize({width:1280,height:900});
 // The auxiliary libraries render 50 rows, preserve totals and focus the first new row.
 for(const [tab,key,selector] of [['local','pdf','[data-local]'],['outlook','mail','[data-mail-open]'],['rag','rag','[data-rag-open]']]){
  await page.locator('#tab-'+tab).click();await page.locator('#results '+selector).first().waitFor();
  assert.equal(await page.locator('#results '+selector).count(),50);
  await page.locator('[data-more-rows='+key+']').click();assert.equal(await page.locator('#results '+selector).count(),100);
  assert.equal(await page.locator('#results '+selector).nth(50).evaluate(el=>el===document.activeElement),true);
 }
 await page.locator('#tab-local').click();await page.locator('#local-query').fill('자료 1');await page.waitForFunction(()=>document.querySelectorAll('[data-local]').length===39);
 await page.locator('#local-clear').click();assert.equal(await page.locator('[data-local]').count(),50);
 await page.locator('[data-more-rows=pdf]').click();await page.locator('#local-query').fill('검색결과없음');await page.waitForFunction(()=>document.querySelectorAll('[data-local]').length===0);
 await page.locator('#local-clear').click();assert.equal(await page.locator('[data-local]').count(),50,'empty searches also reset the page limit');
 // A deleted focused item must leave focus on a surviving list control.
 await page.locator('[data-local]').first().focus();await page.keyboard.press('Control+Space');await page.keyboard.press('Delete');
 await page.waitForFunction(()=>document.querySelector('[data-local]')?.dataset.local==='pdf-1');
 await page.waitForFunction(()=>document.activeElement.matches('[data-local]'));
 // Close/reopen while a request is delayed: only the latest response may populate the dialog.
 await page.locator('#selection-trash').click();for(let i=0;i<100&&!releaseTrash;i++)await wait(10);
 await page.locator('#data-trash-close').click();await page.locator('#selection-trash').click();await page.getByRole('button',{name:'최신 자료 A.pdf PDF',exact:true}).waitFor();
 releaseTrash();await wait(100);assert.equal(await page.locator('#data-trash-list').getByText('오래된 응답.pdf').count(),0);
 const trash=page.locator('[data-trash-key]');await trash.nth(0).press('Space');await trash.nth(1).press('Space');assert.equal(await page.locator('#data-trash-count').innerText(),'2개 선택');
 await page.locator('#data-trash-close').click();
 await page.evaluate(()=>document.querySelector('#rag-warning').showModal());assert.ok(await page.getByRole('dialog',{name:'PDF·이미지를 AI 검색에 올리기 전에'}).isVisible());await page.keyboard.press('Escape');
 // A later toast gets its full display time, even when an earlier timer expires.
 await page.evaluate(()=>toast('첫 안내'));await wait(3000);await page.evaluate(()=>toast('두 번째 안내'));await wait(2300);assert.ok(await page.getByRole('status').filter({hasText:'두 번째 안내'}).isVisible());
 await page.goto(instance.address+'/#'+String.fromCharCode(92));await page.reload();await page.locator('#results .report-card').first().waitFor();
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('PASS: settings draft/save/failure guards, modifier-free selection, bounded PDF/mail/RAG lists, delete focus, stale trash response, modal name, toast lifetime and malformed hash');
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{releaseSave?.();releaseTrash?.();await browser?.close();viewer?.kill()});
