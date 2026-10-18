// End-to-end offline connections with actual encrypted local storage and synthetic PDFs.
// Does not open Outlook, download a model, or access real company documents.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-connections-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let viewer,browser,page;
(async()=>{
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',configured:true,offline:true,github_choice_version:version,sync_time:'08:00'}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/connections-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 assert.ok(fs.existsSync(file),'viewer started');const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{const u=new URL(r.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname)){external.push(u.origin);return r.abort()}return r.continue()});
 await page.goto(instance.address+'/open?key='+instance.key);await page.waitForFunction(()=>typeof state!=='undefined'&&state?.config?.configured);
 const files=await page.evaluate(async()=>{
  const out=[];for(const name of ['기밀 테스트 원본.pdf','이름이 다른 사본.pdf']){
   const r=await fetch('/api/local/add?name='+encodeURIComponent(name),{method:'POST',headers:{'X-AV-Request':'1'},body:'%PDF-1.7\nsynthetic connections fixture\n%%EOF'});if(!r.ok)throw Error(await r.text());out.push(await r.json());
  }await loadLocal();return out;
 });
 await page.locator('#connections-open').click();await page.locator('.connection-card').first().waitFor();
 await page.locator('#connections-query').fill('동일한 파일');
 assert.equal(await page.locator('.connection-card').count(),1);
 assert.match(await page.locator('.connection-reasons').innerText(),/동일한 파일 내용/);
 await page.getByRole('button',{name:'추천 제외',exact:true}).click();await page.waitForFunction(()=>!connectionSaving);
 assert.equal(await page.locator('.connection-card').count(),0);
 await page.reload();await page.locator('#connections-open').click();await page.waitForFunction(()=>documentConnections.loaded&&!documentConnections.busy);
 await page.locator('#connections-query').fill('동일한 파일');assert.equal(await page.locator('.connection-card').count(),0,'exclusion persists on reload');
 await page.locator('#connections-filter').selectOption('rejected');assert.equal(await page.locator('.connection-card').count(),1);
 await page.getByRole('button',{name:'판단 취소 · 다시 추천',exact:true}).click();await page.waitForFunction(()=>!connectionSaving);
 await page.locator('#connections-filter').selectOption('suggested');await page.getByRole('button',{name:'연결 확정',exact:true}).click();await page.waitForFunction(()=>!connectionSaving);
 await page.locator('#connections-filter').selectOption('accepted');assert.equal(await page.locator('.connection-card').count(),1);
 // Dictionary form is usable without a model. Conflict errors preserve the draft.
 await page.locator('#connection-dictionary summary').click();await page.locator('#connection-add-alias').click();
 await page.locator('[data-alias-name]').last().fill('실증 사업');await page.locator('[data-alias-values]').last().fill('AV Pilot, 프로젝트 알파');
 await page.locator('#connections-save-dictionary').click();await page.waitForFunction(()=>!connectionSaving);assert.match(await page.locator('#connections-feedback').innerText(),/저장/);
 await page.locator('#connection-add-alias').click();await page.locator('[data-alias-name]').last().fill('AV Pilot');await page.locator('#connections-save-dictionary').click();await page.waitForFunction(()=>!connectionSaving);
 assert.match(await page.locator('#connections-feedback').innerText(),/여러 항목/);assert.equal(await page.locator('[data-alias-name]').last().inputValue(),'AV Pilot');await page.locator('[data-alias-remove]').last().click();
 await page.locator('#connections-save-dictionary').click();await page.waitForFunction(()=>!connectionSaving);
 await page.locator('#connection-dictionary summary').click();
 await page.screenshot({path:path.join(root,'build/connections-desktop.png')});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 assert.equal(await page.locator('#connections-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'dialog fits narrow screen');
 await page.screenshot({path:path.join(root,'build/connections-mobile.png')});
 await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});
 await page.locator('#tab-graph').click();await page.locator('[data-reference^="rule:"]').waitFor();await page.locator('[data-reference^="rule:"]').click();
 assert.match(await page.locator('#detail').innerText(),/확정한 자료 연결/);assert.equal(await page.locator('#detail [data-connection-open]').count(),2);
 await page.locator('#source-local').uncheck();assert.equal(await page.locator('[data-reference^="rule:"]').count(),0,'source switches hide accepted local links');
 await page.locator('#source-local').check();await page.locator('#tab-map').click();await page.locator('line.reference').first().waitFor();
 assert.equal(await page.evaluate(()=>currentDocuments.links.filter(c=>c.offline).length),1);
 await page.locator('#connections-open').click();await page.waitForFunction(()=>documentConnections.loaded&&!documentConnections.busy);
 await page.evaluate(()=>document.documentElement.dataset.theme='apple-dark');await page.screenshot({path:path.join(root,'build/connections-dark.png')});
 // The index on disk is encrypted; user names never enter the public state.
 const binary=fs.readFileSync(path.join(dir,'local/connections.bin'));assert.equal(binary.includes(Buffer.from('실증 사업')),false);
 const stateResponse=await page.evaluate(()=>api('/api/state'));assert.equal(JSON.stringify(stateResponse).includes('기밀 테스트'),false);
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 console.log('PASS: offline real API, fingerprint evidence, rejection persistence, undo, acceptance, dictionary errors, graph/map source filtering, keyboard close, mobile/dark layouts and encrypted storage');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();viewer?.kill()});
