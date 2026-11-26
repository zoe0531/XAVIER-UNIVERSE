
/* ============================================================
   星宙 · 云端共享版
   —— 斜向银河星 宙 + 密集星尘 + 极少量随机小流星 + 亮白五角星
   —— 所有人读写同一张 Supabase 表，编号用自增 id，删了永不重排
   —— 拖动绕整颗宇宙转圈；每批随机抽 130 颗铺满球面，支持 5 万星位
   —— 零预置；祝福可带照片；管理入口走服务端校验
   ============================================================ */
var CONFIG={
  pass:'1016',
  adminPass:'__server_side__',   /* 口令在服务端校验，前端不出现 */
  batch:130,            // 每批渲染几颗（性能上限，与总数无关）
  capacity:50000,       // 可容纳的星位
  sparkNear:1100,       // 背景亮芒星（柔）
  sparkFar:900,         // 背景亮芒星（细点）
  meteor:10,            // 小流星：极少、随机、短而淡
  maxWishes:5000,
  apiBase:'/api/wishes'   /* 数据交给本站服务端，密钥不再放前端 */
};
var loadFailed=false,retryTimer=null,retryCount=0,lastKnownN=0,emptyStreak=0;
/* 每个元素每种事件全局只绑一次：dataset 打标，后到的绑定直接跳过 */
window.__xzBind=function(el,type,fn){
 if(!el)return;
 var k='xzBound_'+type;
 if(el.dataset&&el.dataset[k])return;
 if(el.dataset)el.dataset[k]='1';
 if(type==='onclick')el.onclick=fn;else el.addEventListener(type,fn);
};
/* 一次点击只放行一次：锁到 Promise 结束，快速双击 / 双绑都不会发出第二个请求 */
window.__xzOnce=function(fn){
 var busy=false;
 return function(){
  if(busy)return;
  busy=true;
  var done=function(){busy=false},r;
  try{r=fn.apply(this,arguments)}catch(e){done();throw e}
  if(r&&typeof r.then==='function')r.then(done,done);else done();
  return r;
 };
};
/* 预览窗 / 断网 / 跨域被拦：请求既不成功也不失败时，2.5 秒后一律转「本机可用」，
   绝不把按钮卡在「···」，也绝不剩一张空背景。云端一通，自动并回共享星 宙。 */
function withTimeout(p,ms){return new Promise(function(res,rej){
 var t=setTimeout(function(){rej(new Error('timeout'))},ms);
 p.then(function(v){clearTimeout(t);res(v)},function(e){clearTimeout(t);rej(e)});
})}
var CACHEKEY='xz_cache_v1';
function cacheGet(){
 try{
  var a=JSON.parse(localStorage.getItem(CACHEKEY)||'[]');
  if(!Array.isArray(a))return[];
  var s={},m=myIdsGet(),i;for(i=0;i<m.length;i++)s[m[i]]=1;
  /* 缓存里可能存着上一版记的归属标签，一律按「这台写没写过」重算，别处写的不混进「我的」 */
  for(i=0;i<a.length;i++){
   var w=a[i],mine=!!s[w.dk]||(/^local_/.test(String(w.dk))&&w.owner===MYKEY);
   w.owner=mine?MYKEY:'other';if(mine)w.canDel=true;
  }
  return a;
 }catch(e){return []}
}
function cacheSet(list){
 var slim=list.map(function(w){return {dk:w.dk,no:w.no,text:w.text,by:w.by,img:w.img||'',
   t:w.t,owner:w.owner,canDel:w.canDel,fixed:w.fixed?1:0}});
 try{localStorage.setItem(CACHEKEY,JSON.stringify(slim))}catch(e){
  try{localStorage.setItem(CACHEKEY,JSON.stringify(slim.map(function(w){
   var z={},k;for(k in w)z[k]=k==='img'?'':w[k];return z}).slice(-200)))}catch(e2){}
 }
}
function localKept(){ return []; }   /* 本机假星已废弃，保留空函数只为兼容旧引用 */
/* WebGL 一旦不可用，自动切 2D 星 宙：照样转、照样点、照样发、照样查 */
var glOK=false,fbCv=null,fbCtx=null,fbPts=[],fbStars=[],fbAng=0;
/* 旧版「失败存本地、联网批量补发」是突然多出几条的根源，整条链路已删除。
   启动时顺手清掉历史队列和缓存里的本机假星，永不重放。 */
try{
  localStorage.removeItem('xz_pending');
  var _cz=JSON.parse(localStorage.getItem(CACHEKEY)||'[]');
  if(Array.isArray(_cz)){
    var _f=_cz.filter(function(w){return w&&!/^local_/.test(String(w.dk))});
    if(_f.length!==_cz.length)localStorage.setItem(CACHEKEY,JSON.stringify(_f));
  }
}catch(e){}
try{lastKnownN=parseInt(localStorage.getItem('xz_last_n')||'0',10)||0}catch(e){}

/* ---------- 永久编号 + 「我写的」归属 ----------
   编号 no 随每条祝福一起存进云端：删掉任何一颗都不重排。
   5 颗删掉第 3 颗 → 剩 1 / 2 / 4 / 5，总数变 4；下一颗是 6。
   全部删光（0 颗）后，下一颗重新从 1 开始，不再接着旧号。
   「我写的」标记直接写进云端那条祝福里（零宽、不显示）：三个地方读同一行就都认得，
   不用加列、不用跑 SQL、不用登录。管理口令输过一次的那台浏览器永久是「主人模式」。 */
var MYKEY=(function(){
 var k='xingzhou_me_v1',v=null;
 try{v=localStorage.getItem(k)}catch(e){}
 if(!v){v='m'+Date.now().toString(36)+Math.random().toString(36).slice(2,9);
  try{localStorage.setItem(k,v)}catch(e){}}
 return v;
})();
var MINEKEY='xingzhou_myids_v1';
var OWNERKEY='xingzhou_owner_v1';
function isOwner(){try{return localStorage.getItem(OWNERKEY)==='1'}catch(e){return false}}
function setOwner(){try{localStorage.setItem(OWNERKEY,'1')}catch(e){}}
/* 展示编号写进正文的零宽前缀里（每台设备读到的都一样）：
   删掉任意一颗，其余编号纹丝不动；全部删光后下一颗重新从 1 开始。
   零宽字符不显示、不占位；旧数据没有前缀时回退用数据库 id。 */
var NMARK='\u2060';
function splitText(v){
 var m=/^\u2060([0-9a-z]+)\u2060([ox])\u2060([\s\S]*)$/.exec(v||'');
 if(m)return {no:parseInt(m[1],36),own:m[2]==='o',text:m[3]};
 var o=/^\u2060([0-9a-z]+)\u2060([\s\S]*)$/.exec(v||'');   /* 旧数据 */
 return o?{no:parseInt(o[1],36),own:false,text:o[2]}:null;
}
/* 任何历史格式都能读：数字 / 十进制串 / 36 进制字母(a=10) / 空值 */
function toNo(v){
 if(typeof v==='number'&&isFinite(v)&&v>=1)return Math.floor(v);
 var s=String(v==null?'':v).trim();
 if(/^\d+$/.test(s))return parseInt(s,10);
 if(/^[0-9a-z]+$/i.test(s))return parseInt(s.toLowerCase(),36);
 return NaN;
}
/* 多人同时写可能撞号；这里只在内存里把重复/坏号补成唯一号，云端一个字不改 */
function normalizeNos(list){
 var i,n,seen={};
 /* 云端行自带的编号先占号：38 永远是 38、40 永远是 40，绝不被旧数据挤掉 */
 for(i=0;i<list.length;i++){
  if(!list[i].fixed)continue;
  n=toNo(list[i].no);
  if(!isFinite(n)||n<1||seen[n]){var k=1;while(seen[k])k++;n=k}
  list[i].no=n;seen[n]=1;
 }
 /* 旧格式 / 本机星再补最小空缺号，不跳号 */
 for(i=0;i<list.length;i++){
  if(list[i].fixed)continue;
  n=toNo(list[i].no);
  if(!isFinite(n)||n<1||seen[n]){var k2=1;while(seen[k2])k2++;n=k2}
  list[i].no=n;seen[n]=1;
 }
 return list;
}
function nextNo(){
 var n=1,i;
 for(i=0;i<wishes.length;i++)if(wishes[i].no>=n)n=wishes[i].no+1;
 return n;
}
function myIdsGet(){
 try{var a=JSON.parse(localStorage.getItem(MINEKEY)||'[]');return Array.isArray(a)?a:[]}catch(e){return []}
}
function myIdsAdd(n){
 var a=myIdsGet();if(a.indexOf(n)<0){a.push(n);try{localStorage.setItem(MINEKEY,JSON.stringify(a))}catch(e){}}
}
function fromRows(rows){
 var a=myIdsGet(),set={},i;
 for(i=0;i<a.length;i++)set[a[i]]=1;
 return rows.map(function(r){
  var q=splitText(r.text),mine=!!set[r.id];   /* 我的：只认这台设备写过的，别处写的不混进来 */
  return {dk:r.id,no:Number(r.id)||toNo(q?q.no:r.id),text:q?q.text:(r.text||''),by:r.name||'',img:r.photo||'',
    t:r.created_at?new Date(r.created_at).getTime():Date.now(),
    owner:mine?MYKEY:'other',fixed:true,
    canDel:((q&&q.own)&&isOwner())||!!set[r.id]};   /* 别处认得出，但删不了你的 */
 });
}
function fromRow(r){
 var q=splitText(r.text);
 return {dk:r.id,no:Number(r.id)||toNo(q?q.no:r.id),text:q?q.text:(r.text||''),by:r.name||'',img:r.photo||'',
   t:r.created_at?new Date(r.created_at).getTime():Date.now(),
   owner:MYKEY,canDel:true,fixed:true};   /* 编号＝真实 id */
}
function findByNo(n){
 var t=toNo(n),i;if(!isFinite(t))return -1;
 /* 只认「这颗祝福自己的编号」，不拿数据库行号兜底 —— 搜 38 绝不会开到别的颗 */
 for(i=0;i<wishes.length;i++)if(toNo(wishes[i].no)===t)return i;
 return -1;
}

/* ---------- 数据层：Supabase REST，所有人读写同一张表 ----------
   分页拉全量（绕开 PostgREST 默认 1000 行上限），5 万条也撑得住。
   写：POST 拿回真实行才落星，绝不假装成功；删：按行精确删，编号不回收。 */
