// skillsync.mjs — 公司技能下发（服务器权威）＋ 员工本地技能的收集与提交
//
// 目录约定（这条是硬边界，改动前先想清楚）：
//   ~/.dsh/skills/dsh-team/    ← 服务器下发。插件每次同步**整体替换**，员工不要在这里改东西。
//   ~/.dsh/skills/my-skills/   ← 员工自己写的。同步逻辑**永远不碰**它，只读取用于提交。
//
// 为什么必须分两个目录：DSH 的技能目录是热加载的，同步要么写一半被加载（技能加载到残缺正文），
// 要么把员工自己写的技能一起删掉。分开之后，"替换"只发生在我们自己那个目录里。
//
// 原子替换为什么是「暂存目录 + 两次 rename」而不是「删掉再写」：后者中间有一段时间目录不存在，
// 热加载可能正好扫到空目录，把公司技能**从会话里弄没**；前者只在两次 rename 之间有一瞬，
// 且任何写盘/校验失败都发生在碰正式目录之前 —— 失败时正式目录**一个字节都没动**。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 服务器下发的技能目录名（`~/.dsh/skills/` 下面一层）。 */
export const REMOTE_DIR_NAME = 'dsh-team'
/** 员工自己写的技能目录名。同步逻辑不碰。 */
export const LOCAL_DIR_NAME = 'my-skills'
/** 暂存目录前缀（写在 `~/.dsh/skills/` 下，与正式目录同级，rename 才是原子的）。 */
export const STAGING_PREFIX = '.dsh-team-staging-'
export const OLD_PREFIX = '.dsh-team-old-'
/** 单个文件上限，与服务器端 MAX_CONTENT_BYTES 一致。 */
export const MAX_FILE_BYTES = 256 * 1024
/** 本地技能最多收集多少个附加文件，与服务器端 MAX_EXTRA_FILES 一致。 */
export const MAX_EXTRA_FILES = 32
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.sh', '.py', '.css', '.html', '.csv'])

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function skillsRoot(dshHome) { return path.join(dshHome, 'skills') }
export function remoteDir(dshHome) { return path.join(skillsRoot(dshHome), REMOTE_DIR_NAME) }
export function localDir(dshHome) { return path.join(skillsRoot(dshHome), LOCAL_DIR_NAME) }

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch (err) { /* 清理失败不该让同步失败 */ }
}

/** 相对路径是否安全（与服务器端 safeRelativePath 同规则：拦绝对路径、`..`、空段）。 */
export function isSafeRelPath(rel) {
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/').trim()
  if (!s || s.length > 200) return false
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false
  const parts = s.split('/')
  for (const p of parts) {
    if (!p || p === '.' || p === '..') return false
    if (p.startsWith('.')) return false          // 隐藏文件不进技能包（.git 之类）
  }
  return true
}

/** 从 frontmatter 里抠 description；抠不到返回空串。 */
export function describeSkill(content) {
  const text = String(content || '')
  if (!text.startsWith('---')) return ''
  const end = text.indexOf('\n---', 3)
  if (end < 0) return ''
  const head = text.slice(3, end)
  const m = head.match(/^\s*description\s*:\s*(.*)$/m)
  if (!m) return ''
  let v = m[1].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  return v.trim()
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * 读一个技能目录下的所有文本文件，SKILL.md 永远排第一。
 * 返回 `{ ok, files:[{path, content}], error }`。
 */
export function readSkillFiles(skillDir) {
  const out = []
  const walk = (dir, prefix) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(abs, rel); continue }
      if (!ent.isFile()) continue                                  // 符号链接一律不收
      if (!isSafeRelPath(rel)) continue
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue
      let buf
      try { buf = fs.readFileSync(abs) } catch (err) { continue }
      if (buf.length > MAX_FILE_BYTES) continue
      if (looksBinary(buf)) continue
      out.push({ path: rel, content: buf.toString('utf8') })
    }
  }
  walk(skillDir, '')
  if (!out.some((f) => f.path === 'SKILL.md')) return { ok: false, files: [], error: '目录里没有 SKILL.md' }
  out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))
  const skills = out.filter((f) => f.path === 'SKILL.md').length
  if (skills > 1) return { ok: false, files: [], error: '一个技能目录里只能有一个 SKILL.md' }
  return { ok: true, files: out, error: null }
}

/**
 * 列出员工本地技能（`~/.dsh/skills/my-skills/<名>/`）。
 * 目录名不合语法、没有 SKILL.md、或超量的都会被跳过并在 `skipped` 里说明原因 —— 静默丢弃是最坏的选择。
 */
