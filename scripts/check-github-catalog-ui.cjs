// Published data is opt-in; Outlook reports remain independently usable.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-github-catalog-'));
const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8'));
const published=catalog.reports.find(r=>r.title.replace(/\s/g,'')!=='주요신규업데이트없음');
const cached={catalog,commit:'a'.repeat(40),origin:'graycoral/DailyReportAnalysis',synced_at:'2026-10-18T08:00:00+09:00'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true,github_choice_version:version}));
 fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify(cached));
 const original=fs.readFileSync(path.join(dir,'snapshot.json'));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(build,'github-catalog-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/local',r=>r.fulfill({json:{available:true,files:[],mails:[],sources:[]}}));
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.locator('#results .empty').waitFor();
 assert.equal(await page.locator('#results [data-report]').count(),0,'old GitHub cache is hidden when disabled');
 assert.match(await page.locator('#results').innerText(),/GitHub 자료 연동/);
 assert.equal(fs.existsSync(path.join(dir,'databases')),false,'startup did not provision seed DB');
 const blocked=await page.request.get(instance.address+'/api/download?id='+published.id+'&index=0');
 assert.equal(blocked.status(),404,'even embedded attachments require the active source');
 for(const [width,height] of [[1440,900],[375,667]]){
  await page.setViewportSize({width,height});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:path.join(build,`github-empty-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});
 const mail={...published,id:'outlook-copy',origin:'outlook-report',attachments:[],mail:{entry_id:'AA',store_id:'BB',subject:'원본 리포트',folder:'데일리',sender:'분석팀'}};
 await page.route('**/api/local/reports',r=>r.fulfill({json:{reports:[mail],revision:'outlook-one'}}));
 await page.evaluate(()=>refresh(true));
 assert.deepEqual(await page.evaluate(()=>catalog().reports.map(r=>r.id)),[mail.id]);
 await page.locator('#results [data-report]').click();
 assert.equal(await page.evaluate(()=>reportOf(selected).origin),'outlook-report');

 // The backend policy is covered by Go tests. Here exercise status-only polls
 // that switch the catalog in another tab, including the same cached commit.
 const offline=await page.evaluate(()=>api('/api/state'));
 let current=offline,reads=0;
 await page.route('**/api/state',r=>{reads++;return r.fulfill({json:current})});
 await page.route('**/api/status',r=>r.fulfill({json:{...current,commit:current.snapshot.commit,synced_at:current.snapshot.synced_at,local_revision:'outlook-one'}}));
 current={...offline,config:{...offline.config,offline:false},snapshot:cached,sync_state:'ready'};
 await page.evaluate(()=>refresh());
 assert.equal(reads,1,'enable poll loads the published catalog');
 assert.equal(await page.locator('#results [data-report="'+mail.id+'"]').count(),0,'identical Outlook content is not listed twice');
 assert.equal(await page.locator('#results [data-report="'+published.id+'"]').count(),1);
 await page.locator('#tab-outlook').click();
 assert.equal(await page.locator('#results [data-report="'+mail.id+'"]').count(),1,'source mail remains accessible');
 assert.match(await page.locator('#results [data-report="'+mail.id+'"] .card-meta').innerText(),/중복/);
 await page.locator('#tab-search').click();
 await page.locator('#results [data-report="'+published.id+'"]').click();
 current={...offline,sync_state:'auto_disabled',config:{...offline.config,offline_reason:'connection_failed'}};
 await page.evaluate(()=>refresh());
 assert.equal(reads,2,'disabled poll must refresh even without a new remote commit');
 assert.deepEqual(await page.evaluate(()=>catalog().reports.map(r=>r.id)),[mail.id]);
 assert.equal(await page.evaluate(()=>selected),mail.id,'detail switches to the retained Outlook original');
 assert.equal(await page.locator('#detail a[href^="/api/download"]').count(),0);
 for(const tab of ['graph','map']){
  await page.locator('#tab-'+tab).click();
  assert.deepEqual(await page.evaluate(()=>catalog().reports.map(r=>r.id)),[mail.id]);
  assert.equal(await page.evaluate(()=>catalog().relations.length),0,'disabled GitHub evidence must not remain');
 }
 await page.locator('#tab-search').click();
 await page.screenshot({path:path.join(build,'github-off-outlook-retained.png'),fullPage:true});
 assert.deepEqual(fs.readFileSync(path.join(dir,'snapshot.json')),original,'cached reports are preserved');
 assert.deepEqual(errors,[]);
 console.log('PASS: disabled cached/embedded reports, empty-state layout, Outlook independence, source deduplication, cross-tab enable/disable and stale detail/evidence removal');
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-github-catalog-'))fs.rmSync(dir,{recursive:true,force:true});
});