function sbH(extra){
 var h={};   /* 凭据收在服务端，前端不带任何密钥 */
 if(extra)for(var k in extra)h[k]=extra[k];
 return h;
}
var STORE={
  base:CONFIG.apiBase,
  load:function(){
    var out=[],off=0,LIM=1000,self=this;
    function page(){
      return withTimeout(fetch(self.base+'?select=id,text,name,photo,created_at&order=id.asc&limit='+LIM+'&offset='+off,
        {headers:sbH({'Cache-Control':'no-cache'}),cache:'no-store'}),2500).then(function(r){
          if(!r.ok)throw new Error('load');return r.json();
        }).then(function(arr){
          if(!Array.isArray(arr))throw new Error('load');
          out=out.concat(arr);
          if(arr.length<LIM||off>=60000)return out;
          off+=LIM;return page();
        });
    }
    return page().then(function(rows){loadFailed=false;return fromRows(rows)})
                 .catch(function(){
                   loadFailed=true;
                   return cacheGet();   /* 云端读不到：只显示已落库缓存，绝不并入本机假星 */
                 });
  },
  add:function(w,rid){
    /* 一次点击一张票：rid 只由 send() 生成，重试复用同一张，服务端 UNIQUE 幂等。
       不再往正文塞零宽编号前缀（编号一律由服务端 id 决定） */
    return withTimeout(fetch(this.base,{method:'POST',
      headers:sbH({'Content-Type':'application/json','Prefer':'return=representation'}),
      body:JSON.stringify({text:w.text,name:w.by,photo:w.img||null,request_id:rid})}),8000)
      .then(function(r){if(!r.ok)throw new Error('add');return r.json()})
      .then(function(a){var r=Array.isArray(a)?a[0]:a;
        if(!r||r.id===undefined)throw new Error('add');
        myIdsAdd(r.id);
        var out=fromRow(r);out.total=(r.total==null?null:Number(r.total));return out;});
  },
  remove:function(dk){
    if(/^local_/.test(String(dk)))return Promise.resolve(true);   /* 本机星直接删 */
    return withTimeout(fetch(this.base+'?id=eq.'+dk,{method:'DELETE',headers:sbH()}),2500)
      .then(function(r){return r.ok}).catch(function(){return loadFailed});
  }
};

/* ---------- 封面 ---------- */
var gate=document.getElementById('gate'),pw=document.getElementById('pw'),gerr=document.getElementById('gerr'),passed=false;
function tryPass(){
 if(passed)return;
 if(pw.value.trim()===CONFIG.pass){
  passed=true;pw.disabled=true;pw.blur();gate.className='out';
  setTimeout(function(){gate.style.display='none';showPlanet()},420);
 }else{
  gate.className='shake';gerr.className='err on';pw.value='';
  setTimeout(function(){if(!passed)gate.className=''},420);
  setTimeout(function(){if(!passed)gerr.className='err'},1800);
 }
}
pw.addEventListener('input',function(){if(pw.value.length>=4)setTimeout(tryPass,120)});
pw.addEventListener('keydown',function(e){if(e.key==='Enter')tryPass()});

/* ---------- 贴图：柔光点 / 斜向银河星 宙 / 短流星 ---------- */
/* 背景星尘：纯柔光小圆点，没有任何十字芒，所以画面里不会再冒出"四个角" */
function sparkTexture(){
 var c=document.createElement('canvas');c.width=c.height=64;var x=c.getContext('2d');
 var g=x.createRadialGradient(32,32,0,32,32,32);
 g.addColorStop(0,'rgba(255,255,255,.96)');g.addColorStop(.07,'rgba(250,244,255,.72)');
 g.addColorStop(.20,'rgba(226,214,255,.26)');g.addColorStop(.46,'rgba(198,178,255,.07)');
 g.addColorStop(1,'rgba(180,155,255,0)');
 x.fillStyle=g;x.fillRect(0,0,64,64);
 return new THREE.CanvasTexture(c);
}
/* 星 宙底图：斜向银河（左上→右下）+ 暗尘埃 + 紫青絮状云 + 密集细星尘
   —— 没有横向光带、没有圆形行星、没有硬边，全程序画，零外部图 */
function paintNebula(){
 var c=document.createElement('canvas');c.width=640;c.height=1280;var x=c.getContext('2d');
 var g=x.createLinearGradient(0,0,640,1280);
 g.addColorStop(0,'#04060f');g.addColorStop(.38,'#080c1e');
 g.addColorStop(.72,'#0b1026');g.addColorStop(1,'#0a0c1c');
 x.fillStyle=g;x.fillRect(0,0,640,1280);
 /* 银河轴：从左上到右下 */
 var K=1.62,B=-120;                     /* y = K*x + B */
 function axisY(px){return K*px+B}
 /* 1) 亮的絮状云，沿轴铺开，越靠轴越密；颜色在青蓝 / 紫 / 暖粉之间游走 */
 x.globalCompositeOperation='lighter';
 function cloud(cx,cy,rx,ry,col,a,rot){
  x.save();x.translate(cx,cy);if(rot)x.rotate(rot);x.scale(rx,ry);
  var rg=x.createRadialGradient(0,0,0,0,0,1);
  rg.addColorStop(0,'rgba('+col+','+a+')');
  rg.addColorStop(.42,'rgba('+col+','+(a*.30)+')');
  rg.addColorStop(1,'rgba('+col+',0)');
  x.fillStyle=rg;x.beginPath();x.arc(0,0,1,0,6.2832);x.fill();x.restore();
 }
 var cols=['92,132,214','118,96,196','150,104,186','72,142,206','176,124,178','96,158,210'];
 for(var i=0;i<330;i++){
  var t=Math.random(),px=-140+t*980,off=(Math.random()-.5)*(250+220*Math.sin(t*Math.PI));
  var py=axisY(px)+off;
  var rx=26+Math.random()*105,ry=14+Math.random()*62;
  var col=cols[Math.floor(Math.random()*cols.length)];
  var a=(.055+Math.random()*.115)*(0.45+0.55*Math.sin(t*Math.PI));
  cloud(px,py,rx,ry,col,a,-0.92+(Math.random()-.5)*1.55);
 }
 /* 更细的亮絮，做出乳白银河的颗粒感 */
 for(var j=0;j<420;j++){
  var t2=Math.random(),qx=-140+t2*980,qy=axisY(qx)+(Math.random()-.5)*210;
  cloud(qx,qy,8+Math.random()*30,5+Math.random()*18,
    Math.random()<.5?'150,178,232':'190,160,220',.045+Math.random()*.075,-.92+(Math.random()-.5)*1.30);
 }
 /* 2) 暗尘埃带：压在银河中间，做出图里那种断裂的暗纹（不是一条整齐亮线） */
 x.globalCompositeOperation='source-over';
 for(var k=0;k<170;k++){
  var t3=Math.random(),dx=-140+t3*980,dy=axisY(dx)+(Math.random()-.5)*120;
  cloud(dx,dy,22+Math.random()*90,9+Math.random()*40,'3,5,14',.10+Math.random()*.20,-.92+(Math.random()-.5)*1.40);
 }
 /* 3) 星尘：靠银河带更密，越远越疏 */
 x.globalCompositeOperation='lighter';
 for(var n=0;n<14000;n++){
  var sx=Math.random()*640,sy=Math.random()*1280;
  var d=Math.abs(sy-axisY(sx))/Math.sqrt(1+K*K);
  var keep=d<105?.92:(d<230?.52:.20);
  if(Math.random()>keep)continue;
  var rr=Math.random()<.94?.38:(Math.random()<.85?.7:1.15);
  var aa=.12+Math.random()*.58;
  var r=Math.random();
  var cc=r<.10?'214,196,255':(r<.22?'168,214,255':(r<.27?'255,214,206':'255,255,255'));
  x.fillStyle='rgba('+cc+','+aa+')';x.beginPath();x.arc(sx,sy,rr,0,6.2832);x.fill();
 }
 /* 4) 几颗带柔光的亮星，小、不抢戏 */
 function bright(cx,cy,r,col){
  var hg=x.createRadialGradient(cx,cy,0,cx,cy,r*9);
  hg.addColorStop(0,'rgba('+col+',.55)');hg.addColorStop(.18,'rgba('+col+',.14)');
  hg.addColorStop(1,'rgba('+col+',0)');
  x.fillStyle=hg;x.beginPath();x.arc(cx,cy,r*9,0,6.2832);x.fill();
  x.fillStyle='rgba(255,255,255,.92)';x.beginPath();x.arc(cx,cy,r,0,6.2832);x.fill();
  x.strokeStyle='rgba('+col+',.22)';x.lineWidth=.7;
  x.beginPath();x.moveTo(cx-r*5,cy);x.lineTo(cx+r*5,cy);
  x.moveTo(cx,cy-r*5);x.lineTo(cx,cy+r*5);x.stroke();
 }
 bright(126,486,1.5,'196,166,255');
 bright(462,1058,1.3,'180,214,255');
 bright(548,232,1.0,'220,200,255');
 bright(218,1112,.9,'190,220,255');
 bright(368,706,.8,'255,226,224');
 return c.toDataURL('image/jpeg',.86);
}
/* 小流星：一根很短的渐隐划痕 + 顶端针尖亮点（不再有长竖丝） */
function trailTexture(){
 var c=document.createElement('canvas');c.width=12;c.height=512;var x=c.getContext('2d');
 var lg=x.createLinearGradient(0,0,0,512);
 lg.addColorStop(0,'rgba(255,255,255,.78)');
 lg.addColorStop(.035,'rgba(248,240,255,.52)');
 lg.addColorStop(.20,'rgba(236,224,255,.22)');
 lg.addColorStop(.60,'rgba(218,200,255,.06)');
 lg.addColorStop(1,'rgba(200,180,255,0)');
 x.fillStyle=lg;x.fillRect(5.0,0,2.0,512);
 /* 横向也做柔边，避免出现一根硬白条 */
 var hg=x.createLinearGradient(0,0,12,0);
 hg.addColorStop(0,'rgba(0,0,0,1)');hg.addColorStop(.5,'rgba(0,0,0,0)');hg.addColorStop(1,'rgba(0,0,0,1)');
 x.globalCompositeOperation='destination-out';x.fillStyle=hg;x.fillRect(0,0,12,512);
 x.globalCompositeOperation='source-over';
 /* 顶端针尖：一个极小的亮点，不画任何芒 */
 x.fillStyle='rgba(255,255,255,.80)';x.fillRect(5.4,0,1.2,6);
 x.fillStyle='rgba(255,255,255,.26)';x.beginPath();x.arc(6,1.4,2.1,0,6.2832);x.fill();
 return new THREE.CanvasTexture(c);
}
/* 祝福星：抽象版「小星球」——柔雾紫球 + 一圈细金环。
   刻意不写实：没有地形明暗、没有厚环、低饱和，130 颗同屏也不乱。 */
