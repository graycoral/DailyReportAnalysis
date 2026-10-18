// Isolated Windows browser check; settings, updates and exit use mock endpoints.
// Build build/navigation-viewer.exe, then run with Playwright and Edge.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-settings-ui-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'page should fit the viewport')}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(build,'navigation-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900},timezoneId:'America/Los_Angeles',reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/local',r=>r.fulfill({json:{available:true,files:[],mails:[],sources:[]}}));
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.locator('#results [data-report]').first().waitFor();
 assert.equal(await page.locator('header #theme,header #exit,header [data-tab]').count(),0);
 assert.equal(await page.locator('.nav-rail #exit').count(),1);
 assert.equal(await page.locator('#sync-indicator').getAttribute('data-state'),'idle');
 assert.match(await page.locator('#sync-time').innerText(),/확인 기록 없음/);
 await page.locator('#sync-summary').click();assert.match(await page.locator('#sync-detail').innerText(),/오프라인/);
 await page.locator('#sync-summary').press('Escape');assert.equal(await page.locator('#sync-indicator').getAttribute('open'),null);

 // Offline update action leads to the new tab, with no report tools showing.
 await page.locator('#sync').click();
 assert.equal(await page.locator('#tab-settings').getAttribute('aria-selected'),'true');
 for(const selector of ['#search-toolbar','#report-filters','#source-controls','.workspace'])assert.equal(await page.locator(selector).isVisible(),false);
 await page.locator('#settings-slot [name=owner]').fill('draft-owner');
 await page.locator('#tab-search').click();await page.locator('#tab-settings').click();
 await page.evaluate(()=>refresh(true));
 assert.equal(await page.locator('#settings-slot [name=owner]').inputValue(),'draft-owner','tab changes and refresh must preserve unsaved settings');
 for(const theme of ['apple','apple-dark','classic']){
  await page.locator('#theme').selectOption(theme);await noOverflow(page);
  await page.screenshot({path:path.join(build,`settings-${theme}.png`),fullPage:true});
 }
 await page.reload();await page.locator('#settings-page').waitFor();
 assert.equal(await page.locator('html').getAttribute('data-theme'),'classic');
 assert.equal(await page.locator('#view-panel').getAttribute('aria-labelledby'),'tab-settings');
 await page.locator('#theme').selectOption('apple');
 for(const [width,height] of [[1440,768],[850,900],[390,900]]){
  await page.setViewportSize({width,height});await noOverflow(page);
  if(width===1440){const rect=await page.locator('#exit').boundingBox();assert.ok(rect.y>=60&&rect.y+rect.height<=height,'exit must fit a standard desktop height')}
  await page.screenshot({path:path.join(build,`settings-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});

 let saved=await page.evaluate(()=>fetch('/api/state').then(r=>r.json())),lastInput,saveFails=false,automaticFails=false,launches=0,updates=0,exits=0;
 let status={...saved,commit:saved.snapshot.commit,synced_at:'2026-10-16T02:45:00Z'};
 await page.route('**/api/state',r=>r.fulfill({json:saved}));
 await page.route('**/api/status',r=>r.fulfill({json:{...status,setup:saved.setup}}));
 await page.route('**/api/check',r=>r.fulfill({json:{ok:true,checks:['테스트 환경 검사 완료']}}));
 await page.route('**/api/install',r=>{
  const input=r.request().postDataJSON();
  if(input.automatic)return r.fulfill({json:automaticFails?{ok:false,error:'테스트 설치 오류'}:{ok:true,checks:['자동 설치 검사']}});
  lastInput=input;if(saveFails)return r.fulfill({json:{ok:false,error:'테스트 연결 오류'}});
  saved={...saved,config:{...saved.config,...input,configured:true}};
  return r.fulfill({json:{ok:true,checks:['테스트 설정 저장 완료']}});
 });
 await page.route('**/api/launch',r=>{launches++;return r.fulfill({json:{ok:true}})});
 await page.route('**/api/sync',r=>{updates++;status={...status,syncing:true,sync_state:'checking'};return r.fulfill({json:{ok:true}})});
 await page.route('**/api/exit',r=>{exits++;return r.fulfill({json:{ok:true}})});
 await page.locator('#settings-slot .check-env').click();await page.getByText('✓ 테스트 환경 검사 완료',{exact:true}).waitFor();
 await page.locator('#settings-slot [name=owner]').fill('saved-owner');
 await page.locator('#settings-slot [name=sync_time]').fill('09:30');
 await page.locator('#settings-slot [name=token]').fill('test-only-placeholder');
 await page.locator('#settings-slot [name=clear_token]').check();
 saveFails=true;await page.locator('#settings-slot .save-settings').click();await page.getByText('테스트 연결 오류',{exact:false}).waitFor();
 assert.equal(await page.locator('#settings-slot [name=owner]').inputValue(),'saved-owner');
 saveFails=false;await page.locator('#settings-slot .save-settings').click();await page.getByText('설정이 저장되었습니다.',{exact:true}).waitFor();
 assert.equal(lastInput.sync_time,'09:30');assert.equal(lastInput.owner,'saved-owner');
 assert.equal(await page.locator('#settings-slot [name=token]').inputValue(),'');
 assert.equal(await page.locator('#settings-slot [name=clear_token]').isChecked(),false);
 assert.equal(await page.locator('#settings-page').isVisible(),true);

 // Timestamp is the last successful check, unchanged by later failures; display always uses KST.
 await page.locator('#tab-search').click();
 for(const [sync_state,signal] of [['ready','ready'],['checking','checking'],['unavailable','error'],['offline','idle'],['unconfigured','idle'],['unknown','idle']]){
  status={...status,sync_state,syncing:sync_state==='checking',status:sync_state==='unavailable'?'테스트 네트워크 연결 오류':''};
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#sync-indicator').getAttribute('data-state'),signal);
  assert.equal(await page.locator('#sync').isDisabled(),sync_state==='checking');
  assert.match(await page.locator('#sync-time').innerText(),/2026.*10.*16.*11:45/);
  if(sync_state==='unavailable'){
   await page.locator('#sync-summary').click();assert.match(await page.locator('#sync-detail').innerText(),/테스트 네트워크 연결 오류/);
   await page.screenshot({path:path.join(build,'settings-sync-error.png'),fullPage:true});
   await page.locator('#sync-summary').press('Escape');await page.locator('#sync').click();
   await page.waitForFunction(()=>document.querySelector('#sync').disabled);assert.equal(updates,1);
  }
 }
 status={...status,sync_state:'unconfigured'};await page.evaluate(()=>refresh());await page.locator('#sync').click();
 assert.equal(await page.locator('#tab-settings').getAttribute('aria-selected'),'true');assert.equal(updates,1);

 // Initial setup keeps automatic install/launch and its manual fallback.
 saved={...saved,setup:true};await page.reload();await page.getByText('설치가 끝났습니다.',{exact:false}).waitFor();assert.equal(launches,1);
 assert.equal(await page.locator('#viewer').isVisible(),false);assert.equal(await page.locator('#sync').isDisabled(),true);
 automaticFails=true;await page.reload();await page.locator('#setup-slot').waitFor();
 assert.match(await page.locator('#setup-home').innerText(),/테스트 설치 오류/);
 assert.equal(await page.locator('#setup-slot form').count(),1);
 saved={...saved,setup:false,config:{...saved.config,configured:false}};
 await page.goto(instance.address+'/');await page.locator('#settings-page').waitFor();
 assert.equal(await page.locator('#tab-settings').getAttribute('aria-selected'),'true');

 // Exit is a separate button; cancel keeps the application running.
 page.once('dialog',d=>d.dismiss());await page.locator('#exit').click();assert.equal(exits,0);
 assert.equal(await page.locator('#viewer').isVisible(),true);
 page.once('dialog',d=>d.accept());await page.locator('#exit').click();await page.getByRole('heading',{name:'AV 리포트를 종료했습니다.'}).waitFor();assert.equal(exits,1);
 assert.deepEqual(errors,[]);
 console.log('PASS: settings tab/drafts/save/recovery, three themes, responsive layout, KST timestamp, signal states/retry, setup/fallback, and exit cancel/confirm');
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-settings-ui-'))fs.rmSync(dir,{recursive:true,force:true});
});
