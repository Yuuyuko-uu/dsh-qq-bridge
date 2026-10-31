// DSH「通到 QQ」· 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「通到 QQ」。1.5.0 起分六个页签：
//   总览 / 绑定 / 消息 / 空间 / 门槛 / 更新
// 绑定是核心：一行 = 一个聊天（私聊 或 群）→ 一间 DSH 会话，各回各的，不串。
//
// ⚠ 这里不碰会话、不发消息，只是往宿主那几条 /dsh-qq-bridge/* 路由上读写。

window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/dsh-qq-bridge'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    const h = React.createElement

    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 190, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 220 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 140,
        boxSizing: 'border-box',
      },
      wide: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      已同步: { margin: '6px 0 10px', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)' },
      未保存: { margin: '6px 0 10px', fontSize: 12, color: '#c0392b', fontWeight: 600 },
      悬浮保存条: {
        position: 'sticky',
        bottom: 0,
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.95))',
        boxShadow: '0 -6px 18px rgba(0,0,0,.18)',
        zIndex: 5,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      tabBar: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 12px' },
      日志行: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap' },
      表头: { display: 'grid', gridTemplateColumns: '70px 130px 1fr 56px 64px 40px', gap: 6, alignItems: 'center', marginBottom: 4 },
      表格行: { display: 'grid', gridTemplateColumns: '70px 130px 1fr 56px 64px 40px', gap: 6, alignItems: 'center', marginBottom: 6 },
      表头字: { fontSize: 11.5, opacity: 0.65 },
      空间表头: { display: 'grid', gridTemplateColumns: '120px 140px 1fr 56px', gap: 6, alignItems: 'center', marginBottom: 4 },
      空间行: { display: 'grid', gridTemplateColumns: '120px 140px 1fr 56px', gap: 6, alignItems: 'center', marginBottom: 6 },
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)
    const 行 = (标签, 控件, 说明) =>
      h('div', { style: S.row }, h('div', { style: S.lab }, 标签), h('div', { style: S.ctl }, 控件, 说明 ? 提示(说明) : null))
    const 按钮 = (文字, onClick, 亮, 关) =>
      h('button', { type: 'button', style: 亮 ? S.btnOn : S.btn, onClick, disabled: !!关, title: 文字 }, 文字)
    const 勾 = (值, onChange) => h('input', { type: 'checkbox', checked: !!值, onChange: (e) => onChange(e.target.checked) })
    const 短id = (id) => {
      const s = String(id)
      return s.length <= 8 ? s : s.slice(-8)
    }

    const 页签们 = ['总览', '绑定', '消息', '空间', '门槛', '更新']

    function Section() {
      const [态, 设态] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')
      const [更新, 设更新] = React.useState(null)
      const [更新忙, 设更新忙] = React.useState(false)
      const [页, 设页] = React.useState('总览')
      const [asr, 设asr] = React.useState(null)
      const [asr忙, 设asr忙] = React.useState(false)
      const [人设行, 设人设行] = React.useState(null) // 哪一行展开了「单独的人设」
      const [人设忙, 设人设忙] = React.useState(false)
      const [人设说, 设人设说] = React.useState('')

      React.useEffect(() => {
        拉()
        get('/update').then((r) => r && 设更新(r)).catch(() => {})
        get('/asr-status').then((r) => r && 设asr(r)).catch(() => {})
      }, [])
      // 装依赖的时候每 2 秒看一眼进度（装完就停）
      React.useEffect(() => {
        if (!asr || !asr.进行中) return undefined
        const t = setInterval(() => {
          get('/asr-status').then((r) => { if (r) 设asr(r) }).catch(() => {})
        }, 2000)
        return () => clearInterval(t)
      }, [asr && asr.进行中])

      const 拉 = async () => {
        const s = await get('/state')
        if (s) 设态(s)
      }
      // ⭐ 1.1.2：人设「现在就生效」—— 不用等 QQ 那边来一条消息
      const 人设现在生效 = async () => {
        设人设忙(true)
        设人设说('')
        const r = await post('/persona-apply', {})
        设人设忙(false)
        if (!r || !r.ok) {
          设人设说('✗ ' + ((r && r.说) || '没反应'))
          return
        }
        const 行们 = Array.isArray(r.结果们) ? r.结果们 : []
        if (!行们.length) {
          设人设说('还没有绑定任何聊天')
          return
        }
        const 不顺 = 行们.filter((x) => !x.生效)
        设人设说((r.生效 ? '✓ ' + r.生效 + ' 间会话生效' : '⌀ 没有生效的会话')
          + (不顺.length ? '；' + 不顺.map((x) => x.聊天 + '：' + x.说).join('；') : ''))
      }
      const 改 = (k, v) => {
        设态((旧) => (旧 ? { ...旧, 配置: { ...(旧.配置 || {}), [k]: v } } : 旧))
        设脏(true)
      }
      // —— 绑定：整份数组替换（宿主那边会再规整一遍、并挡掉重复）——
      const 绑定们 = () => {
        const a = 态 && 态.配置 && 态.配置.绑定
        return Array.isArray(a) ? a : []
      }
      const 设绑定 = (下一份) => 改('绑定', 下一份)
      const 改绑定 = (i, 补) => 设绑定(绑定们().map((x, j) => (j === i ? { ...x, ...补 } : x)))
      const 加绑定 = () => 设绑定([...绑定们(), { 类型: '群', 号码: '', 会话: '', 称呼: '', 门槛: false }])
      const 删绑定 = (i) => 设绑定(绑定们().filter((_, j) => j !== i))

      const 存 = async () => {
        设忙(true)
        const s = await post('/save', (态 && 态.配置) || {})
        设忙(false)
        if (s && s.ok) {
          设态(s)
          设脏(false)
          设说(s.说 || '保存好了')
        } else {
          设说((s && s.说) || '保存失败')
        }
      }
      const 装语音 = async () => {
        设asr忙(true)
        const r = await post('/asr-install', {})
        设说((r && r.说) || '开始了')
        设asr忙(false)
        const s2 = await get('/asr-status')
        if (s2) 设asr(s2)
      }
      const 填语音命令 = async () => {
        const r = await get('/asr-status')
        if (r) 设asr(r)
        if (r && r.就绪 && r.命令) {
          改('语音转写', true)
          改('转写命令', r.命令)
          设说(String(配置.语音模型目录 || '').trim()
            ? '命令已填好（记得点保存）'
            : '命令填好了，但**还没填「语音模型目录」** —— 转写会报「没给模型目录」，填完再点一次这个按钮')
        } else if (r && !r.就绪) 设说('还没装好，先点「自动装依赖」')
        else 设说('读不到状态')
      }

      const 试一句 = async () => {
        设忙(true)
        const s = await post('/test-send', {})
        设忙(false)
        设说((s && s.说) || '没反应')
        await 拉()
      }

      if (!态) return h('div', { style: S.wrap }, h('div', { style: S.h }, '通到 QQ'), h('div', { style: S.dim }, '读取中…'))

      const 配置 = 态.配置 || {}
      const 目标们 = Array.isArray(态.活着的会话) ? 态.活着的会话 : []
      const NapCat = 态.NapCat状态 || null
      const 日志 = Array.isArray(态.日志) ? 态.日志 : []
      const 绑定 = 绑定们()

      const 会话选项 = (值, onChange) =>
        h('select', { style: S.wide, value: 值 || '', onChange: (e) => onChange(e.target.value) },
          h('option', { value: '' }, '（选一间会话）'),
          ...目标们.map((s) => h('option', { value: s.id }, (s.标题 || '…' + 短id(s.id)) + ' · ' + 短id(s.id))),
          值 && !目标们.some((s) => s.id === 值)
            ? h('option', { value: 值 }, '（当前：' + 短id(值) + '）')
            : null)

      const 页签 = h('div', { style: S.tabBar },
        ...页签们.map((名) => 按钮(名, () => 设页(名), 页 === 名, false)))

      // ───────────── 总览 ─────────────
      const 总览页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '开关'),
          行('总开关', 勾(配置.总开关, (v) => 改('总开关', v)), '关着 = 一句都不发（安全默认）。'),
          行('试运行', 勾(配置.试运行, (v) => 改('试运行', v)), '开着只记账、不真发到 QQ。想先看记录就开着它。'),
          行('手机只收「人话」（不发代码/路径）', 勾(配置.只发标记内, (v) => 改('只发标记内', v)), '开着时：只有它写在 [QQ] 这里 [/QQ] 中间的话会发到手机；代码、文件路径、分析过程都留在电脑上，不往手机上推。开之前先让它知道这个写法 —— 开着时转进去的消息会自动提醒它。'),
          行('只回 QQ 叫醒的那一轮', 勾(配置.只回QQ唤醒, (v) => 改('只回QQ唤醒', v)), '开着时：你在 QQ 问一句它回一句；你坐在 DSH 界面里自己聊的，不推到手机。'),
          行('自动触发的也发（主动搭话 / 定时任务）', 勾(配置.自动触发也发, (v) => 改('自动触发也发', v)), '上面那个开着的时候，主动搭话、到点刷 B 站这类「它自己起的头」要不要也推到手机。关着 = 只有 QQ 叫醒的那几轮才发（跟以前一样）；开着 = 那几种也发。⚠ 你自己在窗口里打的字，两种情况都不会发。'),
          行('正文里叫这些名字也算点名', h('input', {
            style: S.wide,
            value: String(配置.点名关键词 || ''),
            placeholder: '留空 = 只认 @ 和引用',
            onChange: (e) => 改('点名关键词', e.target.value),
          }), '群里有人直接说「让它帮我干活」「去问问它」，既没 @ 也没引用 —— 出现这些词就当点名，直接进来，不再靠概率掷骰子。多个用逗号或空格隔开；留空就是关着（跟以前一样）。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '现在的绑定（' + 绑定.length + ' 条）'),
          绑定.length === 0
            ? h('div', { style: S.dim }, '还没有绑定。去「绑定」页签加一条：一个私聊 / 一个群 → 一间会话。')
            : h('div', null,
              ...绑定.map((x, i) => h('div', { key: i, style: { marginBottom: 4 } },
                (x.类型 === '群' ? '群 ' : '私聊 ') + String(x.号码 || '?')
                + ' → ' + (x.会话 ? 短id(x.会话) : '（没选会话）')
                + (x.称呼 ? '　称呼：' + x.称呼 : '')
                + (x.类型 === '群' && x.门槛 ? '　门槛：开' : '')))),
          h('div', { style: { marginTop: 6 } }, 按钮('去绑定', () => 设页('绑定'))),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '自己动手'),
          h('div', null,
            按钮('保存设置', 存, true, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('测试一句', 试一句, false, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('刷新', 拉, false, 忙)),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '「测试一句」会真的发一句去 QQ（绕过试运行），用来确认整条路通没通。'),
          说 ? h('div', { style: { ...S.ok, marginTop: 6 } }, 说) : null,
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '最近 ' + 日志.length + ' 条记录（新的在最下面）'),
          h('div', { style: { marginTop: 6, maxHeight: 220, overflowY: 'auto' } },
            日志.length === 0
              ? h('div', { style: S.dim }, '还没有记录。')
              : 日志.map((条, i) => h('div', { key: i, style: S.日志行 }, 条.时间 + '　' + 条.文本))),
        ),
      )

      // ───────────── 绑定 ─────────────
      const 绑定页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '人设（选填）'),
          h('div', { style: S.dim },
            '给聊天带上一个「它是谁」。下面每一行也可以单独写一份 —— 那一行就用自己的，没写的用这里这份。'),
          h('div', { style: { marginTop: 6 } }, 勾(配置.人设开, (v) => 改('人设开', v)), ' ', '给聊天带上人设'),
          h('textarea', {
            style: { ...S.inp, display: 'block', width: '100%', height: 88, marginTop: 6, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box' },
            value: String(配置.人设 || ''),
            placeholder: '比如：你叫小满，二十出头，说话短、爱开玩笑，偶尔会怼人，但心是软的。',
            onChange: (e) => 改('人设', e.target.value),
          }),
          h('div', { style: { ...S.dim, marginTop: 4 } },
            '几句话就够，别写太长 —— 太长会把它每一轮的注意力都拽到这些字上。'),
          h('div', { style: { marginTop: 6 } },
            按钮('现在就生效', 人设现在生效, false, 人设忙),
            h('span', { style: S.dim }, '　改完不用等 QQ 来信，直接挂上去（那间会话得开着）')),
          人设说 ? h('div', { style: { ...S.dim, marginTop: 4 } }, 人设说) : null,
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '绑定（一行 = 一个聊天 → 一间会话）'),
          h('div', { style: S.dim },
            'QQ 私聊就填你自己的号；群就填群号。哪一行说的话，就只回那一行的聊天 —— 多群也不会串。'
            + '同一间会话可以绑多条（比如私聊 + 一个群都指向同一间）：她说什么，这几边都会收到。'),
          h('div', { style: { ...S.表头, marginTop: 10 } },
            h('div', { style: S.表头字 }, '类型'),
            h('div', { style: S.表头字 }, '号码'),
            h('div', { style: S.表头字 }, '称呼'),
            h('div', { style: S.表头字 }, '门槛'),
            h('div', { style: S.表头字 }, '人设'),
            h('div', { style: S.表头字 }, '')),
          绑定.length === 0
            ? h('div', { style: { ...S.dim, margin: '8px 0' } }, '还没有 —— 点下面的「+ 加一条」')
            : h('div', null, ...绑定.map((x, i) => h(React.Fragment, { key: i },
              h('div', { style: S.表格行 },
                h('select', { style: S.wide, value: x.类型 || '群', onChange: (e) => 改绑定(i, { 类型: e.target.value }) },
                  h('option', { value: '私聊' }, '私聊'),
                  h('option', { value: '群' }, '群')),
                h('input', {
                  style: S.wide, value: String(x.号码 || ''), placeholder: x.类型 === '私聊' ? 'QQ 号' : '群号',
                  onChange: (e) => 改绑定(i, { 号码: e.target.value.trim() }),
                }),
                h('input', {
                  style: S.wide, value: String(x.称呼 || ''),
                  placeholder: x.类型 === '私聊' ? '对方' : '群里的人',
                  onChange: (e) => 改绑定(i, { 称呼: e.target.value }),
                }),
                h('div', { style: { textAlign: 'center' } },
                  勾(x.门槛, (v) => 改绑定(i, { 门槛: v }))),
                h('div', { style: { textAlign: 'center' } },
                  按钮(String(x.人设 || '').trim() ? '✓ 单独' : '单独', () => 设人设行(人设行 === i ? null : i), false, false)),
                h('div', null, 按钮('删', () => 删绑定(i), false, false))),
              // ⭐ 1.1.0：会话单独占一整行，宽度给够
              h('div', { style: { display: 'grid', gridTemplateColumns: '70px 1fr', gap: 6, alignItems: 'center', margin: '0 0 6px' } },
                h('div', { style: S.表头字 }, '会话'),
                会话选项(x.会话, (v) => 改绑定(i, { 会话: v }))),
              // ⭐ 1.1.8：这一行自己的开关 —— 不想理就把「启用」取消，不用删掉
              h('div', { style: { display: 'flex', gap: 16, alignItems: 'center', margin: '0 0 10px', paddingLeft: 2 } },
                h('span', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                  勾(x.开 !== false, (v) => 改绑定(i, { 开: v })),
                  h('span', { style: S.dim }, '启用（关掉 = 这个聊天不收了，也不发）')),
                x.类型 === '群'
                  ? h('span', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                      勾(x.只听点名 == null ? !配置.群里听所有人 : Boolean(x.只听点名), (v) => 改绑定(i, { 只听点名: v })),
                      h('span', { style: S.dim }, '只听 @ 我的'))
                  : null),
              i === 人设行
                ? h('div', { style: { margin: '0 0 8px', padding: '6px 8px', background: 'rgba(127,127,127,.06)', borderRadius: 4 } },
                    h('div', { style: { ...S.dim, marginBottom: 4 } }, '这一行单独用的人设（留空 = 用上面那份）'),
                    h('textarea', {
                      style: { ...S.inp, display: 'block', width: '100%', height: 72, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box' },
                      value: String(x.人设 || ''),
                      placeholder: '比如：这个群里你话少，只接一两句，爱用「嗯」。',
                      onChange: (e) => 改绑定(i, { 人设: e.target.value }),
                    }),
                    h('div', { style: { marginTop: 4 } },
                      按钮('清空', () => 改绑定(i, { 人设: '' }), false, false),
                      h('span', { style: S.dim }, '　'),
                      按钮('收起', () => 设人设行(null), false, false)))
                : null,
              // ⭐ 1.4.3：这个群里「不听点名也直接收」的 QQ 号。
              //   「只听点名」一开，群里**所有人**（包括自己）都要点名才收；这里列出来的号例外。
              x.类型 === '群' && (x.只听点名 == null ? !配置.群里听所有人 : Boolean(x.只听点名))
                ? h('div', { style: { margin: '0 0 8px' } },
                    h('div', { style: { ...S.dim, marginBottom: 3 } },
                      '不受点名限制的 QQ（逗号或空格分隔，留空 = 群里全都要点名）'),
                    h('input', {
                      style: { ...S.inp, display: 'block', width: '100%', boxSizing: 'border-box' },
                      value: String(x.点名例外 || ''),
                      placeholder: '例如 3274796953',
                      onChange: (e) => 改绑定(i, { 点名例外: e.target.value }),
                    }))
                : null))),
          h('div', { style: { marginTop: 8 } },
            按钮('+ 加一条', 加绑定, false, false),
            h('span', { style: S.dim }, '　'),
            按钮('刷新会话清单', 拉, false, 忙)),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '「门槛」只有群有用：开了之后，那个群里的消息会先让它判断「是不是在跟我说话」，不是就停掉这一轮。'
            + '私聊永远不判（你自己私聊，本来就是在跟它说话）。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '群里怎么回（对所有群生效）'),
          h('div', { style: S.dim },
            '群里人多、话密的时候，一句一句回就像刷屏 —— 下面这几个数管的就是这个。@、引用 不受限制。'),
          行('两条之间至少隔（秒）', h('input', { type: 'number', min: 0, max: 300, style: S.small, value: String(配置.回复冷却秒 ?? 5), onChange: (e) => 改('回复冷却秒', Number(e.target.value)) }), '单位秒。回完一次要隔这么久才回下一条；这段时间里群里新的话先攒着，到点一起回。默认 5。'),
          行('一分钟最多回几条', h('input', { type: 'number', min: 1, max: 120, style: S.small, value: String(配置.每分钟最多条 ?? 4), onChange: (e) => 改('每分钟最多条', Number(e.target.value)) }), '一分钟里最多送进去几条。撞上了就等下一分钟再发 —— 是等，话不会丢。默认 4。'),
          行('一次最多攒几条', h('input', { type: 'number', min: 1, max: 50, style: S.small, value: String(配置.合并最多条 ?? 8), onChange: (e) => 改('合并最多条', Number(e.target.value)) }), '群里几个人说的话先合成一条（每句前面带「谁说的」），攒够这么多就立刻送进去，不用干等窗口。默认 8。'),
          行('私聊进来的话标来源', h('select', { style: S.small, value: String(配置.私聊署名 || '关'), onChange: (e) => 改('私聊署名', e.target.value) },
            h('option', { value: '关' }, '不标'), h('option', { value: '前缀' }, '[QQ] 前缀'), h('option', { value: '署名' }, '署名（对方：…）')),
            '默认不标。同一个会话里手机和电脑交替说话时，标一下才分得清哪句是从 QQ 来的。'),
          行('@ 我的一定回', h('input', { type: 'checkbox', checked: 配置.点名必回 !== false, onChange: (e) => 改('点名必回', Boolean(e.target.checked)) }), '关掉之后，「概率」连 @ / 引用 它的话也一起管。默认开：冲它来的就一定回。'),
          行('不是每句都接（概率 %）', h('input', { type: 'number', min: 0, max: 100, style: S.small, value: String(配置.回复概率 ?? 100), onChange: (e) => 改('回复概率', Number(e.target.value)) }), '100 = 每批都接（默认）。调小 = 群里闲聊有时就不理；没掷中的那批**根本不送进来**，不占上下文、也不花 token。'),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '「连着发的几条攒成一条」在「消息」页，默认 1 秒。'),
        ),
      )

      // ───────────── 消息 ─────────────
      const 消息页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '连到哪个 QQ 后端'),
          行('接口地址', h('input', { style: S.wide, value: String(配置.NapCat || ''), onChange: (e) => 改('NapCat', e.target.value) }), 'NapCat / SnowLuma 的 HTTP 地址，一般是 http://127.0.0.1:3000。'),
          行('接口令牌', h('input', { type: 'password', style: S.small, value: String(配置.令牌 || ''), onChange: (e) => 改('令牌', e.target.value) }), '后端开了 HTTP 鉴权才填（access_token）；留空 = 不鉴权。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '发出去的样子'),
          行('长回复拆成几条发', 勾(配置.长回复拆段, (v) => 改('长回复拆段', v)), '开着（默认）：按空行拆成几条、像真人一条条发。关掉：一整段只发一条，不会刷屏。'),
          行('按句子拆（不是按空行）', 勾(配置.按句拆, (v) => 改('按句拆', v)), '开着：一个句号/问号/感叹号算一条，更像人一条条打字。括号里的标点不切。默认关（关着就还是按空行拆）。'),
          行('每段之间隔（毫秒）', h('input', { type: 'number', min: 0, max: 5000, style: S.small, value: String(配置.拆段间隔毫秒 ?? 450), onChange: (e) => 改('拆段间隔毫秒', Number(e.target.value)) }), '只在「拆成几条」开着时有用。默认 450。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '收进来的样子'),
          行('连着发的几条攒成一条', h('input', { type: 'number', min: 0, max: 60, style: S.small, value: String(配置.合并窗口秒 ?? 3), onChange: (e) => 改('合并窗口秒', Number(e.target.value)) }), '单位秒。0 = 不攒（来一条转一条，会一条一条回）。默认 3：同一个人连着发的（比如一次发一串图）合成一条再转进去，它只回一次。'),
          行('最多攒多久', h('input', { type: 'number', min: 3, max: 300, style: S.small, value: String(配置.合并最多秒 ?? 20), onChange: (e) => 改('合并最多秒', Number(e.target.value)) }), '单位秒。有人一直发个不停时，到点也先转进来，不会无限等。默认 20。'),
          行('多久拉一次新消息（毫秒）', h('input', { type: 'number', min: 800, max: 30000, style: S.small, value: String(配置.轮询间隔毫秒 ?? 2000), onChange: (e) => 改('轮询间隔毫秒', Number(e.target.value)) }), '默认 2000（2 秒）。调小 = 消息进来更快，但请求 QQ 机器人更勤；改完要重启 DSH。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '图片'),
          行('收图（QQ → 它）', 勾(配置.收图, (v) => 改('收图', v)), '你在 QQ 里发的图也转给它看。模型看得见图就直接看；纯文本模型只知道「有几张图、存在哪」。'),
          行('发图（它 → QQ）', 勾(配置.发图, (v) => 改('发图', v)), '它这一轮里发的图也发到 QQ。'),
          行('一条最多收几张', h('input', { type: 'number', min: 1, max: 10, style: S.small, value: String(配置.收图最多 ?? 4), onChange: (e) => 改('收图最多', Number(e.target.value)) }), '多出来的不转。一条最多 10 张。'),
          行('单张最大（MB）', h('input', { type: 'number', min: 1, max: 30, style: S.small, value: String(配置.图上限MB ?? 5), onChange: (e) => 改('图上限MB', Number(e.target.value)) }), '超过就跳过（两个方向都按这个）。'),
          行('图片根目录', h('input', { style: S.wide, placeholder: '（留空就行：自动用会话所在的工作区）', value: String(配置.图片根目录 || ''), onChange: (e) => 改('图片根目录', e.target.value) }), '一般不用填。它正文里写 ![名字](相对路径) 时先按这个目录找。'),
          h('div', { style: S.dim }, '收进来的图会存一份到 %USERPROFILE%\\.dsh\\qq-bridge-inbox\\，文字里会带上路径。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '文件'),
          行('发文件（它 → QQ）', 勾(配置.发文件, (v) => 改('发文件', v)), '它这一轮正文里写了 [报告](D:\\x\\报告.docx) 这种链接，就把那个文件传到 QQ。图片那种 ![名](路径) 不算文件。'),
          行('单个文件最大（MB）', h('input', { type: 'number', min: 1, max: 2048, style: S.small, value: String(配置.文件上限MB ?? 50), onChange: (e) => 改('文件上限MB', Number(e.target.value)) }), '超过就只发一句话说明，不硬传。QQ 自己也有单文件上限，太大那边会拒。'),
          行('只往私聊发（群里不发文件）', 勾(配置.文件仅私聊 !== false, (v) => 改('文件仅私聊', v)), '默认开。大群里发文件容易出问题（群文件权限、刷屏、审核），私聊最稳。关掉之后群里也会传。'),
          h('div', { style: S.dim }, '路径带空格就用尖括号：[报告](<D:\\我的 文档\\报告.docx>)。网页链接不会被当成文件。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '语音转写（QQ 语音条 → 文字）'),
          行('转写语音', 勾(配置.语音转写, (v) => 改('语音转写', v)), '开着时，QQ 里的语音条会交给下面那条命令转成文字再转给它；关着就只记一个 [语音]。'),
          // —— 一键装依赖 ——
          h('div', { style: { ...S.row, alignItems: 'center' } },
            h('div', { style: S.lab }, '语音识别环境'),
            h('div', { style: S.ctl },
              h('div', null,
                按钮(asr忙 ? '…' : (asr && asr.就绪 ? '重装 / 修一下' : '自动装依赖'), 装语音, !(asr && asr.就绪), asr忙 || Boolean(asr && asr.进行中)),
                h('span', { style: S.dim }, '　'),
                按钮('把命令填好', 填语音命令, false, false)),
              h('div', { style: S.hint },
                asr && asr.就绪 && asr.模型就绪
                  ? '环境 + 语音模型都就绪：' + String(asr.python || '')
                  : asr && asr.就绪
                    ? '环境装好了，但语音模型还没下来 —— 再点一次「自动装依赖」会接着下'
                  : '还没装。点「自动装依赖」会建一个独立环境、装 sherpa-onnx + numpy（几十 MB，第一次要几分钟）。'),
              // 进度
              asr && asr.步骤 && asr.步骤.length
                ? h('div', { style: { marginTop: 8 } },
                  ...asr.步骤.map((x, i) => h('div', { key: i, style: { fontSize: 12 } },
                    (x.态 === '完成' ? '✓ ' : x.态 === '失败' ? '✗ ' : '⋯ ') + x.名 + (x.附 ? '（' + x.附 + '）' : ''))))
                : null,
              // —— 下载进度条（模型 230MB，得让人看见下了多少）——
              asr && asr.下载
                ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: { height: 8, borderRadius: 6, background: 'rgba(128,128,128,.25)', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        height: '100%', width: String(asr.下载.百分比 || 0) + '%',
                        background: 'var(--dsw-alias-state-business-primary)', transition: 'width .4s',
                      },
                    })),
                  h('div', { style: { ...S.dim, marginTop: 4 } },
                    (asr.下载.文件 ? '正在下 ' + asr.下载.文件 + '：' : '')
                    + '已下 ' + Math.round((asr.下载.已收 || 0) / 1048576) + 'MB'
                    + (asr.下载.总 ? ' / ' + Math.round(asr.下载.总 / 1048576) + 'MB' : '')
                    + '（' + String(asr.下载.百分比 || 0) + '%）'
                    + (asr.下载.速度KB ? '　约 ' + (asr.下载.速度KB > 1024 ? (asr.下载.速度KB / 1024).toFixed(1) + 'MB/s' : asr.下载.速度KB + 'KB/s') : '')))
                : null,
              asr && asr.进行中 ? h('div', { style: { ...S.dim, marginTop: 4 } }, '正在装…已 ' + String(asr.用时秒 || 0) + ' 秒（每 2 秒刷新一次）') : null,
              asr && asr.失败 ? h('div', { style: { color: '#c0392b', fontSize: 12, marginTop: 4 } }, '✗ ' + asr.失败) : null,
              asr && asr.日志
                ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: S.dim }, '安装日志（最后几行）'),
                  h('div', { style: { ...S.日志行, maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', marginTop: 4 } }, String(asr.日志)))
                : null)),
          行('转写命令', h('input', {
            style: S.wide,
            placeholder: 'python D:\\asr_cli.py "{file}"',
            value: String(配置.转写命令 || ''),
            onChange: (e) => 改('转写命令', e.target.value),
          }), '模板里必须有 {file}（会换成音频路径，一般是 wav）。命令往 stdout 打一行文字就算成功；非 0 退出码当失败。'),
          行('语音模型目录', h('input', {
            style: S.wide,
            placeholder: '（装依赖时会自动填好，不用手填）',
            value: String(配置.语音模型目录 || ''),
            onChange: (e) => 改('语音模型目录', e.target.value),
          }), '一般不用管：点「自动装依赖」会把语音模型一起下下来、路径自动写好。只有你想换成自己已有的模型（比如 whisper）时才需要改。'),
          行('超时（秒）', h('input', { type: 'number', min: 5, max: 600, style: S.small, value: String(配置.转写超时秒 ?? 60), onChange: (e) => 改('转写超时秒', Number(e.target.value)) }), '超过就杀掉命令、按失败处理（默认 60 秒）。'),
          h('div', { style: S.dim },
            '插件自己不带语音模型（不然包会变成几百 MB）。仓库里给了一个现成接法：tools/asr_cli.py（本机 SenseVoice）；你有 whisper 或云端接口的话，写一条「读 {file}、打一行字」的命令接上就行。'),
        ),
      )

      // ───────────── 门槛 ─────────────
      const 门槛页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '回复门槛'),
          h('div', { style: S.dim },
            '没有「总开关」——直接去「绑定」页签，给想开的那一行打勾就行；一个群开、别的群照常。'
            + '私聊永远不判（你自己私聊本来就是在跟它说话）。'),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '开了之后：那个群的 QQ 消息照样转进来，但会先让它自己判断「这条是不是在跟我说话」——不是就当场把这一轮停掉，什么都不回。'),
          行('判定不接时：真把这一轮停掉', 勾(配置.门槛真停轮, (v) => 改('门槛真停轮', v)), '关（默认）：只把这轮的话拦住、不发到 QQ，界面上什么异常都没有。开：真的停掉这一轮（省 token），但界面上会显示一次 `Error: tool call aborted` —— 那是「停轮」的表现，不是故障。'),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '⚠ 给某个群打开门槛那一刻，那一间会话的下一次请求会全量重算一遍（因为它多了一个工具）；关着的时候没有影响。'),
          h('div', { style: { ...S.dim, marginTop: 8, fontWeight: 600 } }, '群里听谁的'),
          行('群里也听别人的话', 勾(配置.群里听所有人, (v) => 改('群里听所有人', v)),
            '关（默认）：群里**只把点了名的**话转进来（@ 你、或引用你说的话）—— 省额度，也不会被别人的闲聊牵着走。'
            + '开：群里所有人说的话都转进来，交给上面的「门槛」去判断要不要接。'),
          // ⭐ 1.4.1：被点名之后，同一个群后面紧跟着的几句也放进来（不然接话接不上前文）
          行('点名之后接着听几条', h('input', { type: 'number', min: 0, max: 50, style: S.small, value: String(配置.点名后接听条 ?? 5), onChange: (e) => 改('点名后接听条', Number(e.target.value)) }),
            '被 @ 或者引用之后，同一个群里紧接着的几句话也会转进来，接够这么多条就停，回到「只听点名」。默认 5；填 0 = 不接（只有点名的那一条进得来）。'),
          行('接着听多少秒', h('input', { type: 'number', min: 0, max: 600, style: S.small, value: String(配置.点名后接听秒 ?? 120), onChange: (e) => 改('点名后接听秒', Number(e.target.value)) }),
            '单位秒。过了这么久也停，就算条数还没接完。默认 120。'),
        ),
      )

      // ───────────── 空间 ─────────────
      const 空间定时 = () => {
        const a = 配置.空间定时发
        return Array.isArray(a) ? a : []
      }
      const 设空间定时 = (下一份) => 改('空间定时发', 下一份)
      const 改空间定时 = (i, 补) => 设空间定时(空间定时().map((x, j) => (j === i ? { ...x, ...补 } : x)))
      const 加空间定时 = () => 设空间定时([...空间定时(), { 时: '09:30', 权: 1, 开: true }].slice(0, 12))
      const 删空间定时 = (i) => 设空间定时(空间定时().filter((_, j) => j !== i))

      const 空间页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '开关'),
          行('允许发 QQ 空间动态', 勾(配置.允许发空间动态, (v) => 改('允许发空间动态', v)), '默认关。关着的时候那几个工具还在，但只会说一句「没开」，不会真的发出去。看说说、看好友动态不受这个开关影响。'),
          h('div', { style: S.dim }, '空间走的是「消息」页那个接口地址和令牌，不用另填。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '定时发说说'),
          h('div', { style: S.dim }, '到点了会往绑定的会话里递一句提醒，说什么由它自己写 —— 这里只定时间。'),
          h('div', { style: { ...S.空间表头, marginTop: 10 } },
            h('div', { style: S.表头字 }, '时间'),
            h('div', { style: S.表头字 }, '可见范围'),
            h('div', { style: S.表头字 }, '启用'),
            h('div', { style: S.表头字 }, '')),
          空间定时().length === 0
            ? h('div', { style: { ...S.dim, margin: '8px 0' } }, '还没有 —— 点下面的「+ 加一条」')
            : h('div', null, ...空间定时().map((x, i) => h('div', { key: i, style: S.空间行 },
              h('input', {
                type: 'time', style: S.wide, value: String(x.时 || '09:30'),
                onChange: (e) => 改空间定时(i, { 时: e.target.value }),
              }),
              h('select', {
                style: S.wide, value: String(x.权 || 1),
                onChange: (e) => 改空间定时(i, { 权: Number(e.target.value) }),
              },
                h('option', { value: '1' }, '所有人'),
                h('option', { value: '4' }, '好友'),
                h('option', { value: '64' }, '仅自己')),
              h('div', { style: { textAlign: 'center' } }, 勾(x.开 !== false, (v) => 改空间定时(i, { 开: v }))),
              h('div', null, 按钮('删', () => 删空间定时(i), false, false))))),
          h('div', { style: { marginTop: 8 } },
            按钮('+ 加一条', 加空间定时, false, false),
            h('span', { style: S.dim }, '　最多 12 条')),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '定时看一圈'),
          行('多久看一圈（分钟）', h('input', { type: 'number', min: 5, max: 1440, style: S.small, value: String(配置.空间看圈分 ?? 30), onChange: (e) => 改('空间看圈分', Number(e.target.value)) }), '5～1440，默认 30。'),
          行('开着', 勾(配置.空间看圈开, (v) => 改('空间看圈开', v)), '开着才会定时去拉好友动态；关着什么都不做。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '点赞 / 评论'),
          行('自动点赞', 勾(配置.空间点赞开, (v) => 改('空间点赞开', v)), '看一圈的时候，最近几天里没点过的会顺手点一下。每次最多 3 条、一天最多 20 条。'),
          行('允许评论', 勾(配置.空间评论开, (v) => 改('空间评论开', v)), '看一圈的时候把新动态递进会话，评不评、评什么由它自己决定 —— 这里不替你写评论内容。'),
        ),
      )

      // ───────────── 更新 ─────────────
      const 查更新 = async () => {
        设更新忙(true)
        const r = await get('/update?refresh=1')
        if (r) 设更新(r)
        设更新忙(false)
        设说(!r ? '查不到（网络）' : r.hasUpdate ? '有新版本 v' + r.latest : r.ok ? '已经是最新版' : '查不到：' + (r.error || '网络'))
      }
      const 更新页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '检查更新'),
          h('div', { style: S.dim },
            !更新 ? '正在看有没有新版…'
              : 更新.hasUpdate ? '仓库里已经有 v' + 更新.latest + ' 了'
                : 更新.ok ? '已经是最新版' : '暂时查不到（' + (更新.error || '网络') + '）—— 这不代表没有问题'),
          h('div', { style: { marginTop: 6 } }, 按钮(更新忙 ? '查…' : '检查更新', 查更新, false, 更新忙)),
          更新 && 更新.hasUpdate
            ? h('div', { style: { marginTop: 8 } },
              h('div', { style: S.dim }, '更新方法：先卸旧版再装新版（直接装可能拿到缓存里的旧副本）。'),
              h('div', { style: S.日志行 }, ['dsh plugin --profile web remove dsh-qq-bridge', 'dsh plugin --profile web add dsh-qq-bridge'].join(String.fromCharCode(10))),
              按钮('复制命令', () => navigator.clipboard.writeText(['dsh plugin --profile web remove dsh-qq-bridge', 'dsh plugin --profile web add dsh-qq-bridge'].join(String.fromCharCode(10))).then(() => 设说('命令已复制')).catch(() => 设说('复制不了，手动选中吧')), false, false))
            : null,
        ),
      )

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.h }, '通到 QQ'),
        h('div', { style: S.dim },
          '它在 DSH 里说完一整轮，就把那句原文发到 QQ；你在 QQ 里说的话也会转进来。'
            + '版本 ' + String(态.版本 || '?') + '｜配置文件：' + String(态.配置文件 || '')),
        NapCat && !NapCat.错
          ? h('div', { style: S.已同步 }, '✓ 连着的 QQ：' + NapCat.昵称 + '（' + NapCat.用户 + '）')
          : h('div', { style: S.未保存 }, '⚠ 连不上 QQ 机器人（NapCat / SnowLuma）' + (NapCat && NapCat.错 ? '：' + NapCat.错 : '')),
        页签,
        h('div', { style: 脏 ? S.未保存 : S.已同步 },
          脏 ? '⚠ 有改动还没保存 —— 改完点「保存设置」（底下也会浮一条出来）' : '设置已同步 ✓'),
        页 === '总览' ? 总览页 : null,
        页 === '绑定' ? 绑定页 : null,
        页 === '消息' ? 消息页 : null,
        页 === '空间' ? 空间页 : null,
        页 === '门槛' ? 门槛页 : null,
        页 === '更新' ? 更新页 : null,
        脏
          ? h('div', { style: S.悬浮保存条 },
            h('span', { style: { fontWeight: 600, color: '#c0392b' } }, '⚠ 有改动还没保存'),
            h('span', { style: S.dim }, '改完点这里就行'),
            按钮('保存设置', 存, true, 忙))
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'qq-bridge', order: 54, label: () => '通到 QQ' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