function planetStarTexture(){
 var c=document.createElement('canvas');c.width=c.height=256;
 var x=c.getContext('2d'),C=128;
 /* 外层极淡紫雾 */
 var g0=x.createRadialGradient(C,C,16,C,C,126);
 g0.addColorStop(0,'rgba(150,118,220,.20)');
 g0.addColorStop(.55,'rgba(118,90,188,.09)');
 g0.addColorStop(1,'rgba(88,62,158,0)');
 x.fillStyle=g0;x.fillRect(0,0,256,256);
 /* 金环·后半段（淡） */
 x.save();x.translate(C,C);x.rotate(-.30);x.lineCap='round';
 x.strokeStyle='rgba(238,210,150,.34)';x.lineWidth=4.0;
 x.shadowColor='rgba(255,224,160,.30)';x.shadowBlur=8;
 x.beginPath();x.ellipse(0,0,104,33,0,0,Math.PI*2);x.stroke();
 x.restore();
 /* 紫雾球：柔渐变 + 一点点星尘颗粒 */
 x.save();
 var g=x.createRadialGradient(110,104,4,C,C,64);
 g.addColorStop(0,'rgba(226,212,255,.72)');
 g.addColorStop(.30,'rgba(180,154,236,.68)');
 g.addColorStop(.64,'rgba(128,100,194,.60)');
 g.addColorStop(.88,'rgba(84,60,144,.34)');
 g.addColorStop(1,'rgba(70,50,125,0)');
 x.fillStyle=g;x.beginPath();x.arc(C,C,64,0,Math.PI*2);x.fill();
 /* 星尘颗粒：球内密、边缘稀，像粒子聚成的一团 */
 x.globalCompositeOperation='screen';
 for(var i=0;i<210;i++){
  var a=Math.random()*6.283,r=Math.sqrt(Math.random())*62;
  var fade=r>52?(1-(r-52)/10)*.6:1;
  x.fillStyle='rgba(238,224,255,'+((.08+Math.random()*.22)*fade).toFixed(3)+')';
  x.beginPath();x.arc(C+Math.cos(a)*r,C+Math.sin(a)*r,.5+Math.random()*1.2,0,6.283);x.fill();
 }
 /* 边缘散逸的游离粒子 */
 for(var j=0;j<46;j++){
  var a2=Math.random()*6.283,r2=63+Math.random()*14;
  x.fillStyle='rgba(206,184,255,'+(.06+Math.random()*.14).toFixed(3)+')';
  x.beginPath();x.arc(C+Math.cos(a2)*r2,C+Math.sin(a2)*r2,.4+Math.random()*.8,0,6.283);x.fill();
 }
 x.restore();
 /* 金环·前半段（亮），压在球前面 → 有穿过去的层次 */
 x.save();x.translate(C,C);x.rotate(-.30);
 x.strokeStyle='rgba(255,236,188,.88)';x.lineWidth=3.6;
 x.shadowColor='rgba(255,220,150,.70)';x.shadowBlur=12;
 x.beginPath();x.ellipse(0,0,104,33,0,0,Math.PI);x.stroke();
 x.shadowBlur=0;x.strokeStyle='rgba(255,248,224,.58)';x.lineWidth=1.2;
 x.beginPath();x.ellipse(0,0,104,33,0,0,Math.PI);x.stroke();
 x.restore();
 /* 球缘一道极淡冷光，把边界收干净 */
 x.save();x.strokeStyle='rgba(224,206,255,.26)';x.lineWidth=1.4;
 x.beginPath();x.arc(C,C,62,0,Math.PI*2);x.stroke();x.restore();
 return new THREE.CanvasTexture(c);
}
function starShape(R){
 var s=new THREE.Shape();
 for(var i=0;i<10;i++){
  var rr=(i%2===0)?R:R*0.382,a=-Math.PI/2+i*Math.PI/5;
  var px=Math.cos(a)*rr,py=Math.sin(a)*rr;
  if(i===0)s.moveTo(px,py);else s.lineTo(px,py);
 }
 s.closePath();return s;
}

/* ---------- 场景 ---------- */
var renderer,scene,camera,coreMesh,sparkLayers=[],meteorMesh,haloPoints;
var dummy=new THREE.Object3D(),raycaster=new THREE.Raycaster(),mouse=new THREE.Vector2();
var wishes=[],shown=[],pts=[],appear=[],meteors=[],running=false,raf=null;
var hitFlash={i:-1,t:0};
var theta=0.5,phi=1.25,dist=205,tgtTheta=theta,tgtPhi=phi,tgtDist=dist,autoSpin=true;
var W=innerWidth,H=innerHeight;

function spherePoint(rMin,rMax){
 var u=Math.random()*2-1,t=Math.random()*Math.PI*2,r=rMin+Math.random()*(rMax-rMin);
 var k=Math.sqrt(1-u*u);
 return new THREE.Vector3(r*k*Math.cos(t),r*u,r*k*Math.sin(t));
}
/* 全局：小流星随机冒出来又消失，同时天上通常只有 1~3 条 */
function resetMeteor(m,initial){
 m.v=spherePoint(150,320);
 m.wait=initial?Math.floor(Math.random()*220):160+Math.floor(Math.random()*540);
 m.life=0;m.max=32+Math.floor(Math.random()*30);
 m.sp=1.0+Math.random()*1.5;
 m.w=.55+Math.random()*.55;
 m.len=11+Math.random()*20;
 m.tilt=.46+(Math.random()-.5)*.20;          /* 斜着划，不是竖着掉 */
}
/* ---- 备用星 宙：纯 Canvas 2D，WebGL 开不出来时全功能照常 ---- */
function initFallback2D(){
 if(fbCv)return;
 var skyEl=document.getElementById('sky');
 fbCv=document.createElement('canvas');fbCv.id='fb';
 fbCv.style.cssText='position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none';
 skyEl.insertBefore(fbCv,skyEl.firstChild);
 fbCtx=fbCv.getContext('2d');
 fbStars=[];
 for(var i=0;i<190;i++)fbStars.push({x:Math.random(),y:Math.random(),r:.4+Math.random()*1.1,
   a:.18+Math.random()*.55,ph:Math.random()*6.28,sp:.0006+Math.random()*.0014});
 fbResize();
 addEventListener('resize',fbResize);
}
function fbResize(){
 if(!fbCv)return;
 var dpr=Math.min(devicePixelRatio||1,2);
 fbCv.width=Math.round(innerWidth*dpr);fbCv.height=Math.round(innerHeight*dpr);
 fbCtx.setTransform(dpr,0,0,dpr,0,0);
 fbLayout();
}
function fbLayout(){
 fbPts=[];var n=shown.length,W=innerWidth,H=innerHeight;
 var k=Math.max(.42,Math.min(2.2,205/(dist||205)));
 for(var i=0;i<n;i++){
  var t=(i+.5)/Math.max(1,n),yy=1-2*t,r0=Math.sqrt(Math.max(0,1-yy*yy));
  var a=i*2.399963229728653+fbAng;
  var x=Math.cos(a)*r0,z=Math.sin(a)*r0;
  var tilt=yy*.74+z*.30;
  fbPts.push({x:W/2+x*W*.35*k,y:H/2+tilt*H*.33*k,
    r:(7.5+5.5*(z+1)/2)*k,z:z,no:shown[i]});
 }
}
function tick2D(now){
 if(!fbCtx){raf=requestAnimationFrame(tick);return}
 var W=innerWidth,H=innerHeight,c=fbCtx;
 c.clearRect(0,0,W,H);
 /* 背景星野：缓慢眨眼 */
 for(var i=0;i<fbStars.length;i++){
  var st=fbStars[i],al=st.a*(.62+.38*Math.sin(now*st.sp+st.ph));
  c.globalAlpha=al;c.fillStyle='#d9c9ff';
  c.beginPath();c.arc(st.x*W,st.y*H,st.r,0,6.2832);c.fill();
 }
 c.globalAlpha=1;
 fbAng+=(immersed?.0022:.0013);fbLayout();
 /* 远的先画，近的后画 */
 var order=fbPts.map(function(p,i){return i}).sort(function(a,b){return fbPts[a].z-fbPts[b].z});
 for(var j=0;j<order.length;j++){
  var p=fbPts[order[j]],fade=.55+.45*(p.z+1)/2;
  var boost=(hitFlash.i===order[j]&&hitFlash.t>.01)?1+ .45*hitFlash.t:1;
  var r=p.r*boost;
  var g=c.createRadialGradient(p.x,p.y,0,p.x,p.y,r*1.9);
  g.addColorStop(0,'rgba(206,178,255,'+(.92*fade)+')');
  g.addColorStop(.42,'rgba(140,104,220,'+(.55*fade)+')');
  g.addColorStop(1,'rgba(90,60,170,0)');
  c.fillStyle=g;c.beginPath();c.arc(p.x,p.y,r*1.9,0,6.2832);c.fill();
  c.strokeStyle='rgba(240,206,140,'+(.62*fade)+')';c.lineWidth=Math.max(.7,r*.10);
  c.beginPath();c.ellipse(p.x,p.y,r*1.22,r*.40,-.34,0,6.2832);c.stroke();
  c.fillStyle='rgba(255,246,224,'+(.85*fade)+')';
  c.beginPath();c.arc(p.x,p.y,r*.24,0,6.2832);c.fill();
 }
 raf=requestAnimationFrame(tick);
}
function hit2D(x,y){
 var isOpen=document.getElementById('card').className==='on',sel=-1,bd=32*32;
 for(var i=0;i<fbPts.length;i++){
  var p=fbPts[i],dx=p.x-x,dy=p.y-y,d=dx*dx+dy*dy;
  var rr=Math.max(24,p.r*1.5);
  if(d<Math.min(bd,rr*rr)){bd=d;sel=i}
 }
 if(isOpen){if(sel<0)closeCard();return}
 if(sel>=0){flashStar(sel);openCard(fbPts[sel].no)}
}

function initGL(){ try{
 var neb=paintNebula();
 document.body.style.backgroundImage='url('+neb+')';
 document.body.style.backgroundSize='cover';
 document.body.style.backgroundPosition='center';
 document.body.style.backgroundRepeat='no-repeat';
 gate.style.backgroundImage='linear-gradient(rgba(8,5,28,.52),rgba(8,5,28,.58)),url('+neb+')';
 gate.style.backgroundSize='cover';gate.style.backgroundPosition='center';
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
 renderer.setSize(W,H);renderer.setClearColor(0x000000,0);   /* 透出 CSS 的多层星云底 */
 renderer.domElement.id='gl';var skyEl=document.getElementById('sky');skyEl.insertBefore(renderer.domElement,skyEl.firstChild);
 scene=new THREE.Scene();
 scene.fog=new THREE.FogExp2(0x3a2288,0.00085);
 camera=new THREE.PerspectiveCamera(55,W/H,1,1000);
 var sparkTex=sparkTexture(),trailTex=trailTexture();

 /* 背景：柔光小圆点（3D 层，配合底图星尘） */
 function sparkLayer(n,size,op){
  var pos=new Float32Array(n*3);
  for(var i=0;i<n;i++){var v=spherePoint(175,340);pos[i*3]=v.x;pos[i*3+1]=v.y;pos[i*3+2]=v.z}
  var g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));
  var p=new THREE.Points(g,new THREE.PointsMaterial({map:sparkTex,size:size,transparent:true,opacity:op,
    blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true,fog:false}));
  p.frustumCulled=false;scene.add(p);return p;
 }
 sparkLayers.push(sparkLayer(CONFIG.sparkNear,4.4,.50));
 sparkLayers.push(sparkLayer(CONFIG.sparkFar,2.2,.40));

 /* 小流星：同时天上通常只有 1~3 条，短、斜、很淡，随机冒出来又消失 */
 meteorMesh=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),
   new THREE.MeshBasicMaterial({map:trailTex,transparent:true,opacity:.26,
     blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,fog:false}),CONFIG.meteor);
 meteorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
 meteorMesh.frustumCulled=false;meteorMesh.renderOrder=1;
 for(var m=0;m<CONFIG.meteor;m++){var mm={};resetMeteor(mm,true);meteors.push(mm)}
 scene.add(meteorMesh);

 /* 祝福星：柔雾紫小球＋细金环，始终正对镜头 */
 var geo=new THREE.PlaneGeometry(7.6,7.6);
 coreMesh=new THREE.InstancedMesh(geo,new THREE.MeshBasicMaterial({map:planetStarTexture(),
   color:0xffffff,transparent:true,opacity:.95,side:THREE.DoubleSide,
   depthWrite:false,fog:false}),CONFIG.batch);
 coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
 coreMesh.frustumCulled=false;coreMesh.count=0;coreMesh.renderOrder=3;
 scene.add(coreMesh);

 /* 每颗祝福星外面套一层柔光，bling 但不刺眼 */
 var hg=new THREE.BufferGeometry();
 hg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(CONFIG.batch*3),3));
 /* 圆柔光，压成淡紫，托住小星球不抢戏 */
 haloPoints=new THREE.Points(hg,new THREE.PointsMaterial({map:sparkTex,size:30,transparent:true,
   color:0xb9a2ff,opacity:.38,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true,fog:false}));
 haloPoints.frustumCulled=false;haloPoints.renderOrder=2;scene.add(haloPoints);

 addEventListener('resize',function(){
  W=innerWidth;H=innerHeight;
  if(renderer&&camera){renderer.setSize(W,H);camera.aspect=W/H;camera.updateProjectionMatrix()}
 });
 glOK=true;
 }catch(e){glOK=false;try{initFallback2D()}catch(e2){}}
}

