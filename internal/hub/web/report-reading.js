'use strict';
// Durable per-PC reading history. Requests are serialized so a poll cannot
// overwrite a newly saved read. The server merges writes from other windows.
window.createReportReading=function({api,identity,changed}){
 let queue=Promise.resolve(),keys=new Map(),read=new Set(),ready=false,error='',revision=0;
 const fingerprints=new WeakMap();
 async function fingerprint(report){
  const value=identity(report),cached=fingerprints.get(report);
  if(cached?.value===value)return cached.promise;
  const promise=crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)).then(bytes=>[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join(''));
  fingerprints.set(report,{value,promise});return promise;
 }
 function accept(value){read=new Set(value.read_keys||[]);ready=!!value.initialized;error='';revision++}
 function enqueue(work){
  const result=queue.then(work).catch(e=>{error=e.message;changed();throw e});
  queue=result.catch(()=>{});return result;
 }
 return {
  refresh(reports,{initialize=true}={}){return enqueue(async()=>{
   let next=keys;
   if(reports)next=new Map(await Promise.all(reports.map(async r=>[r.id,await fingerprint(r)])));
   let value=await api('/api/report-reading');
   // First use establishes a baseline. Existing archive items are not "new".
   if(!value.initialized&&initialize)value=await api('/api/report-reading',{action:'initialize',read_keys:[...new Set(next.values())]});
   keys=next;accept(value);changed();
  })},
  mark(report){return enqueue(async()=>{
   if(!ready)return;
   const key=await fingerprint(report);keys.set(report.id,key);
   if(!read.has(key))accept(await api('/api/report-reading',{action:'read',read_keys:[key]}));
   changed();
  })},
  unread(id){return ready&&!error&&keys.has(id)&&!read.has(keys.get(id))},
  get ready(){return ready},get error(){return error},get revision(){return revision}
 };
};
