const assert = require('node:assert/strict');
const vm = require('node:vm');
const {build} = require('esbuild');
(async()=>{
 const compiled=await build({entryPoints:['frontend/note-listing.js'],bundle:true,platform:'node',format:'cjs',write:false});
 const module={exports:{}};vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports});
 const a={id:'a',body:'large body',modified:'1'},b={id:'b',body:'old',modified:'2'};
 const replies=[{root:'one',revision:'1',notes:[b,a]}, {root:'one',revision:'1',delta:true,notes:[]}, {root:'one',revision:'2',delta:true,notes:[{...b,body:'edited',modified:'3'}]}, {root:'one',revision:'3',delta:true,notes:[],deleted:['a']}, {root:'two',revision:'1',notes:[]}];
 const revisions=[];const listing=module.exports.createNoteListing(async revision=>{revisions.push(revision);return replies.shift()});
 const first=await listing(),unchanged=await listing();assert.strictEqual(first.notes,unchanged.notes);
 const edit=await listing();assert.strictEqual(edit.notes[1],a);assert.equal(edit.notes[0].body,'edited');
 const removed=await listing();assert.deepEqual(Array.from(removed.notes,n=>n.id),['b']);
 assert.equal((await listing()).notes.length,0);assert.deepEqual(revisions,['','1','1','2','3']);
 let finish,calls=0;const waiting=module.exports.createNoteListing(()=>{calls++;return new Promise(resolve=>{finish=resolve})});
 const earlier=waiting(),shared=waiting(),fresh=waiting(true);assert.strictEqual(earlier,shared);assert.equal(calls,1);
 finish({root:'one',revision:'1',notes:[]});await earlier;await Promise.resolve();assert.equal(calls,2,'a save waits out an older listing and then refreshes');
 finish({root:'one',revision:'2',notes:[]});assert.equal((await fresh).revision,'2');
 console.log('PASS: note delta merge, unchanged snapshot identity, deletions, root reset and overlapping save/poll requests');
})().catch(e=>{console.error(e);process.exitCode=1});
