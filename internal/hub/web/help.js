'use strict';
// Enhance the section links into tabs. Without JavaScript, every guide remains readable.
(()=>{
 const list=document.querySelector('.guide-jump'),tabs=[...list.querySelectorAll('a')];
 const panels=tabs.map(link=>document.querySelector(link.hash));
 list.setAttribute('role','tablist');
 list.setAttribute('aria-label','탭별 사용법');
 tabs.forEach((link,i)=>{
  const id=panels[i].id;
  link.id='guide-tab-'+id;
  panels[i].id='guide-panel-'+id;
  link.setAttribute('role','tab');
  link.setAttribute('aria-controls',panels[i].id);
  panels[i].setAttribute('role','tabpanel');
  panels[i].setAttribute('aria-labelledby',link.id);
  panels[i].tabIndex=0;
 });
 function select(id,remember=false){
  const index=Math.max(0,tabs.findIndex(link=>link.hash==='#'+id));
  tabs.forEach((link,i)=>{
   link.setAttribute('aria-selected',String(i===index));
   link.tabIndex=i===index?0:-1;
   panels[i].hidden=i!==index;
  });
  if(remember&&location.hash!==tabs[index].hash)history.pushState(null,'',tabs[index].hash);
 }
 tabs.forEach((link,i)=>{
  link.addEventListener('click',event=>{
   if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
   event.preventDefault();select(link.hash.slice(1),true);
  });
  link.addEventListener('keydown',event=>{
   let next;
   if(event.key==='ArrowRight')next=(i+1)%tabs.length;
   else if(event.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;
   else if(event.key==='Home')next=0;
   else if(event.key==='End')next=tabs.length-1;
   else if(event.key===' '||event.key==='Enter')next=i;
   else return;
   event.preventDefault();select(tabs[next].hash.slice(1),true);tabs[next].focus();
  });
 });
 const fromURL=event=>{
  if(event&&['#top','#guide-main'].includes(location.hash))return;
  select(location.hash.slice(1).split('&')[0]);
 };
 window.addEventListener('popstate',fromURL);
 window.addEventListener('hashchange',fromURL);
 fromURL();
})();
