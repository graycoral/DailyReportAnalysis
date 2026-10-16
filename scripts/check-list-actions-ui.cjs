// Real report visibility persistence, with mock PDF metadata in an isolated profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-list-actions-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let viewer,browser;
const fileData=[['alpha','자율주행 시장 분석.pdf'],['beta','서비스 운영 현황과 경쟁사 비교를 정리한 아주 긴 이름의 참고 자료.pdf'],['gamma','안전성 검토.pdf']].map(([id,name])=>({id,name,added:'2026-10-16',size:123456,reports:[]}));
async function fits(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'viewport overflow')}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(build,'navigation-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const instanceFile=path.join(dir,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(instanceFile);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(instanceFile,'utf8'));browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/local',r=>r.fulfill({json:{available:true,files:fileData,mails:[],sources:[]}}));
 await page.route('**/api/rag/map',r=>r.fulfill({json:{ok:true,docs:[],links:[]}}));
 await page.goto(instance.address+'/open?key='+instance.key);await page.locator('#results [data-report]').first().waitFor();
 const original=await page.evaluate(()=>fetch('/api/state').then(r=>r.json()).then(s=>s.snapshot));
 const first=original.catalog.relations[0].report_id,second=original.catalog.reports.find(r=>r.id!==first&&r.title.replace(/\s/g,'')!=='주요신규업데이트없음').id;
 const hide=id=>page.locator(`[data-hide-report="${id}"]`).click();
 const hidden=()=>page.evaluate(()=>fetch('/api/status').then(r=>r.json()).then(s=>s.report_visibility.hidden_reports));
 await page.locator(`[data-report="${first}"]`).click();
 await page.route('**/api/report-visibility',r=>r.fulfill({status:500,body:'테스트 숨김 저장 실패'}));
 await hide(first);await page.getByText('테스트 숨김 저장 실패',{exact:true}).waitFor();
 assert.equal(await page.locator(`[data-report="${first}"]`).count(),1);assert.deepEqual(await hidden(),[]);
 await page.unroute('**/api/report-visibility');await hide(first);await page.locator(`[data-report="${first}"]`).waitFor({state:'detached'});
 await hide(second);await page.locator(`[data-report="${second}"]`).waitFor({state:'detached'});
 for(const view of ['timeline','graph','map']){
  await page.locator('#tab-'+view).click();
  const exists=await page.evaluate(ids=>{const c=catalog();return c.reports.some(r=>ids.includes(r.id))||c.events.some(e=>ids.includes(e.report_id))||c.relations.some(r=>ids.includes(r.report_id))||c.related.some(r=>ids.includes(r.from)||ids.includes(r.to))},[first,second]);
  assert.equal(exists,false,view+' must exclude hidden reports and evidence');
 }
 await page.locator('#tab-settings').click();
 assert.equal(await page.locator('[data-restore-report]').count(),2);
 await page.locator(`[data-restore-report="${first}"]`).check();
 assert.equal(await page.locator('#restore-select-all').evaluate(el=>el.indeterminate),true);
 await page.locator('#tab-search').click();await page.locator('#tab-settings').click();
 assert.equal(await page.locator(`[data-restore-report="${first}"]`).isChecked(),true,'selection survives tab changes');
 await page.route('**/api/report-visibility',r=>r.fulfill({status:500,body:'테스트 복원 저장 실패'}));
 await page.locator('#restore-selected').click();await page.getByText('테스트 복원 저장 실패',{exact:true}).waitFor();
 assert.equal(await page.locator(`[data-restore-report="${first}"]`).isChecked(),true);
 assert.equal((await hidden()).length,2);await page.unroute('**/api/report-visibility');
 await page.locator('#restore-selected').click();await page.locator(`[data-restore-report="${first}"]`).waitFor({state:'detached'});
 assert.deepEqual(await hidden(),[second]);
 await page.reload();await page.locator(`[data-restore-report="${second}"]`).waitFor();assert.equal(await page.locator('[data-restore-report]').count(),1);
 await page.locator('#tab-graph').click();
 assert.equal(await page.evaluate(id=>catalog().relations.some(r=>r.report_id===id),first),true,'restoring returns the original evidence');
 await page.locator('#tab-search').click();await hide(first);await page.locator(`[data-report="${first}"]`).waitFor({state:'detached'});
 await page.getByLabel('리포트 검색',{exact:true}).fill('kept-search');await page.locator('#tab-settings').click();
 await page.locator('#restore-select-all').check();assert.equal(await page.locator('[data-restore-report]:checked').count(),2);
 await page.locator(`[data-restore-report="${second}"]`).uncheck();assert.equal(await page.locator('#restore-select-all').evaluate(el=>el.indeterminate),true);
 await page.locator('#restore-section').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(build,'list-restore-settings.png'),fullPage:true});
 await page.locator('#restore-all-settings').click();await page.getByText('삭제한 리포트가 없습니다.',{exact:true}).waitFor();assert.deepEqual(await hidden(),[]);
 await page.locator('#tab-search').click();assert.equal(await page.getByLabel('리포트 검색',{exact:true}).inputValue(),'kept-search');
 await page.locator('#clear').click();assert.equal(await page.locator(`[data-report="${first}"]`).count(),1);
 assert.deepEqual(await page.evaluate(()=>fetch('/api/state').then(r=>r.json()).then(s=>s.snapshot)),original,'hide/restore never rewrites source reports');
 await page.screenshot({path:path.join(build,'list-report-delete.png'),fullPage:true});

 // Compact PDF rows expose sibling controls; long filenames fit a resized pane and mobile.
 await page.locator('#tab-local').click();assert.equal(await page.locator('.pdf-list-row').count(),3);
 assert.ok((await page.locator('.pdf-list-row').first().boundingBox()).height<85);
 assert.equal(await page.locator('.pdf-file button').count(),0,'row actions cannot be nested buttons');
 await page.locator('[data-local-links="alpha"]').click();await page.locator('#pdf-links-dialog').waitFor();
 assert.equal(await page.locator('#pdf-links-name').innerText(),fileData[0].name);await page.locator('#pdf-links-close').click();
 for(const theme of ['apple','apple-dark','classic']){
  await page.locator('#tab-settings').click();await page.locator('#theme').selectOption(theme);await page.locator('#tab-local').click();await fits(page);
  await page.screenshot({path:path.join(build,`list-pdf-${theme}.png`),fullPage:true});
 }
 await page.locator('#workspace-divider').press('Home');await fits(page);await page.locator('#workspace-divider').press('Enter');
 for(const width of [850,390]){await page.setViewportSize({width,height:900});await fits(page);await page.screenshot({path:path.join(build,`list-pdf-${width}.png`),fullPage:true});await page.locator('#tab-settings').click();await fits(page);await page.locator('#tab-local').click()}
 assert.deepEqual(errors,[]);console.log('PASS: compact PDF rows, sibling actions, report hiding across views, persisted selected/all restore, failed saves, original evidence, themes and responsive layout');
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),dir);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-list-actions-'))fs.rmSync(dir,{recursive:true,force:true});
});
