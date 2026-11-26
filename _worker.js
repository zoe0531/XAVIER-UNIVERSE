/* 星宙 · Cloudflare Pages Advanced Mode 后端
 * 文件名 _worker.js 必须放在站点最外层（和 index.html 同级）。
 * 拖拽上传 / 连接 Git / wrangler 三种部署方式都支持。
 *
 * 关键设计：/api/wishes 完全兼容原站 STORE 用的 PostgREST 形状
 *   GET  ?select=...&order=id.asc&limit=1000&offset=0 → [{id,text,name,photo,created_at}]
 *   GET  ?select=id&order=id.desc&limit=1            → [{id}]   （原站 peek 探针）
 *   POST {text,name,photo,request_id}                 → [行]     （representation + total）
 *        request_id 由每次点击生成，DB 层 UNIQUE 幂等：同票到达 N 次只落 1 行。
 *   DELETE ?id=eq.123                                → 200
 * 所以主页 index.html 只改了 4 行配置，银河渲染一个字节没动。
 *
 * 绑定：DB (D1，必填)、BUCKET (R2，选填)
 * 变量：ADMIN_PASSWORD / ADVANCED_PASSWORD（可选）/ NOTIFY_WEBHOOK /
 *       RESEND_API_KEY / NOTIFY_EMAIL_FROM / NOTIFY_EMAIL_TO
 * 管理员任命只在「高级设置」里进行。
 * 注册接口不接受任何提权参数，前端不出现口令明文。
 */
const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const enc = new TextEncoder();

const json = (d, s, h) => new Response(JSON.stringify(d), { status: s || 200, headers: Object.assign({}, JSON_H, h || {}) });
const fail = (m, s) => json({ error: m }, s || 400);

const toHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array((String(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const rnd = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return toHex(b.buffer); };
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(salt), iterations: 60000, hash: 'SHA-256' }, k, 256));
}
function tseq(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
function cookies(req) {
  const o = {}; (req.headers.get('Cookie') || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > -1) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }); return o;
}
function setCookie(name, val, req, age) {
  const https = new URL(req.url).protocol === 'https:';
  /* age=null → 会话 cookie（不写 Max-Age，关浏览器就没）；
     age>0 → 持久（已登录账号不掉线）；age===0 → 必须写出 Max-Age=0 才能真清掉 */
  const parts = [name + '=' + encodeURIComponent(val), 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (age !== null && age !== undefined) parts.push('Max-Age=' + age);
  if (https) parts.push('Secure');
  return parts.join('; ');
}
const clearCookie = (n, req) => setCookie(n, '', req, 0);
/* ===== v7 分页改造常量 ===== */
const PAGE_SIZE = 24;                 // 每页条数（唯一可配常量）
const LAYOUT_VER = 3;                 // 分片排序口径：1/2=旧升序残留，3=整体 63→1 最新在前（现行）
const MAX_TEXT = 2000;                // 文本长度上限
const MAX_IMG_B64 = 2800000;          // 单图 base64 上限 ≈2MB
const MAX_THUMB_B64 = 400000;         // 缩略图上限
const RATE_WIN = 60000, RATE_MAX = 30;// 游客异常高频：60s 内 30 次，正常连点 3 次不受影响
const CACHE_PAGE = 'public, s-maxage=300, stale-while-revalidate=600';
const summaryOf = (t) => stripMark(t).replace(/\s+/g, ' ').slice(0, 30);
async function body(req) { try { return await req.json(); } catch (e) { return {}; } }

/* ── 身份：匿名设备也有 token，登录只是给它绑上 user_id ── */
async function session(env, req) {
  const t = cookies(req).xz_sid;
  if (!t) return null;
  return await env.DB.prepare('SELECT token,user_id,role FROM sessions WHERE token=?').bind(t).first() || null;
}
async function ensureSession(env, req) {
  let s = await session(env, req);
  if (s) return { s, cookie: null };
  const t = rnd(24);
  await env.DB.prepare('INSERT INTO sessions (token,user_id,role,created_at) VALUES (?,NULL,?,?)')
    .bind(t, 'visitor', Date.now()).run();
  return { s: { token: t, user_id: null, role: 'visitor' }, cookie: setCookie('xz_sid', t, req, null) };
}
async function me(env, req) {
  const s = await session(env, req);
  if (!s || !s.user_id) return null;
  const u = await env.DB.prepare('SELECT id,email,name,is_admin FROM users WHERE id=?').bind(s.user_id).first();
  return u ? { id: u.id, email: u.email, name: u.name, is_admin: Number(u.is_admin) === 1 } : null;
}
/* 站长钥匙（一次性口令，只放服务端） */
const OWNER_PASS = (env) => String(env.ADMIN_PASSWORD || 'zzz030101');
async function isAdmin(env, req) {
  const u = await me(env, req);
  if (u && u.is_admin) return true;          // 被设为管理员的持久身份
  const s = await session(env, req);
  return !!(s && s.role === 'admin');        // 站长口令临时会话，仅用于进设置面板
}
/* 只认「被设置为管理员」的持久身份：控制主页审核符号显隐 */
async function isOwnerAdmin(env, req) {
  const u = await me(env, req);
  return !!(u && u.is_admin);
}
function withCookie(res, c) { if (c) res.headers.append('Set-Cookie', c); return res; }

/* ── 高级设置（口令只放服务端，可用 ADVANCED_PASSWORD 覆盖） ── */
const ADV_PASS = (env) => String(env.ADVANCED_PASSWORD || '1016sxh');
async function isAdvanced(env, req) {
  const s = await session(env, req);
  return !!(s && s.role === 'advanced');
}
async function getFlag(env, key) {
  try {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
    return r ? String(r.value) : '0';
  } catch (e) { return '0'; }
}
async function setFlag(env, key, val) {
  try {
    await env.DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .bind(key, String(val)).run();
  } catch (e) {}
}
/* 旧库自动补字段 / 补表，重复执行安全，用户无需手动跑 SQL */
let _schemaReady = false;
async function ensureSchema(env) {
  if (_schemaReady) return;
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN muted INTEGER NOT NULL DEFAULT 0').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE announcements ADD COLUMN photo TEXT').run(); } catch (e) {}
  /* 幂等键：request_id 全局唯一。SQLite 唯一索引允许多个 NULL，老行不冲突。
     用普通 UNIQUE INDEX（不用 partial），ON CONFLICT(request_id) 才能匹配到约束。 */
  try { await env.DB.prepare('ALTER TABLE wishes ADD COLUMN request_id TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_wishes_request_id ON wishes(request_id)').run(); } catch (e) {}
  /* 图片压缩后单独存这张表，wishes 行里只留 /api/img/<id> 链接，不塞 base64 */
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS wish_images (id INTEGER PRIMARY KEY AUTOINCREMENT, mime TEXT, data TEXT, created_at INTEGER)').run(); } catch (e) {}
  /* v7：摘要、缩略图、分片表、限流表 —— 全部 CREATE IF NOT EXISTS / try-catch，重复执行安全 */
  try { await env.DB.prepare('ALTER TABLE wishes ADD COLUMN summary TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE wish_images ADD COLUMN thumb TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE wish_images ADD COLUMN mime_thumb TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS wish_pages (page_no INTEGER PRIMARY KEY, ver INTEGER, data TEXT)').run(); } catch (e) {}
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS rate_limits (k TEXT, win INTEGER, cnt INTEGER, PRIMARY KEY(k,win))').run(); } catch (e) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wishes_approved ON wishes(status,id)').run(); } catch (e) {}
  _schemaReady = true;
}

