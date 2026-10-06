// reporter.mjs — 员工端插件核心：会话采集 → 本地持久队列 → 批量上报 → 心跳/余额。
//
// 三条设计纪律（服务端 doc 明确要求，违反任意一条都会导致对不上账）：
//  ① 身份只来自 enroll 拿到的机器令牌（存 DSH 官方凭据库，不落明文文件）；
//     上报体里**从不**声明 employee_id —— 服务端也不会采信。
//  ② 幂等键 = 事件的确定性 id：同一 (session, turn, step) 无论重发多少次都只入账一次。
//     这让「网络失败重试」「DSH 重启后重放」都天然安全。
//  ③ 只上报**带真实 usage 的 assistant 步骤**；reasoningTokens 属于 outputTokens，
//     绝不再单独累加（否则输出侧按输出价重复计费，实测偏高约一倍）。
//
// 时间纪律：/ingest/usage 有 ±24h 时钟偏差校验。插件若发现事件已超过 BACKFILL_LIMIT_MS，
// **直接丢弃而不是发出去**，免得整批被 CLOCK_SKEW 拒掉、把新数据也一起卡住。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ReporterPriceTable } from './pricing.mjs'

export const REPORTER_VERSION = '0.1.0'
export const TOKEN_KEY_REF = 'DSH_TEAM_MACHINE_TOKEN'
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const STATE_FILE = path.join(DSH_HOME, 'team-reporter.json')
const QUEUE_FILE = path.join(DSH_HOME, 'team-reporter-queue.jsonl')

const MAX_QUEUE = 20000            // 队列上限：超过就丢最旧的（宁可少算，也不撑爆磁盘）
const BACKFILL_LIMIT_MS = 12 * 3600 * 1000 // 只上报 12h 内的事件（服务端上限 24h，留一倍余量）
const DEFAULT_INTERVAL_SEC = 60
const MAX_BATCH_EVENTS = 2000
const HTTP_TIMEOUT_MS = 15000

// 时间缝：真实运行永远走 Date.now()。
// 只有自动化验收（tools/scripts/reporter-e2e.mjs）会临时把它锚定到确定时刻 ——
// 否则「插件本地时钟」与「被锚定的服务器时钟」不一致，事件会被 CLOCK_SKEW 整批拒绝，
// 测试就变成了时间炸弹（这个坑在服务端 pipeline 测试上已经踩过一次）。
let clock = () => Date.now()
export function setClock(fn) { clock = typeof fn === 'function' ? fn : (() => Date.now()) }
const nowMs = () => clock()

// ─────────────────────────── 本地状态文件 ───────────────────────────
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch (err) { /* 首次运行没有文件 */ }
  return { version: 1, server_url: '', enrollment: null }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (err) {
    return false
  }
}

// ─────────────────────────── 本地持久队列（JSONL 追加） ───────────────────────────
// 为什么落盘：DSH 关掉时还没上报的事件不能丢 —— 否则账目凭空少一截。
// 为什么用 append-only：崩溃安全（最坏丢最后半行，解析时跳过即可），无需事务。
class EventQueue {
  constructor(file) {
    this.file = file
    this.items = []
    this.load()
  }

  load() {
    let text = ''
    try { text = fs.readFileSync(this.file, 'utf8') } catch (err) { return }
    const seen = new Set()
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const ev = JSON.parse(s)
        if (ev && typeof ev.id === 'string' && !seen.has(ev.id)) { seen.add(ev.id); this.items.push(ev) }
      } catch (err) { /* 崩溃时可能留下半行，跳过 */ }
    }
  }

  get depth() { return this.items.length }

  push(ev) {
    this.items.push(ev)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, `${JSON.stringify(ev)}\n`, 'utf8')
    } catch (err) { /* 磁盘不可写时退化为纯内存队列，本次会话仍能上报 */ }
    if (this.items.length > MAX_QUEUE) {
      const dropped = this.items.length - MAX_QUEUE
      this.items.splice(0, dropped)
      this.rewrite()
      return dropped
    }
    return 0
  }

  /** 成功上报后移除；只要有一条失败，后面的全部保留（保证顺序与幂等语义） */
  remove(ids) {
    if (!ids.length) return
    const gone = new Set(ids)
    this.items = this.items.filter((e) => !gone.has(e.id))
    this.rewrite()
  }

  rewrite() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, this.items.map((e) => JSON.stringify(e)).join('\n') + (this.items.length ? '\n' : ''), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) { /* 写失败时内存队列仍是权威 */ }
  }
}

