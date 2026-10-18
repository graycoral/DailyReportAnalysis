// UI regressions for the Hallmark review. Offline profile, no models or Outlook.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/hallmark-review-ui');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-hallmark-review-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));let browser,viewer;
const evidence={maps:[],contrast:[],errors:[]};
async function contrast(page,selector,label){
 const values=await page.locator(selector).evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().width).map(e=>{
  const rgba=s=>{const a=s.match(/[\d.]+/g).map(Number);return [...a.slice(0,3),a[3]??1]};
  const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
  const luminance=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const layers=[];for(let p=e;p;p=p.parentElement)layers.push(rgba(getComputedStyle(p).backgroundColor));
  const bg=layers.reverse().reduce((b,a)=>blend(a,b),[255,255,255]);
  const a=luminance(blend(rgba(getComputedStyle(e).color),bg)),b=luminance(bg);
  return {text:e.textContent.trim(),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
 }));
 assert.ok(values.length,'contrast target exists: '+label);assert.ok(values.every(v=>v.ratio>=4.5),label+': '+JSON.stringify(values));
 evidence.contrast.push({label,minimum:Math.min(...values.map(v=>v.ratio))});
}
async function mapMetrics(page,label){
 const data=await page.locator('.map').evaluate(el=>{
  const texts=[...el.querySelectorAll('.mn text')].filter(t=>getComputedStyle(t).visibility!=='hidden');
  const boxes=texts.map(t=>{const r=t.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}});
  let overlaps=0;for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)overlaps++;}
  return {width:innerWidth,labels:texts.length,overlaps,sizes:texts.map(t=>{const m=t.getScreenCTM();return parseFloat(getComputedStyle(t).fontSize)*Math.hypot(m.a,m.b)}),pageWidth:document.documentElement.scrollWidth};
 });
 assert.ok(data.labels>=2,label+' has readable labels');assert.equal(data.overlaps,0,label+' labels do not overlap');
 assert.ok(data.sizes.every(n=>n>=12.9),label+' text stays >=13px');assert.ok(data.pageWidth<=data.width+1,label+' fits viewport');
 evidence.maps.push({label,...data});
 // Capture the complete map without the scroll pane's sticky heading covering it.
 await page.setViewportSize({width:data.width,height:1400});
 await page.locator('#results-pane').evaluate(el=>el.scrollTop=0);
 await page.locator('.map').screenshot({path:path.join(out,label+'.png')});
 await page.setViewportSize({width:data.width,height:800});
}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',configured:true,offline:true,sync_time:'08:00',github_choice_version:version}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/hallmark-review-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const file=path.join(profile,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'});
 await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await context.route('**/api/rag/map',r=>r.fulfill({json:{ok:false,docs:[],links:[]}}));
 await context.route('**/api/rag/status',r=>r.fulfill({json:{ok:false}}));
 await context.route('**/api/rag/environment',r=>r.fulfill({json:{state:'missing',supported:true,ready:false,message:'검색 환경이 아직 준비되지 않았습니다.'}}));
 const page=await context.newPage();page.on('pageerror',e=>evidence.errors.push(e.message));page.setDefaultTimeout(10000);
 await require('./ui-catalog-fixture.cjs')(page);
 await page.goto(instance.address+'/open?key='+encodeURIComponent(instance.key));await page.locator('#report-title').waitFor();
 for(const theme of ['apple','apple-dark','classic']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await page.locator('#tab-search').click();await contrast(page,'.chip.teal',theme+' tags');
  await page.locator('.downloads a').first().hover();await contrast(page,'.downloads a',theme+' download hover');
  await page.screenshot({path:path.join(out,'reader-'+theme+'.png')});
  await page.locator('#tab-graph').click();await contrast(page,'.source-switch:has(input:checked)',theme+' source switches');
  assert.equal(await page.locator('.node .ui-icon').count(),await page.locator('.node').count(),'all graph nodes use local SVG icons');
  const icons=await page.locator('.node .ui-icon').evaluateAll(es=>es.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,viewBox:el.getAttribute('viewBox'),pathWidth:el.querySelector('path').getBoundingClientRect().width,html:el.outerHTML})));
  assert.ok(icons.every(i=>i.width<32&&i.height<32&&i.pathWidth<32),'graph icons stay inside their nodes: '+JSON.stringify(icons));
  await page.screenshot({path:path.join(out,'graph-'+theme+'.png')});
  await page.locator('#tab-rag').click();await page.locator('#rag-setup').waitFor();await contrast(page,'#rag-setup',theme+' primary');
  await page.locator('#rag-setup').hover();await contrast(page,'#rag-setup',theme+' primary hover');
  await page.screenshot({path:path.join(out,'rag-'+theme+'.png')});
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='apple');await page.locator('#tab-map').click();await page.locator('#map-zoom-in').waitFor();
 await page.waitForTimeout(6400);
 for(const width of [1280,768,414,375,320]){
  await page.setViewportSize({width,height:800});await page.waitForTimeout(150);await page.locator('#map-nearby').click();await mapMetrics(page,'map-'+width);
  const before=await page.locator('.map .viewport').getAttribute('transform');
  await page.locator('#map-zoom-in').click();assert.notEqual(await page.locator('.map .viewport').getAttribute('transform'),before);await mapMetrics(page,'map-zoom-'+width);
  await page.locator('#map-zoom-out').click();await page.locator('#map-overview').click();await mapMetrics(page,'map-overview-'+width);
 }
 await page.setViewportSize({width:1280,height:800});await page.locator('#map-wide').click();
 assert.equal(await page.locator('#detail').isVisible(),false);assert.equal(await page.locator('#map-wide').getAttribute('aria-pressed'),'true');
 await mapMetrics(page,'map-wide');
 const node=page.locator('.mn.report').first();await node.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#detail').isVisible(),true,'selection opens the evidence pane');
 await page.locator('#tab-settings').click();assert.ok(await page.locator('#settings-page').isVisible());
 await page.locator('#tab-search').click();assert.ok(await page.locator('#detail').isVisible(),'wide map does not hide the reader');
 assert.deepEqual(evidence.errors,[]);console.log('PASS: 13px map labels without overlap, five widths, zoom/overview/wide/keyboard selection, three-theme text contrast and consistent graph icons');
 console.log('Evidence: '+out);
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[^\s]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(evidence,null,2));if(browser)await browser.close();
 if(viewer&&viewer.exitCode===null){const done=new Promise(r=>viewer.once('exit',r));viewer.kill();await done;}
 const relative=path.relative(os.tmpdir(),profile);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(profile).startsWith('avhub-hallmark-review-'))fs.rmSync(profile,{recursive:true,force:true});
});