/* ---------- 分批：随机抽，不取前 N 个；星位每次重排 ---------- */
function pickBatch(forceIdx){
 var N=wishes.length,k=Math.min(CONFIG.batch,N),idx=[],used={},guard=0;
 if(forceIdx!==undefined&&forceIdx>=0&&forceIdx<N){idx.push(forceIdx);used[forceIdx]=1}
 while(idx.length<k&&guard<k*24){
  var r=Math.floor(Math.random()*N);
  if(!used[r]){used[r]=1;idx.push(r)}
  guard++;
 }
 if(idx.length<k){for(var z=0;z<N&&idx.length<k;z++)if(!used[z]){used[z]=1;idx.push(z)}}
 shown=idx;
 pts=[];appear=[];
 for(var m=0;m<shown.length;m++){
  var v=spherePoint(54,100);
  pts.push({p:v,rot:(Math.random()-.5)*0.34,tilt:(Math.random()-.5)*0.14,
    s:.58+Math.random()*.42,ph:Math.random()*6.28});
  appear.push({v:0});
 }
 if(glOK&&coreMesh)coreMesh.count=shown.length;
 if(!glOK&&fbCtx)fbLayout();
 updateCount();
 document.getElementById('empty').className=shown.length?'':'on';
}
function updateCount(){
 var el=document.getElementById('count'),n=wishes.length||lastKnownN;
 el.className='';                                   /* 任何状态都同一个浅紫色，不弹暖黄警告 */
 el.textContent='共 '+n.toLocaleString()+' 颗祝福';  /* 只说有几颗，别的一个字不写 */
 document.getElementById('reshuffle').style.display=wishes.length?'flex':'none';
}
/* 点计数条：静默重连，不弹任何文字 */
document.getElementById('count').addEventListener('click',function(){
 if(running){retryCount=0;hardReload()}
});

/* ---------- 渲染 ---------- */
function setMatrices(now){
 var hp=haloPoints.geometry.attributes.position.array;
 for(var i=0;i<pts.length;i++){
  var o=pts[i],a=appear[i];
  if(a.v<1)a.v=Math.min(1,a.v+0.045);
  var ease=1-Math.pow(1-a.v,3),br=.90+.10*Math.sin(now*.0016+o.ph);
  dummy.position.copy(o.p);
  dummy.quaternion.copy(camera.quaternion);          /* 始终正对你，小星球清清楚楚 */
  dummy.rotateZ(o.rot+Math.sin(now*.00035+o.ph)*.055);  /* 只轻轻摇，不翻过去，整片才不乱 */
  dummy.rotateX(o.tilt);
  var fl=(hitFlash.i===i&&hitFlash.t>.01)?(1+.42*hitFlash.t):1;
  var s=o.s*ease*br*fl;dummy.scale.set(s,s,s);dummy.updateMatrix();
  coreMesh.setMatrixAt(i,dummy.matrix);
  if(ease>.05){hp[i*3]=o.p.x;hp[i*3+1]=o.p.y;hp[i*3+2]=o.p.z}
  else{hp[i*3]=9999;hp[i*3+1]=9999;hp[i*3+2]=9999}
 }
 for(var q=pts.length;q<CONFIG.batch;q++){hp[q*3]=9999;hp[q*3+1]=9999;hp[q*3+2]=9999}
 coreMesh.instanceMatrix.needsUpdate=true;
 haloPoints.geometry.attributes.position.needsUpdate=true;
}
function setMeteors(){
 for(var i=0;i<meteors.length;i++){
  var m=meteors[i];
  if(m.wait>0){                                  /* 空档：完全不画 */
   m.wait--;dummy.position.set(9999,9999,9999);dummy.scale.set(0,0,0);dummy.updateMatrix();
   meteorMesh.setMatrixAt(i,dummy.matrix);continue;
  }
  m.life++;
  m.v.x-=m.sp*Math.cos(m.tilt);m.v.y-=m.sp*Math.sin(m.tilt);
  if(m.life>m.max||m.v.y<-260){resetMeteor(m,false);
   dummy.position.set(9999,9999,9999);dummy.scale.set(0,0,0);dummy.updateMatrix();
   meteorMesh.setMatrixAt(i,dummy.matrix);continue}
  var fade=Math.sin(Math.PI*m.life/m.max);      /* 淡入淡出，不突然出现 */
  dummy.position.copy(m.v);
  dummy.quaternion.copy(camera.quaternion);
  dummy.rotateZ(-m.tilt);
  dummy.scale.set(m.w,m.len*fade,1);dummy.updateMatrix();
  meteorMesh.setMatrixAt(i,dummy.matrix);
 }
 meteorMesh.instanceMatrix.needsUpdate=true;
}
function tick(now){
 lastFrameAt=now||Date.now();
 if(!glOK){if(hitFlash.t>.01)hitFlash.t*=.88;else hitFlash.t=0;tick2D(now);return}
 if(hitFlash.t>.01)hitFlash.t*=.88;else hitFlash.t=0;
 theta+=(tgtTheta-theta)*0.12;phi+=(tgtPhi-phi)*0.12;dist+=(tgtDist-dist)*0.12;
 if(!dragging&&pointers.size===0)tgtTheta+=immersed?0.00135:0.00075;  /* 手指一松就转，绝不卡住 */
 camera.position.set(dist*Math.sin(phi)*Math.cos(theta),dist*Math.cos(phi),dist*Math.sin(phi)*Math.sin(theta));
 camera.lookAt(0,0,0);
 for(var i=0;i<sparkLayers.length;i++)sparkLayers[i].rotation.y+=(i?0.00007:0.00011);
 setMeteors();setMatrices(now);
 renderer.render(scene,camera);
 raf=requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange',function(){
 if(!document.hidden&&running&&!raf)raf=requestAnimationFrame(tick);
});
/* 有些「预览浮层」会把页面当成后台、直接掐掉 rAF。
   帧停了 260ms 以上就用低频兜底推一帧，星 宙/星球照样慢慢转，不会定住。 */
var lastFrameAt=0;
setInterval(function(){
 var now=Date.now();
 if(!running||now-lastFrameAt<260)return;
 lastFrameAt=now;
 tgtTheta+=immersed?0.00135:0.00075;
 if(glOK){
  theta+=(tgtTheta-theta)*0.12;phi+=(tgtPhi-phi)*0.12;dist+=(tgtDist-dist)*0.12;
  camera.position.set(dist*Math.sin(phi)*Math.cos(theta),dist*Math.cos(phi),dist*Math.sin(phi)*Math.sin(theta));
  camera.lookAt(0,0,0);renderer.render(scene,camera);
 }else if(fbCtx){tick2D(now)}
},140);
function commitList(list){
 /* 断网 / 云端 0 行：只显示已落库缓存，绝不再并入本机假星、绝不重放旧队列 */
 /* 云端确认为 0 行：本机旧账、缓存、我的列表一并作废。 */
 if(!list.length){
  try{localStorage.removeItem('xz_last_n');localStorage.removeItem(MINEKEY);localStorage.removeItem(CACHEKEY)}catch(e){}
  lastKnownN=0;emptyStreak=0;retryCount=0;
  if(retryTimer){clearTimeout(retryTimer);retryTimer=null}
  wishes=[];lastSig=sigOf([]);pickBatch();markTop();updateCount();
  document.getElementById('empty').className='on';
  return;
 }
 emptyStreak=0;retryCount=0;
 wishes=normalizeNos(list.slice(-CONFIG.capacity));
 lastKnownN=wishes.length;lastSig=sigOf(wishes);pickBatch();markTop();
 lastFullAt=Date.now();
 try{localStorage.setItem('xz_last_n',String(lastKnownN))}catch(e){}
 cacheSet(wishes);
}
function hardReload(){
 if(!running)return;
 if(retryTimer){clearTimeout(retryTimer);retryTimer=null}       /* 不叠加并发重连 */
 retryCount=0;STORE.load().then(function(list){commitList(list);if(!raf)raf=requestAnimationFrame(tick)});
}
function scheduleRetry(){
 if(retryTimer||retryCount>=12||!running)return;
 retryCount++;
 var d=[1200,2000,3000,5000,8000,10000],w=d[Math.min(retryCount-1,d.length-1)];
 retryTimer=setTimeout(function(){
  retryTimer=null;if(!running)return;
  STORE.load().then(commitList);
 },w);
}
function enterSky(){
 if(running)return;running=true;
 STORE.load().then(function(list){
  commitList(list);raf=requestAnimationFrame(tick);
 });
}
addEventListener('online',function(){if(running){retryCount=0;hardReload()}});

/* ---------- 云端同步：别人写的，切回来或每 20 秒就能看见 ----------
   免费版 Supabase 磁盘 IO 有限：轮询改成「只看最新 1 行的 id」，
   没有新祝福就完全不读表；只有真的多了/少了，才拉一次全量。
   访客越多越省，别人写的照样 20 秒内出现；每 5 分钟兜底全量一次防漏。
   断网或空响应一律保留现有星 宙，绝不误清空。 */
STORE.peek=function(){
 return withTimeout(fetch(this.base+'?select=id&order=id.desc&limit=1',
   {headers:sbH({'Cache-Control':'no-cache'}),cache:'no-store'}),2500)
  .then(function(r){if(!r.ok)throw new Error('peek');return r.json()})
  .then(function(a){return (a&&a[0]&&Number(a[0].id))||0})
  .catch(function(){return -1});              /* -1＝探针失败，改走全量，不静默 */
};
var syncing=false,lastSig='',lastTop=-1,lastFullAt=0;
function markTop(){
 var i,m=0;for(i=0;i<wishes.length;i++)if(Number(wishes[i].dk)>m)m=Number(wishes[i].dk);
 lastTop=m;
}
function sigOf(list){
 var a=[],i;for(i=0;i<list.length;i++)a.push(list[i].dk+':'+list[i].no);
 return list.length+'|'+a.join('|');
}
function anyPanelOpen(){
 var ids=['card','sheet','searchPanel','minePanel','allPanel','admin','adminGate'],i;
 for(i=0;i<ids.length;i++)if(document.getElementById(ids[i]).className.indexOf('on')>=0)return true;
 return false;
}
function syncCloud(){
 if(syncing||document.hidden||anyPanelOpen()||!running)return;
 syncing=true;
 var forced=(Date.now()-lastFullAt)>300000;        /* 5 分钟兜底：抓删除/异常 */
 var gate=forced?Promise.resolve(-1):STORE.peek();
 gate.then(function(top){
  if(!forced&&top<0){syncing=false;return}                       /* 探针不通：别再拉全表 */
  if(!forced&&lastTop>=0&&top===lastTop){syncing=false;return}   /* 没新祝福，收工 */
  return STORE.load().then(function(list){
   syncing=false;
   if(loadFailed){commitList(list);return}
   var sg=sigOf(list);
   if(sg===lastSig&&wishes.length){emptyStreak=0;lastFullAt=Date.now();markTop();return}
   commitList(list);
  });
 }).catch(function(){syncing=false;loadFailed=true;updateCount();scheduleRetry()});
}
setInterval(syncCloud,20000);
document.addEventListener('visibilitychange',function(){
 if(document.hidden)return;
 setTimeout(function(){if(running&&loadFailed){retryCount=0;hardReload()}else syncCloud()},600);
});

