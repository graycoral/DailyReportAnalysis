// Seed browser responses only: the actual app profile stays offline.
// This lets reading/layout tests use reports without enabling GitHub sync.
const fs=require('node:fs'),path=require('node:path');
module.exports=async function catalogFixture(page){
 const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/catalog.json'),'utf8'));
 const snapshot={catalog,commit:'a'.repeat(40),origin:'graycoral/DailyReportAnalysis',synced_at:'2026-10-18T08:00:00+09:00'};
 for(const endpoint of ['state','status'])await page.route('**/api/'+endpoint,async route=>{
  const response=await route.fetch(),data=await response.json();
  const common={...data,config:{...data.config,offline:false},sync_state:'ready',syncing:false};
  await route.fulfill({json:endpoint==='state'?{...common,snapshot}:{...common,commit:snapshot.commit,synced_at:snapshot.synced_at}});
 });
};
