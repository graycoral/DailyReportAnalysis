// Real input and production map code, with synthetic documents in an isolated
// offline profile. Deterministic work counts complement elapsed-time evidence.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'avhub-note-performance-'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewer,browser;
(async()=>{
 const version=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)[1];
 fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({owner:'graycoral',repo:'DailyReportAnalysis',branch:'main',sync_time:'08:00',configured:true,offline:true,github_choice_version:version}));
 viewer=spawn(process.env.AV_NOTES_VIEWER||path.join(root,'dist/AVReportHub.exe'),['--no-browser','--data-dir',profile],{windowsHide:true,stdio:'ignore'});
 const file=path.join(profile,'instance-viewer.json');for(let i=0;i<150&&!fs.existsSync(file);i++)await wait(100);
 assert.ok(fs.existsSync(file),'viewer started');const instance=JSON.parse(fs.readFileSync(file,'utf8'));
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto(instance.address+'/open?key='+instance.key);
 await page.waitForFunction(()=>!!window.AVNotes);
 const body=('# Long document\n\n'+'Plain Markdown text for typing latency. '.repeat(220)+'\n\n').repeat(52);
 const note=await page.evaluate(async body=>{
  const response=await fetch('/api/notes/save',{method:'POST',headers:{'X-AV-Request':'1','Content-Type':'application/json'},body:JSON.stringify({path:'large.md',body})});
  if(!response.ok)throw Error(await response.text());return response.json();
 },body);
 await page.locator('#tab-notes').click();await page.evaluate(id=>window.AVNotes.open(id),note.id);
 await page.locator('#note-mode').selectOption('source');
 await page.evaluate(()=>{
  window.previewWrites=0;
  new MutationObserver(records=>{window.previewWrites+=records.filter(r=>r.type==='childList').length}).observe(document.querySelector('#note-preview'),{childList:true});
 });
 const editor=page.locator('#note-editor .cm-content');await editor.click();await page.keyboard.press('Control+End');
 for(const text of [' A',' B',' C'])await page.keyboard.insertText(text);
 await wait(250);
 assert.equal(await page.evaluate(()=>window.previewWrites),0,'source typing must not parse or replace the hidden preview');
 await page.locator('#note-mode').selectOption('split');
 await page.waitForFunction(()=>document.querySelector('#note-preview').textContent.includes('A B C'));
 await page.evaluate(()=>{window.previewWrites=0});
 await editor.click();await page.keyboard.press('Control+End');
 for(const text of [' D',' E',' F'])await page.keyboard.insertText(text);
 await page.waitForFunction(()=>document.querySelector('#note-preview').textContent.includes(' D E F'));
 const writes=await page.evaluate(()=>window.previewWrites);assert.ok(writes>=1&&writes<=2,'rapid input batches visible preview work');
 await page.locator('#note-mode').selectOption('source');
 await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' latest');
 await page.locator('#note-mode').selectOption('read');
 await page.waitForFunction(()=>document.querySelector('#note-preview').textContent.includes(' latest'));
 console.log(JSON.stringify({documentBytes:Buffer.byteLength(body),sourcePreviewWrites:0,batchedPreviewWrites:writes}));
 await page.evaluate(()=>window.AVNotes.flush());

 const map=await browser.newPage({viewport:{width:1000,height:700}});
 await map.setContent('<style>body{margin:0;font-family:Arial}svg{width:100%;height:600px}.mn text{font-size:13px}.mn.report text{font-weight:600}</style><div id="viewer"></div>');
 await map.addScriptTag({path:path.join(root,'internal/hub/web/map-view.js')});
 const metrics=await map.evaluate(()=>{
  let svgReads=0,canvasReads=0;
  const oldSVG=SVGTextContentElement.prototype.getComputedTextLength,oldCanvas=CanvasRenderingContext2D.prototype.measureText;
  SVGTextContentElement.prototype.getComputedTextLength=function(){svgReads++;return oldSVG.call(this)};
  CanvasRenderingContext2D.prototype.measureText=function(text){canvasReads++;return oldCanvas.call(this,text)};
  let controller;
  function render(){
   controller?.stop();
   document.querySelector('#viewer').innerHTML='<div class="map"><svg><g class="viewport"></g></svg><div class="map-caption"></div>'+['zoom-in','zoom-out','overview','nearby','wide'].map(id=>`<button id="map-${id}"></button>`).join('')+'</div>';
   const svg=document.querySelector('svg'),vp=svg.querySelector('g'),nodes=[],N=[],adj=new Map();
   for(let i=0;i<500;i++){
    const node={label:`${i} `+'한글😀 long label '.repeat(9),kind:i%2?'report':'note',deg:1,x:(i%25)*40,y:Math.floor(i/25)*28};nodes.push(node);adj.set(node,new Set());
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');g.setAttribute('class','mn '+node.kind);g.innerHTML='<circle r="6"></circle><text></text>';vp.append(g);N.push(g);
   }
   const start=performance.now();controller=AVMapViewport({svg,nodes,N,adj,links:[]});return performance.now()-start;
  }
  const coldMs=render(),coldCanvasReads=canvasReads,coldSVGReads=svgReads;
  canvasReads=0;const warmMs=render(),warmCanvasReads=canvasReads;
  const widths=Array.from(document.querySelectorAll('text'),el=>oldSVG.call(el));
  document.querySelector('style').textContent+=' .mn text{font-size:18px;font-family:monospace}';
  canvasReads=0;controller.update();const fontChangeReads=canvasReads;
  const largeWidths=Array.from(document.querySelectorAll('text'),el=>oldSVG.call(el));
  controller.stop();return {coldMs,warmMs,coldCanvasReads,coldSVGReads,warmCanvasReads,fontChangeReads,maxWidth:Math.max(...widths),largeMaxWidth:Math.max(...largeWidths)};
 });
 assert.equal(metrics.coldSVGReads,0,'no synchronous SVG width measurements');
 assert.ok(metrics.coldCanvasReads<500*14,'binary search bounds width measurements');
 assert.equal(metrics.warmCanvasReads,0,'map recreation reuses label measurements');
 assert.ok(metrics.fontChangeReads>0,'font changes invalidate cached measurements');
 assert.ok(metrics.maxWidth<=221&&metrics.largeMaxWidth<=221,'labels fit with both font sizes');
 console.log(JSON.stringify({map500:metrics}));
 assert.deepEqual(errors,[]);
 console.log('PASS: large-document input, hidden/visible preview scheduling, fresh mode switches, bounded map measurement and cross-render/font-aware cache');
})().catch(e=>{console.error(String(e.stack||e).replace(/([?&]key=)[a-f0-9]+/g,'$1[redacted]'));process.exitCode=1}).finally(async()=>{
 await browser?.close();if(viewer&&viewer.exitCode===null){const exited=new Promise(resolve=>viewer.once('exit',resolve));viewer.kill();await exited}
 const relative=path.relative(os.tmpdir(),profile);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(profile).startsWith('avhub-note-performance-'))fs.rmSync(profile,{recursive:true,force:true});
});
