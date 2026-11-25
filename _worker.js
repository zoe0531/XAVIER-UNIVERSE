/* 星宙 · Cloudflare Pages Advanced Mode 后端
 * 文件名 _worker.js 必须放在站点最外层（和 index.html 同级）。
 * 拖拽上传 / 连接 Git / wrangler 三种部署方式都支持。
 *
 * 关键设计：/api/wishes 完全兼容原站 STORE 用的 PostgREST 形状
 *   GET  ?select=...&order=id.asc&limit=1000&offset=0 → [{id,text,name,photo,created_at}]
 *   GET  ?select=id&order=id.desc&limit=1            → [{id}]   （原站 peek 探针）
 *   POST {text,name,photo}                            → [行]     （representation）
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
  return `${name}=${encodeURIComponent(val)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${https ? '; Secure' : ''}`;
}
const clearCookie = (n, req) => setCookie(n, '', req, 0);
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
  return { s: { token: t, user_id: null, role: 'visitor' }, cookie: setCookie('xz_sid', t, req, 31536000) };
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
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wishes_dedup ON wishes(owner_token, created_at DESC)').run(); } catch (e) {}
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
/* 去重用完整纯正文，不截断，避免两条长祝福前 240 字相同被误吞；前缀不同也能认出是同一条 */
const dedupText = (t) => stripMark(t);
const when = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

