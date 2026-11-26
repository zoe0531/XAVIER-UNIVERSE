# 星宙 · 云版（技术说明）

> 小白看 **[从零开始-连Git版.md](./从零开始-连Git版.md)**。这份给要改代码的人。

**原银河皮 100% 保留 ＋ 审核 / 多管理员 / 通知 / 登录注册 / 我的祝福 ＋ Cloudflare Pages + D1 ＋ 连 Git 可长期改。**

---

## 主页保真

`index.html` 由原页面 `zoe0531.github.io/Xavieruniverse/星宙.html`（711653 字节）做 **4 行精确字符串手术**：

| 原 | 改 |
|---|---|
| `sbURL` + `sbKey` 两行 | `apiBase:'/api/wishes'` |
| `sbH()` 的 apikey/Authorization | `var h={}` |
| `base:CONFIG.sbURL+'/rest/v1/wishes'` | `base:CONFIG.apiBase` |
| `adminPass:'zzz030101'` | 占位串（口令改服务端） |

另把文件头注释里原站自带的明文口令抹掉（唯一一处非配置改动）。

`/api/wishes` **完全兼容原站 STORE 的 PostgREST 形状**，所以 `load / add / remove / peek / fromRow` 一行没改：

```
GET  /api/wishes?select=...&order=id.asc&limit=1000&offset=0 → [{id,text,name,photo,created_at}]
GET  /api/wishes?select=id&order=id.desc&limit=1            → [{id}]
POST /api/wishes {text,name,photo}                          → [行]
DELETE /api/wishes?id=eq.123                               → 200
```

`text` 里的零宽编号前缀 `\u2060<36进制>\u2060<o|x>\u2060<正文>` 原样存，编号永不重排；`created_at` 返 ISO，`new Date()` 可直接解析。

**末尾独立追加** `<style id="xz-addon-style">` + `<script id="xz-addon">`：实现审核符号、⚙ 设置弹窗、通知弹窗、「我 的」按账号过滤。原 `<style>`、内联 Three.js、原逻辑段、末段脚本、全部 HTML 文案**逐字节不变**（`校验报告.txt` 可复核）。

---

## 文件

```
index.html          原银河主页（4 行配置 + 末尾独立追加层）
console.html        后台：登录注册 / 我的祝福 / 审核 / 管理员 / 通知 / 关于
_worker.js          Pages Advanced Mode 后端（根目录，拖拽上传也支持）
schema.sql          D1 建表（users / sessions / wishes / announcements）
wrangler.toml       CLI 部署参考
校验报告.txt        主页保真校验
从零开始-连Git版.md  小白教程
README.md
```

Advanced Mode：`/api/*` 由 `_worker.js` 接管，其余 `env.ASSETS.fetch()` 回源，**连接 Git / 拖拽上传 / wrangler 三种部署都支持**。

---

## 权限模型（本轮按你的要求重做）

**管理员只有一个来源：站长在设置里按邮箱指定。**

1. 站长在 `console.html` 注册一个账号
2. 主页 ⚙ → 原站那个口令框 → 输 **`zzz030101`** → `POST /api/admin/owner-login`
   - 口令**只在服务端**（`OWNER_PASS(env)`，可用 `ADMIN_PASSWORD` 覆盖），前端任何文件都没有明文
3. 进「设 置」→ **按邮箱号**把账号设为 / 取消管理员 → `users.is_admin`
4. `GET /api/me` 返回：
   - `owner` = 持久管理员（`users.is_admin`）→ **只用它控制主页「✓ 审」符号显隐**
   - `admin` = 持久管理员 **或** 站长临时会话 → 控制后台接口权限

所以：**输口令只是进设置的钥匙，不会让主页冒出审核符号；按邮箱设为管理员才会。取消后符号立刻收起**（后端同时把所有临时 admin 会话降级）。

`POST /api/register` **不接受任何提权参数**；旧版那个「填设置码升级」的接口已整个移除。前端不再出现「管理员设置码」输入框。

---

## 本轮 6 条改动对照

