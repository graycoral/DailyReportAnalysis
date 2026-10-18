'use strict';
let githubChoiceBusy=false,githubChoiceDismissed=false;
const githubChoiceDialog=document.querySelector('#github-choice-dialog');
function updateGitHubChoice(s){
 if(typeof s.github_choice_required!=='boolean')return;
 if(state)state.github_choice_required=s.github_choice_required;
 if(s.setup||!s.github_choice_required){if(githubChoiceDialog.open&&!githubChoiceBusy)githubChoiceDialog.close();return}
 if(githubChoiceDismissed||githubChoiceBusy||githubChoiceDialog.open)return;
 document.querySelector('#github-choice-version').textContent=`설치된 버전 v${s.version||state.version} · 첫 실행 설정`;
 document.querySelector('#github-choice-feedback').textContent='';
 githubChoiceDialog.showModal();
}
function dismissGitHubChoice(){
 if(githubChoiceBusy)return;
 githubChoiceDismissed=true;githubChoiceDialog.close();
 document.querySelector('[data-tab][aria-selected="true"]')?.focus();
}
async function saveGitHubChoice(enabled){
 if(githubChoiceBusy)return;
 githubChoiceBusy=true;let saved=false;
 const feedback=document.querySelector('#github-choice-feedback');
 feedback.textContent='선택을 저장하고 있습니다…';
 githubChoiceDialog.setAttribute('aria-busy','true');
 githubChoiceDialog.querySelectorAll('button').forEach(b=>b.disabled=true);
 try{
  const result=await api('/api/github-choice',{version:state.version,enabled});
  if(!result.ok)throw Error(result.error||'선택을 저장하지 못했습니다. 다시 시도해 주세요.');
  saved=true;state.github_choice_required=false;syncGitHubSettings(result.config,true);
  githubChoiceDialog.close();document.querySelector('[data-tab][aria-selected="true"]')?.focus();
  toast(result.config.offline?'GitHub 연동 없이 계속합니다.':'GitHub 연결과 최신 자료를 확인합니다.');
  await refresh(true);
 }catch(e){
  if(saved)toast('선택은 저장됐지만 화면을 갱신하지 못했습니다. 새로고침해 주세요.');
  else feedback.textContent=e.message;
 }finally{
  githubChoiceBusy=false;githubChoiceDialog.removeAttribute('aria-busy');
  githubChoiceDialog.querySelectorAll('button').forEach(b=>b.disabled=false);
 }
}
document.querySelector('#github-choice-later').onclick=dismissGitHubChoice;
githubChoiceDialog.addEventListener('cancel',e=>{e.preventDefault();dismissGitHubChoice()});
document.querySelector('#github-choice-no').onclick=()=>saveGitHubChoice(false);
document.querySelector('#github-choice-yes').onclick=()=>saveGitHubChoice(true);
if(typeof state!=='undefined'&&state)updateGitHubChoice(state);
