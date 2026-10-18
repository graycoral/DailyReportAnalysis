// Run against a freshly built viewer: AV_HELP_VIEWER=... node scripts/check-help-ui.cjs.
// Uses only bundled reports in an isolated offline profile; no user's data or services are accessed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-help-ui-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'page should fit the viewport')}
async function activeGuide(page,id){
 assert.equal(await page.getByRole('tabpanel').count(),1,'only one tab explanation is visible');
 assert.equal(await page.locator('#guide-panel-'+id).isVisible(),true);
 assert.equal(await page.locator('[role="tab"][aria-selected="true"]').count(),1);
 assert.equal(await page.locator('#guide-tab-'+id).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('[role="tab"][tabindex="0"]').count(),1);
}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true,github_choice_version:fs.readFileSync(path.join(__dirname,'../internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1]}));
 viewer=spawn(process.env.AV_HELP_VIEWER||path.join(build,'navigation-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.waitForFunction(()=>typeof state!=='undefined'&&state?.config?.configured);
 const fixture=fs.readFileSync(path.join(root,'internal/hub/report_import_test.go'),'utf8').match(/const importFixture = `([\s\S]*?)`/)[1];
 await page.locator('#report-input').setInputFiles({name:'daily_2026-10-15.md',mimeType:'text/markdown',buffer:Buffer.from(fixture)});
 await page.locator('#results [data-report]').first().waitFor();
 await page.locator('#query').fill('Uber');
 await page.getByRole('tab',{name:'타임라인',exact:true}).click();
 await page.locator('#results [data-report]').first().click();
 await page.getByText('이 리포트에 연결된 노트가 없습니다.',{exact:true}).waitFor();
 const state=async()=>({url:page.url(),query:await page.locator('#query').inputValue(),detail:await page.locator('#detail').innerText()});
 const beforeHelp=await state();
 const countBefore=page.context().pages().length;
 await page.getByRole('button',{name:'도움말',exact:true}).focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'쉽게 시작하기'});await dialog.waitFor();
 assert.equal(page.context().pages().length,countBefore,'Help first opens a small dialog, not a browser tab');
 assert.match(await dialog.innerText(),/자율주행 소식과 자료/);
 assert.equal(await dialog.locator('li').count(),3);
 assert.ok((await dialog.boundingBox()).width<=460);
 await page.screenshot({path:path.join(build,'help-popup-desktop.png'),fullPage:false});
 await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
 assert.equal(await page.locator('#help').evaluate(el=>el===document.activeElement),true,'Escape returns focus to Help');
 assert.deepEqual(await state(),beforeHelp);
 await page.locator('#help').click();
 const opened=page.waitForEvent('popup');await page.locator('#help-details').click();
 const help=await opened;help.on('pageerror',e=>errors.push(e.message));await help.waitForLoadState();
 assert.equal(new URL(help.url()).pathname,'/help.html');
 assert.equal(await help.title(),'쉬운 사용법 · AV 리포트');
 assert.equal(await help.evaluate(()=>window.opener===null),true);
 assert.equal(new URL(help.url()).hash,'#timeline','details open on the current app tab');
 await activeGuide(help,'timeline');
 await page.locator('#close-help').click();assert.equal(await dialog.isVisible(),false);
 const requests=[],failed=[];
 help.on('request',r=>requests.push(r.url()));help.on('requestfailed',r=>failed.push(r.url()));
 help.on('response',r=>{if(r.status()>=400)failed.push(r.url())});
 await help.reload();await noOverflow(help);
 assert.ok(requests.length>=4&&requests.every(url=>new URL(url).origin===instance.address),'guide needs no external resources');
 await help.screenshot({path:path.join(build,'help-desktop.png'),fullPage:true});
 const jump=help.getByRole('tablist',{name:'탭별 사용법'});
 assert.equal(await jump.getByRole('tab').count(),9);
 for(const link of await jump.getByRole('tab').all()){
  const id=(await link.getAttribute('href')).slice(1);await link.click();await activeGuide(help,id);
  assert.equal(new URL(help.url()).hash,'#'+id);
  assert.equal(await help.getByRole('heading',{name:await link.innerText(),exact:true}).isVisible(),true);
 }
 await help.reload();await activeGuide(help,'settings');
 await help.goBack();await activeGuide(help,'rag');
 await help.goForward();await activeGuide(help,'settings');
 await jump.getByRole('tab',{name:'설정',exact:true}).focus();await help.keyboard.press('ArrowRight');await activeGuide(help,'search');
 await help.keyboard.press('ArrowLeft');await activeGuide(help,'settings');
 await help.keyboard.press('Home');await activeGuide(help,'search');
 await help.keyboard.press('End');await activeGuide(help,'settings');
 await help.keyboard.press('Tab');assert.equal(await help.getByRole('tabpanel').evaluate(el=>el===document.activeElement),true,'Tab moves from selected tab to its instructions');
 await help.getByRole('link',{name:'맨 위로 ↑',exact:true}).click();
 await activeGuide(help,'settings');
 assert.deepEqual(await state(),beforeHelp,'original search, tab and selected report stay unchanged');
 assert.equal(await page.locator('#sync-time').isVisible(),true);
 for(const theme of ['apple','apple-dark','classic']){
  await page.getByRole('tab',{name:'설정',exact:true}).click();await page.locator('#theme').selectOption(theme);
  await page.locator('#help').click();await page.screenshot({path:path.join(build,`help-popup-${theme}.png`),fullPage:false});await page.locator('#close-help').click();
  await help.reload();assert.equal(await help.locator('html').getAttribute('data-theme'),theme);await noOverflow(help);
  await help.screenshot({path:path.join(build,`help-${theme}.png`),fullPage:true});
 }
 await page.locator('#theme').selectOption('apple');await help.reload();
 for(const width of [850,390,320]){
  await page.setViewportSize({width,height:900});await page.locator('#help').click();
  const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.height<=868,'popup fits small screens');
  assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'popup content fits its width');
  await page.screenshot({path:path.join(build,`help-popup-${width}.png`),fullPage:false});await page.locator('#close-help').click();
  await help.setViewportSize({width,height:900});await noOverflow(help);
  await jump.getByRole('tab',{name:'Outlook',exact:true}).click();await activeGuide(help,'outlook');
  await help.screenshot({path:path.join(build,`help-${width}.png`),fullPage:true});
 }
 await help.goto(instance.address+'/help.html#missing');await activeGuide(help,'search');
 // Even with JavaScript disabled, the instructions and section links remain usable.
 const staticContext=await browser.newContext({javaScriptEnabled:false});
 await staticContext.addCookies(await page.context().cookies());
 const staticPage=await staticContext.newPage();await staticPage.goto(instance.address+'/help.html');
 await staticPage.getByRole('navigation').getByRole('link',{name:'내 자료',exact:true}).click();
 assert.match(staticPage.url(),/#local$/);await staticContext.close();
 await help.getByRole('link',{name:'리포트 화면 열기',exact:false}).click();
 await help.locator('#results [data-report]').first().waitFor();
 assert.deepEqual(failed,[]);assert.deepEqual(errors,[]);
 console.log('PASS: compact help dialog, keyboard close/focus, current-tab detail link, nine exclusive guide panels, keyboard tabs, URL/history/reload, original report preserved, local assets, three themes, 320–1440px, return link, no-JS reading');
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-help-ui-'))fs.rmSync(dir,{recursive:true,force:true});
});
