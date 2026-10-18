// Called from the isolated help UI suite. No external service or saved setting changes.
const assert=require('node:assert/strict');
module.exports=async function checkAppMotion(page){
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.locator('#tab-timeline').click();
 assert.ok(await page.locator('.event').count(),'fixture has timeline entries');
 assert.equal(await page.locator('.event').evaluateAll(es=>es.flatMap(e=>e.getAnimations({subtree:true})).length),0,'timeline never restarts an entrance on navigation');
 const filter=page.locator('#filter-toggle');await filter.hover();await page.mouse.down();
 await page.waitForFunction(()=>new DOMMatrix(getComputedStyle(document.querySelector('#filter-toggle')).transform).a<.99);
 await page.mouse.up();
 assert.equal(await filter.locator('span').evaluate(e=>getComputedStyle(e).transitionDuration),'0.16s');
 await page.keyboard.press('Enter');
 assert.equal(await filter.locator('span').evaluate(e=>getComputedStyle(e).transitionDuration),'0s','keyboard cancels arrow motion');
 // An app interaction policy must not disable functional editor caret blinking.
 await page.locator('#tab-notes').click();
 await page.locator('#note-new').click();
 await page.locator('.cm-content').click();await page.keyboard.press('ArrowLeft');
 assert.notEqual(await page.locator('.cm-cursorLayer').evaluate(e=>getComputedStyle(e).animationName),'none','keyboard input preserves the editor caret');
 await page.locator('#tab-timeline').click();

 for(const id of ['connections-dialog','pdf-links-dialog','github-choice-dialog','rag-warning','data-trash-dialog']){
  await page.mouse.move(0,0);
  await filter.hover();
  const frames=await page.evaluate(id=>{
   const d=document.getElementById(id);d.showModal();getComputedStyle(d).opacity;
   const animations=d.getAnimations().filter(a=>a.effect.target===d);
   for(const a of animations){a.pause();a.currentTime=a.effect.getTiming().duration/2}
   return {properties:animations.map(a=>a.transitionProperty),opacity:Number(getComputedStyle(d).opacity),duration:getComputedStyle(d).transitionDuration};
  },id);
  assert.ok(frames.properties.includes('opacity')&&frames.properties.includes('transform'),id+' actually animates');
  assert.ok(frames.opacity>0&&frames.opacity<1,id+' midpoint opacity');assert.equal(parseFloat(frames.duration),.22);
  await page.evaluate(id=>{const d=document.getElementById(id);for(const a of d.getAnimations())a.finish();d.close()},id);
  assert.equal(await page.locator('#'+id).evaluate(d=>d.open),false);
  assert.equal(await page.locator('#'+id).evaluate(d=>getComputedStyle(d,'::backdrop').pointerEvents),'none','closing scrim never blocks input');
  await page.evaluate(id=>document.getElementById(id).showModal(),id);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#'+id).evaluate(d=>getComputedStyle(d).display),'none','Escape interrupts '+id);
 }
 await page.locator('#tab-settings').click();
 const toggle=page.locator('.github-switch input');const original=await toggle.isChecked();
 await toggle.click();
 assert.equal(await toggle.evaluate(e=>getComputedStyle(e,'::before').transitionDuration),'0.16s','switch pseudo-element uses shared motion');
 await page.keyboard.press('Space');assert.equal(await toggle.isChecked(),original);
 assert.equal(await toggle.evaluate(e=>getComputedStyle(e,'::before').transitionDuration),'0s','keyboard cancels pseudo-element motion');
 await toggle.hover();await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await toggle.evaluate(e=>getComputedStyle(e,'::before').transitionDuration),'0s','reduced motion includes pseudo-elements');
 await page.locator('#tab-timeline').click();
 console.log('PASS app motion: command press, instant timeline, five modal midpoints/Escape/reopen, switch keyboard/reduced motion');
};