export function listLocalSkills(dshHome) {
  const dir = localDir(dshHome)
  const skills = []
  const skipped = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return { dir, skills, skipped } }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    if (!SKILL_NAME_RE.test(ent.name)) { skipped.push({ name: ent.name, reason: '目录名不合语法：只能小写字母、数字、连字符' }); continue }
    const read = readSkillFiles(path.join(dir, ent.name))
    if (!read.ok) { skipped.push({ name: ent.name, reason: read.error }); continue }
    const extras = read.files.filter((f) => f.path !== 'SKILL.md')
    if (extras.length > MAX_EXTRA_FILES) { skipped.push({ name: ent.name, reason: `附加文件 ${extras.length} 个，超过上限 ${MAX_EXTRA_FILES}` }); continue }
    let st = null
    try { st = fs.statSync(path.join(dir, ent.name)) } catch (err) {}
    const skillMd = read.files.find((f) => f.path === 'SKILL.md') || { content: '' }
    skills.push({
      name: ent.name,
      description: describeSkill(skillMd.content),
      bytes: read.files.reduce((s, f) => s + Buffer.byteLength(f.content, 'utf8'), 0),
      file_count: read.files.length,
      updated_at: st ? Math.round(st.mtimeMs) : null,
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { dir, skills, skipped }
}

/** 把本地技能整理成提交给服务端的载荷。 */
export function buildSubmission(dshHome, name) {
  if (!SKILL_NAME_RE.test(String(name || ''))) return { ok: false, error: '技能名不合语法：只能小写字母、数字、连字符' }
  const read = readSkillFiles(path.join(localDir(dshHome), String(name)))
  if (!read.ok) return { ok: false, error: read.error }
  const skillMd = read.files.find((f) => f.path === 'SKILL.md')
  const files = read.files.filter((f) => f.path !== 'SKILL.md')
  if (files.length > MAX_EXTRA_FILES) return { ok: false, error: `附加文件 ${files.length} 个，超过上限 ${MAX_EXTRA_FILES}` }
  return { ok: true, name: String(name), content: skillMd.content, files }
}

/** 校验服务器下发的技能包。宁可不装，也不装半截。 */
export function validatePack(pack) {
  if (!pack || typeof pack !== 'object') return { ok: false, error: '技能包不是对象' }
  if (pack.unchanged === true) return { ok: true, unchanged: true, skills: [] }
  if (typeof pack.version !== 'string' || !pack.version) return { ok: false, error: '技能包缺少 version' }
  if (!Array.isArray(pack.skills)) return { ok: false, error: '技能包缺少 skills 数组' }
  const seen = new Set()
  const skills = []
  for (const s of pack.skills) {
    if (!s || typeof s !== 'object') return { ok: false, error: '技能条目不是对象' }
    if (!SKILL_NAME_RE.test(String(s.name || ''))) return { ok: false, error: `技能名不合法：${s.name}` }
    if (seen.has(s.name)) return { ok: false, error: `技能名重复：${s.name}` }
    seen.add(s.name)
    if (!Array.isArray(s.files) || !s.files.length) return { ok: false, error: `技能 ${s.name} 没有文件` }
    for (const f of s.files) {
      if (!f || typeof f !== 'object') return { ok: false, error: `技能 ${s.name} 的文件条目不是对象` }
      if (!isSafeRelPath(f.path)) return { ok: false, error: `技能 ${s.name} 的文件路径不安全：${f.path}` }
      if (typeof f.content !== 'string') return { ok: false, error: `技能 ${s.name}/${f.path} 缺少正文` }
      if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) return { ok: false, error: `技能 ${s.name}/${f.path} 超过单文件上限` }
    }
    if (!s.files.some((f) => f.path === 'SKILL.md')) return { ok: false, error: `技能 ${s.name} 缺少 SKILL.md` }
    skills.push(s)
  }
  return { ok: true, unchanged: false, version: pack.version, skills }
}

/**
 * 应用技能包：全部写进暂存目录 → 校验 → 两次 rename 原子换。
 * 返回 `{ ok, version, count, bytes, dir, error }`；失败时正式目录原样未动。
 */
export function applyPack(dshHome, pack) {
  const v = validatePack(pack)
  if (!v.ok) return { ok: false, error: v.error }
  if (v.unchanged) return { ok: true, unchanged: true, version: pack.version, count: 0, bytes: 0, dir: remoteDir(dshHome) }

  const root = skillsRoot(dshHome)
  const target = remoteDir(dshHome)
  const stamp = crypto.randomBytes(6).toString('hex')
  const staging = path.join(root, STAGING_PREFIX + stamp)
  const stash = path.join(root, OLD_PREFIX + stamp)
  let bytes = 0
  try {
    fs.mkdirSync(root, { recursive: true })
    rmrf(staging)
    for (const skill of v.skills) {
      const skillDir = path.join(staging, skill.name)
      fs.mkdirSync(skillDir, { recursive: true })
      for (const f of skill.files) {
        const buf = Buffer.from(f.content, 'utf8')
        if (f.sha256 && sha256(f.content) !== f.sha256) throw new Error(`sha256 校验不过：${skill.name}/${f.path}`)
        const dest = path.join(skillDir, ...f.path.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, buf)
        bytes += buf.length
      }
    }
  } catch (err) {
    rmrf(staging)
    return { ok: false, error: String((err && err.message) || err) }
  }

  // 走到这里，暂存目录已经是一份完整、校验过的技能树；下面两次 rename 才是"切换"。
  const had = fs.existsSync(target)
  try {
    if (had) fs.renameSync(target, stash)
    try {
      fs.renameSync(staging, target)
    } catch (err) {
      if (had) { try { fs.renameSync(stash, target) } catch (e2) {} }   // 换不上去就把旧的换回来
      throw err
    }
  } catch (err) {
    rmrf(staging)
    return { ok: false, error: String((err && err.message) || err) }
  }
  if (had) rmrf(stash)
  return { ok: true, unchanged: false, version: v.version, count: v.skills.length, bytes, dir: target }
}

/** 清掉上次崩溃留下的暂存/旧目录。只在同步成功后调用，免得误删正在用的东西。 */
export function cleanupTemp(dshHome) {
  const root = skillsRoot(dshHome)
  let removed = 0
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (err) { return { removed } }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith(STAGING_PREFIX) || ent.name.startsWith(OLD_PREFIX)) { rmrf(path.join(root, ent.name)); removed++ }
  }
  return { removed }
}

/** 读当前已装下发的技能清单（不读正文，给面板用）。 */
export function listInstalled(dshHome) {
  const dir = remoteDir(dshHome)
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return { dir, skills: out } }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const skillMd = path.join(dir, ent.name, 'SKILL.md')
    let content = ''
    try { content = fs.readFileSync(skillMd, 'utf8') } catch (err) { continue }
    out.push({ name: ent.name, description: describeSkill(content) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return { dir, skills: out }
}
