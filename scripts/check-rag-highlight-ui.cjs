// Real PDF-derived image/boxes, mocked model replies, isolated app profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/rag-highlight-ui');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-rag-highlight-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let viewer,browser,releasePage,releaseQuery;
const errors=[],layouts=[];
const python=String.raw`
import base64, json, sys, tempfile
from pathlib import Path
sys.path.insert(0, 'rag')
import embed_core as ec
from test_highlights import pdf_bytes
from pdf_highlights import page_highlights
with tempfile.TemporaryDirectory() as tmp:
    file=Path(tmp)/'fixture.pdf'
    file.write_bytes(pdf_bytes())
    pages=list(ec.pdf_pages(file))
    image='data:image/png;base64,'+base64.b64encode(ec.png_bytes(pages[0][1])).decode()
    print(json.dumps({'image':image, 'robotaxi':page_highlights(file,1,'Robotaxi'), 'routes':page_highlights(file,1,'routes')}))
`;
let delayedPage=false,delayedQuery=false;
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const fixture=JSON.parse(execFileSync(process.env.AV_RAG_PYTHON||'python',['-c',python],{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024}));
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',configured:true,offline:true,github_choice_version:version}));
 viewer=spawn(process.env.AV_NAV_VIEWER||path.join(root,'build/rag-highlight-viewer.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const file=path.join(profile,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 const doc={id:'pdf1',name:'Robotaxi <unsafe>.pdf',kind:'pdf',pages:2,size:2000};
 const missing={rects:[],matches:0,reason:'no_match'};
 await context.route('**/api/rag/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname.split('/').pop();
  if(endpoint==='status')return route.fulfill({json:{ok:true,docs:[doc]}});
  if(endpoint==='environment')return route.fulfill({json:{state:'ready',ready:true,supported:true}});
  if(endpoint==='map')return route.fulfill({json:{ok:false,docs:[],links:[]}});
  if(endpoint==='page')return route.fulfill({contentType:'image/png',body:Buffer.from(fixture.image.split(',')[1],'base64')});
  if(endpoint==='query'){
   const q=route.request().postDataJSON().text;
   if(delayedQuery&&q==='Robotaxi'){delayedQuery=false;await new Promise(resolve=>{releaseQuery=resolve});}
   const highlight=['robotaxi','routes'].includes(q.toLowerCase())?fixture[q.toLowerCase()]:{...missing,reason:q==='scan'?'no_text':q==='image'?'image':'no_match'};
   const hit={...doc,doc:doc.id,page:1,similarity:.85,thumb:fixture.image,highlight};
   if(q==='legacy')delete hit.highlight;
   return route.fulfill({json:{ok:true,hits:[hit]}});
  }
  if(endpoint==='highlights'){
   if(route.request().postDataJSON().text==='legacy')return route.fulfill({status:404,json:{error:'not found'}});
   if(delayedPage){delayedPage=false;await new Promise(resolve=>{releasePage=resolve});return route.fulfill({json:{ok:true,...missing}});}
   return route.fulfill({json:{ok:true,...missing}});
  }
  throw Error('Unexpected endpoint '+endpoint);
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(instance.address+'/open?key='+encodeURIComponent(instance.key));
 await page.waitForFunction(()=>typeof state!=='undefined'&&state&&!state.setup);
 if(await page.locator('#github-choice-dialog').isVisible())await page.locator('#github-choice-later').click();
 await page.locator('#tab-rag').click();await page.locator('#rag-query').waitFor();
 async function search(q){await page.locator('#rag-query input').fill(q);await page.locator('#rag-query button').click();await page.waitForFunction(q=>rag.q===q&&!rag.busy&&rag.hits.length,q);}
 await search('Robotaxi');
 assert.equal(await page.locator('#rag-page-highlights rect').count(),2,'first result opens with PDF text highlights');
 assert.equal(await page.locator('.rag-hit .rag-page-highlights rect').count(),2,'thumbnail has the same matches');
 assert.equal(await page.locator('.rag-document-open mark').innerText(),'Robotaxi');
 assert.equal(await page.locator('.rag-document-open img').count(),0,'unsafe filename stays text');
 for(const theme of ['apple','apple-dark','classic']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const width of [1280,768,414,375,320]){
   await page.setViewportSize({width,height:900});
   const metrics=await page.locator('#rag-page-highlights').evaluate((el,box)=>{
    const overlay=el.getBoundingClientRect(),image=el.previousElementSibling.getBoundingClientRect(),rect=el.querySelector('rect').getBoundingClientRect();
    return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,offsetX:Math.abs(overlay.x-image.x),offsetY:Math.abs(overlay.y-image.y),widthDifference:Math.abs(overlay.width-image.width),heightDifference:Math.abs(overlay.height-image.height),matchX:Math.abs(rect.x-image.x-image.width*box.x),fill:getComputedStyle(el.querySelector('rect')).fill};
   },fixture.robotaxi.rects[0]);
   assert.ok(metrics.pageWidth<=width+1);for(const key of ['offsetX','offsetY','widthDifference','heightDifference','matchX'])assert.ok(metrics[key]<1.1,key+' at '+width);
   assert.equal(metrics.fill,'rgb(255, 229, 0)');layouts.push({theme,...metrics});
   if(width===1280)await page.screenshot({path:path.join(out,theme+'.png')});
  }
 }
 await page.setViewportSize({width:1280,height:900});
 await page.locator('#rag-next').click();await page.waitForFunction(()=>document.querySelector('#rag-highlight-status').textContent.includes('일치하는 검색어가 없습니다'));
 assert.equal(await page.locator('#rag-page-highlights rect').count(),0);
 await page.locator('#rag-prev').click();assert.equal(await page.locator('#rag-page-highlights rect').count(),2);
 delayedPage=true;await page.locator('#rag-next').click();
 for(let i=0;i<100&&!releasePage;i++)await wait(10);assert.ok(releasePage);
 await search('routes');assert.equal(await page.locator('#rag-page-highlights rect').count(),1);
 releasePage();await page.waitForTimeout(100);assert.equal(await page.locator('#rag-page-highlights rect').count(),1,'stale page response ignored');
 delayedQuery=true;await page.locator('#rag-query input').fill('Robotaxi');await page.locator('#rag-query button').click();
 for(let i=0;i<100&&!releaseQuery;i++)await wait(10);assert.ok(releaseQuery);
 await search('routes');releaseQuery();await page.waitForTimeout(100);
 assert.equal(await page.locator('#rag-query input').inputValue(),'routes');assert.equal(await page.locator('#rag-page-highlights rect').count(),1,'stale query response ignored');
 for(const [q,message] of [['no-match','일치하는 검색어가 없습니다'],['scan','텍스트가 없는 PDF'],['image','이미지는 검색 위치'],['legacy','검색 서비스를 다시 시작']]){
  await search(q);await page.waitForFunction(message=>document.querySelector('#rag-highlight-status')?.textContent.includes(message),message);
  assert.equal(await page.locator('#rag-page-highlights rect').count(),0,q+' does not invent a matching region');
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: real PDF highlights in three themes/five widths, thumbnails, file names, auto selection, pagination, stale responses and unsupported/old-service fallbacks');
 console.log('Evidence: '+out);
})().catch(error=>{console.error(String(error.stack||error).replace(/([?&]key=)[^\s]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 releasePage?.();releaseQuery?.();fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify({layouts,errors},null,2));
 if(browser)await browser.close();if(viewer&&viewer.exitCode===null){const exited=new Promise(r=>viewer.once('exit',r));viewer.kill();await exited;}
 const relative=path.relative(os.tmpdir(),profile);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(profile).startsWith('avhub-rag-highlight-'))fs.rmSync(profile,{recursive:true,force:true});
});