/* ── 行 → 原站格式 ── */
function row(r) {
  return { id: r.id, text: stripMark(r.text), name: r.name || '', photo: r.photo || '',
    created_at: new Date(Number(r.created_at) || Date.now()).toISOString() };
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
      const text = String(b.text || '');
      if (!stripMark(text).trim()) return fail('先写点什么吧');
      const name = String(b.name || '').slice(0, 40) || '无名';
      const photo = String(b.photo || '').slice(0, 6000000);
      const now = Date.now();
      /* 防重复：同一设备 30 秒内、内容/署名/图完全一样的，只认第一条。
         连点、断网补传、多人重试都不会在星宙或审核里生出第二颗。 */
      const recent = await env.DB.prepare(
        'SELECT id,text,name,photo,created_at FROM wishes WHERE owner_token=? AND created_at>? ORDER BY id DESC LIMIT 20'
      ).bind(s.token, now - 30000).all();
      const same = (recent.results || []).find((x) =>
        dedupText(x.text) === dedupText(text) && String(x.name || '') === name && String(x.photo || '') === photo);
      if (same) return withCookie(json([row(same)], 200, { 'Cache-Control': 'no-store' }), cookie);
      /* ── 编号规则 ──
         只按「全表已有的最大编号 + 1」发号：
         · 删掉中间一颗 → 其余编号纹丝不动，被删的号永久空着（不补位）
         · 所有祝福（含待审 / 未通过）全清空 → 最大号没了，下一颗重新从第 1 颗开始
         · 多人同时写撞了主键就重读最大号再试，绝不丢星、绝不复制出第二颗 */
      const mx = await env.DB.prepare('SELECT MAX(id) AS m FROM wishes').bind().first();
      let no = (mx && Number(mx.m) > 0) ? Number(mx.m) + 1 : 1;
      let ins = null, lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          ins = await env.DB.prepare(
            'INSERT INTO wishes (id,owner_token,user_id,text,name,photo,status,created_at) VALUES (?,?,?,?,?,?,?,?)'
          ).bind(no, s.token, s.user_id, text, name, photo, 'pending', now).run();
          break;
        } catch (e) {
          lastErr = e;
          const mx2 = await env.DB.prepare('SELECT MAX(id) AS m FROM wishes').bind().first();
          no = (mx2 && Number(mx2.m) > 0) ? Number(mx2.m) + 1 : 1;
        }
      }
      if (!ins) throw lastErr || new Error('写入失败');
      let created = await env.DB.prepare(
        'SELECT id,text,name,photo,created_at FROM wishes WHERE id=?'
      ).bind(no).first();
      if (!created) created = await env.DB.prepare(
        'SELECT id,text,name,photo,created_at FROM wishes WHERE owner_token=? AND created_at=? ORDER BY id DESC LIMIT 1'
      ).bind(s.token, now).first() || { id: no, text, name, photo, created_at: now };
      // 通知：有人投稿，等审核
      await safeNotify(env, '收到一条新祝福，待审核',
        [`署名：${name}`, `内容：${plain(text)}`, `时间：${when()}`]);
      // 返回 representation：原站会立刻把这颗星画给自己；别人要等审核通过才看得到
      return withCookie(json([row(created)], 200, { 'Cache-Control': 'no-store' }), cookie);
    }

    if (path === '/wishes' && m === 'DELETE') {
      const eq = q.get('id') || '';
      const id = String(eq).replace(/^eq\./, '');
      if (!/^\d+$/.test(id)) return fail('编号不对');
      const w = await env.DB.prepare('SELECT id,owner_token,user_id FROM wishes WHERE id=?').bind(id).first();
      if (!w) return new Response('', { status: 200 });   // 原站按 r.ok 判断
      const s = await session(env, request);
      const adm = await isAdmin(env, request);
      const mine = s && (s.token === w.owner_token || (s.user_id && s.user_id === w.user_id));
      if (!adm && !mine) return fail('没有权限删除这颗星星', 403);
      await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run();
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
      return withCookie(json({ user: { id: u.id, email: u.email, name: u.name, is_admin: isAdm === 1 } }), cookie);
    }

    if (path === '/login' && m === 'POST') {
      const { s, cookie } = await ensureSession(env, request);
      const b = await body(request);
      const email = String(b.email || '').trim().toLowerCase();
      const u = await env.DB.prepare('SELECT id,email,name,password_hash,salt,is_admin FROM users WHERE email=?').bind(email).first();
      if (!u || !tseq(await pbkdf2(String(b.password || ''), u.salt), u.password_hash)) return fail('账户码或密码不对', 401);
      await env.DB.prepare('UPDATE sessions SET user_id=?,role=? WHERE token=?').bind(u.id, 'user', s.token).run();
      return withCookie(json({ user: { id: u.id, email: u.email, name: u.name, is_admin: Number(u.is_admin) === 1 } }), cookie);
    }

    if (path === '/logout' && m === 'POST') {
      const s = await session(env, request);
      if (s) await env.DB.prepare('UPDATE sessions SET user_id=NULL,role=? WHERE token=?').bind('visitor', s.token).run();
      return json({ ok: true });
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
      if (!s) return json({ wishes: [] });
      const u = await me(env, request);
      const sel = 'SELECT id,text,name,photo,status,created_at FROM wishes ';
      const r = u
        ? await env.DB.prepare(sel + 'WHERE user_id=? ORDER BY id DESC LIMIT 500').bind(u.id).all()
        : await env.DB.prepare(sel + 'WHERE owner_token=? AND user_id IS NULL ORDER BY id DESC LIMIT 500').bind(s.token).all();
      return json({ wishes: (r.results || []).map((w) => Object.assign(row(w), { status: w.status })) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (path === '/mine' && m === 'POST') {
      const s = await session(env, request);
      if (!s) return fail('请先登录或在本机投稿', 401);
      const b = await body(request), id = String(b.id || '');
      const w = await env.DB.prepare('SELECT id,owner_token,user_id,status FROM wishes WHERE id=?').bind(id).first();
      if (!w) return fail('找不到这条祝福');
      const adm = await isAdmin(env, request);
      if (!adm && w.owner_token !== s.token && !(s.user_id && w.user_id === s.user_id))
        return fail('只能改自己的祝福', 403);
      if (String(b.action || '') !== 'delete' && w.status === 'approved')
        return fail('已通过的祝福不能修改，只能删除');
      if (b.action === 'delete') {
        await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run();
        return json({ ok: true });
      }
      const text = String(b.text || ''), name = String(b.name || '').slice(0, 40) || '无名';
      await env.DB.prepare('UPDATE wishes SET text=?,name=?,photo=?,status=? WHERE id=?')
        .bind(text, name, String(b.photo || '').slice(0, 6000000), 'pending', id).run();
      await safeNotify(env, '一条祝福被修改，需重新审核', [`署名：${name}`, `内容：${plain(text)}`, `时间：${when()}`]);
      return json({ ok: true });
    }

    /* ===== 审核后台 ===== */
    if (path === '/admin/wishes' && m === 'GET') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const st = q.get('status') || 'pending';
      if (!['pending', 'approved', 'rejected', 'all'].includes(st)) return fail('状态不合法');
      const base = 'SELECT id,text,name,photo,status,created_at FROM wishes';
      const r = st === 'all'
        ? await env.DB.prepare(base + ' ORDER BY id DESC LIMIT 500').bind().all()
        : await env.DB.prepare(base + ' WHERE status=? ORDER BY id DESC LIMIT 500').bind(st).all();
      return json({ wishes: (r.results || []).map((w) => Object.assign(row(w), { status: w.status })) });
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
        const w = await env.DB.prepare('SELECT id,text,name,status FROM wishes WHERE id=?').bind(id).first();
        if (!w) continue;
        if (act === 'delete') { await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run(); continue; }
        const st = act === 'approve' ? 'approved' : 'rejected';
        await env.DB.prepare('UPDATE wishes SET status=? WHERE id=?').bind(st, id).run();
        if (act === 'approve' && w.status !== 'approved') passed.push(w);
      }
      if (passed.length) await safeNotify(env, `${passed.length} 颗星星已点亮`,
        passed.slice(0, 5).map((w, i) => `${i + 1}. ${w.name}：${plain(w.text).slice(0, 80)}`));
      return json({ ok: true, count: ids.length, approved: passed.length });
    }
    if (parts[0] === 'admin' && parts[1] === 'wishes' && parts[2] && m === 'POST') {
      if (!(await isAdmin(env, request))) return fail('未授权', 401);
      const b = await body(request), id = String(parts[2]);
      const w = await env.DB.prepare('SELECT id,text,name,status FROM wishes WHERE id=?').bind(id).first();
      if (!w) return fail('找不到这条祝福');
      if (b.action === 'delete') await env.DB.prepare('DELETE FROM wishes WHERE id=?').bind(id).run();
      else if (b.action === 'approve' || b.action === 'reject') {
        await env.DB.prepare('UPDATE wishes SET status=? WHERE id=?').bind(b.action === 'approve' ? 'approved' : 'rejected', id).run();
        if (b.action === 'approve' && w.status !== 'approved')
          await safeNotify(env, '一颗星星已点亮', [`署名：${w.name}`, `内容：${plain(w.text)}`, `时间：${when()}`]);
      } else return fail('操作不合法');
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
