// Real reading preferences and imports, isolated from the user's profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/report-unread-ui');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-report-unread-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
async function launch(){
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/color-unread-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const file=path.join(profile,'instance-viewer.json');
 for(let i=0;i<200;i++){if(fs.existsSync(file)){try{const v=JSON.parse(fs.readFileSync(file,'utf8'));if(await fetch(v.address+'/api/ping',{headers:{Cookie:'av_session='+v.key}}).then(r=>r.ok).catch(()=>false))return v}catch{}}await wait(100)}
 throw Error('Viewer did not start');
}
async function stop(){if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true,github_choice_version:version}));
 const instance=await launch();browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await require('./ui-catalog-fixture.cjs')(page);
 await page.goto(instance.address+'/open?key='+instance.key+'#theme=apple');
 await page.waitForFunction(()=>typeof reportReading!=='undefined'&&reportReading.ready);
 const badge=page.locator('#report-unread-count');
 assert.equal(await badge.isVisible(),false,'existing archive is the baseline, not all new');
 assert.equal(await page.locator('#results .report-card').count(),JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8')).reports.length);
 const fixture=fs.readFileSync(path.join(root,'scripts/fixtures/offline-report.md'),'utf8');
 const ids=[];
 for(const day of ['2026-10-19','2026-10-20']){
  ids.push(await page.evaluate(async ({body,day})=>{const r=await fetch('/api/local/reports/import?name='+day+'.md',{method:'POST',headers:{'X-AV-Request':'1'},body});if(!r.ok)throw Error(await r.text());return (await r.json()).id},{body:fixture.replaceAll('2026-10-15',day),day}));
 }
 await page.evaluate(async()=>{await refresh(true);await refreshReportReading()});
 assert.equal(await badge.innerText(),'2');
 assert.match(await page.locator('#report-unread-status').innerText(),/새 문서 2개/);
 assert.equal(await page.locator('.report-new').count(),2);
 await page.locator('#query').fill('not-a-matching-report');
 assert.equal(await badge.innerText(),'2','badge is global, independent of search filters');
 await page.locator('#clear').click();
 await page.locator('#tab-notes').click();assert.equal(await badge.innerText(),'2');
 await page.locator('#tab-search').click();
 assert.equal(await badge.innerText(),'2','automatic selection must not mark a report read');
 // Failed persistence must never pretend a report was successfully read.
 await page.route('**/api/report-reading',async route=>{
  if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='read')return route.fulfill({status:500,body:'읽음 저장 실패 테스트'});
  return route.continue();
 });
 await page.locator(`[data-report="${ids[0]}"]`).click();
 await page.waitForFunction(()=>reportReading.error.includes('실패'));
 assert.equal(await badge.innerText(),'!');
 await page.unroute('**/api/report-reading');await page.evaluate(()=>refreshReportReading());
 assert.equal(await badge.innerText(),'2');
 // Hiding unread reports removes them from the count; restoration brings them back.
 await page.evaluate(id=>changeReportVisibility('hide',id),ids[1]);
 await page.waitForFunction(()=>document.querySelector('#report-unread-count').textContent==='1');
 await page.evaluate(id=>changeReportVisibility('restore',[id]),ids[1]);
 await page.waitForFunction(()=>document.querySelector('#report-unread-count').textContent==='2');
 for(const theme of ['apple','apple-dark','classic']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme);
  await page.mouse.move(1400,90);await page.screenshot({path:path.join(out,theme+'.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='apple');
 await page.locator(`[data-report="${ids[0]}"]`).focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#report-unread-count').textContent==='1');
 assert.equal(await page.locator(`[data-report="${ids[0]}"]`).evaluate(el=>el===document.activeElement),true);
 // A new window with no browser storage sees the same durable reading state.
 const other=await browser.newContext({viewport:{width:1280,height:900}}),otherPage=await other.newPage();
 await require('./ui-catalog-fixture.cjs')(otherPage);await otherPage.goto(instance.address+'/open?key='+instance.key);
 await otherPage.waitForFunction(()=>typeof reportReading!=='undefined'&&reportReading.ready);
 assert.equal(await otherPage.locator('#report-unread-count').innerText(),'1');
 await other.close();
 // Same-content duplicates across the feed and imports do not create extra notifications.
 await page.evaluate(async id=>{const report=importedReports.find(r=>r.id===id);state.snapshot.catalog={...state.snapshot.catalog,reports:[...state.snapshot.catalog.reports,{...report,id:'published-duplicate',origin:undefined}]};updateCatalogView();await refreshReportReading()},ids[0]);
 assert.equal(await badge.innerText(),'1');
 for(const width of [850,390]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const b=await badge.boundingBox(),nav=await page.locator('#tab-search').boundingBox();
  assert.ok(b.x>=nav.x&&b.x+b.width<=nav.x+nav.width+1,'badge stays inside the existing rail');
  await page.screenshot({path:path.join(out,`width-${width}.png`)});
 }
 await context.close();await stop();
 const restarted=await launch();
 const fresh=await browser.newContext(),reopened=await fresh.newPage();
 await require('./ui-catalog-fixture.cjs')(reopened);await reopened.goto(restarted.address+'/open?key='+restarted.key);
 await reopened.waitForFunction(()=>typeof reportReading!=='undefined'&&reportReading.ready);
 assert.equal(await reopened.locator('#report-unread-count').innerText(),'1','new process and port retain unread state');
 await reopened.locator(`[data-report="${ids[1]}"]`).click();
 await reopened.locator('#report-unread-count').waitFor({state:'hidden'});
 await reopened.reload();await reopened.waitForFunction(()=>typeof reportReading!=='undefined'&&reportReading.ready);
 assert.equal(await reopened.locator('#report-unread-count').isVisible(),false,'zero count has no badge');
 assert.deepEqual(errors,[]);
 console.log('PASS: baseline, new imports, global count, explicit reads, failed writes, hide/restore, deduplication, cross-window/restart persistence, three themes and mobile badge');
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();await stop();
 const relative=path.relative(os.tmpdir(),profile);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(profile).startsWith('avhub-report-unread-'))fs.rmSync(profile,{recursive:true,force:true});
});