/* ---------- 拖转 / 缩放 / 点星 ---------- */
var pointers=new Map(),dragging=false,down=null,lastPinch=0,moved=0;
function onDown(e){
 if(!passed||!skyVisible){pointers.clear();dragging=false;down=null;lastPinch=0;return}
 if(!dragging&&pointers.size){pointers.clear();lastPinch=0;down=null}
 var _t=e.target,_cl=(_t&&typeof _t.closest==='function')?_t.closest.bind(_t):null;
 if(immersed){                                   /* 沉浸模式：任意按下都只用来退出 */
  down={x:e.clientX,y:e.clientY,t:performance.now()};moved=0;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  return;
 }
 if(_cl&&(_cl('#card')||_cl('#sheet')||_cl('#admin')||_cl('#adminGate')||_cl('.round')||
    _cl('#setting')||_cl('#searchBtn')||_cl('#searchPanel')||_cl('#minePanel')||
    _cl('#immerse')||_cl('#exitBtn')))return;
 if(document.getElementById('searchPanel').className.indexOf('on')>=0)closeSearch();
 pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(pointers.size===1){down={x:e.clientX,y:e.clientY,t:performance.now()};moved=0;dragging=true;autoSpin=false}
 if(pointers.size===2){lastPinch=pinchDist();down=null}
}
function pinchDist(){var a=[...pointers.values()];return Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)}
function onMove(e){
 if(!pointers.has(e.pointerId))return;
 var prev=pointers.get(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(pointers.size===2){
  var d=pinchDist();if(lastPinch)tgtDist=Math.max(115,Math.min(360,tgtDist*(1+(lastPinch/d-1)*.55)));
  lastPinch=d;moved=999;return;
 }
 if(pointers.size===1&&dragging){
  var dx=e.clientX-prev.x,dy=e.clientY-prev.y;moved+=Math.abs(dx)+Math.abs(dy);
  tgtTheta-=dx*0.0062;tgtPhi=Math.max(.18,Math.min(Math.PI-.18,tgtPhi-dy*0.0062));
 }
}
function onUp(e){
 var wasOne=pointers.size===1;pointers.delete(e.pointerId);
 if(pointers.size<2)lastPinch=0;
 if(pointers.size===0){
  dragging=false;autoSpin=true;
  if(immersed){
   if(down&&wasOne&&moved<28&&performance.now()-down.t<1100)exitImmerse();
   down=null;return;
  }
  if(down&&wasOne&&moved<28&&performance.now()-down.t<1100)hit(e.clientX,e.clientY);
  down=null;
 }
}
function hit(x,y){
 if(!glOK){hit2D(x,y);return}
 var c=document.getElementById('card'),isOpen=(c.className==='on');
 var sel=-1;

 /* A. 精确射线：点在星本体上 */
 if(shown.length){
  mouse.set((x/W)*2-1,-(y/H)*2+1);raycaster.setFromCamera(mouse,camera);
  var rs=raycaster.intersectObject(coreMesh,false);
  if(rs.length&&rs[0].instanceId!==undefined){
   var uv=rs[0].uv,ok=true;
   if(uv){var ux=(uv.x-.5)*2,uy=(uv.y-.5)*2;ok=(ux*ux+uy*uy)<.90*.90}
   if(ok)sel=rs[0].instanceId;
  }
 }
 /* B. 屏幕投影：只有点在星附近才算命中。
       背面星也画在屏幕上，同样能点；空白星空一律不算，没有全屏兜底。 */
 if(sel<0&&shown.length){
  var tmp=new THREE.Vector3(),toCam=new THREE.Vector3(),nrm=new THREE.Vector3();
  var bd=50*50;
  for(var i=0;i<pts.length;i++){
   var p=pts[i].p;
   tmp.copy(p).project(camera);
   if(tmp.z>1||tmp.z<-1)continue;
   var sx=(tmp.x*.5+.5)*W,sy=(-tmp.y*.5+.5)*H;
   if(sx<-30||sx>W+30||sy<-30||sy>H+30)continue;
   var dx=sx-x,dy=sy-y,raw=dx*dx+dy*dy;
   nrm.copy(p).normalize();toCam.copy(camera.position).sub(p);
   var d=raw*(nrm.dot(toCam)<=0?1.35:1);
   if(d<bd){bd=d;sel=i}
  }
 }

 /* ① 卡片已经开着：
       · 点到别的星 → 保持当前这一张，绝不跳到别人的祝福
       · 点到空白   → 退出；退出后再点别的星，才能看见别的祝福 */
 if(isOpen){
  if(sel>=0)return;
  closeCard();return;
 }
 /* ② 卡片没开：只有点中星才立刻打开；点空白什么都不做 */
 if(sel>=0){flashStar(sel);openCard(shown[sel])}
}
/* 点中时那颗星轻轻涨一下，给个"点到了"的确认 */
function flashStar(i){hitFlash.i=i;hitFlash.t=1}
addEventListener('pointerdown',onDown);addEventListener('pointermove',onMove);
addEventListener('pointerup',onUp);addEventListener('pointercancel',onUp);
function resetDrag(){pointers.clear();dragging=false;down=null;lastPinch=0;autoSpin=true}
addEventListener('blur',resetDrag);
document.addEventListener('visibilitychange',function(){if(!document.hidden)resetDrag()});
addEventListener('wheel',function(e){e.preventDefault();
 tgtDist=Math.max(115,Math.min(360,tgtDist*(1+Math.sign(e.deltaY)*0.08)));
},{passive:false});

/* ---------- 祝福卡（可带照片） ---------- */
var card=document.getElementById('card'),cImg=document.getElementById('cImg');
var photoView=document.getElementById('photoView'),pvImg=document.getElementById('pvImg');
cImg.style.cursor='zoom-in';
cImg.addEventListener('pointerdown',function(e){
 e.stopPropagation();e.preventDefault();
 if(!cImg.src)return;
 pvImg.src=cImg.src;photoView.className='on';
});
photoView.addEventListener('pointerdown',function(e){
 e.stopPropagation();e.preventDefault();
 photoView.className='';pvImg.removeAttribute('src');
});
function openCard(idx){
 var w=wishes[idx];if(!w)return;
 card._idx=idx;
 if(w.img){cImg.src=w.img;cImg.style.display='block'}else{cImg.removeAttribute('src');cImg.style.display='none'}
 document.getElementById('cTxt').textContent=w.text;
 var by=w.by&&w.by.trim()?w.by:'无名',dt=new Date(w.t||Date.now());
 var ds=dt.getFullYear()+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'+String(dt.getDate()).padStart(2,'0');
 document.getElementById('cBy').textContent=by;
 document.getElementById('cMeta').textContent=ds+'　·　第 '+(w.no||idx+1)+' 颗';
 card.className='on';
}
function closeCard(){card.className=''}
document.getElementById('cClose').onclick=function(e){e.stopPropagation();closeCard()};
card.addEventListener('pointerdown',function(e){e.stopPropagation()});

/* ---------- 写祝福：面板固定在屏幕上部，不再靠键盘高度计算 ---------- */
var sheet=document.getElementById('sheet'),box=document.getElementById('box'),
    wText=document.getElementById('wText'),wBy=document.getElementById('wBy'),
    wPhoto=document.getElementById('wPhoto'),
    photoPrev=document.getElementById('photoPrev'),photoDel=document.getElementById('photoDel');
var DRAFT='xingzhou_draft_v2',photoData='';
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.className='on';
 clearTimeout(toast._t);toast._t=setTimeout(function(){t.className=''},2600)}
function saveDraft(){try{localStorage.setItem(DRAFT,JSON.stringify({t:wText.value}))}catch(e){}}
/* 署名不进草稿、不预填、不联想：每次打开都是空的，谁用就写谁自己的名字 */
function loadDraft(){wBy.value='';try{var d=JSON.parse(localStorage.getItem(DRAFT)||'null');
 if(d){wText.value=d.t||''}}catch(e){wText.value=''}}
function resetSheet(){
 sheet.className='';
 if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
}
function openSheet(){
 sheet.className='on';loadDraft();
 setTimeout(function(){wText.focus();try{wText.scrollIntoView({block:'nearest'})}catch(e){}},300);
}
function foldSheet(){saveDraft();resetSheet()}
function clearDraft(){wText.value='';wBy.value='';saveDraft();wText.focus()}
wText.addEventListener('input',saveDraft);wBy.addEventListener('input',saveDraft);

