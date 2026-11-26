
/* ===== 星宙 · 追加功能层 =====
 * 只做三件事：接管 ⚙ / 我 的、按管理员身份显隐「审」符号、提供审核与通知弹窗。
 * 上方原有逻辑、渲染、文案一律不修改；本段全部通过覆盖全局函数与动态建 DOM 实现。
 */
(function(){
  var $=function(s,r){return (r||document).querySelector(s)};
  var $$=function(s,r){return Array.from((r||document).querySelectorAll(s))};
  var XZ={admin:false,owner:false,user:null,view:'',status:'pending',muted:false,globalMute:false,advanced:false};
  var TAG={pending:'未 审 核',approved:'已 亮 起',rejected:'未 通 过'};
  var plain=function(t){return String(t||'').replace(/\u2060/g,'')};

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  async function api(method,path,b){
    var r=await fetch('/api'+path,{method:method,credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body:b===undefined?undefined:JSON.stringify(b)});
    var d={};try{d=await r.json()}catch(e){}
    if(!r.ok)throw new Error(d.error||'请求失败');return d;
  }
  function toast(m){
    try{var t=document.getElementById('toast');t.textContent=m;t.className='on';
      clearTimeout(toast._t);toast._t=setTimeout(function(){t.className='';t.textContent=''},2400)}catch(e){}
  }
  function msg(m,ok){var e=$('#xzMsg');e.textContent=m||'';e.className=ok?'ok':'';
    if(m){clearTimeout(msg._t);msg._t=setTimeout(function(){e.textContent='';e.className=''},2600)}}

  /* ── 动态建 DOM，不写进原页面 HTML ── */
  var bar=document.createElement('div');bar.id='xzBar';
  bar.innerHTML='<button class="xz-btn hot" id="xzReview" hidden>✓ 审</button>'+
    '<button class="xz-btn" id="xzNotice">通 知</button>'+
    '<button class="xz-btn" id="xzConsole">后 台</button>';
  document.body.appendChild(bar);

  var modal=document.createElement('div');modal.id='xzModal';
  modal.innerHTML='<div id="xzCard"><button id="xzClose">×</button>'+
    '<h3 id="xzTitle"></h3><div class="xz-kick">XAVIER\'S UNIVERSE</div>'+
    '<div id="xzBody"></div><div id="xzMsg"></div></div>';
  document.body.appendChild(modal);

  /* 只在进入星 宙后显示符号条（跟随原站 #hud 的 on 状态） */
  function syncBar(){
    var hud=document.getElementById('hud');
    bar.className=(hud&&hud.className.indexOf('on')>=0)?'on':'';
  }
  syncBar();
  try{new MutationObserver(syncBar).observe(document.getElementById('hud'),
    {attributes:true,attributeFilter:['class']})}catch(e){setInterval(syncBar,1500)}
  bar.addEventListener('pointerdown',function(e){e.stopPropagation()});
  modal.addEventListener('pointerdown',function(e){e.stopPropagation()});
  $('#xzClose').onclick=function(){modal.className=''};
  modal.addEventListener('click',function(e){if(e.target===modal)modal.className=''});

  /* 弹窗开着时不让星 宙跟着转 */
  try{
    var _any=anyPanelOpen;
    window.anyPanelOpen=function(){return _any()||modal.className==='on'};
  }catch(e){}

  /* ── 身份：被设为管理员就多出「审」符号，取消就收起 ── */
  async function refresh(){
    try{var r=await api('GET','/me');XZ.user=r.user||null;XZ.admin=!!r.admin;XZ.owner=!!r.owner;
      XZ.muted=!!r.muted;XZ.globalMute=!!r.global_mute;XZ.advanced=!!r.advanced}catch(e){
      XZ.user=null;XZ.admin=false;XZ.owner=false;XZ.muted=false;XZ.globalMute=false}
    $('#xzReview').hidden=!XZ.owner;
    var a=document.getElementById('add');if(a)a.textContent=XZ.globalMute?'×':'＋';
    return XZ;
  }
  refresh();setInterval(refresh,60000);

  /* ── 选图：压到 1000px 内的 jpeg，存进通知 ── */
  function compact(file,cb){
    var fr=new FileReader();
    fr.onload=function(){
      var im=new Image();
      im.onload=function(){
        var mx=1000,k=Math.min(1,mx/Math.max(im.width,im.height));
        var c=document.createElement('canvas');
        c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);
        c.getContext('2d').drawImage(im,0,0,c.width,c.height);
        cb(c.toDataURL('image/jpeg',.72));
      };
      im.src=fr.result;
    };
    fr.readAsDataURL(file);
  }
  function bindPic(btnId,fileId,nameId,holder){
    var b=$('#'+btnId),f=$('#'+fileId),n=$('#'+nameId);
    if(!b||!f)return;
    b.onclick=function(){f.click()};
    f.onchange=function(e){
      var file=e.target.files&&e.target.files[0];if(!file)return;
      compact(file,function(d){holder.v=d;if(n)n.textContent='已选图'});
      e.target.value='';
    };
  }

  /* ── 通用弹窗 ── */
  function open(view,title){XZ.view=view;$('#xzTitle').textContent=title;
    modal.className='on';msg('');
    var was=XZ.admin;
    refresh().then(function(){if(XZ.view===view&&was!==XZ.admin)render()});
    render();}
  function closeOther(){
    try{closeCard();foldSheet();closeSearch();closeMine();closeAll();closeAdmin()}catch(e){}
  }
  function render(){
    if(XZ.view==='setting')return renderSetting();
    if(XZ.view==='advanced')return renderAdvanced();
    if(XZ.view==='review')return renderReview();
    if(XZ.view==='notice')return renderNotice();
  }

  /* ── ⚙ 设置 ── */
  function renderSetting(){
    var who=XZ.user?('已登录 · '+esc(XZ.user.name)+(XZ.owner?' · 管理员':'')):'未登录';
    $('#xzBody').innerHTML=
      '<div class="xz-hint">当前：'+who+'</div>'+
      (XZ.user?'':'<div class="xz-row"><button class="xz-chip" id="xzGoLogin">去 登 录</button></div>')+
      '<div class="xz-sec">发 给 全 部 用 户</div>'+
      '<input id="xzNote" type="text" maxlength="200" placeholder="填入通知">'+
      '<div class="xz-row"><button class="xz-chip" id="xzNotePic">选 图</button>'+
        '<span class="xz-hint" id="xzNotePicName" style="flex:1"></span></div>'+
      '<input type="file" id="xzNoteFile" accept="image/*" hidden>'+
      '<div class="xz-row"><button class="xz-chip" id="xzSend">发 送 通 知</button></div>'+
      '<div class="xz-sec">删 除 祝 福 星</div>'+
      '<div class="xz-list" id="xzDelList"><div class="xz-empty">读取中…</div></div>'+
      '<div class="xz-sec">高 级 设 置</div>'+
      '<div class="xz-row"><button class="xz-chip" id="xzGoAdv">进 入</button></div>'+
      '<div class="xz-row" style="margin-top:.9rem"><button class="xz-chip" id="xzGoConsole">打 开 后 台</button></div>';
    var pic={v:''};
    bindPic('xzNotePic','xzNoteFile','xzNotePicName',pic);
    var go=$('#xzGoLogin');if(go)go.onclick=function(){location.href='./console.html'};
    $('#xzGoAdv').onclick=openAdvancedGate;
    $('#xzSend').onclick=window.__xzOnce(async function(){
      var t=$('#xzNote').value.trim();if(!t&&!pic.v){msg('填入通知');return}
      try{await api('POST','/admin/announce',{text:t,photo:pic.v});
        $('#xzNote').value='';pic.v='';$('#xzNotePicName').textContent='';
        msg('已发送','ok');toast('通知已发出')}catch(e){msg(e.message)}
    });
    $('#xzGoConsole').onclick=function(){location.href='./console.html'};
    loadDeletable();
  }

  /* ── 高级设置：口令 1016sxh，只在服务端校验 ── */
  function openAdvancedGate(){
    XZ.view='advgate';
    $('#xzTitle').textContent='高 级 设 置';
    $('#xzBody').innerHTML='<input id="xzAdvPw" type="password" placeholder="密 码">'+
      '<div class="xz-row"><button class="xz-chip" id="xzAdvOk">进 入</button></div>';
    msg('');
    $('#xzAdvOk').onclick=advLogin;
    $('#xzAdvPw').onkeydown=function(e){if(e.key==='Enter')advLogin()};
  }
  async function advLogin(){
    var p=$('#xzAdvPw');if(!p)return;
    try{await api('POST','/advanced/login',{password:p.value});
      p.value='';XZ.advanced=true;refresh();open('advanced','高 级 设 置');
    }catch(e){msg('不对')}
  }
  function renderAdvanced(){
    $('#xzBody').innerHTML=
      '<div class="xz-list" id="xzAdvList"><div class="xz-empty">读取中…</div></div>'+
      '<div class="xz-sec">全 场 禁 言</div>'+
      '<div class="xz-row"><button class="xz-chip" id="xzGmOn">开 启</button>'+
        '<button class="xz-chip warn" id="xzGmOff">关 闭</button>'+
        '<span class="xz-hint" id="xzGmState" style="flex:1"></span></div>'+
      '<div class="xz-row"><button class="xz-chip ghost" id="xzAdvOut">退 出 高 级</button></div>';
    $('#xzGmOn').onclick=function(){setGlobalMute(true)};
    $('#xzGmOff').onclick=function(){setGlobalMute(false)};
    $('#xzAdvOut').onclick=async function(){
      try{await api('POST','/advanced/logout',{});XZ.advanced=false;refresh();
        open('setting','设 置')}catch(e){msg(e.message)}
    };
    loadAdvanced();
  }
  async function setGlobalMute(on){
    try{await api('POST','/advanced/global-mute',{on:on});
      XZ.globalMute=on;refresh();loadAdvanced();toast(on?'已开启':'已关闭')}catch(e){msg(e.message)}
  }
  async function loadAdvanced(){
    var box=$('#xzAdvList');if(!box)return;
    try{
      var r=await api('GET','/advanced/users'),list=r.users||[];
      XZ.globalMute=!!r.global_mute;
      var stn=$('#xzGmState');if(stn)stn.textContent=r.global_mute?'已开启':'未开启';
      if(!list.length){box.innerHTML='<div class="xz-empty">还没有账号</div>';return}
      box.innerHTML=list.map(function(u){
        return '<div class="xz-item"><div class="t"><span class="nm">✦ '+esc(u.name)+'</span>'+
          '<span class="xz-tag '+(u.is_admin?'approved':'')+'">'+
          (u.is_admin?'管 理 员':'成 员')+(u.muted?' · 已 禁 言':'')+'</span></div>'+
          '<div class="t"><span class="tm">'+esc(u.email)+'</span></div>'+
          '<div class="xz-row">'+
            '<button class="xz-chip" data-act="promote" data-k="'+esc(u.email)+'">设为管理员</button>'+
            '<button class="xz-chip warn" data-act="demote" data-k="'+esc(u.email)+'">撤 除</button>'+
            '<button class="xz-chip" data-act="mute" data-k="'+esc(u.email)+'">禁 言</button>'+
            '<button class="xz-chip" data-act="unmute" data-k="'+esc(u.email)+'">解 禁</button>'+
            '<button class="xz-chip" data-act="reset" data-k="'+esc(u.email)+'">重置密码</button>'+
          '</div></div>';
      }).join('');
      $$('[data-act]',box).forEach(function(b){b.onclick=async function(){
        var act=b.dataset.act,k=b.dataset.k;
        try{
          if(act==='promote'||act==='demote')
            await api('POST','/admin/users',{key:k,action:act});
          else if(act==='mute'||act==='unmute')
            await api('POST','/advanced/mute',{key:k,action:act});
          else{
            var d=await api('POST','/advanced/reset-password',{key:k});
            window.alert('新密码（只显示这一次）：'+d.password);
            return;
          }
          toast('已生效');loadAdvanced();refresh();
        }catch(e){msg(e.message)}
      }});
    }catch(e){box.innerHTML='<div class="xz-empty">'+esc(e.message)+'</div>'}
  }

  async function loadDeletable(){
    var box=$('#xzDelList');if(!box)return;
    try{
      var r=XZ.admin?await api('GET','/admin/wishes?status=all'):await api('GET','/mine');
      var list=r.wishes||[];
      if(!list.length){box.innerHTML='<div class="xz-empty">还没有祝福星</div>';return}
      box.innerHTML=list.slice(0,100).map(function(w){
        return '<div class="xz-item"><div class="t"><span class="nm">✦ 第 '+w.id+' 颗 · '+esc(w.name||'无名')+'</span>'+
          '<span class="xz-tag '+(w.status||'approved')+'">'+(TAG[w.status]||'已 亮 起')+'</span></div>'+
          '<p class="tx">'+esc(plain(w.text).slice(0,90))+'</p>'+
          '<div class="xz-row"><button class="xz-chip warn" data-del="'+w.id+'">删 除</button></div></div>';
      }).join('');
      $$('[data-del]',box).forEach(function(b){b.onclick=window.__xzOnce(async function(){
        if(!confirm('确定删除这颗祝福星？'))return;
        try{
          if(XZ.admin)await api('POST','/admin/wishes/'+b.dataset.del,{action:'delete'});
          else await api('POST','/mine',{id:b.dataset.del,action:'delete'});
          toast('已删除');loadDeletable();
          try{hardReload()}catch(e){}
        }catch(e){msg(e.message)}
      })});
    }catch(e){box.innerHTML='<div class="xz-empty">'+esc(e.message)+'</div>'}
  }

  /* ── 审 核：未审核 / 已审核都标明，通过后星 宙里不挂任何审核字样 ── */
  function renderReview(){
    if(!XZ.admin){$('#xzBody').innerHTML='<div class="xz-empty">只有管理员能审核</div>';return}
    $('#xzBody').innerHTML=
      '<div class="xz-row">'+
        ['pending','approved','rejected','all'].map(function(k){
          var n={pending:'待 审',approved:'已 审',rejected:'未 过',all:'全 部'}[k];
          return '<button class="xz-chip'+(XZ.status===k?' on':'')+'" data-st="'+k+'">'+n+'</button>';
        }).join('')+'</div>'+
      '<div class="xz-row"><label class="xz-pick"><input type="checkbox" id="xzAll"> 全 选</label>'+
        '<button class="xz-chip" id="xzApprove">批 量 通 过</button>'+
        '<button class="xz-chip warn" id="xzReject">批 量 拒 绝</button>'+
        '<button class="xz-chip warn" id="xzBatchDel">批 量 删 除</button></div>'+
      '<div class="xz-list" id="xzReviewList"><div class="xz-empty">读取中…</div></div>';
    $$('[data-st]').forEach(function(b){b.onclick=function(){XZ.status=b.dataset.st;renderReview()}});
    $('#xzAll').onchange=function(e){$$('#xzReviewList [data-pick]').forEach(function(c){c.checked=e.target.checked})};
    $('#xzApprove').onclick=function(){batch('approve')};
    $('#xzReject').onclick=function(){batch('reject')};
    $('#xzBatchDel').onclick=function(){batch('delete')};
    loadReviewList();
  }
  async function loadReviewList(){
    var box=$('#xzReviewList');if(!box)return;
    try{
      var r=await api('GET','/admin/wishes?status='+encodeURIComponent(XZ.status)),list=r.wishes||[];
      if(!list.length){box.innerHTML='<div class="xz-empty">这里空空的</div>';return}
      box.innerHTML=list.map(function(w){
        return '<div class="xz-item"><div class="t">'+
          '<label class="xz-pick"><input type="checkbox" data-pick="'+w.id+'"></label>'+
          '<span class="xz-hint" style="flex:1">✦ 第 '+w.id+' 颗</span>'+
          '<span class="xz-tag '+esc(w.status)+'">'+(TAG[w.status]||w.status)+'</span></div>'+
          '<div class="t" style="margin-top:.25rem"><span class="nm">'+esc(w.name||'无名')+'</span>'+
          '<span class="tm">'+fmt(w.created_at)+'</span></div>'+
          (w.photo?'<img src="'+esc(w.photo)+'" alt="">':'')+
          '<p class="tx">'+esc(plain(w.text))+'</p>'+
          '<div class="xz-row">'+
            '<button class="xz-chip" data-one="approve" data-id="'+w.id+'">通 过</button>'+
            '<button class="xz-chip warn" data-one="reject" data-id="'+w.id+'">拒 绝</button>'+
            '<button class="xz-chip warn" data-one="delete" data-id="'+w.id+'">删 除</button>'+
          '</div></div>';
      }).join('');
      $$('[data-one]',box).forEach(function(b){b.onclick=window.__xzOnce(async function(){
        if(b.dataset.one==='delete'&&!confirm('确定删除？'))return;
        try{await api('POST','/admin/wishes/'+b.dataset.id,{action:b.dataset.one});
          toast('已处理');loadReviewList();try{hardReload()}catch(e){}}
        catch(e){msg(e.message)}
      })});
    }catch(e){box.innerHTML='<div class="xz-empty">'+esc(e.message)+'</div>'}
  }
  function picked(){return $$('#xzReviewList [data-pick]:checked').map(function(c){return c.dataset.pick})}
  var batch=window.__xzOnce(async function(act){
    var ids=picked();if(!ids.length){msg('先勾选几条');return}
    if(act==='delete'&&!confirm('确定删除选中的 '+ids.length+' 条？'))return;
    try{await api('POST','/admin/wishes/batch',{ids:ids,action:act});
      toast('已批量处理');loadReviewList();try{hardReload()}catch(e){}}
    catch(e){msg(e.message)}
  });
  function fmt(v){var d=new Date(v);return isNaN(d)?'':(d.getMonth()+1)+'/'+d.getDate()+' '+
    String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}

  /* ── 通 知 ── */
  function renderNotice(){
    $('#xzBody').innerHTML='<div class="xz-list" id="xzNoticeList"><div class="xz-empty">读取中…</div></div>'+
      (XZ.admin?'<div class="xz-sec">发 给 全 部 用 户</div>'+
        '<input id="xzNote2" type="text" maxlength="200" placeholder="填入通知">'+
        '<div class="xz-row"><button class="xz-chip" id="xzNote2Pic">选 图</button>'+
          '<span class="xz-hint" id="xzNote2PicName" style="flex:1"></span></div>'+
        '<input type="file" id="xzNote2File" accept="image/*" hidden>'+
        '<div class="xz-row"><button class="xz-chip" id="xzSend2">发 送 通 知</button></div>':'');
    var pic={v:''};
    bindPic('xzNote2Pic','xzNote2File','xzNote2PicName',pic);
    var s=$('#xzSend2');if(s)s.onclick=window.__xzOnce(async function(){
      var t=$('#xzNote2').value.trim();if(!t&&!pic.v){msg('填入通知');return}
      try{await api('POST','/admin/announce',{text:t,photo:pic.v});
        $('#xzNote2').value='';pic.v='';$('#xzNote2PicName').textContent='';
        msg('已发送','ok');loadNoticeList()}catch(e){msg(e.message)}
    });
    loadNoticeList();
  }
  async function loadNoticeList(){
    var box=$('#xzNoticeList');if(!box)return;
    try{var r=await api('GET','/announcements'),list=r.announcements||[];
      if(!list.length){box.innerHTML='<div class="xz-empty">暂时没有通知</div>';return}
      box.innerHTML=list.map(function(n){
        return '<div class="xz-item"><div class="t"><span class="nm">✦ '+esc(n.author||'星宙')+'</span>'+
          '<span class="tm">'+fmt(n.created_at)+'</span></div>'+
          (n.photo?'<img class="notice-img" src="'+esc(n.photo)+'" alt="">':'')+
          '<p class="tx">'+esc(n.text)+'</p>'+
          (XZ.admin?'<div class="xz-row"><button class="xz-chip warn" data-ndel="'+n.id+'">撤 除</button></div>':'')+
          '</div>';
      }).join('');
      $$('[data-ndel]',box).forEach(function(b){b.onclick=window.__xzOnce(async function(){
        if(!confirm('撤除这条通知？'))return;
        try{await api('POST','/admin/announce/'+b.dataset.ndel,{action:'delete'});
          toast('已撤除');loadNoticeList()}catch(e){msg(e.message)}
      })});
    }catch(e){box.innerHTML='<div class="xz-empty">'+esc(e.message)+'</div>'}
  }

  /* ── 接管 ⚙、我 的；其余符号 ── */
  /* ⚙：先过站长口令 → 再进设置。口令不出现在任何前端文件里 */
  /* 接管 ⚙：用 __xzBind 覆盖，绝不和主脚本叠成两个 click */
  var _set=document.getElementById('setting');
  if(_set)_set.dataset.xzBound_onclick='';
  window.__xzBind(_set,'onclick',function(e){
    e.stopPropagation();closeOther();
    var gate=document.getElementById('adminGate'),pw=document.getElementById('adPw');
    gate.className='on';pw.value='';document.getElementById('adErr').className='err';
    setTimeout(function(){try{pw.focus()}catch(err){}},240);
    window.xzAfterGate=function(){gate.className='';open('setting','设 置')};
  });
  var xzEnterAdmin=function(){
    var pw=document.getElementById('adPw'),err=document.getElementById('adErr');
    api('POST','/admin/owner-login',{password:pw.value}).then(function(){
      pw.value='';err.className='err';
      try{closeAdmin()}catch(err){}
      if(window.xzAfterGate){var f=window.xzAfterGate;window.xzAfterGate=null;f()}
      refresh();
    }).catch(function(){err.className='err on';pw.value=''});
  };
  window.enterAdmin=xzEnterAdmin;                        /* 回车键那条监听会解析到这里 */
  var _ae=document.getElementById('adEnter');if(_ae)_ae.dataset.xzBound_onclick='';
  window.__xzBind(_ae,'onclick',xzEnterAdmin);
  $('#xzReview').onclick=function(e){e.stopPropagation();closeOther();open('review','审 核')};
  $('#xzNotice').onclick=function(e){e.stopPropagation();closeOther();open('notice','通 知')};
  $('#xzConsole').onclick=function(e){e.stopPropagation();location.href='./console.html'};

  /* 禁言时 + 号不再打开投稿框 */
  var addEl=document.getElementById('add');
  if(addEl){
    var _origAdd=addEl.onclick;
    addEl.dataset.xzBound_onclick='';
    window.__xzBind(addEl,'onclick',function(e){
      if(XZ.globalMute){e.stopPropagation();toast('暂时无法投星');return}
      if(XZ.muted){e.stopPropagation();toast('该账号已被禁言');return}
      if(_origAdd)_origAdd.call(this,e);
    });
  }

  /* 「我 的」只显示自己写的，并标明未审核 / 已亮起，不再混进别人的星 */
  window.renderMine=function(){
    var box=document.getElementById('mineList'),num=document.getElementById('mineNum');
    box.innerHTML='<div class="none">读取中…</div>';
    api('GET','/mine').then(function(r){
      var list=r.wishes||[];
      num.textContent='共 '+(typeof r.total==='number'?r.total:list.length)+' 条';
      if(!list.length){box.innerHTML='<div class="none">还没有你的星星</div>';return}
      box.innerHTML=list.slice(0,200).map(function(w){
        return '<div class="it"><div class="bd">'+
          '<div class="no"><span class="xz-tag '+esc(w.status)+'" style="font-size:9px;padding:.05rem .4rem;border-radius:99px;border:1px solid rgba(190,160,255,.3)">'+
          (TAG[w.status]||'已 亮 起')+'</span> · ✦ 第 '+w.id+' 颗</div>'+
          '<div class="tx">'+esc(plain(w.text))+'</div>'+
          (w.photo?'<img class="im" src="'+esc(w.photo)+'" alt="">':'')+'</div>'+
          '<span class="xz-del" data-id="'+w.id+'" style="cursor:pointer">删 除</span></div>';
      }).join('');
    }).catch(function(e){box.innerHTML='<div class="none">'+esc(e.message)+'</div>'});
  };
  window.__xzBind(document.getElementById('mineList'),'click',function(e){
    var b=e.target.closest?e.target.closest('.xz-del'):null;if(!b)return;
    e.stopPropagation();
    if(b.__busy)return;
    if(!confirm('确定删除这颗祝福星？'))return;
    b.__busy=true;
    api('POST','/mine',{id:b.dataset.id,action:'delete'}).then(function(){
      b.__busy=false;toast('已删除');renderMine();try{hardReload()}catch(err){}
    }).catch(function(err){b.__busy=false;toast(err.message)});
  });
})();
