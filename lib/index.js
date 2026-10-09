// index.js — DSH 员工端插件（团队版 Reporter）。
//
// 职责：把本机 DSH 每一步的真实 token 用量，按幂等事件上报给团队服务器；
// 并提供一个本地面板（右下角浮动徽标）用于填写服务器地址、用邀请码 enroll、查看上报状态。
//
// 挂载方式（与 dsh-whale-widget 同机制）：
//   package.json → { "type":"module", "main":"lib/index.js", "dsh": { "bundle": { "patch":"./cordis.patch.yml" } } }
//   cordis.patch.yml → - insert: [ { id: dsh-team-reporter, name: dsh-team-reporter } ]
//   安装： dsh plugin --profile <profile> add link:<本目录绝对路径>
//
// ⚠️ 三条必须遵守的宿主兼容纪律（踩过就知道有多疼）：
//  ① `root.inject([...])` 只能列出**确定存在**的服务。可选服务（deepseekAccount）必须用 `ctx.get()` 读，
//     写进 inject 会让插件在旧宿主上**永不 apply**（比少个功能严重得多）。
//  ② 桌面端（Electron）的 index.html 直接读安装包 dist，**不经过宿主 renderIndex**，
//     所以 `webServer.tapIndex` 在桌面端无效；桌面端唯一注入通道是
//     `root.on('webserver/index-inject', table => ...)`，且该行必须**尽早**注册（注入表是一次性收集的）。
//  ③ `apply()` 必须立即返回，不能 await 任何东西；可选服务用 `ctx.get()` 惰性访问。

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TeamReporter, REPORTER_VERSION, TOKEN_KEY_REF, DSH_HOME, setClock } from './reporter.mjs'
import { applyPack, cleanupTemp, listInstalled, listLocalSkills, buildSubmission } from './skillsync.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_PATH = '/dsh-team/ui.js'
const API_PREFIX = '/dsh-team/api/'

const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000
const BALANCE_INTERVAL_MS = 15 * 60 * 1000
const CONFIG_REFRESH_MS = 30 * 60 * 1000
// 技能同步比配置刷新还慢一档：技能是"人写出来的 SOP"，一天变不了几次，
// 而每次同步都要把整个库的正文拉一遍。30 分钟足够让一次审批在半小时内到达全员。
const SKILL_SYNC_INTERVAL_MS = 30 * 60 * 1000
const MIN_INTERVAL_SEC = 15
const MAX_INTERVAL_SEC = 3600

/**
 * 把服务端下发的 flush 间隔夹到合理范围。
 * 下限 15 秒：再快也不会更"实时"（人看报表不差那几秒），只会白花流量。
 * 上限 1 小时：再慢就有数据长时间躺着不报，看板上会出现"刚用完却不显示"的困惑。
 * 非法值（0/负数/NaN/字符串）一律退回默认 15 秒 —— 服务端设置是可以被改坏的，
 * 客户端不能因为一个坏值就定时器变成 0ms 把自己跑死。
 */
function clampIntervalSec(v) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n <= 0) return MIN_INTERVAL_SEC
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, n))
}


