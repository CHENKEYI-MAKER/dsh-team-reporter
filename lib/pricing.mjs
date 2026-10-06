// pricing.mjs — 员工端计价与峰谷判定。
//
// ⚠️ 为什么要在这里**重复一份**服务端 packages/server/src/lib/pricing.js 的逻辑？
//   员工机器上通常只安装本插件（`dsh plugin add link:<reporter 目录>`），
//   跨包 import `../../server/src/lib/pricing.js` 在 link 安装后路径不稳、也把服务端代码拖进员工机器。
//   因此这里刻意保留一份独立实现，并遵守两条纪律：
//     ① 单价与峰谷规则**必须与服务端逐字一致** —— 由 tools/scripts/check-reporter-parity.mjs 自动校验；
//     ② 改动服务端价目表时**必须同步改这里**，否则 A/A′ 口径会漂移（对账页会报警）。
//
// 口径铁律：total_tokens = input + cache_read + output。
// DSH 保证 reasoningTokens ⊆ outputTokens，**绝不能把 reasoning 再单独加一次**。

// 峰谷定价的两个生效分界（与服务端/whale-widget 逐字一致）
export const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // 北京 2026-08-23 00:00
export const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // 北京 2026-09-19 00:00

const PEAK_WINDOWS_DEFAULT = [[540, 720], [840, 1080]] // 分钟：09:00–12:00、14:00–18:00

// ⚠️ 与服务端 BUILTIN_CALENDAR 保持同步。2027 年尚未由国务院公布，标 (估)。
export const FALLBACK_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  // 2027（估计值）
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12',
  '2027-04-04', '2027-04-05', '2027-04-06',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09', '2027-06-10', '2027-06-11',
  '2027-09-15', '2027-09-16', '2027-09-17',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
])

export const FALLBACK_RATES = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] },
}
export const FALLBACK_MODEL = 'deepseek-flash'

const pad = (n) => String(n).padStart(2, '0')

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** 把服务端下发的 calendar 展开成 Set<day>；客户端只认这个，不自行推算节假日。 */
export function expandHolidays(calendar) {
  const set = new Set(FALLBACK_HOLIDAYS)
  const table = calendar?.holidays
  if (table && typeof table === 'object') {
    set.clear()
    for (const ranges of Object.values(table)) {
      if (!Array.isArray(ranges)) continue
      for (const entry of ranges) {
        if (Array.isArray(entry)) {
          const [start, end] = entry
          for (let d = start; d && end && d <= end; d = addDays(d, 1)) set.add(d)
        } else if (typeof entry === 'string') {
          set.add(entry)
        }
      }
    }
    for (const d of calendar?.extraHolidays || []) set.add(d)
  }
  return set
}

/**
 * 员工端价格表。
 * 典型用法：先用服务端 `/api/v1/config` 下发的 pricing 构造，服务端不可达时退回内置常量。
 */
export class ReporterPriceTable {
  constructor(pricing) {
    const p = pricing && typeof pricing === 'object' ? pricing : {}
    this.pricing = {
      version: p.version || 'builtin',
      calendar: p.calendar || null,
      peakWindows: Array.isArray(p.peakWindows) && p.peakWindows.length ? p.peakWindows : PEAK_WINDOWS_DEFAULT,
      models: Array.isArray(p.models) && p.models.length ? p.models : null,
      fallbackModel: p.fallbackModel || FALLBACK_MODEL,
    }
    this.holidays = expandHolidays(this.pricing.calendar)
    // 模型匹配键：小写子串包含 + **最长键优先**（与服务端一致）
    this.matchKeys = []
    if (this.pricing.models) {
      for (const m of this.pricing.models) {
        for (const k of m.match || [m.id]) this.matchKeys.push({ key: String(k).toLowerCase(), id: m.id })
      }
    } else {
      for (const [id, r] of Object.entries(FALLBACK_RATES)) this.matchKeys.push({ key: id, id })
    }
    this.matchKeys.sort((a, b) => b.key.length - a.key.length)
    this.byId = new Map(this.pricing.models ? this.pricing.models.map((m) => [m.id, m]) : Object.entries(FALLBACK_RATES))
  }

  get version() { return this.pricing.version }

  /** 解析模型名 → { id, rates, known }。未命中回退 fallback（=Flash 价），与服务端一致。 */
  resolve(model) {
    const lower = String(model || '').trim().toLowerCase()
    for (const { key, id } of this.matchKeys) {
      if (key && lower.includes(key)) return { id, rates: this.ratesOf(id), known: true }
    }
    return { id: this.pricing.fallbackModel, rates: this.ratesOf(this.pricing.fallbackModel), known: false }
  }

  ratesOf(id) {
    const m = this.byId.get(id)
    if (!m) return FALLBACK_RATES[FALLBACK_MODEL]
    if (Array.isArray(m.hit)) return { hit: m.hit, miss: m.miss, out: m.out }
    return m
  }

  /**
   * 某时刻是否峰时 —— 与服务端 PriceTable.isPeak / whale-widget isPeakTime 逐条对齐。
   * 注意：它**不** gate 2026-08-17 之前（那时还没有峰谷定价），与服务端/客户端保持一致。
   */
  isPeak(ts) {
    const n = Math.floor(Number(ts) / 1000)
    if (!Number.isFinite(n)) return false
    // 北京时间 = UTC + 8h；用 UTC 存取器读出来就是北京时间的年月日时分
    const bj = new Date(n * 1000 + 8 * 3600 * 1000)
    const dow = bj.getUTCDay()
    if (n >= WEEKEND_VALLEY_FROM_SEC && (dow === 0 || dow === 6)) return false
    const day = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`
    if (n >= HOLIDAY_VALLEY_FROM_SEC && this.holidays.has(day)) return false
    const minute = bj.getUTCHours() * 60 + bj.getUTCMinutes()
    return this.pricing.peakWindows.some(([a, b]) => minute >= a && minute < b)
  }

  /** 计算单事件客户端成本（仅作对账参考；服务端一律重算）。 */
  compute({ model, inputTokens, cacheReadTokens, outputTokens, occurredAt }) {
    const { id, rates, known } = this.resolve(model)
    const peak = this.isPeak(occurredAt)
    const k = peak ? 1 : 0
    const input = Math.max(0, Math.trunc(inputTokens || 0))
    const cacheRead = Math.max(0, Math.trunc(cacheReadTokens || 0))
    const output = Math.max(0, Math.trunc(outputTokens || 0))
    const cost = (cacheRead / 1e6) * rates.hit[k] + (input / 1e6) * rates.miss[k] + (output / 1e6) * rates.out[k]
    return {
      model_id: id,
      known,
      is_peak: peak,
      cost_cny: Math.round(cost * 1e6) / 1e6,
      total_tokens: input + cacheRead + output,
      price_version: this.version,
    }
  }
}
