// Run with: node scripts/check-release.cjs (no network or GitHub credentials).
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {publishRelease}=require('./publish-release.cjs');
const base=fs.realpathSync(os.tmpdir());
const dir=fs.mkdtempSync(path.join(base,'av-release-test-'));
const names=['AVReportHub-Windows-x64.zip','AVReportHub-Setup.exe','AVReportHub.exe','SHA256SUMS.txt'];
const files=names.map(name=>{const p=path.join(dir,name);fs.writeFileSync(p,'fixture '+name);return p});
const notesFile=path.join(dir,'notes.md');fs.writeFileSync(notesFile,'Test release');
const options={repository:'example/reports',tag:'v1.0.0',commit:'a'.repeat(40),files,notesFile};
const assets=files.map(file=>({name:path.basename(file),state:'uploaded',size:fs.statSync(file).size,digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
const failed=code=>({status:1,stdout:'',stderr:'HTTP '+code+' (https://api.github.com/repos/example/reports/releases/assets/1)'});
const ok=stdout=>({status:0,stdout:stdout||'',stderr:''});
function fixture({exists=true,initial=[],readFailures=[],uploadFailures={},createLostResponse=false,omitFinal=false}={}){
 const calls=[],delays=[],remote=new Map(initial.map(a=>[a.name,{...a}]));
 let created=false,creates=0,uploads=0;
 const deps={log(){},sleep:async ms=>{delays.push(ms)},gh:async args=>{
  calls.push(args);
  if(args[0]==='api'){
   if(readFailures.length)return failed(readFailures.shift());
   if(!exists)return failed(404);
   return ok(JSON.stringify({assets:omitFinal&&uploads===files.length?[]:[...remote.values()]}));
  }
  if(args[1]==='create'){
   creates++;
   if(createLostResponse&&creates===1){exists=true;created=true;return failed(500)}
   if(exists)return failed(422);
   exists=true;created=true;return ok();
  }
  assert.equal(args[1],'upload');
  assert.equal(args.length,7,'one file per upload');
  const name=path.basename(args[3]);
  const failures=uploadFailures[name]||[];
  if(failures.length)return failed(failures.shift());
  remote.set(name,{...assets.find(a=>a.name===name)});
  uploads++;
  return ok();
 }};
 return {deps,calls,delays,remote,get created(){return created}};
}
(async()=>{
 // Retry a GitHub read failure and the exact asset that failed; do not recreate an existing release.
 let f=fixture({readFailures:[500],uploadFailures:{[names[0]]:[500]}});
 await publishRelease(options,f.deps);
 assert.equal(f.created,false);
 assert.equal(f.calls.filter(c=>c[1]==='create').length,0);
 const uploads=f.calls.filter(c=>c[1]==='upload').map(c=>path.basename(c[3]));
 assert.deepEqual(uploads,[names[0],...names]);
 assert.deepEqual(f.delays,[2000,2000]);
 // Do not clobber files already uploaded by a previous successful attempt.
 f=fixture({initial:assets});
 await publishRelease(options,f.deps);
 assert.equal(f.calls.filter(c=>c[1]==='upload').length,0);
 // HTTP 500 must not be mistaken for "release does not exist".
 f=fixture({readFailures:[500,502,503,500,500]});
 await assert.rejects(publishRelease(options,f.deps),/Read release.*HTTP 500/);
 assert.equal(f.calls.filter(c=>c[1]==='create').length,0);
 assert.deepEqual(f.delays,[2000,4000,8000,16000]);
 // A genuine 404 creates a release and verifies all expected artifacts.
 f=fixture({exists:false});
 await publishRelease(options,f.deps);
 assert.equal(f.created,true);
 assert.equal(f.remote.size,4);
 // The server created the release but its response was lost; recover after the duplicate response.
 f=fixture({exists:false,createLostResponse:true});
 await publishRelease(options,f.deps);
 assert.equal(f.created,true);
 assert.equal(f.remote.size,4);
 // Permanent errors stop immediately, keeping completed earlier uploads intact.
 f=fixture({uploadFailures:{[names[1]]:[403]}});
 await assert.rejects(publishRelease(options,f.deps),/Upload AVReportHub-Setup.exe.*HTTP 403/);
 assert.deepEqual(f.calls.filter(c=>c[1]==='upload').map(c=>path.basename(c[3])),names.slice(0,2));
 assert.equal(f.delays.length,0);
 assert.ok(f.remote.has(names[0]));
 // An outage is bounded and cannot become a green release.
 f=fixture({uploadFailures:{[names[0]]:[500,500,500,500,500]}});
 await assert.rejects(publishRelease(options,f.deps),/Upload AVReportHub-Windows-x64.zip.*HTTP 500/);
 assert.equal(f.calls.filter(c=>c[1]==='upload').length,5);
 assert.deepEqual(f.delays,[2000,4000,8000,16000]);
 // Exit status alone is insufficient: remote metadata must describe every completed upload.
 f=fixture({omitFinal:true});
 await assert.rejects(publishRelease(options,f.deps),/Release verification failed/);
 // Validate every file before making any remote changes.
 f=fixture();
 await assert.rejects(publishRelease({...options,files:[...files,path.join(dir,'missing.exe')]},f.deps),/ENOENT/);
 assert.equal(f.calls.length,0);
 console.log('PASS: transient retries, per-file recovery, checksum skip, 404/create distinction, lost response, permanent errors, retry limit and final verification');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
 const resolved=fs.realpathSync(dir);
 if(path.dirname(resolved)!==base||!path.basename(resolved).startsWith('av-release-test-'))throw Error('Unexpected test cleanup path');
 fs.rmSync(resolved,{recursive:true,force:true});
});
