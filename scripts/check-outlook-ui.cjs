// Run with: node scripts/check-outlook-ui.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname,'../internal/hub/web/app.js'),'utf8');
const source = app.slice(app.indexOf('// Outlook path form:'));
assert.ok(source.startsWith('// Outlook path form:'));
assert.ok(app.includes('${outlookPathHtml()}'));
assert.ok(app.includes('bindOutlookPathForm();'));
function fixture(){
 const input={value:'',attributes:{},focus(){this.focused=true},setAttribute(k,v){this.attributes[k]=v}};
 const button={disabled:false,textContent:''};
 const browse={disabled:false,textContent:''};
 const status={hidden:true,textContent:'',classes:new Set(),classList:{toggle(k,on){if(on)status.classes.add(k);else status.classes.delete(k)}}};
 const form={elements:{namedItem:()=>input},querySelector:()=>button,setAttribute(){}};
 let timer,implementation=async()=>{throw Error('Unexpected request')};
 const calls=[];
 const context=vm.createContext({
  window:{},
  $:selector=>({'#pst-form':form,'#pst-status':status,'#pst-browse':browse}[selector]),
  esc:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  local:{sources:[],files:[],mails:[]},
  api:async(...args)=>{calls.push(args);return implementation(...args)},
  render:()=>{},AbortController,
  setTimeout:fn=>{timer=fn;return 1},clearTimeout:()=>{timer=null},
 });
 vm.runInContext(source,context);
 const evaluate=code=>vm.runInContext(code,context);
 evaluate('bindOutlookPathForm()');
 return {
  input,button,browse,status,form,calls,context,evaluate,
  type(value){input.value=value;input.oninput({target:input})},
  submit(){return form.onsubmit({currentTarget:form,preventDefault(){}})},
  respond(fn){implementation=fn},
  expire(){assert.ok(timer);timer()},
 };
}
(async()=>{
 // The primary action opens the native picker without needing a typed path.
 let f=fixture(),releasePicker;
 f.respond(async(url,body)=>{
  if(url==='/api/outlook/pick')return new Promise(resolve=>{releasePicker=resolve});
  if(url==='/api/outlook/source'){
   assert.equal(body.source.path,'D:\\회사 메일\\보관.pst');
   return {ok:true};
  }
  assert.equal(url,'/api/local');
  return {available:true,sources:[{path:'D:\\회사 메일\\보관.pst',name:'보관.pst'}]};
 });
 const picking=f.browse.onclick();
 assert.equal(f.calls[0][0],'/api/outlook/pick');
 assert.equal(f.browse.disabled,true);
 assert.equal(f.button.disabled,true);
 assert.equal(f.input.readOnly,true);
 assert.match(f.status.textContent,/파일 선택 창/);
 await f.browse.onclick();await f.submit();
 assert.equal(f.calls.length,1,'duplicate clicks must not open additional dialogs or save');
 f.evaluate('bindOutlookPathForm()');
 assert.equal(f.browse.disabled,true,'re-render must keep picker busy');
 releasePicker({path:'D:\\회사 메일\\보관.pst',cancelled:false});
 await picking;
 assert.equal(f.context.local.sources.length,1);
 assert.match(f.status.textContent,/추가했습니다/);
 assert.equal(f.browse.disabled,false);

 // Cancel preserves the draft and does not save; a later picker can succeed.
 f=fixture();f.type('C:\\draft.pst');
 f.respond(async()=>({path:'',cancelled:true}));
 await f.browse.onclick();
 assert.equal(f.calls.length,1);
 assert.equal(f.input.value,'C:\\draft.pst');
 assert.match(f.status.textContent,/취소/);
 assert.equal(f.status.classes.has('error'),false);
 assert.equal(f.browse.disabled,false);
 f.respond(async()=>{throw Error('파일 선택 창을 열지 못했습니다.')});
 await f.browse.onclick();
 assert.match(f.status.textContent,/열지 못했습니다/);
 assert.equal(f.input.value,'C:\\draft.pst');
 assert.equal(f.input.readOnly,false);
 assert.equal(f.browse.disabled,false);

 // Picker results still use the same extension and duplicate validation as typed paths.
 f=fixture();f.respond(async()=>({path:'C:\\wrong.pdf',cancelled:false}));
 await f.browse.onclick();
 assert.equal(f.calls.length,1);
 assert.match(f.status.textContent,/PST 또는 OST/);
 f.context.local.sources=[{path:'C:\\mail.pst'}];
 f.respond(async()=>({path:'c:\\MAIL.PST',cancelled:false}));
 await f.browse.onclick();
 assert.equal(f.calls.length,2);
 assert.match(f.status.textContent,/이미 추가된/);

 // Empty and folder-only submissions must show a persistent message and focus the input.
 f=fixture();
 await f.submit();
 assert.match(f.status.textContent,/전체 경로를 먼저 입력/);
 assert.equal(f.status.hidden,false);
 assert.equal(f.input.focused,true);
 assert.equal(f.input.attributes['aria-invalid'],'true');
 assert.equal(f.calls.length,0);
 f.type('D:\\메일');
 await f.submit();
 assert.match(f.status.textContent,/폴더 경로만으로는/);
 assert.equal(f.calls.length,0);

 // Explorer "Copy as path" is accepted; save feedback starts before the request finishes.
 f=fixture();
 f.type('  "D:\\메일\\보관.pst"  ');
 let release;
 f.respond(async(url,body)=>{
  if(url==='/api/outlook/source'){
   assert.equal(body.source.path,'D:\\메일\\보관.pst');
   await new Promise(resolve=>{release=resolve});
   return {ok:true};
  }
  return {available:true,sources:[{path:'D:\\메일\\보관.pst',name:'보관.pst'}]};
 });
 const save=f.submit();
 assert.equal(f.button.disabled,true);
 assert.equal(f.input.readOnly,true);
 assert.match(f.status.textContent,/확인하고 저장/);
 await f.submit();
 assert.equal(f.calls.length,1);
 release();
 await save;
 assert.equal(f.context.local.sources.length,1);
 assert.equal(f.button.disabled,false);
 assert.equal(f.input.value,'');
 assert.match(f.status.textContent,/추가했습니다/);

 // A duplicate cannot silently make another request.
 f.type('d:\\메일\\보관.PST');
 const before=f.calls.length;
 await f.submit();
 assert.match(f.status.textContent,/이미 추가된/);
 assert.equal(f.calls.length,before);

 // Errors stay beside the input and leave the path available for editing/retry.
 f=fixture();
 f.type('C:\\mail.ost');
 f.respond(async()=>{throw Error('파일을 찾을 수 없습니다.')});
 await f.submit();
 assert.match(f.status.textContent,/파일을 찾을 수 없습니다/);
 assert.equal(f.input.value,'C:\\mail.ost');
 assert.equal(f.button.disabled,false);
 assert.equal(f.input.readOnly,false);
 f.type('C:\\fixed.ost');
 assert.equal(f.status.hidden,true);

 // Hung requests are cancelled and controls are re-enabled.
 f=fixture();f.type('C:\\mail.pst');
 f.respond((url,body,options)=>new Promise((resolve,reject)=>{
  options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
 }));
 const waiting=f.submit();
 f.expire();
 await waiting;
 assert.match(f.status.textContent,/시간이 초과/);
 assert.equal(f.button.disabled,false);
 assert.equal(f.input.value,'C:\\mail.pst');

 // Successful storage must not be reported as a failed save if only list refresh fails.
 f=fixture();f.type('C:\\mail.pst');
 f.respond(async url=>{
  if(url==='/api/outlook/source')return {ok:true};
  throw Error('refresh failed');
 });
 await f.submit();
 assert.match(f.status.textContent,/경로는 저장됐지만/);
 assert.equal(f.input.value,'');
 assert.equal(f.button.disabled,false);

 // Typed values are escaped and retained when the surrounding page re-renders.
 f=fixture();f.type('C:\\<img src=x>.pst');
 assert.ok(f.evaluate('outlookPathHtml()').includes('&lt;img src=x&gt;'));
 f.evaluate('bindOutlookPathForm()');
 assert.equal(f.input.value,'C:\\<img src=x>.pst');
 console.log('PASS: Outlook native picker, selection/save, cancellation, repeated clicks, validation, quoted paths, errors, timeout, refresh failure and draft retention');
})().catch(error=>{console.error(error);process.exitCode=1});