// ─────────────────────────── 会话事件 → 用量事件 ───────────────────────────
/**
 * 确定性事件 id：同一 (session, turn, step, model) 永远得到同一个 id。
 * 【为什么不用 ULID】ULID 依赖「何时第一次看到这条事件」，重启后重放会生成新 id，
 * 于是同一步真实消耗被记两次。哈希是幂等的。
 */
export function eventIdOf({ sessionId, turn, step, model }) {
  const h = createHash('sha256')
  h.update(`dsh-team|${sessionId}|${turn}|${step}|${model}`)
  return `t${h.digest('hex').slice(0, 40)}`
}

export function sessionHashOf(sessionId) {
  return createHash('sha256').update(`dsh-team-session|${sessionId}`).digest('hex').slice(0, 32)
}

/** 采集器：按 session.id 分桶，隔离主会话与子代理（spawn/fork）并发。 */
export class UsageCollector {
  constructor({ priceTable, workspaceOf, onEvent, log }) {
    this.priceTable = priceTable
    this.workspaceOf = workspaceOf || (() => null)
    this.onEvent = onEvent
    this.log = log || (() => {})
    this.buckets = new Map() // sessionId -> { turn, step }
  }

  disposeSession(sessionId) {
    this.buckets.delete(sessionId)
  }

  /**
   * 逐字对齐 whale-widget handleSessionEvent 的取值方式：
   *   event.type === 'assistant/message' && event.data.usage
   *   usage = { inputTokens, cacheReadTokens, outputTokens }
   *   turn  = event.data.turn
   *   model = event.data.message.source.model
   * 唯一的差别：我们**为每一步都产出事件**（whale 只累加成一个轮次汇总），
   * 因为团队看板需要按模型/工作区拆分的明细。
   */
  handle(session, event) {
    try {
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return null

      if (type === 'turn/end' || type === 'turn/start') {
        const sid = session?.id
        if (sid != null) this.buckets.delete(sid)
        return null
      }
      if (type !== 'assistant/message') return null

      const usage = d.usage
      if (!usage || typeof usage !== 'object') return null
      const turn = Number(d.turn)
      if (!Number.isFinite(turn)) return null

      const sessionId = session?.id != null ? String(session.id) : 'unknown'
      let bucket = this.buckets.get(sessionId)
      if (!bucket || bucket.turn !== turn) {
        bucket = { turn, step: 0 }
        this.buckets.set(sessionId, bucket)
      }
      bucket.step += 1

      const inputTokens = Math.max(0, Math.trunc(Number(usage.inputTokens) || 0))
      const cacheReadTokens = Math.max(0, Math.trunc(Number(usage.cacheReadTokens) || 0))
      // reasoningTokens ⊆ outputTokens（dsh-token-meter 会校验 reasoning > output 即非法）
      const outputTokens = Math.max(0, Math.trunc(Number(usage.outputTokens) || 0))
      const model = (d.message && d.message.source && d.message.source.model) || ''
      if (!model) return null
      if (inputTokens + cacheReadTokens + outputTokens <= 0) return null

      const occurredAt = nowMs()
      const id = eventIdOf({ sessionId, turn, step: bucket.step, model })
      const computed = this.priceTable.compute({ model, inputTokens, cacheReadTokens, outputTokens, occurredAt })

      const ev = {
        id,
        session_hash: sessionHashOf(sessionId),
        turn,
        step: bucket.step,
        model,
        workspace: this.workspaceOf(session) || null,
        occurred_at: occurredAt,
        input_tokens: inputTokens,
        cache_read_tokens: cacheReadTokens,
        output_tokens: outputTokens,
        client_cost_cny: computed.cost_cny,
        source: 'live',
      }
      this.onEvent(ev)
      return ev
    } catch (err) {
      this.log(`采集异常（已忽略）: ${String((err && err.message) || err)}`)
      return null
    }
  }
}

