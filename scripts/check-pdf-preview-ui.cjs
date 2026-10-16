// Build build/pdf-preview-viewer.exe, then run with Playwright and Microsoft Edge.
// Uses only generated PDFs and an isolated offline profile, never the user's files.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-pdf-ui-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
function samplePDF(label){
 const stream=text=>`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  ...[6,7].map(n=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${n} 0 R >>`),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ...[1,2].map(n=>stream(`BT /F1 24 Tf 60 740 Td (${label} - Page ${n}) Tj 0 -50 Td /F1 14 Tf (Local PDF preview test) Tj ET\n`))];
 let pdf='%PDF-1.4\n',offsets=[0];
 for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`}
 const start=Buffer.byteLength(pdf);
 pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
 return Buffer.from(pdf+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
async function noOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'page fits viewport')}
async function ready(page,scope='#local-pdf-preview'){
 await page.locator(scope+' iframe[src]').waitFor();
 await page.locator(scope+' [role="status"]').waitFor({state:'hidden'});
}
(async()=>{
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true}));
 viewer=spawn(process.env.AV_PDF_VIEWER||path.join(build,'pdf-preview-viewer.exe'),['--no-browser','--data-dir',dir],{windowsHide:true,stdio:'ignore'});
 const file=path.join(dir,'instance-viewer.json');
 for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[],pdfResponses=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&/refused to (frame|display)|frame-ancestors/i.test(m.text()))errors.push(m.text())});
 page.on('response',r=>{if(r.url().includes('/api/local/file?')&&r.request().method()==='GET')pdfResponses.push(r)});
 page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(instance.address+'/'))external.push(r.url())});
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.locator('#results [data-report]').first().waitFor();
 const pdfA=samplePDF('ALPHA'),pdfB=samplePDF('BETA');
 const added=page.waitForResponse(r=>r.url().includes('/api/local/add?'));
 await page.locator('#local-input').setInputFiles({name:'알파 미리보기.pdf',mimeType:'application/pdf',buffer:pdfA});
 const first=await (await added).json();await ready(page);
 assert.equal(await page.getByRole('tab',{name:'내 자료',exact:true}).getAttribute('aria-selected'),'true');
 assert.match(await page.locator('#local-pdf-preview iframe').getAttribute('title'),/알파 미리보기/);
 assert.ok(pdfResponses.some(r=>r.status()===200||r.status()===206),'browser requested actual PDF bytes');
 const response=pdfResponses.find(r=>r.url().includes(first.id));
 assert.match(response.headers()['content-security-policy'],/frame-ancestors 'self'/);
 assert.equal(response.headers()['cache-control'],'no-store');

 // Resizing must retain the loaded PDF browsing context and must not fetch it again.
 await page.locator('#local-pdf-preview iframe').evaluate(el=>{el.dataset.resizeIdentity='keep'});
 const divider=page.locator('#workspace-divider'),handle=await divider.boundingBox(),pdfRequestsBefore=pdfResponses.length;
 await page.mouse.move(handle.x+5,handle.y+100);await page.mouse.down();
 await page.mouse.move(handle.x+160,handle.y+100,{steps:8});await page.mouse.up();
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('data-resize-identity'),'keep');
 assert.equal(pdfResponses.length,pdfRequestsBefore);
 await divider.press('Enter');

 // Search and saving a report link must preserve the same iframe browsing context.
 await page.locator('#local-pdf-preview iframe').evaluate(el=>{el.dataset.testIdentity='keep'});
 assert.ok((await page.locator('.pdf-list-row').first().boundingBox()).height<85,'desktop PDF rows should be compact');
 await page.locator(`[data-local-links="${first.id}"]`).click();await page.locator('#pdf-links-dialog').waitFor();
 const report=await page.locator('#pdf-dialog-target option').nth(1).getAttribute('value');
 await page.locator('#pdf-dialog-target').selectOption(report);
 await page.locator('#pdf-links-form button').click();await page.locator('[data-dialog-unlink]').waitFor();
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('data-test-identity'),'keep');
 await page.locator('#pdf-links-close').click();
 await page.getByLabel('내 자료 파일명 검색').fill('알파');
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('data-test-identity'),'keep');
 await page.locator('[data-pdf-unlink]').click();await page.locator('[data-pdf-unlink]').waitFor({state:'detached'});
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('data-test-identity'),'keep');
 await noOverflow(page);
 await page.locator('#detail').evaluate(el=>{el.scrollTop=0});
 await page.screenshot({path:path.join(build,'pdf-preview-inline.png'),fullPage:true});

 // The large viewer is modal, supports keyboard dismissal, and frees its frame on close.
 await page.getByRole('button',{name:'크게 보기',exact:true}).click();await ready(page,'#pdf-dialog-preview');
 assert.equal(await page.locator('#pdf-dialog').isVisible(),true);
 const large=await page.locator('#pdf-dialog iframe').boundingBox(),small=await page.locator('#local-pdf-preview iframe').boundingBox();
 assert.ok(large.width>small.width*1.5);
 // The native PDF plugin paints asynchronously after the iframe's load event.
 await wait(1000);
 await page.screenshot({path:path.join(build,'pdf-preview-large.png'),fullPage:true});
 await page.getByRole('button',{name:'PDF 미리보기 닫기'}).focus();await page.keyboard.press('Escape');
 await page.locator('#pdf-dialog').waitFor({state:'hidden'});
 await page.locator('#pdf-dialog iframe').waitFor({state:'detached'});
 assert.equal(await page.locator('#pdf-dialog iframe').count(),0);
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('data-test-identity'),'keep');
 assert.equal(await page.getByRole('button',{name:'크게 보기',exact:true}).evaluate(el=>el===document.activeElement),true);

 const download=page.waitForEvent('download');await page.locator('#local-pdf-preview').getByRole('link',{name:'다운로드',exact:true}).click();
 const downloaded=await download;assert.equal(downloaded.suggestedFilename(),first.name);
 assert.deepEqual(fs.readFileSync(await downloaded.path()),pdfA);
 const newTab=page.locator('#local-pdf-preview').getByRole('link',{name:'새 탭에서 열기',exact:true});
 assert.equal(await newTab.getAttribute('target'),'_blank');
 assert.match(await newTab.getAttribute('href'),new RegExp(first.id+'&view=1$'));

 // A different file replaces the preview; missing file errors offer a working retry.
 await page.locator('#local-clear').click();
 const addedB=page.waitForResponse(r=>r.url().includes('/api/local/add?'));
 await page.locator('#local-input').setInputFiles({name:'베타.pdf',mimeType:'application/pdf',buffer:pdfB});
 const second=await (await addedB).json();await page.locator(`#local-pdf-preview iframe[src*="${second.id}"]`).waitFor();await ready(page);
 assert.match(await page.locator('#local-pdf-preview iframe').getAttribute('src'),new RegExp(second.id));
 const route='**/api/local/file?**';
 await page.route(route,r=>r.request().method()==='HEAD'?r.fulfill({status:404}):r.continue());
 await page.locator(`[data-local="${first.id}"]`).click();
 await page.locator('.pdf-preview-retry').waitFor();
 assert.match(await page.locator('.pdf-preview-status').innerText(),/PDF를 열 수 없습니다/);
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('src'),null);
 await page.unroute(route);
 await page.getByRole('button',{name:'다시 시도',exact:true}).click();await ready(page);

 for(const theme of ['apple','apple-dark','classic']){
  await page.getByRole('tab',{name:'설정',exact:true}).click();await page.locator('#theme').selectOption(theme);
  await page.getByRole('tab',{name:'내 자료',exact:true}).click();await ready(page);await noOverflow(page);
  await page.screenshot({path:path.join(build,`pdf-preview-${theme}.png`),fullPage:true});
 }
 for(const width of [850,390]){
  await page.setViewportSize({width,height:900});await noOverflow(page);
  await page.getByRole('button',{name:'크게 보기',exact:true}).click();await ready(page,'#pdf-dialog-preview');await noOverflow(page);
  const rect=await page.locator('#pdf-dialog').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width+1);
  await wait(600);
  await page.screenshot({path:path.join(build,`pdf-preview-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'PDF 미리보기 닫기'}).click();
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('tab',{name:'데일리리포트',exact:true}).click();assert.equal(await page.locator('#local-pdf-preview').count(),0);
 await page.getByRole('tab',{name:'내 자료',exact:true}).click();await ready(page);
 // Row delete uses the real removal API; cancel/failure preserve both PDF and preview.
 page.once('dialog',d=>d.dismiss());await page.locator(`[data-delete-pdf="${first.id}"]`).click();
 assert.equal(await page.locator(`[data-local="${first.id}"]`).count(),1);
 await page.route('**/api/local/delete',r=>r.fulfill({status:500,body:'테스트 PDF 삭제 실패'}));
 page.once('dialog',d=>d.accept());await page.locator(`[data-delete-pdf="${first.id}"]`).click();
 await page.getByText('테스트 PDF 삭제 실패',{exact:true}).waitFor();await ready(page);
 assert.equal(await page.locator(`[data-local="${first.id}"]`).count(),1);
 await page.unroute('**/api/local/delete');
 page.once('dialog',d=>d.accept());await page.locator(`[data-delete-pdf="${first.id}"]`).click();
 await page.locator(`[data-local="${first.id}"]`).waitFor({state:'detached'});
 assert.equal(await page.locator('#local-pdf-preview').count(),0);
 assert.equal(await page.evaluate(id=>fetch('/api/local/file?id='+id,{method:'HEAD'}).then(r=>r.status),first.id),404,'row deletion must remove the stored PDF');

 // Browsers configured without an embedded PDF viewer keep usable file actions.
 await page.addInitScript(()=>Object.defineProperty(navigator,'pdfViewerEnabled',{get:()=>false}));
 await page.reload();await page.locator(`[data-local="${second.id}"]`).click();
 assert.match(await page.locator('.pdf-preview-status').innerText(),/미리보기를 지원하지 않습니다/);
 assert.equal(await page.locator('#local-pdf-preview iframe').getAttribute('src'),null);
 assert.equal(await page.locator('#local-pdf-preview a').count(),2);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('PASS: real encrypted PDF upload/inline view, large modal, search/link continuity, download, switching, retry, deletion, browser fallback, three themes, responsive layout and no external requests');
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await done}
 const relative=path.relative(os.tmpdir(),dir);
 if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(dir).startsWith('avhub-pdf-ui-'))fs.rmSync(dir,{recursive:true,force:true});
});
