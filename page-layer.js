/* 星宙 · 分页适配层 v7
   增量覆盖：原 app.js / addon.js 一个字节不改，只在最后运行时替换少数全局函数。
   实现：列表分页 / 详情按需 / 服务端搜索 / 服务端采样 / 共 N 条 / 弱网错误态。
   不引依赖、不改视觉、不改审核规则、不恢复本地补发队列。 */
(function(){
'use strict';
var SIZE=24;
var P={ver:0,total:0,pages:0,size:SIZE,page:1,items:[],loaded:0,mode:'all',kw:'',busy:false};

function get(u,nostore){
  var o={credentials:'same-origin'};
  if(nostore){o.cache='no-store';o.headers={'Cache-Control':'no-cache'}}
  return fetch(u,o).then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json()});
}
function esc2(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function day(t){var d=new Date(t||Date.now());return d.getFullYear()+'.'+
  String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0')}
function mineSet(){var a=[],o={},i;try{a=myIdsGet()}catch(e){}
  for(i=0;i<a.length;i++)o[a[i]]=1;return o}
function light(r,mine){
  return {dk:r.id,no:Number(r.id)||0,text:r.summary||'',by:r.name||'',img:r.thumb||'',
    t:r.created_at?new Date(r.created_at).getTime():Date.now(),
    owner:mine?MYKEY:'other',canDel:!!mine,fixed:true};
}

/* ── 1. 首屏：只取 index + 第 1 页(24) + 130 颗随机星球元数据，绝不全量拉 ──
   ver 没变就复用同一份数组：否则 20 秒同步 / 5 分钟兜底会把星海重新随机排一遍。
   只有审核通过、删除、编辑让 ver+1 时才真正重取（视觉与原来完全一致）。 */
var _pool=null,_poolVer=-1;
STORE.load=function(){
  var ms=mineSet();
  return get('/api/index.json',true).then(function(idx){
    P.ver=Number(idx.ver)||0;P.total=Number(idx.total)||0;
    P.pages=Number(idx.pages)||0;P.size=Number(idx.size)||SIZE;
    if(_pool&&_poolVer===P.ver){loadFailed=false;return _pool}
    return Promise.all([
      get('/api/page/1?v='+P.ver),
      get('/api/sample?n=130',true).catch(function(){return {items:[]}})
    ]).then(function(a){
      var p1=a[0]||{},sm=a[1]||{},seen={},rows=[];
      var list=(sm.items||[]).concat(p1.items||[]);
      P.items=(p1.items||[]).slice();P.loaded=P.items.length;P.page=1;
      for(var i=0;i<list.length;i++){
        var r=list[i];if(!r||seen[r.id])continue;seen[r.id]=1;
        rows.push(light(r,!!ms[r.id]));
      }
      _pool=rows;_poolVer=P.ver;
      loadFailed=false;return rows;
    });
  }).catch(function(){loadFailed=true;return (_pool||cacheGet())});
};

/* ── 2. 上传端：长边 ≤1600、单图 ≤2MB、生成 320px 缩略图 ──
   不改 send()：它在原文件里已被绑定，适配层只接管 STORE.add。 */
function prepImage(dataUrl){
  return new Promise(function(res){
    if(!dataUrl||!/^data:image\//.test(dataUrl)){res({full:dataUrl||'',thumb:''});return}
    var im=new Image();
    im.onload=function(){
      var W=im.width,H=im.height,sc=Math.min(1,1600/Math.max(W,H));
      var w2=Math.round(W*sc),h2=Math.round(H*sc),full=dataUrl;
      if(sc<1||dataUrl.length>2800000){
        try{
          var cv=document.createElement('canvas');cv.width=w2;cv.height=h2;
          cv.getContext('2d').drawImage(im,0,0,w2,h2);
          full=cv.toDataURL('image/jpeg',0.82);
        }catch(e){full=dataUrl.slice(0,2800000)}
      }
      var tw=Math.min(320,w2),th=Math.max(1,Math.round(h2*tw/w2));
      var thumb='';
      try{
        var c2=document.createElement('canvas');c2.width=tw;c2.height=th;
        c2.getContext('2d').drawImage(im,0,0,tw,th);
        thumb=c2.toDataURL('image/jpeg',0.72);
      }catch(e){}
      res({full:full,thumb:thumb});
    };
    im.onerror=function(){res({full:dataUrl,thumb:''})};
    im.src=dataUrl;
  });
}
STORE.add=function(w,rid){
  return prepImage(w.img).then(function(p){
    return withTimeout(fetch(this.base,{method:'POST',
      headers:sbH({'Content-Type':'application/json','Prefer':'return=representation'}),
      body:JSON.stringify({text:w.text,name:w.by,photo:p.full||null,
        thumb:p.thumb||null,request_id:rid})}),9000);
  }.bind(this)).then(function(r){
    if(r.status===429)return r.json().then(function(j){throw new Error(j.error||'稍 后 再 试')});
    if(!r.ok)throw new Error('add');return r.json();
  }).then(function(a){var r=Array.isArray(a)?a[0]:a;
    if(!r||r.id===undefined)throw new Error('add');
    myIdsAdd(r.id);
    var out=fromRow(r);out.total=(r.total==null?null:Number(r.total));return out;});
};

/* ── 3. 列表：分页渲染，保留原 .it/.bd/.no/.tx/.im 长框样式 ── */
function rowHtml(r){
  var by=r.name&&String(r.name).trim()?r.name:'无名';
  return '<div class="it" data-id="'+r.id+'"><div class="bd">'+
   '<div class="no">✦ 第 '+r.id+' 颗 · '+day(r.created_at)+' · '+esc2(by)+'</div>'+
   '<div class="tx">'+esc2(r.summary||'')+'</div>'+
   (r.thumb?'<img class="im" src="'+esc2(r.thumb)+'" alt="" loading="lazy" width="320" height="180">':'')+
   '</div></div>';
}
function draw(box,num,errmsg){
  var h=P.items.map(rowHtml).join('');
  if(errmsg)h+='<div class="it" data-retry="1"><div class="bd"><div class="tx">'+esc2(errmsg)+' · 点 击 重 试</div></div></div>';
  else if(P.loaded<P.total)
    h+='<div class="it" data-more="1"><div class="bd"><div class="tx">加 载 更 多 ↓</div></div></div>';
  box.innerHTML=h||'<div class="none">还没有祝福</div>';
  num.textContent='共 '+P.total+' 条 / 已加载 '+P.loaded+' 条';
}
function loadPage(n,reset){
  if(P.busy)return;
  var box=document.getElementById('allList'),num=document.getElementById('allNum');
  P.busy=true;
  if(reset){box.innerHTML='<div class="none">正在点亮星海…</div>';
    num.textContent='正在点亮星海…'}
  var u=P.mode==='search'
    ?'/api/search?q='+encodeURIComponent(P.kw)+'&page='+n
    :'/api/page/'+n+'?v='+P.ver;
  get(u).then(function(d){
    P.busy=false;
    P.total=Number(d.total)||P.total;P.pages=Number(d.pages)||P.pages;
    if(reset){P.items=[];P.loaded=0}
    var add=(d.items||[]).slice().reverse();   /* 每页内最新在前，页间按加载顺序追加 */
    P.items=P.items.concat(add);P.loaded=P.items.length;P.page=n;
    draw(box,num);
  }).catch(function(){
    P.busy=false;
    draw(box,num,'没 加 载 出 来');
  });
}
window.openAll=function(list,kw){
  var panel=document.getElementById('allPanel');
  if(!panel)return;
  var head=document.getElementById('allHead'),box=document.getElementById('allList');
  P.kw=kw||'';P.mode=kw?'search':'all';P.page=1;P.items=[];P.loaded=0;
  head.textContent=kw?('「'+kw+'」的 祝 福'):'全 部 祝 福';
  panel.className='on';
  box.onclick=function(e){
    var it=e.target.closest('.it');if(!it)return;
    if(it.getAttribute('data-more')||it.getAttribute('data-retry')){
      loadPage(it.getAttribute('data-retry')?P.page:P.page+1,!!it.getAttribute('data-retry'));return}
    var id=parseInt(it.getAttribute('data-id'),10);
    if(isFinite(id)){closeAll();openById(id)}
  };
  /* 每次打开都取一次最新 ver：审核刚通过时立刻翻到新分片，不会被 CDN 旧页挡住 */
  get('/api/index.json',true).then(function(idx){
    P.ver=Number(idx.ver)||P.ver;P.total=Number(idx.total)||P.total;
    P.pages=Number(idx.pages)||P.pages;
    loadPage(1,true);
  }).catch(function(){loadPage(1,true)});
};

/* ── 4. 点开星球：按需拉全文 + 原图，列表从不带这两样 ── */
function openById(id){
  get('/api/wish/'+id,true).then(function(d){
    var k=-1,i;
    for(i=0;i<wishes.length;i++)if(Number(wishes[i].dk)===Number(id)){k=i;break}
    if(k<0){
      wishes.push(light({id:id,name:d.name,created_at:d.created_at},false));
      k=wishes.length-1;
    }
    wishes[k].text=d.text||'';wishes[k].by=d.name||'';wishes[k].img=d.photo||'';
    wishes[k].t=d.created_at?new Date(d.created_at).getTime():Date.now();
    return k;
  }).then(function(k){pickBatch(k);flashStar(0);openCard(k)})
    .catch(function(){toast('这 颗 星 星 暂 时 打 不 开 · 请 重 试 ✦')});
}

/* ── 5. 搜索：编号直达详情，关键词走服务端分页 ── */
window.doSearch=function(){
  var raw=searchNo.value.trim();
  if(!raw){
    searchPanel.className='on shk';
    setTimeout(function(){if(searchPanel.className.indexOf('shk')>=0)searchPanel.className='on'},400);
    return;
  }
  if(/^\d+$/.test(raw)){closeSearch();openById(Number(raw));return}
  closeSearch();window.openAll([],raw);
};

/* ── 6. 弱网：给「加 载 更 多」按钮加点击回调（事件委托已覆盖），这里只补错误提示 ── */
window.addEventListener('online',function(){
  if(P.loaded<P.total&&document.getElementById('allPanel').className.indexOf('on')>=0)
    loadPage(P.page+1,false);
});
})();