| # | 要求 | 落地 |
|---|---|---|
| 1 | 邮箱框删掉「你的QQ号@」那段 | `console.html` placeholder 改为「邮 箱」 |
| 2 | 名字框写「填入名称」 | 已改 |
| 3 | ⚙ 里能删星 + 设管理员；`zzz030101` 进入且不显示；按邮箱设；管理员可删星；设/取消时审核符号显隐；全部祝福必经审核；未审核/已审核标明；审核完不显「审核通过」；通知全部用户放控制台旁 | 全部实现，见下 |
| 4 | 「我 的」只显示自己写的 | 覆盖 `renderMine()` 走 `/api/mine`，按设备 token / 账号归属，带状态标签 |
| 5 | 后台不显示「控制台」三字；「星宙」淡紫 ins 风 | `console.html` title / kick / 按钮全去掉；h1 淡紫渐变 + 细体大字距 + 光晕 |
| 6 | 删掉登录页那句说明 | 已删 |

第 3 条细节：
- 投稿默认 `pending`，只有 `approved` 才进公共星 宙
- 审核列表与「我 的」用 `未 审 核 / 已 亮 起 / 未 通 过` 标明
- 通过后列表移除该条、toast 只说「已处理」，**星 宙里的星星不挂任何审核字样**
- 批量通过只发一条汇总通知，文案不含「审核通过」
- 通知全部用户：站内公告（所有人可见）＋ 群机器人 ＋ 全部注册邮箱，入口在设置弹窗与后台「通 知」标签

---

## 环境变量（全部选填）

| 变量 | 作用 |
|---|---|
| `ADMIN_PASSWORD` | 覆盖站长口令（不填用服务端默认那串） |
| `NOTIFY_WEBHOOK` | 群机器人，按域名自动适配企业微信 / 钉钉 / 飞书 |
| `RESEND_API_KEY` | Resend 邮件 |
| `NOTIFY_EMAIL_FROM` / `NOTIFY_EMAIL_TO` | 发件人 / 固定收件人 |

通知失败一律吞掉，不影响投稿与审核。

---

## 接口

```
原站 STORE
GET/POST/DELETE  /api/wishes
账号
GET  /api/me                       { user, admin, owner }
POST /api/register /api/login /api/logout
站长
POST /api/admin/owner-login        { password }   ← 唯一进设置入口
POST /api/admin/login|logout       兜底口令
GET  /api/admin/check
我的
GET  /api/mine                    只列自己写的，含状态
POST /api/mine                    编辑（改后回 pending）/ 删除自己的
审核
GET  /api/admin/wishes?status=    pending|approved|rejected|all
POST /api/admin/wishes/batch      {ids, action}
POST /api/admin/wishes/:id        {action}
管理员
GET  /api/admin/users
POST /api/admin/users             {key: 邮箱, action: promote|demote}（严格按邮箱）
通知
GET  /api/announcements           所有人可读
POST /api/admin/announce          {text} → 站内 + 群 + 全部注册邮箱
```

---

## 容量

- `CONFIG.capacity = 50000`，超过只留最新 5 万条；`batch:130` 每批随机抽 130 颗铺球面
- `maxWishes:5000` 原站定义了但未生效（投稿判断用 capacity）
- 照片按原站做法存进数据库行（base64，单条上限 6,000,000 字符）
- **D1 单库 10 GB**；绑 R2（变量名 `BUCKET`）可把大图挪出去，免费 10 GB·月
- 纯文字几千～5 万条都稳；带大图主要吃存储

---

## 部署

连 Git（可长期改）：GitHub 仓库放全部文件 → Cloudflare Pages Connect to Git → 建 D1 执行 `schema.sql` → 绑定 `DB` → 变量 → **重新部署** → `/console.html` 注册 → 主页 ⚙ 输口令 → 按邮箱设自己为管理员。

拖拽上传也支持（`_worker.js` 在根目录），但以后改要重新传。

> `*.pages.dev` 前缀建完不可改；绑定或变量改完必须重新部署。

---

## 测试

Node 内置 SQLite 跑真实 `schema.sql`，**45 项断言全过**：PostgREST 形状兼容、零宽编号、待审可见性、删除权限、站长口令与 owner 字段、按邮箱设/取消管理员、符号显隐、临时会话降级、批量通过、状态标明、通知三通道、通知挂掉不阻塞、不配通知零外发、主页分段字节保真、前端无口令/无被删文案。

---

## 旧数据

新库默认从 0 开始，原站照常跑。要迁移：导出旧数据 → 生成可直接粘进 D1 Console 的 INSERT SQL，编号不重排。
