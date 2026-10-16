// End-to-end UI check. Build build/import-viewer.exe first; requires Playwright and Edge.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-import-ui-'));
const fixture=fs.readFileSync(path.join(root,'internal/hub/report_import_test.go'),'utf8').match(/const importFixture = `([\s\S]*?)`/)[1];
let viewer,browser;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){
 viewer=spawn(path.join(root,'build/import-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
async function stop(){if(!viewer)return;const child=viewer;viewer=null;child.kill();await new Promise(resolve=>child.once('exit',resolve));const file=path.join(dir,'instance-viewer.json');if(fs.existsSync(file))fs.unlinkSync(file)}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true}));
 let instance=await start();
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1560,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.getByRole('button',{name:'↻ 지금 업데이트',exact:true}).waitFor();
 // The real browser drop path, including its preventDefault handler.
 await page.evaluate(body=>{const transfer=new DataTransfer();transfer.items.add(new File([body],'daily_2026-10-15.md',{type:'text/markdown'}));dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}))},fixture);
 await page.locator('#results [data-report="local-2026-10-15"]').waitFor();
 await page.getByRole('heading',{name:'Uber 운행 지역 확대',exact:true}).last().waitFor();
 assert.match(await page.locator('#report-import-status').innerText(),/가져왔습니다/);
 assert.match(await page.locator('#detail').innerText(),/MD 다운로드/);
 await page.locator('#report-input').setInputFiles({name:'same.md',mimeType:'text/markdown',buffer:Buffer.from(fixture)});
 await page.waitForFunction(()=>document.querySelector('#report-import-status').textContent.includes('이미 가져온'));
 assert.equal(await page.locator('#results [data-report="local-2026-10-15"]').count(),1);
 await page.locator('#report-input').setInputFiles({name:'invalid.md',mimeType:'text/markdown',buffer:Buffer.from('# invalid')});
 await page.waitForFunction(()=>document.querySelector('#report-import-status').textContent.includes('머리말'));
 assert.equal(await page.locator('#results [data-report="local-2026-10-15"]').count(),1);
 await page.getByRole('tab',{name:'타임라인',exact:true}).click();
 await page.locator('#results [data-report="local-2026-10-15"]').waitFor();
 await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();
 await page.screenshot({path:path.join(root,'build/import-ui.png'),fullPage:true});
 // Fail/recover labels do not permanently disable retry.
 await page.evaluate(()=>showStatus({sync_state:'unavailable',status:'GitHub 연결 불가'}));
 assert.equal(await page.locator('#sync-indicator').getAttribute('data-state'),'error');assert.equal(await page.locator('#sync').isEnabled(),true);
 await page.evaluate(()=>showStatus({sync_state:'ready',status:'최신 자료 확인 완료'}));
 assert.match(await page.locator('#sync').innerText(),/지금 업데이트/);
 // Folder selection is tested without accessing a real user's Outlook profile.
 const store={name:'테스트 메일함',store_id:'00AA'},folder={...store,name:'테스트 메일함/자율주행',folder_id:'00BB',folder_name:'자율주행'};
 let sources=[],selectedSource;
 await page.route('**/api/local',route=>route.fulfill({json:{available:true,files:[],mails:[],sources}}));
 await page.route('**/api/outlook/stores',route=>route.fulfill({json:{stores:[store]}}));
 await page.route('**/api/outlook/folders',route=>route.fulfill({json:{folders:[folder]}}));
 await page.route('**/api/outlook/source',route=>{selectedSource=route.request().postDataJSON().source;sources=[selectedSource];return route.fulfill({json:{ok:true}})});
 await page.getByRole('tab',{name:'Outlook',exact:true}).click();
 await page.getByRole('button',{name:'Outlook 연동',exact:true}).click();
 await page.getByRole('button',{name:'폴더 선택',exact:true}).click();
 await page.getByRole('button',{name:'이 폴더 추가',exact:true}).click();
 await page.getByText('자동 가져오기 · 태그: 자율주행',{exact:true}).waitFor();
 assert.equal(selectedSource.folder_id,'00BB');assert.equal(selectedSource.folder_name,'자율주행');
 assert.match(await page.locator('#results').innerText(),/일반 메일은 저장하지 않습니다/);
 await page.screenshot({path:path.join(root,'build/outlook-import-ui.png'),fullPage:true});
 // Persisted MD remains available after restarting the server with GitHub offline.
 await page.close();await stop();instance=await start();
 const again=await browser.newPage();await again.goto(instance.address+'/open?key='+instance.key);
 await again.locator('#results [data-report="local-2026-10-15"]').waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: offline label, MD drag/drop, duplicates, invalid input, timeline, retry/recovery, Outlook folder selection and restart persistence');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();await stop();
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-import-ui-'))fs.rmSync(dir,{recursive:true,force:true});
});
