// Real encrypted local storage; RAG is mocked so no model or external service is required.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-selection-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let viewer,browser;
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true,github_choice_version:fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1]}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/selection-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const instanceFile=path.join(dir,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(instanceFile);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(instanceFile,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let ragDocs=[1,2].map(i=>({id:String(i).repeat(16),name:'image-'+i+'.png',pages:1,size:100,kind:'image'})),ragTrash=[];
 await page.route('**/api/rag/status',r=>r.fulfill({json:{ok:true,docs:ragDocs,trash:ragTrash,model:{}}}));
 await page.route('**/api/rag/environment',r=>r.fulfill({json:{state:'ready',ready:true,supported:true}}));
 await page.route('**/api/rag/map',r=>r.fulfill({json:{ok:true,docs:ragDocs,links:[]}}));
 for(const action of ['trash','restore','delete'])await page.route('**/api/rag/'+action,r=>{
  const id=r.request().postDataJSON().doc,d=[...ragDocs,...ragTrash].find(d=>d.id===id);
  ragDocs=ragDocs.filter(d=>d.id!==id);ragTrash=ragTrash.filter(d=>d.id!==id);
  if(action==='trash')ragTrash.push(d);if(action==='restore')ragDocs.push(d);return r.fulfill({json:{ok:true}});
 });
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.locator('#tab-search').click();
 const fixture=fs.readFileSync(path.join(root,'scripts/fixtures/offline-report.md'),'utf8');
 for(const date of ['2026-10-14','2026-10-15','2026-10-16']){
  await page.locator('#report-input').setInputFiles({name:date+'.md',mimeType:'text/markdown',buffer:Buffer.from(fixture.replaceAll('2026-10-15',date))});
  await page.locator(`[data-report="local-${date}"]`).waitFor();
 }
 const count=async n=>{await page.waitForFunction(n=>document.querySelector('#selection-count').textContent===`${n}개 선택`,n)};
 const rows=()=>page.locator('#results [data-report]');
 await rows().nth(0).click();await rows().nth(1).click({modifiers:['Control']});await count(2);
 await rows().nth(1).click({modifiers:['Control']});await count(1);await rows().nth(1).click({modifiers:['Control']});await count(2);
 // Delete in a search field must edit text instead of deleting selected files.
 await page.locator('#query').focus();await page.keyboard.press('Delete');assert.equal(await rows().count(),3);
 await rows().nth(0).focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>document.querySelectorAll('#results [data-report]').length===1);
 await page.locator('#selection-trash').click();await page.locator('#data-trash-list .trash-item').nth(1).waitFor();
 await page.locator('#data-trash-list .trash-item').nth(0).click();await page.locator('#data-trash-list .trash-item').nth(1).click({modifiers:['Control']});
 await page.locator('#data-trash-restore').click();await page.waitForFunction(()=>document.querySelectorAll('#data-trash-list .trash-item').length===0);await page.locator('#data-trash-close').click();
 assert.equal(await rows().count(),3);
 await page.locator('#tab-timeline').click();await rows().nth(0).click();await rows().nth(1).click({modifiers:['Control']});await count(2);
 await page.locator('#tab-search').click();await count(0);
 await rows().nth(0).click();const deletedID=await rows().nth(0).getAttribute('data-report');
 page.once('dialog',d=>d.dismiss());await page.keyboard.press('Shift+Delete');assert.equal(await rows().count(),3);
 page.once('dialog',d=>d.accept());await page.keyboard.press('Shift+Delete');await page.waitForFunction(()=>document.querySelectorAll('#results [data-report]').length===2);
 assert.equal(await page.evaluate(async id=>(await api('/api/local/reports')).reports.some(r=>r.id===id),deletedID),false);
 // Local PDF trash retains the blob and restores the same ID.
 const pdfs=await page.evaluate(async()=>{const out=[];for(let i=0;i<2;i++){const r=await fetch('/api/local/add?name=test-'+i+'.pdf',{method:'POST',headers:{'X-AV-Request':'1'},body:'%PDF-1.7\n%%EOF'});if(!r.ok)throw Error(await r.text());out.push(await r.json())}await loadLocal();return out});
 await page.locator('#tab-local').click();await page.locator('[data-local]').nth(0).click();await page.locator('[data-local]').nth(1).click({modifiers:['Control']});await count(2);
 await page.keyboard.press('Delete');await page.waitForFunction(()=>document.querySelectorAll('[data-local]').length===0);
 await page.locator('#selection-trash').click();await page.locator('#data-trash-list .trash-item').nth(1).waitFor();await page.locator('#data-trash-all').click();await page.locator('#data-trash-restore').click();
 await page.waitForFunction(()=>document.querySelectorAll('#data-trash-list .trash-item').length===0);await page.locator('#data-trash-close').click();assert.equal(await page.locator('[data-local]').count(),2);
 await page.locator('[data-local]').nth(0).click();page.once('dialog',d=>d.accept());await page.keyboard.press('Shift+Delete');await page.waitForFunction(()=>document.querySelectorAll('[data-local]').length===1);
 const survivor=await page.locator('[data-local]').getAttribute('data-local');const removed=pdfs.find(f=>f.id!==survivor);assert.equal(fs.existsSync(path.join(dir,'docs/pdf',removed.id+'.bin')),false);
 // Notes: both list and graph support Ctrl selection; editing keeps Delete local.
 await page.evaluate(async()=>{for(const n of ['selection A','selection B'])await api('/api/notes/save',{path:n+'.md',body:'abc'});});
 await page.locator('#tab-notes').click();await page.locator('[data-note-id]').nth(1).waitFor();
 await page.locator('[data-note-id]').nth(0).click();await page.locator('[data-note-id]').nth(1).click({modifiers:['Control']});await count(2);
 await page.locator('#note-title').focus();await page.keyboard.press('Delete');assert.equal(await page.locator('[data-note-id]').count(),2);
 await page.locator('[data-note-id]').nth(0).focus();await page.keyboard.press('Delete');await page.waitForFunction(()=>document.querySelectorAll('[data-note-id]').length===0);
 await page.locator('#selection-trash').click();await page.locator('#data-trash-list .trash-item').nth(1).waitFor();await page.locator('#data-trash-all').click();await page.locator('#data-trash-restore').click();await page.waitForFunction(()=>document.querySelectorAll('#data-trash-list .trash-item').length===0);await page.locator('#data-trash-close').click();
 await page.locator('#tab-graph').click();await page.locator('[data-network-node]').nth(1).waitFor();await page.locator('[data-network-node]').nth(0).click();await page.locator('[data-network-node]').nth(1).click({modifiers:['Control']});await count(2);
 await page.locator('#tab-map').click();await page.locator('.mn.note').nth(1).waitFor();await page.locator('.mn.note').nth(0).dispatchEvent('click');await page.locator('.mn.note').nth(1).dispatchEvent('click',{ctrlKey:true});await count(2);
 await page.locator('#tab-rag').click();await page.locator('[data-rag-open]').nth(1).waitFor();await page.locator('[data-rag-open]').nth(0).click();await page.locator('[data-rag-open]').nth(1).click({modifiers:['Control']});await count(2);await page.keyboard.press('Delete');await page.waitForFunction(()=>document.querySelectorAll('[data-rag-open]').length===0);assert.equal(ragTrash.length,2);
 await page.locator('#selection-trash').click();await page.locator('#data-trash-list .trash-item').nth(1).waitFor();await page.locator('#data-trash-all').click();page.once('dialog',d=>d.accept());await page.locator('#data-trash-delete').click();await page.waitForFunction(()=>document.querySelectorAll('#data-trash-list .trash-item').length===0);assert.equal(ragTrash.length,0);await page.locator('#data-trash-close').click();
 await page.evaluate(()=>{importedReports=importedReports.map(r=>({...r,origin:'outlook-report'}));mergedSource=null;setTab('outlook')});
 await rows().nth(0).click();await rows().nth(1).click({modifiers:['Control']});await count(2);
 // Filtered-out selection and tab changes cannot leave hidden deletion targets.
 await page.locator('#outlook-query').fill('no-match');await count(0);
 for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true)}
 assert.deepEqual(errors,[]);console.log('PASS: Ctrl selection across seven tabs, editing protection, Delete trash/restore, Shift+Delete cancel/confirm, encrypted blob removal, filtering and responsive layout');
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();if(viewer&&viewer.exitCode===null){const done=new Promise(r=>viewer.once('exit',r));viewer.kill();await done}
 const rel=path.relative(os.tmpdir(),dir);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&path.basename(dir).startsWith('avhub-selection-'))fs.rmSync(dir,{recursive:true,force:true});
});