/* 照片：选图 / 粘贴 / 拖进来；失败一律静默，不弹任何话 */
function showPhoto(){
 photoPrev.innerHTML='';
 if(photoData){var im=document.createElement('img');im.src=photoData;photoPrev.appendChild(im);
  photoPrev.style.display='block';photoDel.style.display='block'}
 else{photoPrev.style.display='none';photoDel.style.display='none'}
}
function readPhoto(file){
 if(!file||!/^image\//.test(file.type))return
 var fr=new FileReader();
 fr.onerror=function(){};
 fr.onload=function(){
  var im=new Image();
  im.onerror=function(){};
  im.onload=function(){
   /* 高清：最长边 3200、质量 .96；只有体积过大才逐档退，尽量保住细节 */
   function render(edge,q){
    var sc=Math.min(1,edge/Math.max(im.width,im.height));
    var c=document.createElement('canvas');
    c.width=Math.max(1,Math.round(im.width*sc));c.height=Math.max(1,Math.round(im.height*sc));
    var cx=c.getContext('2d');
    cx.imageSmoothingEnabled=true;cx.imageSmoothingQuality='high';
    cx.drawImage(im,0,0,c.width,c.height);
    return c.toDataURL('image/jpeg',q);
   }
   try{
    var d=render(3200,.96);
    if(d.length>5000000)d=render(2560,.94);
    if(d.length>5000000)d=render(2000,.92);
    if(d.length>5000000)d=render(1600,.88);
    photoData=d;
   }catch(err){return}
   showPhoto();
  };
  im.src=fr.result;
 };
 fr.readAsDataURL(file);
}
document.getElementById('photoPick').onclick=function(e){
 e.stopPropagation();
 try{wPhoto.click()}catch(err){}
};
wPhoto.addEventListener('change',function(e){
 var f=e.target.files&&e.target.files[0];if(f)readPhoto(f);e.target.value='';
});
/* 粘贴：截图后从剪贴板带进来，绕开被拦的文件选择 */
document.getElementById('photoPaste').onclick=async function(e){
 e.stopPropagation();
 try{
  var items=await navigator.clipboard.read();
  var got=false;
  for(var i=0;i<items.length;i++){
   for(var j=0;j<items[i].types.length;j++){
    if(/^image\//.test(items[i].types[j])){
     var blob=await items[i].getType(items[i].types[j]);
     readPhoto(new File([blob],'p.png',{type:blob.type}));got=true;break;
    }
   }
   if(got)break;
  }
  if(!got)return;
 }catch(err){}
};
document.addEventListener('paste',function(e){
 if(sheet.className!=='on')return;
 var its=e.clipboardData&&e.clipboardData.items;if(!its)return;
 for(var i=0;i<its.length;i++)if(/^image\//.test(its[i].type)){
  readPhoto(its[i].getAsFile());e.preventDefault();return;
 }
});
box.addEventListener('dragover',function(e){e.preventDefault()});
box.addEventListener('drop',function(e){
 e.preventDefault();var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
 if(f)readPhoto(f);
});
photoDel.onclick=function(){photoData='';showPhoto()};

/* ── 提交：一次点击 = 一张 request_id = 恰好一条写入请求 ──
   · 无内容/图片/作者/时间窗去重，无 3 秒限流：解锁后用户再点就是合法新的一条
   · 点击立刻 disabled + loading，收到服务端成功回执才解锁
   · 没收到回执期间不生成新票、不重复发；失败最多重试 1 次且复用同一张票
   · 不存本地队列、不联网重放；图片压缩后随请求提交，表里只留链接 */
var sending=false;
function newTicket(){
 try{ if(window.crypto&&crypto.randomUUID)return crypto.randomUUID(); }catch(e){}
 return 't'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
}
function showMyTotal(n){
 var el=document.getElementById('mineNum');
 if(el)el.textContent='共 '+n+' 条';
}
function send(){
 if(sending)return;                       /* 按钮也 disabled，双保险 */
 var btn=document.getElementById('wSend');
 if(!btn||btn.disabled)return;
 var txt=wText.value;
 if(!txt.trim())return;
 if(wishes.length>=CONFIG.capacity)return;
 var by=wBy.value.trim()||'无名',img=photoData||'';
 var ticket=newTicket();                 /* 本次点击唯一的一张票，重试不再生成 */
 var old=btn.textContent;
 function lock(){sending=true;btn.disabled=true;btn.textContent='· · ·'}
 function unlock(){sending=false;btn.disabled=false;btn.textContent=old}
 function succeed(w){
  unlock();
  wText.value='';wBy.value='';photoData='';showPhoto();saveDraft();resetSheet();
  toast('已 提 交 · 审 核 通 过 后 才 会 亮 起 ✦');
  if(w&&typeof w.total==='number')showMyTotal(w.total);
  try{renderMine()}catch(e){}
 }
 function giveUp(){
  unlock();
  toast('没 发 出 去 · 请 再 点 一 次 ✦');   /* 内容还在，用户重新点=新票=合法新增 */
 }
 lock();
 function attempt(retried){
  STORE.add({text:txt,by:by,img:img},ticket).then(succeed).catch(function(){
   if(!retried){setTimeout(function(){attempt(true)},1200);return}  /* 同票最多重试 1 次 */
   giveUp();
  });
 }
 attempt(false);
}
/* 旧 flushPending / setInterval / online 重放 / 本地队列：全部删除，绝不批量重放 */
window.__xzBind(document.getElementById('add'),'onclick',function(e){e.stopPropagation();closeSearch();closeMine();openSheet()});
window.__xzBind(document.getElementById('reshuffle'),'onclick',function(e){e.stopPropagation();closeSearch();closeMine();closeCard();pickBatch()});
window.__xzBind(document.getElementById('wSend'),'onclick',send);
window.__xzBind(document.getElementById('wFold'),'onclick',foldSheet);
window.__xzBind(document.getElementById('wClear'),'onclick',clearDraft);
sheet.addEventListener('pointerdown',function(e){if(e.target===sheet)foldSheet()});
box.addEventListener('pointerdown',function(e){e.stopPropagation()});

/* ---------- 搜索：右下角 → 查第几颗 → 直接看见那条祝福 ---------- */
var searchPanel=document.getElementById('searchPanel'),searchNo=document.getElementById('searchNo');
function openSearch(){
 closeCard();foldSheet();closeAdmin();closeMine();closeAll();
 searchPanel.className='on';
 setTimeout(function(){searchNo.focus()},260);
}
function closeSearch(){searchPanel.className='';searchNo.value=''}
function doSearch(){
 var raw=searchNo.value.trim();
 if(!raw){searchPanel.className='on shk';
  setTimeout(function(){if(searchPanel.className.indexOf('shk')>=0)searchPanel.className='on'},400);return}
 var n=toNo(raw),idx=findByNo(n),numeric=/^\d+$/.test(raw);
 /* 纯编号 → 直接开那一颗；38 就是 38，40 就是 40 */
 if(isFinite(n)&&idx>=0){
  closeSearch();pickBatch(idx);flashStar(0);openCard(idx);return
 }
 /* 数字没搜到：先静默向云端再要一次全量（有人刚写时不会漏），仍没有才明说 */
 if(numeric){
  searchPanel.className='on shk';
  setTimeout(function(){if(searchPanel.className.indexOf('shk')>=0)searchPanel.className='on'},400);
  retryCount=0;hardReload();
  setTimeout(function(){
   var k=findByNo(n);
   if(k>=0){closeSearch();pickBatch(k);flashStar(0);openCard(k)}
   else toast('共 '+wishes.length+' 颗 · 没有第 '+n+' 颗');
  },900);
  return;
 }
 /* 名字 / 正文关键词 → 列出这个人写的所有祝福 */
 var kw=raw.toLowerCase(),res=[];
 for(var i=0;i<wishes.length;i++){
  var w=wishes[i];
  if(((w.by||'').toLowerCase().indexOf(kw)>=0)||((w.text||'').toLowerCase().indexOf(kw)>=0))res.push(i);
 }
 if(!res.length){
  searchPanel.className='on shk';
  setTimeout(function(){if(searchPanel.className.indexOf('shk')>=0)searchPanel.className='on'},400);
  toast('共 '+wishes.length+' 颗 · 没找到「'+raw+'」');return;
 }
 closeSearch();openAll(res,raw);
}
/* ---- 全部祝福：查每一个人写的东西，点一条看全文 + 高清图 ---- */
var allPanel=document.getElementById('allPanel');
function closeAll(){if(allPanel)allPanel.className=''}
function openAll(list,kw){
 if(!allPanel)return;
 var head=document.getElementById('allHead'),num=document.getElementById('allNum'),box=document.getElementById('allList');
 head.textContent=kw?('「'+kw+'」的 祝 福'):'全 部 祝 福';
 num.textContent='共 '+list.length+' 条';
 var h=list.slice().reverse().map(function(i){
  var w=wishes[i],dt=new Date(w.t||Date.now());
  var ds=dt.getFullYear()+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'+String(dt.getDate()).padStart(2,'0');
  var by=w.by&&w.by.trim()?w.by:'无名';
  var tx=w.text||'',cut=tx.length>70?tx.slice(0,70)+'…':tx;
  return '<div class="it" data-idx="'+i+'"><div class="bd">'+
   '<div class="no">✦ 第 '+w.no+' 颗 · '+ds+' · '+esc(by)+'</div>'+
   '<div class="tx">'+esc(cut)+'</div>'+
   (w.img?'<img class="im" src="'+w.img+'" alt="">':'')+'</div></div>';
 }).join('');
 box.innerHTML=h||'<div class="none">还没有祝福</div>';
 allPanel.className='on';
 box.onclick=function(e){
  var it=e.target.closest('.it');if(!it)return;
  var k=parseInt(it.getAttribute('data-idx'),10);
  closeAll();pickBatch(k);flashStar(0);openCard(k);
 };
}
document.getElementById('allOpen').onclick=function(e){
 e.stopPropagation();closeSearch();closeCard();foldSheet();closeMine();
 var all=[];for(var i=0;i<wishes.length;i++)all.push(i);
 openAll(all,'');
};
document.getElementById('allClose').onclick=function(e){e.stopPropagation();closeAll()};
allPanel.addEventListener('pointerdown',function(e){e.stopPropagation()});
document.getElementById('searchBtn').onclick=function(e){e.stopPropagation();openSearch()};
document.getElementById('searchGo').onclick=function(e){e.stopPropagation();doSearch()};
document.getElementById('searchClose').onclick=function(e){e.stopPropagation();closeSearch()};
searchNo.addEventListener('keydown',function(e){if(e.key==='Enter')doSearch()});
searchPanel.addEventListener('pointerdown',function(e){e.stopPropagation()});

/* ---------- 管理：小设置 → 密码 → 输第几颗删除，全程不对外显示 ---------- */
var adminGate=document.getElementById('adminGate'),admin=document.getElementById('admin'),
    adPw=document.getElementById('adPw'),adErr=document.getElementById('adErr'),delNo=document.getElementById('delNo');
function closeAdmin(){adminGate.className='';admin.className='';adPw.value='';adErr.className='err';delNo.value='';
 document.getElementById('delPrev').textContent=''}
window.__xzBind(document.getElementById('setting'),'onclick',function(e){
 e.stopPropagation();closeCard();foldSheet();closeSearch();closeMine();
 admin.className='';adminGate.className='on';setTimeout(function(){adPw.focus()},260);
});
window.__xzBind(document.getElementById('adCancel'),'onclick',closeAdmin);
window.__xzBind(document.getElementById('adClose'),'onclick',closeAdmin);
function enterAdmin(){
 if(adPw.value===CONFIG.adminPass){
  setOwner();                         /* 输过一次，这台以后写的都归进「我的」 */
  adminGate.className='';admin.className='on';adPw.value='';adErr.className='err';
  document.getElementById('delPrev').textContent='输入序号后，这里会先显示那一条，确认再删';
 }else{adErr.className='err on';adPw.value=''}
}
window.__xzBind(document.getElementById('adEnter'),'onclick',enterAdmin);
window.__xzBind(adPw,'keydown',function(e){if(e.key==='Enter')enterAdmin()});
delNo.addEventListener('input',function(){
 var n=parseInt(delNo.value,10),p=document.getElementById('delPrev'),idx=findByNo(n);
 if(idx>=0){
  var w=wishes[idx],s=w.text.length>34?w.text.slice(0,34)+'…':w.text;
  p.textContent='第 '+w.no+' 颗｜'+(w.by||'无名')+'：'+s+(w.img?'　［含照片］':'');
 }else p.textContent=delNo.value?'没有这一颗':'';
});
window.__xzBind(document.getElementById('delBtn'),'onclick',function(){
 var n=parseInt(delNo.value,10),idx=findByNo(n);
 if(idx<0){document.getElementById('delPrev').textContent='没有这一颗';return}
 var delDk=wishes[idx].dk;
 STORE.remove(delDk).then(function(ok){
  if(!ok&&!loadFailed){document.getElementById('delPrev').textContent='没删掉';return}
  var k=findByNo(n);if(k>=0)wishes.splice(k,1);
  lastKnownN=wishes.length;emptyStreak=2;
  try{localStorage.setItem('xz_last_n',String(lastKnownN))}catch(e){}
  lastSig=sigOf(wishes);
  closeCard();pickBatch();
  var tt=document.getElementById('toast');tt.className='';tt.textContent='';
  delNo.value='';document.getElementById('delPrev').textContent='已删除';
 });
});
adminGate.addEventListener('pointerdown',function(e){e.stopPropagation()});
admin.addEventListener('pointerdown',function(e){e.stopPropagation()});

/* ---------- 我的星星：只看自己写的，只看数量，只能删除 ---------- */
var minePanel=document.getElementById('minePanel'),mineList=document.getElementById('mineList');
function esc(s){return String(s).replace(/[&<>"']/g,function(c){
 return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function mineIdx(){
 var a=[],i,s={},m=myIdsGet();for(i=0;i<m.length;i++)s[m[i]]=1;
 for(i=0;i<wishes.length;i++){
  var w=wishes[i];
  if(s[w.dk]||(/^local_/.test(String(w.dk))&&w.owner===MYKEY))a.push(i);
 }
 return a;
}
/* 实时判定：主人浏览器全可删；别人那边只能删自己在这台写过的 */
function canDelete(w){return isOwner()||w.canDel===true}
function renderMine(){
 var ix=mineIdx(),LIMIT=200,show=ix.slice(-LIMIT).reverse();   /* 最近的在前，最多 200 条，多了不卡 */
 document.getElementById('mineNum').textContent='共 '+ix.length+' 条';
 if(!ix.length){mineList.innerHTML='<div class="none">还没有你的星星</div>';return}
 var html=show.map(function(i){
  var w=wishes[i],dt=new Date(w.t||Date.now());
  var ds=dt.getFullYear()+'.'+String(dt.getMonth()+1).padStart(2,'0')+'.'+String(dt.getDate()).padStart(2,'0');
  return '<div class="it"><div class="bd"><div class="no">第 '+w.no+' 颗 · '+ds+'</div>'+
   '<div class="tx">'+esc(w.text)+'</div>'+
   (w.img?'<img class="im" src="'+w.img+'" alt="">':'')+'</div>'+
   (canDelete(w)?'<span class="del" data-no="'+w.no+'">删 除</span>':'')+'</div>';
 }).join('');
 if(ix.length>LIMIT)html+='<div class="none">只显示最近 200 颗</div>';
 mineList.innerHTML=html;
}
function openMine(){
 closeCard();foldSheet();closeSearch();closeAdmin();
 minePanel.className='on';renderMine();
}
function closeMine(){minePanel.className=''}
window.__xzBind(document.getElementById('mineBtn'),'onclick',function(e){e.stopPropagation();openMine()});
window.__xzBind(document.getElementById('mineClose'),'onclick',function(e){e.stopPropagation();closeMine()});
/* 「我 的」列表的删除统一交给 addon 唯一的委托监听（.xz-del），
   这里不再挂第二个 click 监听，杜绝双绑各删一次 */
minePanel.addEventListener('pointerdown',function(e){e.stopPropagation()});


/* ---------- 粒子星球：紫色球体 + 香槟金细环，实时自转，点一下推近穿进星 宙 ----------
   独立 renderer / scene / camera，与底下那片星 宙完全隔离；穿入后即释放。 */
var planet=document.getElementById('planet'),pc=document.getElementById('pc');
var sky=document.getElementById('sky'),skyVisible=false,zoomAcc=0,pCooldown=0;
var immersed=false;
function exitImmerse(){
 immersed=false;document.body.classList.remove('immerse');
 resetDrag();
}
function toggleImmerse(){
 if(immersed){exitImmerse();return}
 immersed=true;
 closeFloating();resetDrag();autoSpin=true;
 document.body.classList.add('immerse');
}
document.getElementById('immerse').addEventListener('pointerdown',function(e){
 e.stopPropagation();e.preventDefault();toggleImmerse();
});
document.getElementById('exitBtn').addEventListener('pointerdown',function(e){
 e.stopPropagation();e.preventDefault();backToPlanet();
});
function skyBusy(){return !skyVisible}
function closeFloating(){
 photoView.className='';pvImg.removeAttribute('src');
 ['card','sheet','searchPanel','minePanel','admin','adminGate'].forEach(function(id){
  var el=document.getElementById(id);
  if(el)el.className=el.className.replace(/\bon\b/g,'').trim();
 });
}
/* 左上角退出键 → 星 宙缩小、退回粒子星球；星球轻触 → 放大进入星 宙 */
function backToPlanet(){
 if(skyBusy())return;
 skyVisible=false;zoomAcc=0;
 if(immersed)exitImmerse();
 closeFloating();
 pCooldown=Date.now()+1950;                    /* 缩回期间残留的手指别把星球又点穿 */
 /* 从「当前这一刻的缩放值」继续，一点一点缩到 .28，不再唰一下跳完 */
 var mm=sky.style.transform.match(/scale\(([\d.]+)/);
 var cur=mm?parseFloat(mm[1]):1;
 sky.className='';
 sky.style.transition='transform 2.2s cubic-bezier(.40,.30,.60,.70),opacity 1.9s ease';
 sky.style.transform='scale('+Math.min(cur,.28)+')';
 sky.style.opacity='0';
 showPlanet();                                 /* 星球 1.5s 慢慢淡入，像镜头缓缓拉远 */
 planet.className='on wait';
 setTimeout(function(){if(planet.className.indexOf('wait')>=0)planet.className='on'},1700);
 setTimeout(function(){
  if(skyVisible)return;                        /* 期间又点进去了就不收尾 */
  sky.className='gone';sky.style.transform='';sky.style.opacity='';
 },2350);
}
var pRenderer=null,pScene=null,pCam=null,pGroup=null,pRing=null,pGalaxy=null;
var pTwinkle=[],pWanderers=[],pCoreGlow=null,pCa=Math.cos(0.55),pSa=Math.sin(0.55);
var pRAF=0,pAlive=false,pPierce=false,pT0=0,pZ0=8.6,pZ1=1.50;
var pW=0,pH=0,pResize=null;

function pDot(inner,mid){
 var c=document.createElement('canvas');c.width=c.height=64;
 var x=c.getContext('2d');
 var g=x.createRadialGradient(32,32,0,32,32,32);
 g.addColorStop(0,inner);g.addColorStop(.36,mid);g.addColorStop(1,'rgba(255,255,255,0)');
 x.fillStyle=g;x.fillRect(0,0,64,64);
 var t=new THREE.CanvasTexture(c);t.needsUpdate=true;return t;
}
function pPoints(pos,col,size,op,tex,normal){
 var g=new THREE.BufferGeometry();
 g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(pos),3));
 g.setAttribute('color',new THREE.BufferAttribute(new Float32Array(col),3));
 var m=new THREE.PointsMaterial({size:size,map:tex,vertexColors:true,transparent:true,
   opacity:op,depthWrite:false,
   blending:normal?THREE.NormalBlending:THREE.AdditiveBlending,sizeAttenuation:true});
 return new THREE.Points(g,m);
}
/* 面向相机的空心雾紫光晕：中心透、边缘一圈柔亮 —— 参考图那种星尘壳感 */
function pCore(R){
 var c=document.createElement('canvas');c.width=c.height=256;
 var x=c.getContext('2d'),g=x.createRadialGradient(128,128,0,128,128,128);
 g.addColorStop(0,'rgba(9,6,22,.50)');
 g.addColorStop(.55,'rgba(10,7,24,.38)');
 g.addColorStop(.82,'rgba(12,8,28,.12)');
 g.addColorStop(1,'rgba(12,8,28,0)');
 x.fillStyle=g;x.fillRect(0,0,256,256);
 var t=new THREE.CanvasTexture(c);t.needsUpdate=true;
 var sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,transparent:true,depthWrite:false,
   depthTest:false,blending:THREE.NormalBlending}));
 sp.scale.set(R*1.75,R*1.75,1);sp.renderOrder=4;return sp;
}
function pHalo(R){
 var c=document.createElement('canvas');c.width=c.height=256;
 var x=c.getContext('2d'),g=x.createRadialGradient(128,128,0,128,128,128);
 g.addColorStop(0,'rgba(168,138,232,0)');
 g.addColorStop(.66,'rgba(168,138,232,0)');
 g.addColorStop(.80,'rgba(190,162,246,.045)');
 g.addColorStop(.89,'rgba(216,192,255,.155)');
 g.addColorStop(.95,'rgba(196,166,246,.075)');
 g.addColorStop(1,'rgba(158,126,222,0)');
 x.fillStyle=g;x.fillRect(0,0,256,256);
 var t=new THREE.CanvasTexture(c);t.needsUpdate=true;
 var sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,transparent:true,depthWrite:false,
   blending:THREE.AdditiveBlending,opacity:.95}));
 sp.scale.set(R*2.34,R*2.34,1);return sp;
}
function tri(){return (Math.random()+Math.random()+Math.random()+Math.random())/4}
function pMix(a,b,t){return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]}

