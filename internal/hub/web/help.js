'use strict';
// Enhance the section links into tabs. Without JavaScript, every guide remains readable.
(()=>{
 const version=document.querySelector('[data-app-version]');
 fetch('/api/ping',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error();return response.json()}).then(info=>{
  if(typeof info.version!=='string'||!info.version)throw Error();
  version.textContent='v'+info.version;
 }).catch(()=>{version.textContent='버전 확인 불가'});
 const connection=document.querySelector('[data-guide-connection]');
 const connectionStates={
  ready:'연결되어 있어요. 아래 GitHub 안내에 따라 데일리리포트를 읽어 보세요.',
  checking:'GitHub 자료를 확인하고 있어요. 리포트 화면에서 완료 안내를 확인하세요.',
  offline:'연동이 꺼져 있어요. 아래 Outlook 메일함·PST 또는 파일 가져오기로 시작하세요.',
  auto_disabled:'연결 실패로 연동이 꺼졌어요. Outlook·PST로 시작하거나 설정에서 다시 연결할 수 있어요.',
  unavailable:'GitHub 연결을 확인하지 못했어요. Outlook·PST로 시작하거나 설정을 확인하세요.',
  choice_required:'아직 연동 여부를 선택하지 않았어요. 리포트 화면에서 연동하기 또는 연동하지 않기를 선택하세요.',
  unconfigured:'GitHub 연결 설정 전이에요. 아래 연결 안내를 따르거나 Outlook·PST로 시작하세요.'
 };
 let connectionRequest;
 async function refreshConnection(){
  if(connectionRequest)return;
  const controller=new AbortController();connectionRequest=controller;
  const timeout=setTimeout(()=>controller.abort(),5000);
  try{
   const response=await fetch('/api/status',{cache:'no-store',signal:controller.signal});
   if(!response.ok)throw Error();
   const status=await response.json();
   connection.textContent=connectionStates[status.sync_state]||'연결 확인 대기 중이에요. 리포트 화면 상단의 상태 표시를 눌러 확인하세요.';
  }catch{connection.textContent='상태를 불러오지 못했어요. 리포트 화면 상단의 상태 표시를 눌러 확인하세요.'}
  finally{clearTimeout(timeout);connectionRequest=null}
 }
 refreshConnection();
 window.addEventListener('focus',refreshConnection);
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
  const id=location.hash.slice(1).split('&')[0],target=document.getElementById(id);
  const parent=target&&panels.findIndex(panel=>panel.contains(target));
  if(target&&parent>=0){
   select(tabs[parent].hash.slice(1));
   // Reveal the owning panel before scrolling to a setup step, including on reload.
   requestAnimationFrame(()=>target.scrollIntoView({block:'start'}));
  }else select(id);
 };
 window.addEventListener('popstate',fromURL);
 window.addEventListener('hashchange',fromURL);
 fromURL();
})();