// ─────────────────────────── HTTP 客户端 ───────────────────────────
async function httpJson(url, { method = 'GET', token, body, fetchImpl = fetch } = {}) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (err) {
    return { ok: false, network: true, error: `无法连接团队服务器：${String((err && err.message) || err)}` }
  }
  let json = null
  try { json = await res.json() } catch (err) { json = null }
  if (!res.ok || !json || json.ok === false) {
    const e = json && json.error ? json.error : {}
    return { ok: false, status: res.status, code: e.code || `HTTP_${res.status}`, error: e.message || `服务端返回 ${res.status}`, details: e.details }
  }
  return { ok: true, status: res.status, data: json.data }
}

// ─────────────────────────── 上报器主对象 ───────────────────────────
export class TeamReporter {
  /**
   * @param {object} deps
   * @param {(keyRef:string)=>Promise<{value:string}|null>} deps.resolveCredential
   * @param {(keyRef:string,value:string)=>Promise<void>} [deps.setCredential]
   * @param {()=>string|null} [deps.workspaceOf]
   * @param {(msg:string)=>void} [deps.log]
   * @param {typeof fetch} [deps.fetchImpl]
   */
  constructor(deps = {}) {
    this.resolveCredential = deps.resolveCredential || (async () => null)
    this.setCredential = deps.setCredential || null
    this.log = deps.log || (() => {})
    this.fetchImpl = deps.fetchImpl || fetch

    this.state = readState()
    this.queue = new EventQueue(QUEUE_FILE)
    this.token = null            // 内存缓存；持久化在 DSH 凭据库
    this.priceTable = new ReporterPriceTable(this.state.pricing || null)
    this.collector = new UsageCollector({
      priceTable: this.priceTable,
      workspaceOf: deps.workspaceOf,
      onEvent: (ev) => this.enqueue(ev),
      log: this.log,
    })

    this.stats = {
      collected: 0, uploaded: 0, duplicated: 0, rejected: 0,
      dropped_stale: 0, dropped_overflow: 0,
      last_flush_at: null, last_error: null, last_ok_at: null,
      consecutive_failures: 0,
      identity: null, config: null,
    }
    this.flushing = false
  }

  get serverUrl() { return String(this.state.server_url || '').replace(/\/+$/, '') }
  /**
   * 「已绑定」= 有令牌（真正的凭据）**且**地址已配置。
   * 不只看 state.enrollment：名片文件可能被删/不可写，而令牌还在凭据库里；
   * 那种情况下上报其实仍然可用（canReport），但这属于异常状态，
   * 面板必须显示「未绑定」而不是给出已经连上的错觉。
   */
  get enrolled() { return !!this.token && !!this.serverUrl }
  /**
   * 「能不能上报」只看地址与令牌，**不看** state.enrollment。
   * 【为什么】state.enrollment 只是给人看的名片（员工姓名、enrollment_id）；
   * 真正的凭据在 DSH 凭据库里。若把上报条件绑在名片上，任何丢失名片的路径
   * （老版本升级、状态文件被删、状态文件不可写）都会让令牌明明有效却停止上报 —— 静默丢账。
   */
  get canReport() { return !!this.serverUrl && !!this.token }
  get queueDepth() { return this.queue.depth }

  status() {
    return {
      reporter_version: REPORTER_VERSION,
      server_url: this.serverUrl,
      enrolled: this.enrolled,
      has_token: !!this.token,
      token_key_ref: TOKEN_KEY_REF,
      identity: this.stats.identity,
      enrollment: this.state.enrollment
        ? { enrollment_id: this.state.enrollment.enrollment_id, employee: this.state.enrollment.employee, enrolled_at: this.state.enrollment.enrolled_at }
        : null,
      queue_depth: this.queueDepth,
      stats: { ...this.stats },
      price_version: this.priceTable.version,
      state_file: STATE_FILE,
      queue_file: QUEUE_FILE,
      server_reachable: !!this.stats.last_ok_at,
    }
  }