/* ── 通知（全部选填，失败不影响主流程） ── */
function notifyText(title, lines) {
  return ['✦ ' + title, ...lines, '', '— 星宙 XAVIER\'S UNIVERSE'].join('\n');
}
async function postJson(url, payload, headers) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(payload) });
  if (!r.ok) throw new Error('notify ' + r.status);
}
async function notify(env, title, lines) {
  const text = notifyText(title, lines), jobs = [];
  const hook = String(env.NOTIFY_WEBHOOK || '').trim();
  if (hook) {
    let p;
    if (hook.includes('qyapi.weixin.qq.com')) p = { msgtype: 'text', text: { content: text } };
    else if (hook.includes('oapi.dingtalk.com')) p = { msgtype: 'text', text: { content: text } };
    else if (hook.includes('open.feishu.cn')) p = { msg_type: 'text', content: { text } };
    else p = { msgtype: 'text', text: { content: text }, content: text };
    jobs.push(postJson(hook, p));
  }
  const key = String(env.RESEND_API_KEY || '').trim();
  const to = String(env.NOTIFY_EMAIL_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (key && to.length) {
    const from = String(env.NOTIFY_EMAIL_FROM || '星宙 <onboarding@resend.dev>').trim();
    const html = `<div style="font-family:sans-serif;line-height:1.8"><h2>✦ ${title}</h2>` +
      lines.map((l) => `<p>${String(l).replace(/</g, '&lt;')}</p>`).join('') +
      `<hr><small>— 星宙 XAVIER'S UNIVERSE</small></div>`;
    jobs.push(postJson('https://api.resend.com/emails', { from, to, subject: `【星宙】${title}`, html },
      { Authorization: `Bearer ${key}`, 'User-Agent': 'xavier-universe/1.0' }));
  }
  if (!jobs.length) return;
  await Promise.allSettled(jobs);
}
async function safeNotify(env, title, lines) { try { await notify(env, title, lines); } catch (e) { /* 吞掉 */ } }
/* 旧版把「36 进制编号 / 归属标记」用零宽符塞在正文开头，
   只删零宽符会残留成 "1x张" 这种鬼东西。这里整段前缀一起剥掉，只留真正文。
   兼容三段式 ‹号›‹o|x›‹正文› 和两段式 ‹号›‹正文›；正常中文不会误命中。 */
function stripMark(t) {
  const v = String(t == null ? '' : t);
  let m = /^\u2060([0-9a-z]+)\u2060([ox])\u2060([\s\S]*)$/i.exec(v);
  if (m) return m[3];
  m = /^\u2060([0-9a-z]+)\u2060([\s\S]*)$/i.exec(v);
  return m ? m[2] : v.replace(/\u2060/g, '');
}
const plain = (t) => stripMark(t).slice(0, 240);
const when = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
/* 作者当前总条数（登录按 user_id，游客按设备 token），用于成功回执 */
async function myTotal(env, s) {
  try {
    const r = s.user_id
      ? await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes WHERE user_id=?').bind(s.user_id).first()
      : await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes WHERE owner_token=? AND user_id IS NULL').bind(s.token).first();
    return r ? Number(r.n) || 0 : 0;
  } catch (e) { return 0; }
}

/* 图片压缩后单独存表；wishes 行里只留 /api/img/<id> 链接，绝不塞 base64 */
async function storePhoto(env, raw, thumbRaw, now) {
  const v = String(raw || '').slice(0, MAX_IMG_B64);
  const tv = String(thumbRaw || '').slice(0, MAX_THUMB_B64);
  const dm = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/i.exec(v);
  if (dm) {
    const td = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/i.exec(tv);
    const ir = await env.DB.prepare(
      'INSERT INTO wish_images (mime,data,thumb,mime_thumb,created_at) VALUES (?,?,?,?,?)'
    ).bind(dm[1], dm[2], td ? td[2] : '', td ? td[1] : '', now).run();
    const id = ir.meta && ir.meta.last_row_id != null ? ir.meta.last_row_id : null;
    return { photo: id != null ? '/api/img/' + id : '', imgId: id };
  }
  if (/^\/api\/img\/\d+$/.test(v)) return { photo: v, imgId: null };
  return { photo: '', imgId: null };
}
async function dropPhoto(env, photo) {
  const m = /^\/api\/img\/(\d+)$/.exec(String(photo || ''));
  if (m) { try { await env.DB.prepare('DELETE FROM wish_images WHERE id=?').bind(m[1]).run(); } catch (e) {} }
}

/* ── 行 → 原站格式 ── */
function row(r) {
  return { id: r.id, text: stripMark(r.text), name: r.name || '', photo: r.photo || '',
    created_at: new Date(Number(r.created_at) || Date.now()).toISOString() };
}


/* ===== v7 读路径：分片存 D1，CDN 按 ver 边缘缓存 ===== */
async function getMeta(env, k, def) {
  try { const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(k).first();
        return r ? String(r.value) : def; } catch (e) { return def; }
}
async function setMeta(env, k, v) {
  try { await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, String(v)).run(); } catch (e) {}
}
async function backfill(env) {
  try {
    if ((await getMeta(env, 'summary_done', '0')) === '1') return;
    const rows = (await env.DB.prepare('SELECT id,text FROM wishes WHERE summary IS NULL LIMIT 200').bind().all()).results || [];
    for (const r of rows) {
      await env.DB.prepare('UPDATE wishes SET summary=? WHERE id=?').bind(summaryOf(r.text), r.id).run();
    }
    if (rows.length < 200) await setMeta(env, 'summary_done', '1');
  } catch (e) {}
}
async function ensureIndex(env) {
  /* 排序口径升级（最老在前 → 最新在前）：只做一次，bump ver 让 CDN 与 D1 旧分片一起失效，
     不删 wishes、不改 id/status，老祝福一条不少。 */
  let ver = Number(await getMeta(env, 'pages_ver', '0')) || 0;
  if (Number(await getMeta(env, 'layout_ver', '1')) !== LAYOUT_VER) {
    ver += 1;
    await setMeta(env, 'pages_ver', String(ver));
    await setMeta(env, 'layout_ver', String(LAYOUT_VER));
    try { await env.DB.prepare('DELETE FROM wish_pages').run(); } catch (e) {}
  }
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM wishes WHERE status='approved'").bind().first();
  const total = Number((c && c.n) || 0);
  return { total: total, pages: Math.ceil(total / PAGE_SIZE), ver: ver, size: PAGE_SIZE };
}
async function markDirty(env) {
  const ver = (Number(await getMeta(env, 'pages_ver', '0')) || 0) + 1;
  await setMeta(env, 'pages_ver', String(ver));
  return ver;
}
/* 列表项：只回 id / 编号 / 摘要 / 缩略图 / 时间 / 是否有图，绝不回全文或原图 */
function listItem(r) {
  const m = /^\/api\/img\/(\d+)$/.exec(String(r.photo || ''));
  const sum = (r.summary != null && r.summary !== '') ? r.summary : summaryOf(r.text);
  return {
    id: Number(r.id), no: Number(r.id), name: r.name || '',
    summary: sum,
    thumb: m ? ('/api/img/' + m[1] + '?thumb=1') : (r.photo || ''),
    has_img: !!(m || r.photo),
    created_at: new Date(Number(r.created_at) || Date.now()).toISOString()
  };
}
async function buildPage(env, n, ver) {
  const rows = (await env.DB.prepare(
    "SELECT id,name,photo,summary,text,created_at FROM wishes WHERE status='approved' ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(PAGE_SIZE, (n - 1) * PAGE_SIZE).all()).results || [];
  /* 双保险：页内严格编号递减，避免任何旧口径分片/驱动返回升序 */
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  const items = rows.map(listItem);
  await env.DB.prepare(
    'INSERT INTO wish_pages(page_no,ver,data) VALUES(?,?,?) ON CONFLICT(page_no) DO UPDATE SET ver=excluded.ver,data=excluded.data'
  ).bind(n, ver, JSON.stringify({ page: n, ver: ver, items: items })).run();
  return items;
}
async function rateGuard(env, request, s) {
  const win = Math.floor(Date.now() / RATE_WIN);
  const ip = (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'x').split(',')[0].trim();
  const k = ip;   /* 按出口 IP 计，游客换 token 也挡得住；常量 RATE_MAX 可调 */
  try {
    await env.DB.prepare('DELETE FROM rate_limits WHERE win<?').bind(win - 1).run();
    await env.DB.prepare('INSERT INTO rate_limits(k,win,cnt) VALUES(?,?,1) ON CONFLICT(k,win) DO UPDATE SET cnt=cnt+1').bind(k, win).run();
    const r = await env.DB.prepare('SELECT cnt FROM rate_limits WHERE k=? AND win=?').bind(k, win).first();
    return r && Number(r.cnt) > RATE_MAX;
  } catch (e) { return false; }   /* 限流表异常绝不阻断正常投稿 */
}

/* ── 主路由（导出供测试） ── */
export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '/') || '/';
  const parts = path.split('/').filter(Boolean);
  const m = request.method, q = url.searchParams;

  if (!env.DB) return json({ error: 'DB_NOT_BOUND' }, 503);
  if (m === 'OPTIONS') return new Response(null, { status: 204 });
  await ensureSchema(env);

  try {
    /* ===== 单独存的图片：wishes 行只留这个链接 ===== */
    if (parts[0] === 'img' && parts[1] && m === 'GET') {
      const r = await env.DB.prepare('SELECT mime,data,thumb,mime_thumb FROM wish_images WHERE id=?').bind(parts[1]).first();
      if (!r) return new Response('', { status: 404 });
      const useT = q.get('thumb') === '1' && !!r.thumb;
      const b64 = useT ? String(r.thumb) : String(r.data || '');
      const mime = useT ? String(r.mime_thumb || r.mime || 'image/jpeg') : String(r.mime || 'image/jpeg');
      let bin;
      try { bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
      catch (e) { return new Response('', { status: 404 }); }
      return new Response(bin, { headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      }});
    }


    /* ===== v7 公开读：index / 分页 / 详情 / 搜索 / 采样 ===== */
    if (path === '/index.json' && m === 'GET') {
      await backfill(env);
      return json(await ensureIndex(env), 200, { 'Cache-Control': 'no-store' });
    }
    if (parts[0] === 'page' && parts[1] && m === 'GET') {
      const pn = Math.max(parseInt(parts[1], 10) || 1, 1);
      const idx = await ensureIndex(env);
      if (idx.total === 0 || pn > idx.pages)
        return json({ page: pn, items: [], total: idx.total, pages: idx.pages, ver: idx.ver, size: PAGE_SIZE }, 200, { 'Cache-Control': CACHE_PAGE });
      const cached = await env.DB.prepare('SELECT ver,data FROM wish_pages WHERE page_no=?').bind(pn).first();
      let items;
      if (cached && Number(cached.ver) === idx.ver && cached.data) {
        try { items = (JSON.parse(cached.data).items) || []; } catch (e) { items = null; }
        /* 旧包残留的「升序」分片即使版本号相同也要作废，重建为 63→…→1 */
        if (items && items.length > 1 &&
            Number(items[0].id) < Number(items[items.length - 1].id)) items = null;
      }
      if (!items) items = await buildPage(env, pn, idx.ver);
      return json({ page: pn, items: items, total: idx.total, pages: idx.pages, ver: idx.ver, size: PAGE_SIZE }, 200, { 'Cache-Control': CACHE_PAGE });
    }
    if (parts[0] === 'wish' && parts[1] && m === 'GET') {
      const id = String(parts[1]);
      if (!/^\d+$/.test(id)) return fail('编号不对');
      const w = await env.DB.prepare('SELECT id,text,name,photo,created_at,status,owner_token,user_id FROM wishes WHERE id=?').bind(id).first();
      if (!w) return json({ error: '找不到这颗星' }, 404);
      const ss = await session(env, request);
      const mine = ss && (ss.token === w.owner_token || (ss.user_id && ss.user_id === w.user_id));
      if (w.status !== 'approved' && !mine && !(await isAdmin(env, request)))
        return json({ error: '找不到这颗星' }, 404);
      return json({ id: w.id, text: stripMark(w.text), name: w.name || '', photo: w.photo || '',
        created_at: new Date(Number(w.created_at) || Date.now()).toISOString(), status: w.status },
        200, { 'Cache-Control': 'no-store' });
    }
    if (path === '/search' && m === 'GET') {
      const kw = String(q.get('q') || '').trim().slice(0, 60).replace(/[%_]/g, '');
      const pg = Math.max(parseInt(q.get('page') || '1', 10) || 1, 1);
      if (!kw) return json({ items: [], total: 0, pages: 0, page: 1 }, 200, { 'Cache-Control': 'no-store' });
      const pat = '%' + kw + '%';
      const cn = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM wishes WHERE status='approved' AND (text LIKE ? OR name LIKE ? OR CAST(id AS TEXT)=?)"
      ).bind(pat, pat, kw).first();
      const total = Number((cn && cn.n) || 0);
      const rows = (await env.DB.prepare(
        "SELECT id,name,photo,summary,text,created_at FROM wishes WHERE status='approved' AND (text LIKE ? OR name LIKE ? OR CAST(id AS TEXT)=?) ORDER BY id DESC LIMIT ? OFFSET ?"
      ).bind(pat, pat, kw, PAGE_SIZE, (pg - 1) * PAGE_SIZE).all()).results || [];
      return json({ items: rows.map(listItem), total: total, pages: Math.ceil(total / PAGE_SIZE), page: pg }, 200, { 'Cache-Control': 'no-store' });
    }
    if (path === '/sample' && m === 'GET') {
      const nn = Math.min(Math.max(parseInt(q.get('n') || '130', 10) || 130, 1), 300);
      const rows = (await env.DB.prepare(
        "SELECT id,name,photo,summary,text,created_at FROM wishes WHERE status='approved' ORDER BY RANDOM() LIMIT ?"
      ).bind(nn).all()).results || [];
      return json({ items: rows.map(listItem) }, 200, { 'Cache-Control': 'no-store' });
    }

    /* ===== 原站 STORE 专用：/api/wishes ===== */
    if (path === '/wishes' && m === 'GET') {
      // peek 探针：只看最新一条已通过的 id
      if (q.get('select') === 'id') {
        const r = await env.DB.prepare('SELECT id FROM wishes WHERE status=? ORDER BY id DESC LIMIT 1').bind('approved').first();
        return json(r ? [{ id: r.id }] : []);
      }
      const lim = Math.min(Math.max(parseInt(q.get('limit') || '1000', 10) || 1000, 1), 1000);
      const off = Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0);
      const r = await env.DB.prepare(
        'SELECT id,text,name,photo,created_at FROM wishes WHERE status=? ORDER BY id ASC LIMIT ? OFFSET ?'
      ).bind('approved', lim, off).all();
      return json((r.results || []).map(row), 200, { 'Cache-Control': 'no-store' });
    }

    if (path === '/wishes' && m === 'POST') {
      const { s, cookie } = await ensureSession(env, request);
      const b = await body(request);
      if ((await getFlag(env, 'global_mute')) === '1') return fail('暂时无法投星');
      const cur = await me(env, request);
      if (cur) {
        try {
          const mu = await env.DB.prepare('SELECT muted FROM users WHERE id=?').bind(cur.id).first();
          if (mu && Number(mu.muted) === 1) return fail('该账号已被禁言');
        } catch (e) {}
      }
      /* 幂等键：一次点击一张票。缺票一律拒绝，绝不按内容/图片/作者/时间窗去重。 */
      const rid = String(b.request_id || '').slice(0, 80);
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(rid)) return fail('缺少 request_id');
      const text = String(b.text || '');
      if (!stripMark(text).trim()) return fail('先写点什么吧');
      if (stripMark(text).length > MAX_TEXT) return fail('文字太长了');
      const name = String(b.name || '').slice(0, 40) || '无名';
      const rawPhoto = String(b.photo || '').slice(0, MAX_IMG_B64);
      const now = Date.now();

      /* 同票已落库：直接把已存在那行当成功返回，不报错、不新增、不重复存图 */
      const hit = await env.DB.prepare(
        'SELECT id,text,name,photo,created_at FROM wishes WHERE request_id=?'
      ).bind(rid).first();
      if (hit) {
        const total = await myTotal(env, s);
        return withCookie(json([Object.assign(row(hit), { total })], 200, { 'Cache-Control': 'no-store' }), cookie);
      }

      /* 同票重放不消耗限流配额；只挡游客异常高频，不按内容判、不合并行 */
      if (await rateGuard(env, request, s)) return fail('稍 后 再 试', 429);
      /* 图片压缩后单独存表，wishes.photo 只留链接 */
      const sp = await storePhoto(env, rawPhoto, b.thumb, now);
      const photo = sp.photo, imgId = sp.imgId;

      /* 编号：全表最大 +1；删中间不补位；全清空归 1。
         并发撞主键或撞 request_id 都收敛到「已存在那行」，绝不生成第二颗。 */
      let no = 0, created = null, lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const mx = await env.DB.prepare('SELECT MAX(id) AS m FROM wishes').bind().first();
          no = (mx && Number(mx.m) > 0) ? Number(mx.m) + 1 : 1;
          await env.DB.prepare(
            'INSERT INTO wishes (id,request_id,owner_token,user_id,text,name,photo,status,created_at,summary) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING'
          ).bind(no, rid, s.token, s.user_id, text, name, photo, 'pending', now, summaryOf(text)).run();
        } catch (e) { lastErr = e; }
        created = await env.DB.prepare(
          'SELECT id,text,name,photo,created_at FROM wishes WHERE request_id=?'
        ).bind(rid).first();
        if (created) break;                    /* 无论本次插入还是并发里别人先插的，都拿到同一行 */
      }
      if (!created) {
        if (imgId != null) { try { await env.DB.prepare('DELETE FROM wish_images WHERE id=?').bind(imgId).run(); } catch (e) {} }
        throw lastErr || new Error('写入失败');
      }
      /* 并发下若这张票是别人插的，我这次白存的那张图删掉 */
      if (imgId != null && String(created.photo || '') !== photo) {
        try { await env.DB.prepare('DELETE FROM wish_images WHERE id=?').bind(imgId).run(); } catch (e) {}
      }
      const total = await myTotal(env, s);
      /* 只在确实新建（这行的 id 就是本次算的号）时才发投稿通知，重放不重发 */
      if (Number(created.id) === no) {
        await safeNotify(env, '收到一条新祝福，待审核',
          [`署名：${name}`, `内容：${plain(text)}`, `时间：${when()}`]);
      }
      return withCookie(json([Object.assign(row(created), { total })], 200, { 'Cache-Control': 'no-store' }), cookie);
    }

    if (path === '/wishes' && m === 'DELETE') {
      const eq = q.get('id') || '';
      const id = String(eq).replace(/^eq\./, '');
      if (!/^\d+$/.test(id)) return fail('编号不对');
      const w = await env.DB.prepare('SELECT id,owner_token,user_id,photo FROM wishes WHERE id=?').bind(id).first();
      if (!w) return new Response('', { status: 200 });   // 原站按 r.ok 判断
      const s = await session(env, request);
      const adm = await isAdmin(env, request);
      const mine = s && (s.token === w.owner_token || (s.user_id && s.user_id === w.user_id));
      if (!adm && !mine) return fail('没有权限删除这颗星星', 403);
      await dropPhoto(env, w.photo);
      await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run();
      await markDirty(env);
      return new Response('', { status: 200 });
    }

    /* ===== 通 知：所有人可读，管理员可群发 ===== */
    if (path === '/announcements' && m === 'GET') {
      let rows;
      try { rows = (await env.DB.prepare('SELECT id,text,photo,author,created_at FROM announcements ORDER BY id DESC LIMIT 30').bind().all()).results || []; }
      catch (e) { rows = (await env.DB.prepare('SELECT id,text,author,created_at FROM announcements ORDER BY id DESC LIMIT 30').bind().all()).results || []; rows.forEach((x) => { x.photo = ''; }); }
      return json({ announcements: rows.map((n) => ({
        id: n.id, text: n.text, photo: n.photo || '', author: n.author,
        created_at: new Date(Number(n.created_at) || Date.now()).toISOString()
      })) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (path === '/admin/announce' && m === 'POST') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const b = await body(request);
      const text = String(b.text || '').trim().slice(0, 500);
      const photo = String(b.photo || '').slice(0, 900000);
      if (!text && !photo) return fail('填入通知');
      const u = await me(env, request);
      await env.DB.prepare('INSERT INTO announcements (text,photo,author,created_at) VALUES (?,?,?,?)')
        .bind(text, photo, u ? u.name : '星宙', Date.now()).run();
      // 群机器人 + 固定通知地址
      await safeNotify(env, '星宙通知', [text, `时间：${when()}`]);
      // 全部注册用户：站内公告人人可见，账户码也各发一封（不与固定收件人重复）
      const key = String(env.RESEND_API_KEY || '').trim();
      const ur = await env.DB.prepare('SELECT email FROM users ORDER BY id').bind().all();
      const all = (ur.results || []).map((x) => x.email).filter(Boolean);
      const fixed = String(env.NOTIFY_EMAIL_TO || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const extra = all.filter((e) => !fixed.includes(e.toLowerCase()));
      if (key && extra.length) {
        const from = String(env.NOTIFY_EMAIL_FROM || '星宙 <onboarding@resend.dev>').trim();
        const jobs = [];
        for (let i = 0; i < extra.length; i += 50) {
          jobs.push(postJson('https://api.resend.com/emails', {
            from, to: extra.slice(i, i + 50), subject: '【星宙】全体通知',
            html: `<div style="font-family:sans-serif;line-height:1.8"><h2>✦ 星宙 · 全体通知</h2><p>${text.replace(/</g, '&lt;')}</p>${photo ? '<p>（含一张图片，请到站内通知查看）</p>' : ''}<hr><small>— 星宙 XAVIER'S UNIVERSE</small></div>`
          }, { Authorization: `Bearer ${key}`, 'User-Agent': 'xavier-universe/1.0' }));
        }
        await Promise.allSettled(jobs);
      }
      return json({ ok: true, users: all.length });
    }

    /* ===== 通知撤除：管理员都能撤 ===== */
    if (parts[0] === 'admin' && parts[1] === 'announce' && parts[2] && m === 'POST') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const b = await body(request);
      if (String(b.action || '') !== 'delete') return fail('操作不合法');
      const id = String(parts[2]);
      if (!/^\d+$/.test(id)) return fail('编号不对');
      await env.DB.prepare('DELETE FROM announcements WHERE id=?').bind(id).run();
      return json({ ok: true });
    }

    /* ===== 控制台：账号 ===== */
    if (path === '/me' && m === 'GET') {
      const u = await me(env, request);
      let muted = 0;
      if (u) { try { const r = await env.DB.prepare('SELECT muted FROM users WHERE id=?').bind(u.id).first(); muted = r && Number(r.muted) === 1 ? 1 : 0; } catch (e) {} }
      return json({ user: u, admin: await isAdmin(env, request), owner: await isOwnerAdmin(env, request),
        advanced: await isAdvanced(env, request), muted: muted,
        global_mute: (await getFlag(env, 'global_mute')) === '1' ? 1 : 0 });
    }

    /* 站长口令：不出现在任何前端文件里，只在这里校验 */
    if (path === '/admin/owner-login' && m === 'POST') {
      const b = await body(request);
      if (!tseq(String(b.password || ''), OWNER_PASS(env))) return fail('不对', 401);
      const { s, cookie } = await ensureSession(env, request);
      await env.DB.prepare('UPDATE sessions SET role=? WHERE token=?').bind('admin', s.token).run();
      return withCookie(json({ ok: true }), cookie);
    }

    if (path === '/register' && m === 'POST') {
      const { s, cookie } = await ensureSession(env, request);
      const b = await body(request);
      const email = String(b.email || '').trim().toLowerCase();
      const name = String(b.name || '').trim().slice(0, 20);
      const pw = String(b.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('账户码格式不对');
      if (!name) return fail('填个名字吧');
      if (pw.length < 6) return fail('密码至少 6 位');
      if (await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first()) return fail('这个账户码注册过了');
      // 管理员只能在高级设置里指定，注册接口不接受任何提权参数
      const isAdm = 0;
      const salt = rnd(16), ph = await pbkdf2(pw, salt);
      await env.DB.prepare('INSERT INTO users (email,name,password_hash,salt,is_admin,created_at) VALUES (?,?,?,?,?,?)')
        .bind(email, name, ph, salt, isAdm, Date.now()).run();
      const u = await env.DB.prepare('SELECT id,email,name,is_admin FROM users WHERE email=?').bind(email).first();
      await env.DB.prepare('UPDATE sessions SET user_id=?,role=? WHERE token=?').bind(u.id, 'user', s.token).run();
      return withCookie(json({ user: { id: u.id, email: u.email, name: u.name, is_admin: isAdm === 1 } }), setCookie('xz_sid', s.token, request, 31536000));
    }

    if (path === '/login' && m === 'POST') {
      const { s, cookie } = await ensureSession(env, request);
      const b = await body(request);
      const email = String(b.email || '').trim().toLowerCase();
      const u = await env.DB.prepare('SELECT id,email,name,password_hash,salt,is_admin FROM users WHERE email=?').bind(email).first();
      if (!u || !tseq(await pbkdf2(String(b.password || ''), u.salt), u.password_hash)) return fail('账户码或密码不对', 401);
      await env.DB.prepare('UPDATE sessions SET user_id=?,role=? WHERE token=?').bind(u.id, 'user', s.token).run();
      return withCookie(json({ user: { id: u.id, email: u.email, name: u.name, is_admin: Number(u.is_admin) === 1 } }), setCookie('xz_sid', s.token, request, 31536000));
    }

    /* ===== 游客一次性：每次进入页面都换一张新身份牌 =====
       只换「没登录」的；登录账号按 user_id 走，跨设备/关浏览器都不受影响。
       旧 session 行不删（避免和正在提交的写请求抢），但浏览器 cookie 已被覆盖，
       再也不会带着旧牌回来 —— 老祝福仍留在 wishes 表里，审核看得到、通过照常亮。 */
    if (path === '/visitor/new' && m === 'POST') {
      const s = await session(env, request);
      if (s && s.user_id) return json({ ok: true, guest: false });
      /* 旧游客牌直接作废：就算哪台设备还揣着旧 cookie，也认不回任何记录 */
      if (s) await env.DB.prepare('DELETE FROM sessions WHERE token=? AND user_id IS NULL').bind(s.token).run();
      const t = rnd(24);
      await env.DB.prepare('INSERT INTO sessions (token,user_id,role,created_at) VALUES (?,NULL,?,?)')
        .bind(t, 'visitor', Date.now()).run();
      return withCookie(json({ ok: true, guest: true }), setCookie('xz_sid', t, request, null));
    }

    if (path === '/logout' && m === 'POST') {
      /* 点「退 出」也当离开：连登录绑定一起断，回来是全新游客 */
      const s = await session(env, request);
      if (s) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(s.token).run();
      const t = rnd(24);
      await env.DB.prepare('INSERT INTO sessions (token,user_id,role,created_at) VALUES (?,NULL,?,?)')
        .bind(t, 'visitor', Date.now()).run();
      return withCookie(json({ ok: true }), setCookie('xz_sid', t, request, null));
    }

    if (path === '/admin/login' && m === 'POST') {
      if (!env.ADMIN_PASSWORD) return fail('尚未配置 ADMIN_PASSWORD', 503);
      const b = await body(request);
      if (!tseq(String(b.password || ''), env.ADMIN_PASSWORD)) return fail('不对', 401);
      const { s, cookie } = await ensureSession(env, request);
      await env.DB.prepare('UPDATE sessions SET role=? WHERE token=?').bind('admin', s.token).run();
      return withCookie(json({ ok: true }), cookie);
    }
    if (path === '/admin/logout' && m === 'POST') {
      const s = await session(env, request);
      if (s) await env.DB.prepare('UPDATE sessions SET role=? WHERE token=?').bind(s.user_id ? 'user' : 'visitor', s.token).run();
      return json({ ok: true });
    }
    if (path === '/admin/check' && m === 'GET') return json({ admin: await isAdmin(env, request) });

    /* ===== 「我的祝福」：可编辑 / 删除，改后重新审核 ===== */
    if (path === '/mine' && m === 'GET') {
      const s = await session(env, request);
      if (!s) return json({ wishes: [], total: 0 });
      const u = await me(env, request);
      const sel = 'SELECT id,text,name,photo,status,created_at FROM wishes ';
      const r = u
        ? await env.DB.prepare(sel + 'WHERE user_id=? ORDER BY id DESC LIMIT 500').bind(u.id).all()
        : await env.DB.prepare(sel + 'WHERE owner_token=? AND user_id IS NULL ORDER BY id DESC LIMIT 500').bind(s.token).all();
      return json({ wishes: (r.results || []).map((w) => Object.assign(row(w), { status: w.status })),
        total: await myTotal(env, s) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (path === '/mine' && m === 'POST') {
      const s = await session(env, request);
      if (!s) return fail('请先登录或在本机投稿', 401);
      const b = await body(request), id = String(b.id || '');
      const w = await env.DB.prepare('SELECT id,owner_token,user_id,status,photo FROM wishes WHERE id=?').bind(id).first();
      if (!w) return fail('找不到这条祝福');
      const adm = await isAdmin(env, request);
      if (!adm && w.owner_token !== s.token && !(s.user_id && w.user_id === s.user_id))
        return fail('只能改自己的祝福', 403);
      if (String(b.action || '') !== 'delete' && w.status === 'approved')
        return fail('已通过的祝福不能修改，只能删除');
      if (b.action === 'delete') {
        await dropPhoto(env, w.photo);
        await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run();
        await markDirty(env);
        return json({ ok: true });
      }
      const text = String(b.text || ''), name = String(b.name || '').slice(0, 40) || '无名';
      /* 编辑路径同样只 UPDATE，图片单独存，wishes 行只留链接 */
      const sp2 = await storePhoto(env, b.photo, b.thumb, Date.now());
      if (sp2.photo !== String(w.photo || '')) await dropPhoto(env, w.photo);
      await env.DB.prepare('UPDATE wishes SET text=?,name=?,photo=?,status=?,summary=? WHERE id=?')
        .bind(text, name, sp2.photo, 'pending', summaryOf(text), id).run();
      await markDirty(env);
      await safeNotify(env, '一条祝福被修改，需重新审核', [`署名：${name}`, `内容：${plain(text)}`, `时间：${when()}`]);
      return json({ ok: true });
    }

    /* ===== 审核后台 ===== */
    if (path === '/admin/wishes' && m === 'GET') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const st = q.get('status') || 'pending';
      if (!['pending', 'approved', 'rejected', 'all'].includes(st)) return fail('状态不合法');
      const pg = Math.max(parseInt(q.get('page') || '1', 10) || 1, 1);
      const sz = Math.min(Math.max(parseInt(q.get('size') || '24', 10) || 24, 1), 100);
      const where = st === 'all' ? '' : ' WHERE status=?';
      const args = st === 'all' ? [] : [st];
      const cn = await env.DB.prepare('SELECT COUNT(*) AS n FROM wishes' + where).bind(...args).first();
      const total = Number((cn && cn.n) || 0);
      const base = 'SELECT id,text,name,photo,status,created_at FROM wishes' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?';
      const r = await env.DB.prepare(base).bind(...args, sz, (pg - 1) * sz).all();
      return json({ wishes: (r.results || []).map((w) => Object.assign(row(w), { status: w.status })),
        total: total, page: pg, size: sz, pages: Math.ceil(total / sz) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (path === '/admin/wishes/batch' && m === 'POST') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const b = await body(request);
      const ids = (Array.isArray(b.ids) ? b.ids : []).slice(0, 100).map(String);
      const act = String(b.action || '');
      if (!ids.length) return fail('还没选中任何祝福');
      if (!['approve', 'reject', 'delete'].includes(act)) return fail('操作不合法');
      const passed = [];
      for (const id of ids) {
        const w = await env.DB.prepare('SELECT id,text,name,status,photo FROM wishes WHERE id=?').bind(id).first();
        if (!w) continue;
        /* 审核路径只 DELETE / UPDATE，绝无 INSERT，行数恒定 */
        if (act === 'delete') { await dropPhoto(env, w.photo); await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run(); continue; }
        const st = act === 'approve' ? 'approved' : 'rejected';
        await env.DB.prepare('UPDATE wishes SET status=? WHERE id=?').bind(st, id).run();
        if (act === 'approve' && w.status !== 'approved') passed.push(w);
      }
      if (passed.length) await markDirty(env);
      if (passed.length) await safeNotify(env, `${passed.length} 颗星星已亮起`,
        passed.slice(0, 5).map((w, i) => `${i + 1}. ${w.name}：${plain(w.text).slice(0, 80)}`));
      return json({ ok: true, count: ids.length, approved: passed.length });
    }
    if (parts[0] === 'admin' && parts[1] === 'wishes' && parts[2] && m === 'POST') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const b = await body(request), id = String(parts[2]);
      const w = await env.DB.prepare('SELECT id,text,name,status,photo FROM wishes WHERE id=?').bind(id).first();
      if (!w) return fail('找不到这条祝福');
      /* 单条审核：同样只 DELETE / UPDATE，禁止 INSERT */
      if (b.action === 'delete') { await dropPhoto(env, w.photo); await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run(); }
      else if (b.action === 'approve' || b.action === 'reject') {
        await env.DB.prepare('UPDATE wishes SET status=? WHERE id=?').bind(b.action === 'approve' ? 'approved' : 'rejected', id).run();
        if (b.action === 'approve' && w.status !== 'approved')
          await safeNotify(env, '一颗星星已亮起', [`署名：${w.name}`, `内容：${plain(w.text)}`, `时间：${when()}`]);
      } else return fail('操作不合法');
      await markDirty(env);
      return json({ ok: true });
    }

    /* ===== 多管理员 ===== */
    if (path === '/admin/users' && m === 'GET') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      /* 管理员页只给管理员名字：不返回账户码、不返回普通成员、不含未登录访客 */
      const ul2 = (await env.DB.prepare(
        'SELECT id,name,is_admin FROM users WHERE is_admin=1 ORDER BY id DESC LIMIT 500'
      ).bind().all()).results || [];
      return json({ users: ul2 });
    }
    if (path === '/admin/users' && m === 'POST') {
      if (!(await isAdvanced(env, request))) return fail('未授权', 401);
      const b = await body(request), act = String(b.action || '');
      if (!['promote', 'demote'].includes(act)) return fail('操作不合法');
      const email = String(b.key || b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('请填完整的账户码');
      const u = await env.DB.prepare('SELECT id,name,is_admin FROM users WHERE email=?').bind(email).first();
      if (!u) return fail('找不到这个账户码');
      await env.DB.prepare('UPDATE users SET is_admin=? WHERE id=?').bind(act === 'promote' ? 1 : 0, u.id).run();
      // 审核符号只看 users.is_admin（/me 的 owner 字段），这里一改，对方刷新后符号立刻收起。
      // 不降级任何会话，避免站长取消别人时把自己也踢出设置。
      return json({ ok: true, name: u.name });
    }

    /* ===== 高级设置：1016sxh ===== */
    if (path === '/advanced/login' && m === 'POST') {
      const b = await body(request);
      if (!tseq(String(b.password || ''), ADV_PASS(env))) return fail('不对', 401);
      const { s, cookie } = await ensureSession(env, request);
      await env.DB.prepare('UPDATE sessions SET role=? WHERE token=?').bind('advanced', s.token).run();
      return withCookie(json({ ok: true }), cookie);
    }
    if (path === '/advanced/logout' && m === 'POST') {
      const s = await session(env, request);
      if (s) await env.DB.prepare('UPDATE sessions SET role=? WHERE token=?')
        .bind(s.user_id ? 'user' : 'visitor', s.token).run();
      return json({ ok: true });
    }
    if (path === '/advanced/users' && m === 'GET') {
      if (!(await isAdvanced(env, request))) return fail('未授权', 401);
      let ul = [];
      try { ul = (await env.DB.prepare('SELECT id,email,name,is_admin,muted,created_at FROM users ORDER BY id DESC LIMIT 500').bind().all()).results || []; }
      catch (e) { ul = (await env.DB.prepare('SELECT id,email,name,is_admin,created_at FROM users ORDER BY id DESC LIMIT 500').bind().all()).results || []; ul.forEach((x) => { x.muted = 0; }); }
      return json({ users: ul, global_mute: (await getFlag(env, 'global_mute')) === '1' ? 1 : 0 });
    }
    if (path === '/advanced/mute' && m === 'POST') {
      if (!(await isAdvanced(env, request))) return fail('未授权', 401);
      const b = await body(request), on = String(b.action || '') === 'mute' ? 1 : 0;
      const key = String(b.key || '').trim().toLowerCase();
      const u = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(key).first();
      if (!u) return fail('找不到这个账户码');
      await env.DB.prepare('UPDATE users SET muted=? WHERE id=?').bind(on, u.id).run();
      return json({ ok: true, muted: on });
    }
    if (path === '/advanced/global-mute' && m === 'POST') {
      if (!(await isAdvanced(env, request))) return fail('未授权', 401);
      const b = await body(request);
      await setFlag(env, 'global_mute', b.on ? '1' : '0');
      return json({ ok: true, on: !!b.on });
    }
    /* 密码是加盐哈希、不可逆，无法查看明文；这里改成「重置」，新密码只返回这一次 */
    if (path === '/advanced/reset-password' && m === 'POST') {
      if (!(await isAdvanced(env, request))) return fail('未授权', 401);
      const b = await body(request);
      const key = String(b.key || '').trim().toLowerCase();
      const u = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(key).first();
      if (!u) return fail('找不到这个账户码');
      const np = rnd(6).slice(0, 10);
      const salt = rnd(16), ph = await pbkdf2(np, salt);
      await env.DB.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').bind(ph, salt, u.id).run();
      return json({ ok: true, password: np });
    }

    return fail('接口不存在', 404);
  } catch (e) {
    return fail('SERVER_ERROR: ' + (e && e.message ? e.message : 'unknown'), 500);
  }
}

/* ── Pages Advanced Mode 入口 ── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    if (!env.ASSETS) return new Response('ASSETS_NOT_BOUND', { status: 503 });
    const r = await env.ASSETS.fetch(request);
    const out = new Response(r.body, r);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    out.headers.set('X-Frame-Options', 'SAMEORIGIN');
    if (url.pathname.startsWith('/api/')) out.headers.set('Cache-Control', 'no-store');
    return out;
  }
};
