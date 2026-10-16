// Build build/navigation-viewer.exe, then run with Playwright and Microsoft Edge.
// Uses an isolated offline profile; no user's files, Outlook or model service are accessed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-navigation-ui-'));
const fixture=fs.readFileSync(path.join(root,'internal/hub/report_import_test.go'),'utf8').match(/const importFixture = `([\s\S]*?)`/)[1];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
async function noOverflow(page){
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'page should fit the viewport');
}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(build,'navigation-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/local',r=>r.fulfill({json:{available:true,files:['alpha','beta'].map(id=>({id,name:id+'.pdf',added:'2026-10-15',size:100,reports:[]})),mails:[],sources:[]}}));
 await page.route('**/api/rag/environment',r=>r.fulfill({json:{state:'ready',supported:true,ready:true,message:'테스트 환경'}}));
 await page.route('**/api/rag/status',r=>r.fulfill({json:{ok:true,docs:[],model:{}}}));
 await page.route('**/api/rag/map',r=>r.fulfill({json:{ok:true,docs:[],links:[]}}));
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.locator('#results [data-report]').first().waitFor();
 assert.equal(await page.getByRole('tab').count(),8);
 assert.equal(await page.getByRole('tablist').getAttribute('aria-orientation'),'vertical');
 assert.equal(await page.locator('#filter-panel').isVisible(),false);
 await noOverflow(page);
 await page.screenshot({path:path.join(build,'navigation-search.png'),fullPage:true});

 // Resize the real workspace without replacing report content or losing the user's ratio.
 const divider=page.getByRole('separator',{name:'목록과 본문 너비 조절'});
 const width=async()=>Math.round((await page.locator('#results-pane').boundingBox()).width);
 const startWidth=await width();
 assert.equal(await page.locator('#view-title').innerText(),'데일리리포트');
 await page.locator('#detail').evaluate(el=>{el.dataset.resizeIdentity='keep'});
 let handle=await divider.boundingBox();
 await page.mouse.move(handle.x+handle.width/2,handle.y+100);await page.mouse.down();
 await page.mouse.move(handle.x-190,handle.y+100,{steps:8});await page.mouse.up();
 const narrower=await width();assert.ok(narrower<startWidth-150);
 assert.equal(await page.locator('#detail').getAttribute('data-resize-identity'),'keep');
 assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('workspace-resizing')),false);
 const cookie=(await page.context().cookies('http://127.0.0.1:1/')).find(c=>c.name==='avhub_workspace_split');
 assert.ok(cookie&&cookie.expires>Date.now()/1000+86400,'ratio survives server port changes and browser restarts');
 await page.reload();await divider.waitFor();
 assert.ok(Math.abs(await width()-narrower)<=1,'saved ratio restored');
 await divider.press('ArrowRight');assert.ok(Math.abs(await width()-narrower-20)<=1);
 await divider.press('Home');assert.equal(await width(),280);await noOverflow(page);
 await divider.press('End');assert.ok(Math.abs((await page.locator('#detail').boundingBox()).width-320)<=1);await noOverflow(page);
 await divider.press('Enter');assert.ok(Math.abs(await width()-startWidth)<=1);
 handle=await divider.boundingBox();
 await page.mouse.move(handle.x+5,handle.y+100);await page.mouse.down();await page.mouse.move(handle.x-130,handle.y+100);
 await page.keyboard.press('Escape');await page.mouse.up();assert.ok(Math.abs(await width()-startWidth)<=1,'Escape cancels dragging');
 await divider.press('ArrowLeft');await divider.dblclick();assert.ok(Math.abs(await width()-startWidth)<=1,'double click restores default');
 await divider.press('Home');await page.setViewportSize({width:900,height:900});await noOverflow(page);
 await page.setViewportSize({width:390,height:900});assert.equal(await divider.isVisible(),false);await noOverflow(page);
 await page.setViewportSize({width:1440,height:1000});await divider.waitFor();await divider.press('Enter');
 await page.screenshot({path:path.join(build,'navigation-resizable.png'),fullPage:true});

 // Import through the retained action, then keep conditions across all report views.
 const imported=page.waitForResponse(r=>r.url().includes('/api/local/reports/import?'));
 await page.locator('#report-input').setInputFiles({name:'navigation.md',mimeType:'text/markdown',buffer:Buffer.from(fixture)});
 const response=await imported;assert.equal(response.status(),200,await response.text());
 await page.locator('#results [data-report="local-2026-10-15"]').waitFor();
 await page.getByLabel('리포트 검색',{exact:true}).fill('Uber');
 await page.locator('#filter-toggle').click();
 await page.locator('#company').selectOption('Uber');
 await page.locator('#from').fill('2026-10-15');await page.locator('#to').fill('2026-10-15');
 await page.screenshot({path:path.join(build,'navigation-filters.png'),fullPage:true});
 await page.locator('#filter-toggle').click();
 assert.match(await page.locator('#active-filters').innerText(),/기업: Uber/);
 assert.match(await page.locator('#active-filters').innerText(),/시작일: 2026-10-15/);
 for(const name of ['타임라인','관계 그래프','전체 지도','데일리리포트']){
  await page.getByRole('tab',{name,exact:true}).click();
  assert.equal(await page.locator('#company').inputValue(),'Uber');
  assert.equal(await page.locator('#from').inputValue(),'2026-10-15');
  assert.equal(await page.locator('#report-filters').isVisible(),true);
 }
 await page.getByRole('button',{name:'기업: Uber 해제',exact:true}).click();
 assert.equal(await page.locator('#company').inputValue(),'');
 assert.equal(await page.locator('#from').inputValue(),'2026-10-15');

 // Filename search is independent; report filters/statistics/sort do not imply applicability.
 await page.getByRole('tab',{name:'내 자료',exact:true}).click();
 assert.equal(await page.locator('#results [data-local]').count(),2);
 for(const id of ['report-filters','report-query','stats','sort','visibility-menu'])assert.equal(await page.locator('#'+id).isVisible(),false);
 await page.getByLabel('내 자료 파일명 검색').fill('alpha');
 assert.equal(await page.locator('#results [data-local]').count(),1);
 await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();
 assert.equal(await page.getByLabel('리포트 검색',{exact:true}).inputValue(),'Uber');
 await page.getByRole('tab',{name:'내 자료',exact:true}).click();
 assert.equal(await page.getByLabel('내 자료 파일명 검색').inputValue(),'alpha');
 await page.getByRole('tab',{name:'AI 검색',exact:true}).click();
 await page.locator('#rag-query input').waitFor();
 assert.equal(await page.locator('#search-toolbar').isVisible(),false);
 assert.equal(await page.locator('#report-filters').isVisible(),false);
 assert.equal(await page.locator('#stats').isVisible(),false);
 await page.screenshot({path:path.join(build,'navigation-rag.png'),fullPage:true});

 // Roving tab focus and URL state remain available to keyboard/bookmark users.
 await page.getByRole('tab',{name:'AI 검색',exact:true}).focus();
 await page.keyboard.press('Home');
 assert.equal(await page.getByRole('tab',{name:'데일리리포트',exact:true}).getAttribute('aria-selected'),'true');
 await page.keyboard.press('ArrowDown');
 assert.equal(await page.getByRole('tab',{name:'타임라인',exact:true}).getAttribute('aria-selected'),'true');
 assert.match(page.url(),/#timeline$/);
 await page.reload();
 await page.locator('#results [data-report]').first().waitFor();
 assert.equal(await page.locator('#view-panel').getAttribute('aria-labelledby'),'tab-timeline');

 // Hiding and restoring remains reachable from the result menu, including after a rerender.
 await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();
 await page.locator('#results [data-report="local-2026-10-15"]').click();
 await page.locator('#hide-report').click();
 await page.waitForFunction(()=>document.querySelector('#hidden-count').textContent.includes('1개'));
 await page.locator('#visibility-label').click();
 await page.locator('#restore-reports').click();
 await page.locator('#restore-all-settings').click();
 await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();
 await page.locator('#results [data-report="local-2026-10-15"]').waitFor();
 await page.locator('#visibility-label').press('Escape');
 await page.locator('#help').click();await page.getByRole('dialog').waitFor();
 assert.match(await page.locator('#published').innerText(),/마지막 GitHub 확인/);
 await page.getByRole('button',{name:'도움말 닫기',exact:true}).click();

 for(const theme of ['apple','apple-dark','classic']){
  await page.getByRole('tab',{name:'설정',exact:true}).click();
  await page.locator('#theme').selectOption(theme);
  await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();
  await noOverflow(page);
  await page.screenshot({path:path.join(build,`navigation-${theme}.png`),fullPage:true});
 }
 await page.getByRole('tab',{name:'설정',exact:true}).click();await page.locator('#theme').selectOption('apple');await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();
 for(const width of [1100,850,390]){
  await page.setViewportSize({width,height:900});
  await noOverflow(page);
  await page.locator('#filter-toggle').click();
  await page.locator('#filter-panel .filter-options>summary').click();
  await noOverflow(page);
  await page.screenshot({path:path.join(build,`navigation-${width}.png`),fullPage:true});
  await page.locator('#filter-panel .filter-options>summary').click();
  await page.locator('#filter-toggle').click();
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: icon navigation, keyboard/bookmarks, shared filters, independent filename/RAG search, import, hide/restore, help, three themes and responsive layout');
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-navigation-ui-'))fs.rmSync(dir,{recursive:true,force:true});
});
