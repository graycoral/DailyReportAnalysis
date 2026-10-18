// Run all browser regressions against a fresh Windows build.
// Override AV_NAV_VIEWER to test a different executable.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const viewer=path.resolve(root,process.env.AV_NAV_VIEWER||'dist/AVReportHub.exe');
if(!fs.existsSync(viewer))throw Error('Build the Windows app first or set AV_NAV_VIEWER: '+viewer);
const env={...process.env,AV_NAV_VIEWER:viewer,AV_HELP_VIEWER:viewer,AV_NOTES_VIEWER:viewer,AV_PDF_VIEWER:viewer};
const checks=[
 'connections-ui','github-choice-ui','github-catalog-ui','notes-ui','note-network-ui',
 'navigation-ui','settings-ui','audit-ui','report-reading-ui','hallmark-ui','help-ui',
 'outlook-sources-ui','import-ui','pdf-preview-ui','list-actions-ui','selection-ui',
];
for(const check of checks){
 console.log('Running '+check);
 const result=spawnSync(process.execPath,[path.join(__dirname,'check-'+check+'.cjs')],{cwd:root,env,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
console.log('PASS: all '+checks.length+' browser regression suites');
