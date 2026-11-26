
/* 边框小兔子：只观察 6 个框的开关，不改动任何原有事件与数据 */
(function(){
 var b=document.getElementById('bunny');
 var map=[
  ['card','card'],['sheet','box'],['searchPanel','searchPanel'],
  ['minePanel','minePanel'],['adminGate','adminGate'],['admin','admin']
 ];
 var last={},prev={},active=null,raf=null;
 function hide(){
  if(raf){cancelAnimationFrame(raf);raf=null}
  b.className='';active=null;
 }
 /* 逐帧贴着框走：面板浮入 / 缩放时兔子始终骑在顶边金线上，不掉进框里 */
 function follow(panelId,boxId){
  var panel=document.getElementById(panelId),el=document.getElementById(boxId);
  function tick(){
   if(b.className!=='play'){raf=null;return}
   if(panel.className.indexOf('on')<0||document.body.classList.contains('immerse')){hide();return}
   var r=el.getBoundingClientRect();
   if(r.width>60&&r.height>40&&r.top>-40){
    b.style.setProperty('--dx',Math.max(52,Math.min(116,r.width-72))+'px');
    b.style.left=(r.left+Math.min(26,r.width*.10))+'px';
    b.style.top=(r.top-13)+'px';
   }
   raf=requestAnimationFrame(tick);
  }
  if(raf)cancelAnimationFrame(raf);
  raf=requestAnimationFrame(tick);
 }
 function play(id,boxId){
  if(document.body.classList.contains('immerse'))return;
  if(document.getElementById('photoView').className.indexOf('on')>=0)return;
  var now=Date.now();
  if(now-(last[id]||0)<1400)return;            /* 抖动/连点不重复播 */
  last[id]=now;
  var el=document.getElementById(boxId);if(!el)return;
  var r=el.getBoundingClientRect();
  if(r.width<60||r.height<40)return;
  b.style.setProperty('--dx',Math.max(52,Math.min(116,r.width-72))+'px');
  b.style.left=(r.left+Math.min(26,r.width*.10))+'px';
  b.style.top=(r.top-13)+'px';
  active=id;
  b.className='';void b.offsetWidth;b.className='play';   /* 强制重排，每次开框都重播 */
  follow(id,boxId);
 }
 map.forEach(function(pair){
  var id=pair[0],boxId=pair[1],el=document.getElementById(id);if(!el)return;
  prev[id]=el.className.indexOf('on')>=0;
  new MutationObserver(function(){
   var on=el.className.indexOf('on')>=0;
   if(on&&!prev[id])play(id,boxId);
   else if(!on&&prev[id]&&active===id)hide();
   prev[id]=on;
  }).observe(el,{attributes:true,attributeFilter:['class']});
 });
 b.addEventListener('animationend',hide);
})();
