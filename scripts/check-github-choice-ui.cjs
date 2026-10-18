// Isolated profile; enable/failure UI uses mocked endpoints, no GitHub access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-github-choice-'));
const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
async function stopViewer(){
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const instance=path.join(dir,'instance-viewer.json');if(fs.existsSync(instance))fs.unlinkSync(instance);
}
async function startViewer(){
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(build,'github-choice-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 return instance.address+'/open?key='+instance.key;
}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true}));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/local',r=>r.fulfill({json:{available:true,files:[],mails:[],sources:[]}}));
 await page.goto(await startViewer());
 const dialog=page.getByRole('dialog',{name:'GitHub 자료를 연동할까요?'});
 await dialog.waitFor();
 assert.match(await page.locator('#github-choice-version').innerText(),new RegExp(version.replaceAll('.','\\.')));
 assert.equal(await page.locator('#sync').isDisabled(),true);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'github-choice-title');
 for(let i=0;i<6;i++){await page.keyboard.press('Tab');const focus=await page.evaluate(()=>({inside:document.activeElement.closest('#github-choice-dialog')!==null,id:document.activeElement.id,tag:document.activeElement.tagName}));assert.ok(focus.inside||focus.tag==='BODY',JSON.stringify(focus))}
 for(const theme of ['apple','apple-dark','classic']){
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  for(const [width,height] of [[1440,900],[375,667],[667,375]]){
   await page.setViewportSize({width,height});
   const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1);
   assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:path.join(build,`github-choice-${theme}.png`),fullPage:true});
 }
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 await page.evaluate(()=>refresh());assert.equal(await dialog.isVisible(),false,'later stays dismissed during this page session');
 await page.reload();await dialog.waitFor();

 let posts=0;
 await page.route('**/api/github-choice',async r=>{
  posts++;if(posts===1){await wait(200);return r.fulfill({status:500,body:'테스트 저장 실패: 다시 시도해 주세요.'})}
  return r.continue();
 });
 await page.evaluate(()=>{saveGitHubChoice(false);saveGitHubChoice(false)});
 await page.getByText('테스트 저장 실패: 다시 시도해 주세요.',{exact:true}).waitFor();
 assert.equal(posts,1,'busy dialog ignores duplicate submissions');
 assert.equal(await dialog.isVisible(),true);
 const reports=await page.evaluate(()=>state.snapshot.catalog.reports.length);
 assert.equal(reports,0,'GitHub reports must be absent before a decision');
 await page.getByRole('button',{name:'연동하지 않기',exact:true}).click();
 await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>!githubChoiceBusy);
 assert.equal(await page.evaluate(()=>state.snapshot.catalog.reports.length),reports);
 let config=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
 assert.equal(config.github_choice_version,version);assert.equal(config.offline,true);
 await page.reload();assert.equal(await dialog.isVisible(),false);
 await stopViewer();await page.goto(await startViewer());
 await page.locator('#results .empty').waitFor();
 assert.equal(await page.locator('#results [data-report]').count(),0);
 assert.equal(fs.existsSync(path.join(dir,'databases')),false,'declining must not provision the bundled DB');
 assert.equal(await dialog.isVisible(),false,'same version remembers the choice after process restart');

 await stopViewer();config.github_choice_version='older-version';
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(config));
 await page.goto(await startViewer());await dialog.waitFor();
 let saved=await page.evaluate(()=>fetch('/api/state').then(r=>r.json())),input;
 await page.unroute('**/api/github-choice');
 await page.route('**/api/github-choice',r=>{
  input=r.request().postDataJSON();
  saved={...saved,github_choice_required:false,sync_state:'auto_disabled',config:{...saved.config,github_choice_version:version,offline:true,offline_reason:'connection_failed'}};
  return r.fulfill({json:{ok:true,config:saved.config,github_choice_required:false}});
 });
 await page.route('**/api/state',r=>r.fulfill({json:saved}));
 await page.route('**/api/status',r=>r.fulfill({json:{...saved,commit:saved.snapshot.commit}}));
 await page.getByRole('button',{name:'연동하기',exact:true}).click();
 await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>!githubChoiceBusy);
 assert.deepEqual(input,{version,enabled:true});
 assert.equal(await page.locator('#sync').isDisabled(),true);
 assert.match(await page.locator('#sync-status').innerText(),/자동 꺼짐/);
 await page.reload();await page.locator('#results .empty').waitFor();
 assert.equal(await dialog.isVisible(),false,'connection failure must not repeat an answered prompt');
 await page.evaluate(()=>updateGitHubChoice({setup:true,github_choice_required:true}));
 assert.equal(await dialog.isVisible(),false,'setup only prepares the installation');
 assert.deepEqual(errors,[]);
 console.log('PASS: legacy/changed-version prompt, keyboard and responsive themes, defer, retry, duplicate clicks, persisted decline/restart, and failed enable without repeated prompts');
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();await stopViewer();
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-github-choice-'))fs.rmSync(dir,{recursive:true,force:true});
});
