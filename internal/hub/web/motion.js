'use strict';
// Scope motion to pointer interactions. Keyboard and assistive clicks stay immediate.
(()=>{
 const root=document.documentElement;
 const input=kind=>{if(root.dataset.uiInput!==kind)root.dataset.uiInput=kind};
 input('keyboard');
 document.addEventListener('pointerdown',()=>input('pointer'),{capture:true,passive:true});
 document.addEventListener('pointermove',event=>{
  if(event.movementX||event.movementY)input('pointer');
 },{capture:true,passive:true});
 document.addEventListener('keydown',()=>input('keyboard'),true);
 document.addEventListener('click',event=>{if(event.detail===0)input('keyboard')},true);
})();
