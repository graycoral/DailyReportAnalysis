// Report reader regressions, using a fresh offline profile and headless Edge.
// Build cmd/viewer and set AV_NAV_VIEWER to that executable before running.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build'),out=path.join(build,'report-reading-ui');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-report-reading-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
async function fits(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow')}
async function shot(page,name){await fits(page);await page.screenshot({path:path.join(out,name+'.png')})}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true,github_choice_version:version}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(build,'navigation-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const instanceFile=path.join(profile,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(instanceFile);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(instanceFile,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await require('./ui-catalog-fixture.cjs')(page);
 await page.goto(instance.address+'/open?key='+encodeURIComponent(instance.key));
 const cards=page.locator('#results .report-card'),detail=page.locator('#detail');
 await cards.first().waitFor();await page.locator('.local-links-empty').waitFor();

 // Switching reports resets the reader, without recreating the focused list button.
 await detail.evaluate(el=>el.scrollTop=600);
 assert.ok(await detail.evaluate(el=>el.scrollTop)>300);
 await cards.nth(1).focus();
 await cards.nth(1).evaluate(el=>window.testReportCard=el);
 await page.keyboard.press('Enter');
 assert.equal(await detail.evaluate(el=>el.scrollTop),0,'new report begins at its title');
 assert.ok(await page.evaluate(()=>document.activeElement===window.testReportCard&&window.testReportCard.isConnected),'keyboard focus stays on the mounted card');
 assert.equal(await cards.nth(1).getAttribute('aria-pressed'),'true');
 await page.keyboard.press('Tab');
 assert.ok(await page.evaluate(()=>document.activeElement!==window.testReportCard&&document.activeElement.closest('.report-card-shell')===window.testReportCard.parentElement),'Tab continues to the selected report\'s tags or actions');
 await detail.evaluate(el=>el.scrollTop=400);
 await page.evaluate(()=>renderDetail());
 assert.equal(await detail.evaluate(el=>el.scrollTop),400,'same-report refresh preserves reading position');
 await page.locator('[data-related]').first().click();
 assert.equal(await detail.evaluate(el=>el.scrollTop),0,'related report opens at the top');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'report-title');

 // An empty attachment panel is compact; the user's expanded state survives refresh.
 const empty=page.locator('.local-links-empty');
 assert.equal(await empty.evaluate(el=>el.open),false);
 assert.ok((await empty.boundingBox()).height<50,'empty attachments use a single line');
 await empty.locator('summary').click();
 await page.waitForFunction(()=>expandedLocalLinks.has(selected));
 await page.evaluate(()=>renderDetail());
 assert.equal(await empty.evaluate(el=>el.open),true);
 await empty.locator('summary').click();
 await page.waitForFunction(()=>!expandedLocalLinks.has(selected));
 await page.evaluate(()=>{local.files=[{id:'test-linked-pdf',name:'연결된 자료.pdf',size:100,reports:[selected]}];renderDetail()});
 assert.ok(await page.locator('.local-links .mail-open').isVisible(),'actual attachments stay visible');
 assert.equal(await page.locator('.local-links-empty').count(),0);
 await page.evaluate(()=>{local.files=[];renderDetail()});

 // Muted text must remain legible on all three surfaces in every supported theme.
 const contrast=[];
 for(const theme of ['apple','apple-dark','classic']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const ratios=await page.evaluate(()=>{
   const css=getComputedStyle(document.documentElement);
   const luminance=name=>{const hex=css.getPropertyValue(name).trim().slice(1);const rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722};
   const text=luminance('--muted');
   return ['--bg','--surface','--surface-2'].map(name=>{const bg=luminance(name);return {surface:name,ratio:(Math.max(text,bg)+0.05)/(Math.min(text,bg)+0.05)}});
  });
  assert.ok(ratios.every(x=>x.ratio>=4.5),theme+' muted contrast: '+JSON.stringify(ratios));
  contrast.push({theme,ratios});
  await detail.evaluate(el=>el.scrollTop=0);await cards.first().click();
  assert.ok(await cards.evaluateAll(es=>es.every(el=>getComputedStyle(el).animationName==='none')),'report lists have no entrance animation');
  await cards.first().hover();
  assert.equal(await cards.first().evaluate(el=>getComputedStyle(el).transform),'none','hover does not move a report');
  assert.ok(await cards.first().evaluate(el=>!getComputedStyle(el).transitionProperty.includes('box-shadow')),'focus outline is immediate');
  await shot(page,'desktop-'+theme);
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='apple');

 // Narrow layouts expose one pane at a time and return to the exact list position.
 for(const width of [768,414,375,320]){
  await page.setViewportSize({width,height:800});
  await page.locator('#tab-search').click();
  await page.locator('#query').fill('자율주행');
  assert.ok(await cards.count()>3);
  assert.equal(await detail.isVisible(),false);
  await cards.nth(3).scrollIntoViewIfNeeded();
  await cards.nth(3).focus();
  const before=await page.evaluate(()=>scrollY);
  const id=await cards.nth(3).getAttribute('data-report');
  await shot(page,'list-'+width);
  await page.keyboard.press('Enter');
  assert.ok(await detail.isVisible());
  assert.equal(await page.locator('#results-pane').isVisible(),false);
  assert.equal(await page.evaluate(()=>scrollY),0);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'report-title');
  const title=await page.locator('#report-title').boundingBox();
  assert.ok(title.y>=0&&title.y+title.height<800,'selected report title visible at '+width);
  await shot(page,'reader-'+width);
  await page.evaluate(()=>scrollTo(0,800));
  const back=await page.locator('#report-back').boundingBox();
  assert.ok(back.y>=0&&back.y+back.height<800,'back stays within viewport while reading');
  await page.locator('#report-back').click();
  assert.equal(await detail.isVisible(),false);
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-before)<=1,'restored list position');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.report),id);
  assert.equal(await page.locator('#query').inputValue(),'자율주행','search survives return');
  await fits(page);
 }
 // Timeline follows the same navigation; resizing never leaves focus in hidden detail.
 await page.locator('#tab-timeline').click();
 await page.locator('#results [data-report]').first().click();
 await page.locator('#report-back').waitFor();
 await page.locator('#report-back').click();
 assert.equal(await detail.isVisible(),false);
 // Linked mail can point to a daily report outside the Outlook report list.
 await page.evaluate(()=>{
  const r=state.snapshot.catalog.reports[0];
  importedReports=[{...r,id:'reading-outlook-fixture',origin:'outlook-report',mail:{entry_id:'fixture',subject:r.title}}];
  local.mails=[{entry_id:'linked-fixture',subject:'연결된 메일',report:r.id}];
  mergedSource=null;setTab('outlook');
 });
 await page.locator('#results [data-report]').first().click();
 await page.locator('#report-back').waitFor();
 await page.locator('#report-back').click();
 const linked=page.locator('#results [data-goto-report]').first();
 const linkedID=await linked.getAttribute('data-goto-report');
 await linked.click();
 assert.ok(await detail.isVisible(),'linked daily report opens in narrow Outlook view');
 assert.equal(await page.evaluate(()=>selected),linkedID);
 await page.locator('#report-back').click();
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.gotoReport),linkedID,'return focuses the original mail link');
 await page.evaluate(()=>{importedReports=[];local.mails=[];mergedSource=null});
 await page.locator('#tab-search').click();await page.locator('#clear').click();
 await cards.first().click();
 await page.setViewportSize({width:1440,height:900});
 await page.waitForFunction(()=>!document.querySelector('#viewer').classList.contains('report-reading'));
 assert.ok(await page.locator('#results-pane').isVisible());
 assert.ok(await detail.isVisible());
 await page.setViewportSize({width:375,height:800});
 await page.waitForFunction(()=>document.activeElement.matches('#results [data-report]'));
 assert.equal(await detail.isVisible(),false);
 // Repeat desktop-to-narrow focus transitions; CSS can blur before matchMedia runs.
 for(let i=0;i<5;i++){
  await page.setViewportSize({width:1280,height:800});
  await page.locator('#report-title').focus();
  await page.setViewportSize({width:375,height:800});
  await page.waitForFunction(()=>document.activeElement.matches('#results [data-report]'));
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(()=>document.activeElement.tagName),'BODY');
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await cards.first().evaluate(el=>getComputedStyle(el).animationName),'none');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'contrast.json'),JSON.stringify(contrast,null,2));
 console.log('PASS: report/related scroll reset, refresh preservation, keyboard focus, compact/linked attachments, three-theme contrast, stable cards, narrow reader/back/search/scroll, timeline, resize and reduced motion');
 console.log('Evidence: '+out);
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),profile);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(profile).startsWith('avhub-report-reading-'))fs.rmSync(profile,{recursive:true,force:true});
});
