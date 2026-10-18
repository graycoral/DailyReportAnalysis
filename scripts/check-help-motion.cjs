// Run by check-help-ui.cjs with its isolated profile and fixture report.
const assert=require('node:assert/strict'),path=require('node:path');
module.exports=async function checkHelpMotion(page,help,build){
 const settle=()=>page.waitForFunction(()=>document.querySelector('#help-dialog').getAnimations({subtree:true}).every(a=>a.playState==='finished'));
 const modalState=()=>page.evaluate(()=>{
  const dialog=document.querySelector('#help-dialog'),style=getComputedStyle(dialog),backdrop=getComputedStyle(dialog,'::backdrop');
  return {open:dialog.open,modal:dialog.matches(':modal'),opacity:style.opacity,display:style.display,duration:style.transitionDuration,easing:style.transitionTimingFunction,backdropDuration:backdrop.transitionDuration,focus:document.activeElement.id};
 });
 await page.emulateMedia({reducedMotion:'no-preference'});
 await help.emulateMedia({reducedMotion:'no-preference'});
 await page.locator('#help').click();
 const enter=await modalState();
 assert.equal(enter.open,true);assert.equal(enter.modal,true);assert.equal(enter.focus,'close-help');
 assert.ok(parseFloat(enter.duration)>0&&parseFloat(enter.duration)<.3);
 assert.equal(enter.backdropDuration,enter.duration,'scrim and modal enter together');
 // Freeze the actual CSS transitions for a midpoint visual check, then complete them.
 const animated=await page.evaluate(()=>{
  const dialog=document.querySelector('#help-dialog');
  const animations=dialog.getAnimations({subtree:true}).filter(a=>a.effect.target===dialog);
  window.helpMotionFrames=animations;
  for(const animation of animations){animation.pause();animation.currentTime=animation.effect.getTiming().duration/2}
  return animations.map(a=>a.transitionProperty);
 });
 assert.ok(animated.includes('opacity')&&animated.includes('transform'),'native dialog entrance actually animates');
 await page.screenshot({path:path.join(build,'help-motion-midpoint.png')});
 await page.evaluate(()=>{for(const animation of window.helpMotionFrames)animation.finish();delete window.helpMotionFrames});
 await settle();
 await page.locator('#close-help').click();
 const exit=await modalState();
 assert.equal(exit.open,false);assert.equal(exit.modal,false);assert.equal(exit.focus,'help','native close immediately restores focus');
 assert.ok(parseFloat(exit.duration)>0&&parseFloat(exit.duration)<parseFloat(enter.duration),'exit is faster');
 assert.ok(exit.backdropDuration.split(',').every(duration=>parseFloat(duration)===parseFloat(exit.duration)));
 await settle();assert.equal((await modalState()).display,'none');

 // Escape interrupts an in-flight pointer entrance without a delayed close/focus timer.
 await page.locator('#help').click();await page.keyboard.press('Escape');
 assert.equal((await modalState()).display,'none');assert.equal((await modalState()).focus,'help');
 await page.keyboard.press('Enter');
 const keyboard=await modalState();
 assert.equal(keyboard.opacity,'1');assert.equal(keyboard.duration,'0s');assert.equal(keyboard.backdropDuration,'0s');
 await page.keyboard.press('Escape');assert.equal((await modalState()).display,'none');

 // Retarget during an exit. A stale animation completion must never close the reopened dialog.
 const trigger=await page.locator('#help').boundingBox();
 await page.locator('#help').click();await settle();
 await page.locator('#close-help').click();
 await page.mouse.click(trigger.x+trigger.width/2,trigger.y+trigger.height/2);
 await settle();assert.equal((await modalState()).modal,true);assert.equal((await modalState()).opacity,'1');
 await page.keyboard.press('Escape');

 await help.setViewportSize({width:1440,height:1000});
 const tab=help.locator('#guide-tab-outlook');await tab.hover();await help.mouse.down();
 await help.waitForFunction(()=>new DOMMatrix(getComputedStyle(document.querySelector('#guide-tab-outlook')).transform).a<.99);
 await help.mouse.up();
 assert.equal(await help.locator('#guide-panel-outlook').isVisible(),true);
 assert.equal(await help.locator('#guide-panel-outlook').evaluate(el=>el.getAnimations({subtree:true}).length),0,'reading content has no entry animation');
 await help.keyboard.press('ArrowRight');
 assert.equal(await help.locator('#guide-panel-local').isVisible(),true);
 assert.equal(await help.locator('#guide-tab-local').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 await help.keyboard.press('Home');
 await help.locator('#start-github summary').focus();await help.keyboard.press('Enter');
 assert.equal(await help.locator('#start-github details').evaluate(el=>el.open&&el.getAnimations({subtree:true}).length===0),true,'disclosure opens immediately');

 // Motion preference changes also cancel a running modal and its pseudo-element backdrop.
 await page.locator('#help').click();await page.emulateMedia({reducedMotion:'reduce'});
 const reduced=await modalState();
 assert.equal(reduced.opacity,'1');assert.equal(reduced.duration,'0s');assert.equal(reduced.backdropDuration,'0s');
 await page.locator('#close-help').click();assert.equal((await modalState()).display,'none');
 await help.emulateMedia({reducedMotion:'reduce'});
 await tab.hover();await help.mouse.down();
 assert.equal(await tab.evaluate(el=>getComputedStyle(el).transform),'none','reduced motion removes press scaling too');
 await help.mouse.up();
 console.log('PASS motion: '+JSON.stringify({enter,exit,keyboard:keyboard.duration,reduced:reduced.duration}));
};