function initPlanet(){
 if(pAlive)return;
 pW=window.innerWidth;pH=window.innerHeight;
 try{
  pRenderer=new THREE.WebGLRenderer({canvas:pc,antialias:true,alpha:true,powerPreference:'high-performance'});
 }catch(e){pFallback();return}
 pRenderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
 pRenderer.setSize(pW,pH,false);
 pRenderer.setClearColor(0x000000,0);

 pScene=new THREE.Scene();
 pCam=new THREE.PerspectiveCamera(45,pW/pH,.1,100);
 pCam.position.set(0,0,pZ0);pCam.lookAt(0,0,0);

 var texP=pDot('rgba(255,255,255,.95)','rgba(226,210,255,.42)');
 var texG=pDot('rgba(250,240,255,.55)','rgba(180,152,232,.16)');
 var texR=pDot('rgba(255,250,228,1)','rgba(255,214,140,.55)');
 var texW=pDot('rgba(255,255,255,.90)','rgba(214,212,238,.30)');

 /* ===== 动态银河：实时粒子，会流动、会眨眼、亮核会呼吸 =====
    斜向带（左下→右上）+ 高斯聚带 + 斑驳明暗 + 暗尘裂谷；纯矢量，不贴图。 */
 var ca=pCa,sa=pSa;                          /* 斜带角度，动画循环也要用 */
 var gp=[],gc=[],hp=[],hc=[],G=21000,i,u,v,X,Y,Z,fall,lum,clump;
 var LAY=[[],[],[],[]],LC=[[],[],[],[]];      /* 4 组不同相位 → 星星各自眨，不整片一起闪 */
 for(i=0;i<G;i++){
  u=(Math.random()*2-1)*10.8;
  v=(Math.random()+Math.random()+Math.random()+Math.random()-2)/2*1.55;
  clump=.56+.44*Math.sin(u*1.65+1.2)*Math.cos(u*.81-.4);
  if(Math.random()>clump*.88+.10)continue;
  if(Math.abs(v)<.16&&Math.sin(u*2.2+.7)>.28&&Math.random()<.66)continue;  /* 暗尘裂谷 */
  X=u*ca-v*sa;Y=u*sa+v*ca;Z=-4.9-Math.random()*2.4;
  fall=Math.exp(-v*v/1.30);
  lum=(.48+Math.random()*1.05)*fall*(.62+clump*.50);
  var g4=i%4;
  LAY[g4].push(X,Y,Z);
  LC[g4].push(lum*1.0,lum*.98,lum*1.10);
  if(i%7===0){hp.push(X,Y,Z+.3);hc.push(.72*fall,.62*fall,.92*fall)}
 }
 /* 带外全域细星，铺满画面 */
 var ap=[],ac=[],ai;
 for(ai=0;ai<5200;ai++){
  ap.push((Math.random()-.5)*13,(Math.random()-.5)*10,-4.5-Math.random()*3.5);
  var av=.20+Math.random()*.42;ac.push(av*.92,av*.90,av*1.08);
 }
 var galaxy=new THREE.Group();
 galaxy.add(pPoints(ap,ac,.048,.68,texW));
 var dust=pPoints(hp,hc,.34,.30,texG);         /* 宽尘雾，缓慢呼吸 */
 galaxy.add(dust);
 pTwinkle=[];
 for(i=0;i<4;i++){
  var st=pPoints(LAY[i],LC[i],i%2?.110:.080,1.0,texW);
  galaxy.add(st);
  pTwinkle.push({m:st.material,ph:i*1.57,sp:.55+i*.27,base:1.0});
 }
 pTwinkle.push({m:dust.material,ph:.7,sp:.23,base:.30});
 /* 带心亮核：一大团软雾，随呼吸明暗 */
 var cn=pDot('rgba(216,206,255,.50)','rgba(126,100,190,.12)');
 var core=new THREE.Sprite(new THREE.SpriteMaterial({map:cn,transparent:true,depthWrite:false,
   blending:THREE.AdditiveBlending,opacity:.46}));
 core.scale.set(9.0,3.8,1);core.position.set(1.5,1.45,-6.4);core.renderOrder=1;
 galaxy.add(core);pCoreGlow=core;
 var core2=new THREE.Sprite(new THREE.SpriteMaterial({map:cn,transparent:true,depthWrite:false,
   blending:THREE.AdditiveBlending,opacity:.30}));
 core2.scale.set(6.4,2.8,1);core2.position.set(-2.1,-1.55,-6.6);core2.renderOrder=1;
 galaxy.add(core2);
 /* 沿斜带缓缓游走的亮星 */
 pWanderers=[];
 for(i=0;i<9;i++){
  var ws=new THREE.Sprite(new THREE.SpriteMaterial({map:texW,transparent:true,depthWrite:false,
    blending:THREE.AdditiveBlending,opacity:.5}));
  var sz=.16+Math.random()*.18;ws.scale.set(sz,sz,1);
  galaxy.add(ws);
  pWanderers.push({s:ws,u:Math.random()*20-10,v:(Math.random()-.5)*.7,
    sp:.55+Math.random()*.75,ph:Math.random()*6.28});
 }
 pScene.add(galaxy);
 pGalaxy=galaxy;

 /* 带外零星远星，极淡，只作呼吸 */
 var fp=[],fc=[];
 for(i=0;i<150;i++){
  fp.push((Math.random()-.5)*11,(Math.random()-.5)*8,-4-Math.random()*6);
  var vv=.16+Math.random()*.26;fc.push(vv*.86,vv*.82,vv);
 }
 pScene.add(pPoints(fp,fc,.032,.40,texP));

 /* ===== 紫色球体：絮状星尘壳，中心稀暗、边缘密亮，空心通透 ===== */
 var N=9000,R=0.80,pos=[],col=[],glp=[],glc=[],dust=[],dustc=[];
 var cA=[.55,.41,.84],cB=[.81,.68,.98],cC=[.94,.88,1.0];
 var GA=Math.PI*(3-Math.sqrt(5)),k;
 var CL=[];
 for(k=0;k<18;k++){
  var yy=Math.random()*2-1,rr0=Math.sqrt(Math.max(0,1-yy*yy)),aa=Math.random()*6.2832;
  CL.push([Math.cos(aa)*rr0,yy,Math.sin(aa)*rr0]);
 }
 for(i=0;i<N;i++){
  var y=1-(i/(N-1))*2,r=Math.sqrt(Math.max(0,1-y*y)),th=GA*i;
  var dx=Math.cos(th)*r,dy=y,dz=Math.sin(th)*r;
  dx+=(Math.random()-.5)*.055;dy+=(Math.random()-.5)*.055;dz+=(Math.random()-.5)*.055;
  var ln0=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;dx/=ln0;dy/=ln0;dz/=ln0;
  if(Math.random()<.58){                       /* 朝随机簇聚拢 → 絮状团块，不是均匀网格 */
   var cc0=CL[(Math.random()*CL.length)|0],w=.16+Math.random()*.46;
   dx+=(cc0[0]-dx)*w;dy+=(cc0[1]-dy)*w;dz+=(cc0[2]-dz)*w;
   var ln=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;dx/=ln;dy/=ln;dz/=ln;
  }
  var rim=1-Math.abs(dz);                      /* 0=正对镜头(中心) 1=球缘 */
  if(Math.random()<.34*(1-rim))continue;       /* 中心留白，边缘密 → 空心发光壳 */
  var rr=R+(Math.random()-.5)*.055;
  pos.push(dx*rr,dy*rr,dz*rr);
  var t=Math.random(),cv=t<.70?pMix(cA,cB,t/.70):pMix(cB,cC,(t-.70)/.30);
  var dim=(.36+rim*.64)*(.64+Math.random()*.36);
  col.push(cv[0]*dim,cv[1]*dim,cv[2]*dim);
  if(i%23===0){glp.push(dx*rr*1.03,dy*rr*1.03,dz*rr*1.03);glc.push(.60,.47,.86)}
 }
 /* 向外飘散的游离星尘 */
 for(i=0;i<620;i++){
  var q=Math.random()*6.2832,ph=Math.acos(Math.random()*2-1),rd=R*(1.05+Math.random()*.48);
  dust.push(Math.sin(ph)*Math.cos(q)*rd,Math.cos(ph)*rd,Math.sin(ph)*Math.sin(q)*rd);
  var dv=.22+Math.random()*.34;dustc.push(dv*.82,dv*.68,dv);
 }
 var sphere=pPoints(pos,col,.030,.72,texP);sphere.renderOrder=10;
 var glow=pPoints(glp,glc,.090,.16,texG);
 var halo=pHalo(R);halo.renderOrder=6;
 pGroup=new THREE.Group();
 pGroup.add(sphere);pGroup.add(glow);
 pGroup.add(pPoints(dust,dustc,.022,.42,texP));
 pScene.add(pGroup);
 pScene.add(pCore(R));                        /* 暗核：球从密集星野里浮出来 */
 pScene.add(halo);                             /* 光晕不随球转，是视线效果 */

 /* ===== 香槟金细环：极细、极克制，斜向穿过球心 ===== */
 var M=3000,rp=[],rc=[],cR=[.96,.84,.60],cR2=[1.0,.93,.74];
 for(i=0;i<M;i++){
  var a=Math.random()*Math.PI*2;
  var rad=1.16+(tri()-.5)*.14;
  var lift=(Math.random()-.5)*.026;
  var scat=Math.random()<.012?(Math.random()-.5)*.24:0;
  rp.push(Math.cos(a)*(rad+scat),lift+scat*.22,Math.sin(a)*(rad+scat));
  var q2=Math.random(),cc=pMix(cR,cR2,q2),dd=.62+Math.random()*.38;
  rc.push(cc[0]*dd,cc[1]*dd,cc[2]*dd);
 }
 var ring=pPoints(rp,rc,.024,.70,texR);ring.renderOrder=12;
 pRing=new THREE.Group();pRing.add(ring);
 pRing.rotation.x=0.38;
 pRing.rotation.z=-0.34;
 pScene.add(pRing);

 pResize=function(){
  if(!pAlive)return;
  pW=window.innerWidth;pH=window.innerHeight;
  pCam.aspect=pW/pH;pCam.updateProjectionMatrix();
  pRenderer.setSize(pW,pH,false);
 };
 window.addEventListener('resize',pResize);
 pAlive=true;pPierce=false;
 pRAF=requestAnimationFrame(pLoop);
}
function pLoop(now){
 if(!pAlive)return;
 if(pPierce){
  var k=Math.min(1,(now-pT0)/860),e=k*k*(3-2*k);
  pCam.position.z=pZ0-(pZ0-pZ1)*e;
  pGroup.rotation.y+=.007;pRing.rotation.y+=.003;
  pRenderer.render(pScene,pCam);
  if(k>=1){pFinish();return}
 }else{
  var t=now*.001;
  pGroup.rotation.y+=.0012;
  pGroup.rotation.x=.05+Math.sin(now*.00017)*.028;
  pRing.rotation.y+=.0006;
  if(pGalaxy){                                  /* 银河极慢流动 + 轻微视差 */
   pGalaxy.rotation.z+=.000055;
   pGalaxy.position.x=Math.sin(t*.075)*.24;
   pGalaxy.position.y=Math.cos(t*.052)*.14;
  }
  if(pTwinkle)for(var ti=0;ti<pTwinkle.length;ti++){
   var tw=pTwinkle[ti];
   tw.m.opacity=tw.base*(.80+.20*Math.sin(t*tw.sp+tw.ph));
  }
  if(pCoreGlow)pCoreGlow.material.opacity=.36+.14*Math.sin(t*.42);
  if(pWanderers)for(var wi=0;wi<pWanderers.length;wi++){
   var wd=pWanderers[wi];
   wd.u+=wd.sp*.016;if(wd.u>11.2)wd.u=-11.2;
   wd.s.position.set(wd.u*pCa-wd.v*pSa,wd.u*pSa+wd.v*pCa,-6.1);
   wd.s.material.opacity=.28+.42*Math.abs(Math.sin(t*.9+wd.ph));
  }
  pRenderer.render(pScene,pCam);
 }
 pRAF=requestAnimationFrame(pLoop);
}
function showPlanet(){
 skyVisible=false;
 planet.style.display='';
 planet.className='on';
 if(pRenderer){                              /* 已有场景：复位镜头、直接复活动画 */
  pCam.position.z=pZ0;pAlive=true;pPierce=false;
  pRAF=requestAnimationFrame(pLoop);
 }else setTimeout(initPlanet,60);           /* 首次才新建上下文 */
}
function pFallback(){
 /* 极老机型开不出第二个 WebGL：不卡住，直接放行到星 宙；没有星球页就别留退出键 */
 document.getElementById('exitBtn').style.display='none';
 planet.className='out';
 sky.className='';sky.style.transform='';skyVisible=true;
 setTimeout(function(){planet.style.display='none';document.getElementById('hud').className='on';if(!running)enterSky()},700);
}
function pFinish(){
 pPierce=false;pAlive=false;
 if(pRAF)cancelAnimationFrame(pRAF);
 planet.className='out';                       /* 紫雾淡出，星 宙「放大」铺满 */
 sky.className='';
 sky.style.transition='none';
 sky.style.transform='scale(.30)';sky.style.opacity='.25';
 void sky.offsetWidth;                         /* 先落定小尺寸，再放大 */
 sky.style.transition='transform 1.0s cubic-bezier(.2,.72,.2,1),opacity 1.0s ease';
 sky.style.transform='scale(1)';sky.style.opacity='1';
 skyVisible=true;zoomAcc=0;resetDrag();
 tgtDist=205;dist=205;                         /* 每次重新进来都回到完整星 宙 */
 document.getElementById('hud').className='on';
 if(!running)requestAnimationFrame(function(){if(!running)enterSky()});  /* 让放大动画先起步，别被首次初始化卡住 */
 setTimeout(function(){
  if(pAlive)return;                             /* 已经又回到星球了 */
  planet.style.display='none';
 },1050);
}
function pierce(){
 if(!pAlive||pPierce||Date.now()<pCooldown)return;
 pPierce=true;pT0=performance.now();
}
planet.addEventListener('pointerdown',function(e){e.stopPropagation();pierce()});

/* 双指捏合 / 滚轮：只把星 宙本身拉近拉远，不再退回星球。
   退回星球只走左上角那枚小箭头。 */
try{initGL()}catch(e){glOK=false;try{initFallback2D()}catch(e2){}}
/* 封面与密码输入保留：输 1016 → 粒子星球 → 点一下才进星 宙，别人进不来乱弄 */
gate.style.display='';
skyVisible=false;
document.getElementById('hud').className='';
enterSky();