  // ── 令牌 ────────────────────────────────────────────────────
  async loadToken() {
    try {
      const cred = await this.resolveCredential(TOKEN_KEY_REF)
      this.token = cred && cred.value ? String(cred.value) : null
    } catch (err) {
      this.token = null
      this.log(`读取机器令牌失败：${String((err && err.message) || err)}`)
    }
    return this.token
  }

  async saveToken(token) {
    this.token = token
    if (this.setCredential) {
      await this.setCredential(TOKEN_KEY_REF, token)
      return true
    }
    return false
  }

  // ── 配置 ────────────────────────────────────────────────────
  applyConfig(cfg) {
    this.stats.config = cfg
    if (cfg && cfg.pricing) {
      this.priceTable = new ReporterPriceTable(cfg.pricing)
      this.collector.priceTable = this.priceTable
      this.state.pricing = cfg.pricing
      writeState(this.state)
    }
    // 通知宿主：配置换了。宿主用它重建冲刷定时器 ——
    // 否则服务端的 report_interval_sec 只是个"转了没用的旋钮"。
    // 回调抛错绝不能影响配置应用本身（配置已经生效了）。
    if (typeof this.onConfigApplied === 'function') {
      try { this.onConfigApplied(cfg) } catch { /* 宿主自己的事，不影响配置生效 */ }
    }
  }