/** 注入到页面的那一行：内联 script 动态插入真正的 ui.js（与 whale-widget 同一手法）。 */
const INJECT_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${UI_PATH}?t="+Date.now();` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'dsh-team-reporter',

  apply(root) {
    const disposers = []
    let reporter = null
    let timers = []

    // ── ① 结构化注入行：桌面端唯一生效的通道。必须最早注册（注入表一次性收集）。 ──
    try {
      disposers.push(root.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(UI_PATH)) return
          if (row.kind === 'script-src' && row.src === UI_PATH) return
        }
        table.push({ kind: 'script', placement: 'body', text: INJECT_ROW_TEXT })
      }))
    } catch (err) {
      // 老宿主没有这个事件：忽略即可（web 形态还有 tapIndex 兜底）
      try { console.warn('[dsh-team] webserver/index-inject 不可用：' + String((err && err.message) || err)) } catch (e) {}
    }

    // ── ② 其余逻辑：等齐三个确定存在的服务 ──
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      const log = (msg) => { try { console.warn(`[dsh-team] ${msg}`) } catch (err) {} }

      // 信任栅栏：whale-widget 的做法（Host/Origin 被伪造时拒门），拿不到服务就放宽为「只允许本机 Host」。
      const fence = (req, res) => {
        try {
          const conn = ctx.get('connection')
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req)
            if (code === undefined || code === null || code === false) return false
            res.statusCode = typeof code === 'number' ? code : 403
            res.end('forbidden')
            return true
          }
        } catch (err) {
          // 栅栏本身抛异常 → fail-closed（放行比拒绝危险）
          res.statusCode = 403
          res.end('forbidden')
          return true
        }
        const host = String((req.headers && req.headers.host) || '')
        const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
        const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
        if (!local) {
          res.statusCode = 403
          res.end('forbidden')
          return true
        }
        return false
      }

      const registerRoute = (route) => {
        const inner = route.handler
        return ctx.webServer.register({
          ...route,
          handler: async (req, res) => {
            if (fence(req, res)) return
            try {
              await inner(req, res)
            } catch (err) {
              try {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String((err && err.message) || err) } }))
              } catch (e2) {}
            }
          },
        })
      }

      const sendJson = (res, status, payload) => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const readJsonBody = async (req, max = 512 * 1024) => {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > max) throw new Error('请求体过大')
          chunks.push(chunk)
        }
        if (!chunks.length) return {}
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      const handle = (fn) => async (req, res) => {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          const data = await fn(body)
          sendJson(res, 200, { ok: true, data })
        } catch (err) {
          sendJson(res, 400, {
            ok: false,
            error: { code: (err && err.code) || 'BAD_REQUEST', message: String((err && err.message) || err) },
          })
        }
      }

      // ── 凭据桥：机器令牌存 DSH 官方凭据库（不落明文文件） ──
      const credBridge = {
        resolveCredential: async (keyRef) => {
          try { return await ctx.credentials.resolve(keyRef) } catch (err) { return null }
        },
        setCredential: async (keyRef, value) => {
          if (!ctx.credentials || typeof ctx.credentials.set !== 'function') throw new Error('当前 DSH 版本不支持写入凭据')
          await ctx.credentials.set(keyRef, value)
        },
      }

      // 会话工作区名：只有 basename 会上报（服务端也会再归一化一次）
      const workspaceOf = (session) => {
        try {
          const cwd = session && (session.cwd || (session.meta && session.meta.cwd))
          if (!cwd) return null
          return path.basename(String(cwd))
        } catch (err) { return null }
      }

      reporter = new TeamReporter({ ...credBridge, workspaceOf, log })

      // ── 采集：按 session.id 分桶，隔离主会话与子代理并发 ──
      disposers.push(ctx.on('session/event', (session, event) => {
        try { reporter.collector.handle(session, event) } catch (err) { log(`采集失败: ${String((err && err.message) || err)}`) }
      }))
      disposers.push(ctx.on('session/disposed', (session) => {
        try { reporter.collector.disposeSession(session && session.id != null ? String(session.id) : '') } catch (err) {}
      }))

      // ── 余额：可选服务，必须用 ctx.get() 惰性读 ──
      let lastBalance = null
      let lastBalanceSentAt = 0
      async function collectBalance() {
        let account = null
        try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch (err) { account = null }
        if (!account || typeof account.getBalance !== 'function') return null
        let result
        try {
          result = await account.getBalance({
            version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
            locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          })
        } catch (err) { return null }
        if (!result || result.status !== 'ready' || !Array.isArray(result.value)) return null
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
        const sum = (list, cur) => (Array.isArray(list) ? list : [])
          .filter((w) => w && String(w.currency || 'CNY').toUpperCase() === cur && num(w.balance) !== null)
          .reduce((s, w) => s + Number(w.balance), 0)
        const wallets = result.value.filter((w) => w && num(w.balance) !== null)
        if (!wallets.length) return null
        const currency = wallets.some((w) => String(w.currency || '').toUpperCase() === 'CNY')
          ? 'CNY'
          : String((wallets[0] && wallets[0].currency) || 'CNY').toUpperCase()
        // 与服务端/whale-widget 同口径：总余额 = 充值钱包 + 赠金钱包
        return { currency, remaining: Number((sum(result.value, currency) + sum(result.bonusWallets, currency)).toFixed(6)) }
      }

      async function balanceTick() {
        if (!reporter.enrolled) return
        const b = await collectBalance()
        if (!b) return
        const changed = lastBalance === null || Math.abs(b.remaining - lastBalance) >= 0.01
        const due = Date.now() - lastBalanceSentAt >= 60 * 60 * 1000
        if (!changed && !due) return
        const out = await reporter.reportBalance(b.remaining, { currency: b.currency })
        if (out) { lastBalance = b.remaining; lastBalanceSentAt = Date.now() }
      }

      // ── 公司技能同步（服务器权威 → ~/.dsh/skills/dsh-team/） ──
      // 失败一律**保留现有技能**：拉不到包、包坏了、写盘失败，都只算"这次没更新"。
      // 绝不能因为网络抖一下，就把员工手里本来能用的 SOP 清空 —— 那比不更新糟得多。
      let syncingSkills = false
      async function syncSkills({ force = false } = {}) {
        if (syncingSkills) return { ok: false, error: '正在同步中，稍后再试' }
        syncingSkills = true
        try {
          const prev = reporter.skillState || {}
          const res = await reporter.fetchSkillPack(force ? '' : String(prev.version || ''))
          if (!res.ok) {
            reporter.setSkillState({ last_error: res.error || '同步失败', last_attempt_at: Date.now() })
            return { ok: false, error: res.error || '同步失败' }
          }
          const pack = res.pack || {}
          if (pack.unchanged) {
            reporter.setSkillState({ version: String(pack.version || prev.version || ''), last_error: null, last_checked_at: Date.now() })
            return { ok: true, unchanged: true, version: pack.version }
          }
          const applied = applyPack(DSH_HOME, pack)
          if (!applied.ok) {
            reporter.setSkillState({ last_error: applied.error, last_attempt_at: Date.now() })
            log(`技能同步失败（现有技能原样保留）: ${applied.error}`)
            return { ok: false, error: applied.error }
          }
          cleanupTemp(DSH_HOME)
          reporter.setSkillState({
            version: applied.version, count: applied.count, bytes: applied.bytes,
            dir: applied.dir, synced_at: Date.now(), last_error: null, last_checked_at: Date.now(),
          })
          log(`技能已更新：${applied.count} 个（${applied.version}）`)
          return { ok: true, unchanged: false, version: applied.version, count: applied.count }
        } catch (err) {
          const msg = String((err && err.message) || err)
          reporter.setSkillState({ last_error: msg, last_attempt_at: Date.now() })
          return { ok: false, error: msg }
        } finally {
          syncingSkills = false
        }
      }
      /** 面板要的完整技能视图：同步状态 + 已装（下发） + 本地（可提交）。 */
      function skillsView() {
        const installed = listInstalled(DSH_HOME)
        const local = listLocalSkills(DSH_HOME)
        return {
          state: reporter.skillState || null,
          syncing: syncingSkills,
          remote_dir: installed.dir,
          installed: installed.skills,
          local_dir: local.dir,
          local: local.skills,
          local_skipped: local.skipped,
        }
      }

      // ── 定时器 ──
      let flushing = false
      // 冲刷间隔可由服务端 /api/v1/config 的 interval_sec 下发（clamp 到 [15s, 1h]）。
      // 之前这里写死 15 秒、而服务端那个 report_interval_sec 旋钮根本没人读 ——
      // 「配置里有个不起作用的开关」是最容易让后来人踩坑的一类东西，两边必须接上。
      let flushDelayMs = clampIntervalSec(reporter.stats.config && reporter.stats.config.interval_sec) * 1000
      let flushTimer = null
      function startFlushTimer() {
        flushTimer = setInterval(async () => {
          if (flushing) return
          flushing = true
          try { await reporter.tick() } catch (err) { log(`上报失败: ${String((err && err.message) || err)}`) } finally { flushing = false }
        }, flushDelayMs)
        if (flushTimer.unref) flushTimer.unref()
        timers.push(flushTimer)
      }
      startFlushTimer()
      /** 配置变化时重建定时器（间隔一致就不用动，免得每次都重置计时）。 */
      reporter.onConfigApplied = (cfg) => {
        const next = clampIntervalSec(cfg && cfg.interval_sec) * 1000
        if (next === flushDelayMs) return
        flushDelayMs = next
        if (flushTimer) clearInterval(flushTimer)
        startFlushTimer()
      }

      const hbTimer = setInterval(() => { reporter.heartbeat().catch(() => {}) }, HEARTBEAT_INTERVAL_MS)
      if (hbTimer.unref) hbTimer.unref()
      timers.push(hbTimer)

      const balTimer = setInterval(() => { balanceTick().catch(() => {}) }, BALANCE_INTERVAL_MS)
      if (balTimer.unref) balTimer.unref()
      timers.push(balTimer)

      const cfgTimer = setInterval(() => { reporter.fetchConfig().catch(() => {}) }, CONFIG_REFRESH_MS)
      if (cfgTimer.unref) cfgTimer.unref()
      timers.push(cfgTimer)

      const skillTimer = setInterval(() => { syncSkills().catch(() => {}) }, SKILL_SYNC_INTERVAL_MS)
      if (skillTimer.unref) skillTimer.unref()
      timers.push(skillTimer)

      // ── HTTP 路由（逐条注册，不能只导出一张路由表） ──
      const routes = []
      routes.push(registerRoute({
        method: 'GET',
        path: `${API_PREFIX}status`,
        handler: (req, res) => sendJson(res, 200, { ok: true, data: reporter.status() }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}config`,
        handler: handle(async (body) => {
          if (body.server_url !== undefined) reporter.setServerUrl(body.server_url)
          return { server_url: reporter.serverUrl }
        }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}enroll`,
        handler: handle(async (body) => {
          const info = await reporter.enroll({
            serverUrl: body.server_url,
            code: body.code,
            hostname: body.hostname || os.hostname(),
            platform: body.platform || `${process.platform}-${process.arch}`,
          })
          balanceTick().catch(() => {})
          return { enrollment: info, status: reporter.status() }
        }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}unenroll`,
        handler: handle(async () => {
          await reporter.unenroll()
          return { status: reporter.status() }
        }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}test`,
        handler: handle(async () => {
          const identity = await reporter.probe()
          await reporter.fetchConfig()
          return { identity, status: reporter.status() }
        }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}flush`,
        handler: handle(async () => {
          const out = await reporter.tick()
          return { result: out, status: reporter.status() }
        }),
      }))

      // ── 技能：状态 / 手动同步 / 提交本地技能 ──
      routes.push(registerRoute({
        method: 'GET',
        path: `${API_PREFIX}skills`,
        handler: (req, res) => sendJson(res, 200, { ok: true, data: skillsView() }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}skills/sync`,
        handler: handle(async () => {
          const result = await syncSkills({ force: true })
          return { result, skills: skillsView() }
        }),
      }))

      routes.push(registerRoute({
        method: 'POST',
        path: `${API_PREFIX}skills/submit`,
        handler: handle(async (body) => {
          const built = buildSubmission(DSH_HOME, body && body.name)
          if (!built.ok) throw new Error(built.error)
          // 服务端只收 SKILL.md 之外的文件作为 extra；正文单独走 content。
          const submission = await reporter.submitSkill({ name: built.name, content: built.content, files: built.files })
          return { submission, skills: skillsView() }
        }),
      }))

      const uiJs = fs.readFileSync(path.join(HERE, 'ui.js'), 'utf8')
      routes.push(registerRoute({
        method: 'GET',
        path: UI_PATH,
        handler: (req, res) => {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(uiJs)
        },
      }))
      disposers.push(() => { for (const d of routes) { try { d && d() } catch (err) {} } })

      // web 形态的兜底注入通道（桌面端走 ① 的注入行）
      try {
        if (typeof ctx.webServer.tapIndex === 'function') {
          disposers.push(ctx.webServer.tapIndex((html) => {
            if (typeof html !== 'string' || html.includes(UI_PATH)) return html
            const tag = `<script defer src="${UI_PATH}"></script>`
            return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
          }))
        }
      } catch (err) {}

      // ── 启动自检：令牌在凭据库里就加载，否则面板提示去 enroll ──
      ;(async () => {
        await reporter.loadToken()
        if (reporter.token) {
          await reporter.heartbeat()
          await reporter.fetchConfig()
          try { await reporter.probe() } catch (err) { log(`令牌自检失败：${String((err && err.code) || (err && err.message) || err)}`) }
          await balanceTick()
          // 启动就拉一次技能：员工装完插件、绑完码，公司 SOP 应该马上出现，
          // 而不是"等半小时后的那个定时器"。
          await syncSkills()
        }
        await reporter.tick()
      })().catch((err) => log(`启动自检异常：${String((err && err.message) || err)}`))

      ctx.effect(() => () => {
        for (const t of timers) { try { clearInterval(t) } catch (err) {} }
        for (const d of disposers) { try { d() } catch (err) {} }
      })
    })
  },
}

export { REPORTER_VERSION, TOKEN_KEY_REF, DSH_HOME, setClock, clampIntervalSec, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC }
