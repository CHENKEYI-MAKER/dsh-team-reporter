// ui.js — 员工端面板（右下角浮动徽标 + 展开面板）。宿主以 <script src="/dsh-team/ui.js"> 加载。
//
// 约定：不使用任何构建步骤、不依赖框架、不改动宿主 DOM 结构（只 append 一个容器）。
// 所有文本都用 textContent 写入，绝不把服务端返回的字符串拼进 innerHTML（防 XSS）。
;(function () {
  'use strict'
  if (window.__DSH_TEAM_UI__) return
  window.__DSH_TEAM_UI__ = true

  var BASE = '/dsh-team/api/'
  var open = false
  var busy = false
  var lastStatus = null

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = String(text)
    return n
  }

  async function api(path, body) {
    var res = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    })
    var json = null
    try { json = await res.json() } catch (e) { json = null }
    if (!json || json.ok === false) {
      var msg = (json && json.error && json.error.message) || ('请求失败 HTTP ' + res.status)
      var err = new Error(msg)
      err.code = json && json.error && json.error.code
      throw err
    }
    return json.data
  }

  function fmtTime(ts) {
    if (!ts) return '—'
    try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) } catch (e) { return '—' }
  }

  function laneColor(s) {
    if (!s || !s.enrolled) return '#8b93a7'
    if (s.stats && s.stats.last_error) return '#ff6161'
    if (s.stats && s.stats.last_ok_at) return '#38d39f'
    return '#f3b13a'
  }

  // 构建一次 DOM，之后只更新文本/样式（避免每次刷新重建节点导致面板闪烁）
  var root, badge, dot, badgeText, panel, rows, form, msg
  var skillHead, skillList, skillLocalHead, skillLocalList
  var rowRefs = {}

  function build() {
    root = el('div', 'dsh-team-root')
    root.setAttribute('data-dsh-team', '1')

    badge = el('button', 'dsh-team-badge')
    badge.type = 'button'
    dot = el('span', 'dsh-team-dot')
    badgeText = el('span', null, '团队上报')
    badge.appendChild(dot)
    badge.appendChild(badgeText)
    badge.addEventListener('click', function () { open = !open; render(); if (open) { refresh(); refreshSkills() } })

    panel = el('div', 'dsh-team-panel')
    panel.style.display = 'none'

    var head = el('div', 'dsh-team-head')
    head.appendChild(el('strong', null, 'DSH 团队版 · 员工端上报'))
    var close = el('button', 'dsh-team-close', '×')
    close.type = 'button'
    close.addEventListener('click', function () { open = false; render() })
    head.appendChild(close)
    panel.appendChild(head)

    panel.appendChild(el('p', 'dsh-team-note',
      '本面板只做一件事：把本机的 token 用量上报给团队服务器，供管理员查看用量与成本。这是用量可见性工具，不是财务审计。'))

    rows = el('div', 'dsh-team-rows')
    var defs = [
      ['state', '连接状态'],
      ['server', '服务器'],
      ['employee', '身份'],
      ['queue', '待上报队列'],
      ['uploaded', '已上报 / 重复'],
      ['rejected', '被拒 / 丢弃'],
      ['lastok', '最近成功'],
      ['error', '最近错误'],
    ]
    for (var i = 0; i < defs.length; i++) {
      var r = el('div', 'dsh-team-row')
      r.appendChild(el('span', 'dsh-team-k', defs[i][1]))
      var v = el('span', 'dsh-team-v', '—')
      rowRefs[defs[i][0]] = v
      r.appendChild(v)
      rows.appendChild(r)
    }
    panel.appendChild(rows)

    form = el('div', 'dsh-team-form')
    var lbl1 = el('label', null, '团队服务器地址')
    var in1 = el('input')
    in1.type = 'text'
    in1.placeholder = 'http://192.168.1.10:8787'
    in1.id = 'dsh-team-url'
    lbl1.appendChild(in1)
    form.appendChild(lbl1)

    var lbl2 = el('label', null, '邀请码（管理员在控制台生成）')
    var in2 = el('input')
    in2.type = 'text'
    in2.placeholder = 'DSH-XXXX-XXXX'
    in2.id = 'dsh-team-code'
    lbl2.appendChild(in2)
    form.appendChild(lbl2)

    var btns = el('div', 'dsh-team-btns')
    var bEnroll = el('button', 'primary', '绑定')
    bEnroll.type = 'button'
    bEnroll.addEventListener('click', function () { act('enroll') })
    var bTest = el('button', null, '测试连接')
    bTest.type = 'button'
    bTest.addEventListener('click', function () { act('test') })
    var bFlush = el('button', null, '立即上报')
    bFlush.type = 'button'
    bFlush.addEventListener('click', function () { act('flush') })
    var bOff = el('button', 'danger', '解绑')
    bOff.type = 'button'
    bOff.addEventListener('click', function () { act('unenroll') })
    btns.appendChild(bEnroll); btns.appendChild(bTest); btns.appendChild(bFlush); btns.appendChild(bOff)
    form.appendChild(btns)
    panel.appendChild(form)

    msg = el('div', 'dsh-team-msg', '')
    panel.appendChild(msg)

    // ── 公司技能：上半是「服务器下发的 SOP」，下半是「我自己写的、可提交审核的」 ──
    var sk = el('div', 'dsh-team-skills')
    skillHead = el('div', 'dsh-team-skills-head', '公司技能 · 读取中…')
    sk.appendChild(skillHead)
    skillList = el('div', 'dsh-team-skill-list')
    sk.appendChild(skillList)
    var skBtns = el('div', 'dsh-team-btns')
    var bSync = el('button', null, '同步公司技能')
    bSync.type = 'button'
    bSync.addEventListener('click', function () { act('skills-sync') })
    skBtns.appendChild(bSync)
    sk.appendChild(skBtns)

    skillLocalHead = el('div', 'dsh-team-skills-head', '我写的技能')
    sk.appendChild(skillLocalHead)
    skillLocalList = el('div', 'dsh-team-skill-list')
    sk.appendChild(skillLocalList)
    panel.appendChild(sk)

    root.appendChild(badge)
    root.appendChild(panel)
  }

  /**
   * 渲染技能区。三种状态必须肉眼可分，否则"同步失败"会被当成"公司还没发技能"：
   *   ① 同步正常 → 列出技能名
   *   ② 同步失败 → 红字写清原因，并说明**现有技能没被动过**
   *   ③ 从没同步过 → 灰字提示还没绑定
   */
  function renderSkills(v) {
    if (!skillHead || !skillList) return
    var st = (v && v.state) || null
    var installed = (v && v.installed) || []
    var n = installed.length
    if (st && st.last_error) {
      skillHead.textContent = '公司技能 · 上次同步失败（现有 ' + n + ' 个技能未受影响）'
      skillHead.style.color = '#ff6161'
    } else if (st && st.synced_at) {
      skillHead.textContent = '公司技能 · ' + n + ' 个 · 更新于 ' + fmtTime(st.synced_at)
      skillHead.style.color = ''
    } else if (st && st.version) {
      skillHead.textContent = '公司技能 · ' + n + ' 个 · 已是最新'
      skillHead.style.color = ''
    } else {
      skillHead.textContent = '公司技能 · 还没同步过（绑定团队后会自动拉取）'
      skillHead.style.color = ''
    }
    skillList.textContent = ''
    if (st && st.last_error) {
      skillList.appendChild(el('div', 'dsh-team-skill-desc', '原因：' + st.last_error))
    }
    if (!n) {
      skillList.appendChild(el('div', 'dsh-team-skill-desc', '服务器上还没有下发技能。'))
    }
    for (var i = 0; i < installed.length; i++) {
      var row = el('div', 'dsh-team-skill')
      row.appendChild(el('div', 'dsh-team-skill-name', installed[i].name))
      if (installed[i].description) row.appendChild(el('div', 'dsh-team-skill-desc', installed[i].description))
      skillList.appendChild(row)
    }

    var local = (v && v.local) || []
    var skipped = (v && v.local_skipped) || []
    skillLocalHead.textContent = '我写的技能 · ' + local.length + ' 个'
    skillLocalList.textContent = ''
    if (!local.length) {
      skillLocalList.appendChild(el('div', 'dsh-team-skill-desc',
        '还没有。让 DSH 把一套流程写成技能，它会放进 ' + ((v && v.local_dir) || '~/.dsh/skills/my-skills/') + '，然后在这里提交。'))
    }
    for (var j = 0; j < local.length; j++) {
      ;(function (item) {
        var row = el('div', 'dsh-team-skill')
        var top = el('div', 'dsh-team-skill-top')
        top.appendChild(el('span', 'dsh-team-skill-name', item.name))
        var b = el('button', 'primary', '提交审核')
        b.type = 'button'
        b.addEventListener('click', function () { submitSkill(item.name) })
        top.appendChild(b)
        row.appendChild(top)
        if (item.description) row.appendChild(el('div', 'dsh-team-skill-desc', item.description))
        skillLocalList.appendChild(row)
      })(local[j])
    }
    // 被跳过的本地技能必须说出来：静默不显示 = 员工以为提交了其实没提交
    for (var k = 0; k < skipped.length; k++) {
      skillLocalList.appendChild(el('div', 'dsh-team-skill-desc',
        '⚠ ' + skipped[k].name + '：' + skipped[k].reason))
    }
  }

  async function refreshSkills() {
    try {
      var v = await api('skills')
      renderSkills(v)
    } catch (err) {
      if (skillHead) { skillHead.textContent = '技能状态读取失败：' + err.message; skillHead.style.color = '#ff6161' }
    }
  }

  async function submitSkill(name) {
    if (busy) return
    busy = true
    say('正在提交 ' + name + ' …', 'info')
    try {
      var out = await api('skills/submit', { name: name })
      var sub = (out && out.submission) || {}
      if (sub.duplicate) say(name + '：同样的内容已经提交过了，等管理员审核即可。', 'ok')
      else if (sub.valid === false) say(name + ' 已提交，但敏感信息扫描没过（' + ((sub.problems || []).length) + ' 项），管理员看不到通过按钮。请先改掉再提交。', 'bad')
      else say(name + ' 已提交，等管理员审核通过后会下发给全员。', 'ok')
      renderSkills(out && out.skills)
    } catch (err) {
      say('提交失败：' + err.message, 'bad')
    } finally {
      busy = false
    }
  }

  function render() {
    if (!root) return
    panel.style.display = open ? 'block' : 'none'
    var c = laneColor(lastStatus)
    dot.style.background = c
    if (lastStatus) {
      if (!lastStatus.enrolled) badgeText.textContent = '未绑定团队'
      else if (lastStatus.stats && lastStatus.stats.last_error) badgeText.textContent = '上报异常'
      else badgeText.textContent = '已连接 · 待发 ' + lastStatus.queue_depth
    }
  }

  function paint(s) {
    lastStatus = s
    var refs = rowRefs
    refs.state.textContent = !s.enrolled
      ? '未绑定（请在下方用邀请码绑定）'
      : (s.stats && s.stats.last_error ? '已绑定但上报失败' : '已绑定，正常')
    refs.server.textContent = s.server_url || '—'
    refs.employee.textContent = s.identity && s.identity.employee
      ? (s.identity.employee.name + '（' + (s.identity.employee.department || '未分组') + '）')
      : (s.enrollment && s.enrollment.employee ? s.enrollment.employee.name : '—')
    refs.queue.textContent = String(s.queue_depth)
    refs.uploaded.textContent = s.stats.uploaded + ' / ' + s.stats.duplicated
    refs.rejected.textContent = s.stats.rejected + ' / ' + (s.stats.dropped_stale + s.stats.dropped_overflow)
    refs.lastok.textContent = fmtTime(s.stats.last_ok_at)
    refs.error.textContent = s.stats.last_error
      ? (s.stats.last_error.code || '') + ' ' + (s.stats.last_error.message || '')
      : '无'
    var urlInput = document.getElementById('dsh-team-url')
    if (urlInput && !urlInput.value && s.server_url) urlInput.value = s.server_url
    render()
  }

  async function refresh() {
    try {
      var s = await api('status')
      paint(s)
    } catch (err) {
      if (msg) msg.textContent = '读取状态失败：' + err.message
    }
  }

  function say(text, kind) {
    if (!msg) return
    msg.textContent = text
    msg.style.color = kind === 'bad' ? '#ff6161' : (kind === 'ok' ? '#38d39f' : '#8b93a7')
  }

  async function act(kind) {
    if (busy) return
    busy = true
    var urlInput = document.getElementById('dsh-team-url')
    var codeInput = document.getElementById('dsh-team-code')
    try {
      if (kind === 'enroll') {
        var url = urlInput ? urlInput.value.trim() : ''
        var code = codeInput ? codeInput.value.trim() : ''
        if (!url) throw new Error('请填写团队服务器地址')
        if (!code) throw new Error('请填写邀请码')
        say('正在绑定…')
        var out = await api('enroll', { server_url: url, code: code })
        paint(out.status)
        if (codeInput) codeInput.value = ''
        say('绑定成功，已开始上报', 'ok')
      } else if (kind === 'test') {
        var url2 = urlInput ? urlInput.value.trim() : ''
        if (url2 && (!lastStatus || url2 !== lastStatus.server_url)) {
          await api('config', { server_url: url2 })
        }
        say('正在测试…')
        var out2 = await api('test')
        paint(out2.status)
        say(out2.identity && out2.identity.employee
          ? ('连接正常，服务端识别为：' + out2.identity.employee.name)
          : '连接正常', 'ok')
      } else if (kind === 'flush') {
        say('正在上报…')
        var out3 = await api('flush')
        paint(out3.status)
        var r = out3.result || {}
        say(r.skipped ? ('未上报：' + r.reason) : ('已上报，队列剩余 ' + out3.status.queue_depth), r.ok === false ? 'bad' : 'ok')
      } else if (kind === 'unenroll') {
        if (!window.confirm('解绑后将停止上报本机用量，确定吗？')) return
        var out4 = await api('unenroll')
        paint(out4.status)
        say('已解绑', 'ok')
      } else if (kind === 'skills-sync') {
        say('正在同步公司技能…')
        var out5 = await api('skills/sync', {})
        renderSkills(out5.skills)
        var res = out5.result || {}
        say(res.ok
          ? (res.unchanged ? '已是最新，无需更新' : ('已更新 ' + res.count + ' 个技能'))
          : ('同步失败：' + (res.error || '未知原因') + '（本机现有技能未受影响）'), res.ok ? 'ok' : 'bad')
      }
    } catch (err) {
      say(err.message || String(err), 'bad')
    } finally {
      busy = false
    }
  }

  function mount() {
    build()
    document.body.appendChild(root)
    render()
    refresh()
    refreshSkills()
    setInterval(refresh, 20000)
  }

  var css = document.createElement('style')
  css.textContent = [
    '.dsh-team-root{position:fixed;right:14px;bottom:14px;z-index:2147483000;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#e6ecf7}',
    '.dsh-team-badge{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid #2b3a55;background:#16223a;color:#e6ecf7;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)}',
    '.dsh-team-badge:hover{border-color:#4f8cff}',
    '.dsh-team-dot{width:8px;height:8px;border-radius:50%;background:#8b93a7;display:inline-block}',
    '.dsh-team-panel{position:absolute;right:0;bottom:36px;width:340px;max-height:74vh;overflow:auto;padding:12px;border-radius:12px;border:1px solid #2b3a55;background:#101a2e;box-shadow:0 14px 40px rgba(0,0,0,.5)}',
    '.dsh-team-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}',
    '.dsh-team-close{border:0;background:transparent;color:#8b93a7;font-size:16px;cursor:pointer}',
    '.dsh-team-note{margin:0 0 10px;color:#8b93a7}',
    '.dsh-team-rows{border-top:1px solid #22314c;border-bottom:1px solid #22314c;padding:6px 0;margin-bottom:10px}',
    '.dsh-team-row{display:flex;justify-content:space-between;gap:10px;padding:2px 0}',
    '.dsh-team-k{color:#8b93a7;flex:0 0 84px}',
    '.dsh-team-v{flex:1;text-align:right;word-break:break-all}',
    '.dsh-team-form label{display:block;margin:8px 0 2px;color:#8b93a7}',
    '.dsh-team-form input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid #2b3a55;background:#0b1220;color:#e6ecf7}',
    '.dsh-team-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}',
    '.dsh-team-btns button{padding:5px 10px;border-radius:8px;border:1px solid #2b3a55;background:#16223a;color:#e6ecf7;cursor:pointer}',
    '.dsh-team-btns button.primary{background:#4f8cff;border-color:#4f8cff;color:#04101f}',
    '.dsh-team-btns button.danger{border-color:#5a2b2b;color:#ffb1b1}',
    '.dsh-team-msg{margin-top:8px;min-height:16px;word-break:break-all}',
    '.dsh-team-skills{margin-top:12px;border-top:1px solid #22314c;padding-top:8px}',
    '.dsh-team-skills-head{color:#8b93a7;margin:6px 0 4px}',
    '.dsh-team-skill-list{display:flex;flex-direction:column;gap:6px}',
    '.dsh-team-skill{border:1px solid #22314c;border-radius:8px;padding:6px 8px;background:#0b1220}',
    '.dsh-team-skill-top{display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '.dsh-team-skill-name{font-weight:600}',
    '.dsh-team-skill-desc{color:#8b93a7;margin-top:2px;word-break:break-word}',
    '.dsh-team-skill button{padding:3px 8px;border-radius:8px;border:1px solid #2b3a55;background:#16223a;color:#e6ecf7;cursor:pointer}',
    '.dsh-team-skill button.primary{background:#4f8cff;border-color:#4f8cff;color:#04101f}',
  ].join('')
  document.head.appendChild(css)

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