  setServerUrl(url) {
    const clean = String(url || '').trim().replace(/\/+$/, '')
    if (clean && !/^https?:\/\//i.test(clean)) throw new Error('服务器地址必须以 http:// 或 https:// 开头')
    this.state.server_url = clean
    writeState(this.state)
    return clean
  }

  /** enroll：用一次性邀请码换取机器令牌。令牌只在这里写一次凭据库。 */
  async enroll({ serverUrl, code, hostname, platform }) {
    if (serverUrl !== undefined) this.setServerUrl(serverUrl)
    if (!this.serverUrl) throw new Error('请先填写团队服务器地址')
    const out = await httpJson(`${this.serverUrl}/api/v1/enroll`, {
      method: 'POST',
      body: {
        code: String(code || '').trim(),
        hostname: hostname || os.hostname(),
        platform: platform || `${process.platform}-${process.arch}`,
        reporter_version: REPORTER_VERSION,
      },
      fetchImpl: this.fetchImpl,
    })
    if (!out.ok) {
      const err = new Error(out.error || '邀请码兑换失败')
      err.code = out.code
      throw err
    }
    const data = out.data || {}
    await this.saveToken(data.machine_token)
    this.state.enrollment = {
      enrollment_id: data.enrollment_id,
      employee: data.employee,
      account_group: data.account_group,
      enrolled_at: nowMs(),
    }
    writeState(this.state)
    this.stats.identity = data.employee ? { ...data.employee, enrollment_id: data.enrollment_id } : null
    // 立刻拉一次配置（含服务端价目表），保证本地计价与服务端同源
    try { await this.fetchConfig() } catch (err) { /* 下次心跳会重试 */ }
    return this.state.enrollment
  }

  async unenroll() {
    this.state.enrollment = null
    this.state.server_url = this.state.server_url || ''
    writeState(this.state)
    this.token = null
    this.stats.identity = null
    return true
  }

  // ── 与团队服务器交互 ─────────────────────────────────────────
  async probe() {
    if (!this.serverUrl) throw new Error('请先填写团队服务器地址')
    const out = await httpJson(`${this.serverUrl}/api/v1/me`, { token: this.token, fetchImpl: this.fetchImpl })
    if (!out.ok) { const e = new Error(out.error || '连接失败'); e.code = out.code; throw e }
    this.stats.identity = out.data
    return out.data
  }

  async fetchConfig() {
    if (!this.serverUrl || !this.token) return null
    const out = await httpJson(`${this.serverUrl}/api/v1/config`, { token: this.token, fetchImpl: this.fetchImpl })
    if (!out.ok) return null
    this.applyConfig(out.data)
    return out.data
  }

  async heartbeat() {
    if (!this.serverUrl || !this.token) return null
    const out = await httpJson(`${this.serverUrl}/api/v1/heartbeat`, {
      method: 'POST',
      token: this.token,
      body: { reporter_version: REPORTER_VERSION, client_time: nowMs(), dsh_version: process.env.DSH_CLIENT_VERSION || null },
      fetchImpl: this.fetchImpl,
    })
    return out.ok ? out.data : null
  }

  async reportBalance(remaining, { currency = 'CNY', source = 'api', observedAt } = {}) {
    if (!this.serverUrl || !this.token) return null
    const out = await httpJson(`${this.serverUrl}/api/v1/ingest/balance`, {
      method: 'POST',
      token: this.token,
      body: { currency, remaining, observed_at: observedAt || nowMs(), source },
      fetchImpl: this.fetchImpl,
    })
    return out.ok ? out.data : null
  }

  // ── 队列与上报 ───────────────────────────────────────────────
  enqueue(ev) {
    if (!ev) return
    const age = nowMs() - ev.occurred_at
    if (age > BACKFILL_LIMIT_MS) { this.stats.dropped_stale += 1; return }
    const dropped = this.queue.push(ev)
    if (dropped) this.stats.dropped_overflow += dropped
    this.stats.collected += 1
  }

  /**
   * 冲刷队列。语义：
   *  - 按 acceptance 移除：服务端 accepted 或 duplicated 的一律从队列删除（幂等成功）；
   *  - 被拒（rejected）的：CLOCK_SKEW 丢弃（永远不可能成功），其余也丢弃并计数，
   *    因为无限重试一条格式错误的事件会把后面的好数据永远堵住（毒丸）。
   *  - 网络失败：**整批保留**，退避后重试。
   */
  async flush() {
    if (this.flushing) return { skipped: true, reason: 'already_flushing' }
    if (!this.canReport) return { skipped: true, reason: this.token ? 'no_server_url' : 'no_token' }
    if (this.queue.depth === 0) return { skipped: true, reason: 'empty' }
    this.flushing = true
    try {
      const batch = this.queue.items.slice(0, MAX_BATCH_EVENTS)
      const out = await httpJson(`${this.serverUrl}/api/v1/ingest/usage`, {
        method: 'POST',
        token: this.token,
        body: { reporter_version: REPORTER_VERSION, batch_id: `b${nowMs().toString(36)}`, events: batch },
        fetchImpl: this.fetchImpl,
      })
      this.stats.last_flush_at = nowMs()
      if (!out.ok) {
        this.stats.last_error = { at: nowMs(), code: out.code, message: out.error }
        this.stats.consecutive_failures += 1
        // 令牌失效（被吊销/员工停用）：保留队列但明确暴露，等管理员重新 enroll
        if (out.code === 'INVALID_TOKEN' || out.code === 'UNAUTHENTICATED') {
          this.stats.last_error.fatal = true
        }
        return { ok: false, code: out.code, error: out.error, kept: batch.length }
      }
      const data = out.data || {}
      const done = [].concat(data.accepted_ids || [], data.duplicate_ids || [])
      this.queue.remove(done)
      this.stats.uploaded += Number(data.accepted || 0)
      this.stats.duplicated += Number(data.duplicated || 0)
      this.stats.rejected += Number(data.rejected || 0)
      // 被拒的事件不会出现在 accepted_ids / duplicate_ids 里 → 必须显式清掉，否则毒丸堵队列
      const rejectedIds = (data.rejected_details || []).map((r) => (batch[r.index] ? batch[r.index].id : null)).filter(Boolean)
      if (rejectedIds.length) this.queue.remove(rejectedIds)
      this.stats.consecutive_failures = 0
      this.stats.last_ok_at = nowMs()
      this.stats.last_error = null
      return { ok: true, ...data }
    } finally {
      this.flushing = false
    }
  }

  tick() {
    return this.flush()
  }
}
