// Run with: node scripts/check-rag-ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const source = script.slice(script.indexOf('// Environment setup is separate'));
assert.ok(source.startsWith('// Environment setup'));
const slot = {innerHTML:''};
let environment = {state:'missing',supported:true,message:'환경 설정이 필요합니다.'};
let service = false, renders = 0, posts = 0, release;
const ctx = vm.createContext({
  rag:{status:{ok:false}}, tab:'rag',
  esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  $:selector=>selector==='#rag-environment'?slot:null,
  setTimeout:()=>1,clearTimeout:()=>{},toast:()=>{},
  render:()=>{renders++},
  api:async(url)=>{
    if(url==='/api/rag/environment')return environment;
    posts++;
    await new Promise(resolve=>{release=resolve});
    environment={state:'installing',supported:true,busy:true,message:'설치 중'};
    return {ok:true};
  },
  ragStatus:async()=>{ctx.rag.status={ok:service}},
});
vm.runInContext(source,ctx);
const evaluate=code=>vm.runInContext(code,ctx);
const html=()=>evaluate('ragEnvironmentHtml()');
const state=value=>{ctx.nextState=value;evaluate('ragEnvironmentState=nextState')};

(async()=>{
  state(environment);
  assert.match(html(),/id="rag-setup"/);
  assert.doesNotMatch(html(),/환경 설정 완료/);

  state({state:'installing',busy:true,message:'패키지 설치 중'});
  assert.match(html(),/환경 설정 중/);
  assert.match(html(),/id="rag-setup" disabled/);

  state({state:'ready',ready:true,supported:true,message:'검증 완료'});
  assert.match(html(),/환경 설정 완료/);
  assert.match(html(),/서비스 꺼짐/);
  assert.match(html(),/id="rag-start"/);

  ctx.rag.status={ok:true};
  state({state:'missing',supported:true});
  assert.match(html(),/환경 설정 완료/);
  assert.match(html(),/서비스 실행 중/);
  assert.doesNotMatch(html(),/id="rag-setup"|id="rag-start"/);

  ctx.rag.status={ok:false};
  state({state:'error',python_required:true,message:'<img src=x onerror=alert(1)>'});
  assert.match(html(),/Python 공식 설치 페이지/);
  assert.match(html(),/환경 설정 다시 시도/);
  assert.doesNotMatch(html(),/<img src=x/);

  // Polling a stable service updates only the setup card, preserving search inputs.
  state(environment);
  await evaluate('pollRagEnvironment()');
  assert.equal(renders,0);
  assert.equal(posts,0);
  assert.match(slot.innerHTML,/환경 설정/);
  service=true;
  await evaluate('pollRagEnvironment()');
  assert.equal(renders,1);

  // A second click while the first request is pending cannot start a second install.
  service=false;ctx.rag.status={ok:false};state(environment);
  const first=evaluate("ragEnvironmentTask('setup')");
  await evaluate("ragEnvironmentTask('setup')");
  assert.equal(posts,1);
  release();
  await first;
  assert.match(html(),/환경 설정 중/);
  assert.equal(evaluate('ragEnvironmentAction'),false);

  // Navigating away stops polling; it does not create or launch any environment.
  ctx.tab='search';
  const prior=renders;
  await evaluate('pollRagEnvironment()');
  assert.equal(renders,prior);
  assert.equal(posts,1);
  console.log('PASS: missing/installing/ready/external service/error, polling and duplicate-click protection');
})().catch(error=>{console.error(error);process.exitCode=1});
