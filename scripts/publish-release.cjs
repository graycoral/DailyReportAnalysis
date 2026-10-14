// Publisher only; invoked by the Windows release job. No extra npm dependencies.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');

function runGh(args){
 const result=spawnSync('gh',args,{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
 if(result.error)throw result.error;
 return {status:result.status,stdout:result.stdout||'',stderr:result.stderr||''};
}
const retryable=text=>/\bHTTP\s+(?:429|5\d\d)\b|TLS handshake timeout|i\/o timeout|connection reset|unexpected EOF|context deadline exceeded|temporary failure/i.test(text);
const missing=text=>/\bHTTP\s+404\b/.test(text);
const matches=(asset,file)=>asset?.state==='uploaded'&&asset.size===file.size&&asset.digest==='sha256:'+file.sha256;

async function publishRelease(options,deps={}){
 const gh=deps.gh||runGh;
 const sleep=deps.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const log=deps.log||console.log;
 const attempts=options.attempts||5;
 const {repository,tag,commit,notesFile}=options;
 if(!/^[\w.-]+\/[\w.-]+$/.test(repository||'')||!tag||!commit)throw Error('Repository, release tag and commit are required.');
 // Validate all local inputs before creating a release or replacing any asset.
 const files=options.files.map(file=>{
  const bytes=fs.readFileSync(file);
  if(!bytes.length)throw Error('Empty release file: '+file);
  return {path:file,name:path.basename(file),size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 });
 if(!files.length||new Set(files.map(f=>f.name)).size!==files.length)throw Error('Release files must have distinct names.');
 fs.accessSync(notesFile);
 async function retry(label,args,allowMissing=false){
  for(let attempt=1;attempt<=attempts;attempt++){
   const result=await gh(args);
   const message=(result.stderr||result.stdout||'GitHub CLI failed').trim();
   if(result.status===0)return result.stdout;
   if(allowMissing&&missing(message))return null;
   if(attempt===attempts||!retryable(message))throw Error(label+': '+message);
   const delay=Math.min(2000*2**(attempt-1),30000);
   log(label+' failed ('+attempt+'/'+attempts+'); retrying in '+delay/1000+'s. '+message);
   await sleep(delay);
  }
 }
 const endpoint='repos/'+repository+'/releases/tags/'+encodeURIComponent(tag);
 const readRelease=async allowMissing=>{
  const json=await retry('Read release '+tag,['api',endpoint],allowMissing);
  return json===null?null:JSON.parse(json);
 };
 let release=await readRelease(true);
 if(!release){
  try{
   await retry('Create release '+tag,['release','create',tag,'--repo',repository,'--target',commit,'--title','AV Report Hub '+tag,'--notes-file',notesFile]);
  }catch(error){
   // A create may have succeeded before its response was lost. Do not create another release.
   release=await readRelease(true);
   if(!release)throw error;
  }
  if(!release)release=await readRelease(false);
 }
 for(const file of files){
  if(matches((release.assets||[]).find(a=>a.name===file.name),file)){
   log('Already uploaded with matching SHA-256: '+file.name);
   continue;
  }
  log('Uploading '+file.name);
  // Retry only this file; successful uploads are not deleted again when another file fails.
  await retry('Upload '+file.name,['release','upload',tag,file.path,'--repo',repository,'--clobber']);
 }
 const uploaded=await readRelease(false);
 for(const file of files){
  const asset=(uploaded.assets||[]).find(a=>a.name===file.name);
  if(!asset||asset.state!=='uploaded'||asset.size!==file.size||(asset.digest&&asset.digest!=='sha256:'+file.sha256)){
   throw Error('Release verification failed for '+file.name+': missing, incomplete or different content.');
  }
 }
 log('Release '+tag+' verified: '+files.map(f=>f.name).join(', '));
}

async function main(){
 const root=path.resolve(__dirname,'..');
 const source=fs.readFileSync(path.join(root,'internal/hub/model.go'),'utf8');
 const version=source.match(/\bVersion\s*=\s*"([^"]+)"/)?.[1];
 if(!version)throw Error('Version constant not found.');
 const tag='v'+version;
 if(process.env.GITHUB_REF_TYPE==='tag'&&process.env.GITHUB_REF_NAME!==tag)throw Error('Git tag does not match Version '+version);
 await publishRelease({
  repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA,tag,
  notesFile:path.join(root,'docs/RELEASE_NOTES.md'),
  files:['AVReportHub-Windows-x64.zip','AVReportHub-Setup.exe','AVReportHub.exe','SHA256SUMS.txt'].map(name=>path.join(root,'dist',name)),
 });
}
module.exports={publishRelease};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1});
