// 「通到 QQ」宿主半边冒烟测试 —— 假 ctx / 假 fetch 把「DSH → QQ」这半跑一遍。
// 验的是：
//   1) 提取正文：只收 text 块，reasoning / image 不要；空 → ''
//   2) assistant/message + turn/end(completed) → 真的向 NapCat 发一条 send_private_msg
//   3) interrupted 那轮不发；turn/end 不是 completed 不发
//   4) 试运行开着 → 不真发（fetch 不被打）；总开关关着 → 不真发
//   5) /state 路由能回出配置和 NapCat 探活结果
// 跑法： node tests/宿主半边.mjs

import { mkdtempSync, writeFileSync as 原写文件, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { setImmediate as 下一跳 } from 'node:timers/promises'

const 家 = mkdtempSync(join(tmpdir(), 'qq-bridge-'))
process.env.DSH_HOME = 家

// ⭐ 1.0.9：这一份测的是「转进来」这件事本身，不是群聊的节奏 ——
//   所以每次写配置都顺手把「回复冷却」关掉（不然群的那批会被冷却挂住，后面全乱）。
//   群聊节奏另有自己的测试（tests/群节奏.mjs）。
const writeFileSync = (路, 数据, ...余) => {
  if (String(路).endsWith('qq-bridge-config.json')) {
    try {
      const o = JSON.parse(String(数据))
      if (o.回复冷却秒 === undefined) o.回复冷却秒 = 0
      if (o.每分钟最多条 === undefined) o.每分钟最多条 = 999
      数据 = JSON.stringify(o, null, 2)
    } catch (e) {}
  }
  return 原写文件(路, 数据, ...余)
}

// 先把配置写好（总开关开、真发、私聊 123）
writeFileSync(
  join(家, 'qq-bridge-config.json'),
  JSON.stringify({
    总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '',
    转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
  }, null, 2),
  'utf8',
)

let 挂了 = 0
const 报 = (标签, 过, 详情) => { if (!过) 挂了++; console.log(`${过 ? 'PASS' : 'FAIL'}  ${标签}${详情 ? '  :: ' + 详情 : ''}`) }

// 假 fetch：记下每次 POST，回一个「发送成功」；拉历史时给一条她的新消息
const 发了 = []
const 请求头们 = []
let 私聊消息文本 = '宝宝'
let 私聊消息时间 = 1700000000
let 私聊消息id = 9000
let 私聊消息段 = null          // 给「卡片 / 合并转发」用：设了就替掉默认的 text 段
let 私聊消息们 = null          // 1.0.2：设了就用这一串（测「攒成一条」）
let 私聊消息人 = 123           // 1.0.3：测「另一条绑定」时换成别的号
let 发送者昵称 = ''            // 1.2.1：测「私聊署名」时给个昵称
let 转发节点 = null            // get_forward_msg 假数据
let 转发拉取次数 = 0           // ⭐ 1.1.5：数「同一条转发被重拉了几次」
let 群消息文本 = '群里的话'
let 群消息时间 = 1700000000
let 群消息id = 9100
let 群消息段 = null          // 给群消息用（跟私聊那个一样）
let 群消息们 = null          // ⭐ 1.4.1：设了就用这一串（测「点名之后接着听」）
let 内层节点 = null           // 「转发里套转发」用的内层节点
let 深层节点 = null           // 1.0.3：第三层转发（fw-deep）
let 空间列表回 = null         // ⭐ 1.4.1：QQ 空间的假回包
let 空间详情回 = null
let 空间动态回 = null
const 空间请求 = []           // 打到空间那几个 action 上的请求（url + 体）
globalThis.fetch = async (url, 选项) => {
  const 体 = JSON.parse((选项 && 选项.body) || '{}')
  const u = String(url)
  请求头们.push({ url: u, headers: (选项 && 选项.headers) || {} })
  if (u.includes('get_login_info')) {
    return { json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试号' } }) }
  }
  if (u.includes('get_friend_msg_history')) {
    const 们 = 私聊消息们 || [{ user_id: 私聊消息人, time: 私聊消息时间, message_id: 私聊消息id, message_type: 'private',
      sender: 发送者昵称 ? { nickname: 发送者昵称 } : undefined,
      message: 私聊消息段 || [{ type: 'text', data: { text: 私聊消息文本 } }] }]
    return {
      json: async () => ({ status: 'ok', retcode: 0, data: { messages: 们 } }),
    }
  }
  if (u.includes('get_group_msg_history')) {
    return {
      json: async () => ({
        status: 'ok', retcode: 0,
        data: { messages: 群消息们 || [{ user_id: 123, time: 群消息时间, message_id: 群消息id, message_type: 'group',
          message: 群消息段 || [{ type: 'text', data: { text: 群消息文本 } }] }] },
      }),
    }
  }
  // ⭐ 1.4.1：QQ 空间那四个 action（回包可以按用例换）
  if (u.includes('send_qzone_msg') || u.includes('get_qzone_msg_list')
      || u.includes('get_qzone_msg_detail') || u.includes('get_qzone_feeds')) {
    空间请求.push({ url: u, 体, headers: (选项 && 选项.headers) || {} })
    if (u.includes('send_qzone_msg')) {
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { tid: 'tid-9988' } }) }
    }
    const 回 = u.includes('get_qzone_msg_list') ? 空间列表回 : (u.includes('get_qzone_msg_detail') ? 空间详情回 : 空间动态回)
    return { ok: true, json: async () => 回 || { status: 'ok', retcode: 0, data: {} } }
  }
  if (u.includes('multimedia.nt.qq.com.cn')) {
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
  }
  if (u.includes('get_forward_msg')) {
    转发拉取次数 += 1
    const 是谁 = JSON.stringify(体)
    const 内层 = 是谁.includes('fw-inner')
    const 深层 = 是谁.includes('fw-deep')
    return { json: async () => ({ status: 'ok', retcode: 0, data: { messages: (深层 ? 深层节点 : (内层 ? 内层节点 : 转发节点)) || [] } }) }
  }
  发了.push({ url: u, 体 })
  return { json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

process.env.QQ_BRIDGE_探活超时 = '300'   // 让「NapCat 不回应」那条测试 0.3 秒就有结果
process.env.QQ_BRIDGE_不加速 = '1'       // 攒消息的「补跑一跳」别插进测试里
const 模 = await import(new URL('../lib/host.js', import.meta.url).href + '?v=' + Date.now())

// ---------- 纯函数 ----------
报('名字导出', 模.name === 'qq-bridge', 模.name)
报('inject = agents + sessions + sessionTitle + webServer + timer + workspaceRegistry + attachments + tools', Array.isArray(模.inject) && 模.inject.join() === 'agents,sessions,sessionTitle,webServer,timer,workspaceRegistry,attachments,tools', String(模.inject))

const 块 = (type, text) => ({ type, text })
const 正文 = 模.提取正文({ content: [块('reasoning', '想一下'), 块('text', '第一条\n第二条'), 块('image', ''), 块('text', '第三条')] })
报('提取正文：只收 text，reasoning/image 都不要', 正文 === '第一条\n第二条\n第三条', JSON.stringify(正文))
报('提取正文：没有 text → 空串', 模.提取正文({ content: [块('reasoning', 'x')] }) === '')

// ⭐ 2026-10-22 图片
报('提取图块：只挑带 attachment 的 image 块', 模.提取图块({ content: [
  { type: 'text', text: '看图' },
  { type: 'image', attachment: { attachmentId: 'sha256:aa' } },
  { type: 'image' }, // 没 attachment：不算（发不出去）
  { type: 'file', attachment: { attachmentId: 'sha256:bb' } },
] }).length === 1)
报('图片段：base64 直接塞进 OneBot image 段', (() => {
  const 段 = 模.图片段('AAA')
  return 段.type === 'image' && 段.data.file === 'base64://AAA'
})())
报('抠正文图：markdown 图抠出来，正文留干净的', (() => {
  const r = 模.抠正文图('看图！\n![小肥鱼](_stickers/feiyu-test.webp)\n好看吧')
  return r.净文字 === '看图！\n\n好看吧' && r.图.length === 1 && r.图[0].kind === 'path' && r.图[0].value === '_stickers/feiyu-test.webp'
})())
报('抠正文图：网络图单独算一类', (() => {
  const r = 模.抠正文图('![](https://x.com/a.png)纯图')
  return r.净文字 === '纯图' && r.图.length === 1 && r.图[0].kind === 'url'
})())

// ---------- 假 ctx ----------
const 监听 = []
const 路由 = new Map()
const 转进的 = []
const 入站事件 = new EventEmitter()
const 记录转入 = (m) => { 转进的.push(m); 入站事件.emit('followup', m) }
let 轮询回调 = null
const 注册的工具 = []
let X活着 = true      // 可以让某间会话「死掉 / 点活」，用来测「会话死了消息不丢」
let G活着 = true
const 取消 = []
const 假agent = {
  followup: 记录转入,
  session: { id: 'session-X' },
  cancel: async (a) => { 取消.push(a) },
  ctx: { tools: { register: (t) => { 注册的工具.push(t); return () => { t.__卸了 = true } } } },
}
const 假群agent = {
  followup: 记录转入,
  session: { id: 'session-G' },
  cancel: async () => {},
  ctx: { tools: { register: (t) => { 注册的工具.push(t); return () => { t.__卸了 = true } } } },
}
const ctx = {
  on: (名字, cb) => { if (名字 === 'session/event') 监听.push(cb); return () => {} },
  effect: (fn) => { const 摘 = fn(); return () => { try { 摘 && 摘() } catch {} } },
  webServer: { register: (o) => 路由.set(o.path, o.handler) },
  logger: { info: (t) => { try { (globalThis.__桥日志 ||= []).push(String(t)) } catch {} } },
  agents: { get: (id) => (String(id) === 'session-X' ? (X活着 ? 假agent : undefined) : (String(id) === 'session-G' ? (G活着 ? 假群agent : undefined) : undefined)) },
  sessions: { flush: async () => {} },
  interval: (fn) => { 轮询回调 = fn; return () => {} },
  get: () => undefined,
}

const 桥 = 模.apply(ctx)
报('session/event 监听挂上了', 监听.length >= 1)

const 会话 = { id: 'session-X' }
const 别的会话 = { id: 'session-Y' }
const 助手消息 = (turn, step, blocks, interrupted) => ({ type: 'assistant/message', data: { turn, step, interrupted, message: { role: 'assistant', content: blocks } } })
const 转完 = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

// ① 正常一轮 → 发一条私聊
监听[0](会话, 助手消息(7, 1, [块('text', '宝宝，我想你了')], false))
监听[0](会话, 转完(7))
await new Promise((r) => setTimeout(r, 20))
报('一整轮结束 → 发出一条私聊', 发了.length === 1 && 发了[0].url.endsWith('/send_private_msg'), 发了.map((x) => x.url + ' :: ' + JSON.stringify(x.体.response || x.体)).join(' / '))

if (发了[0]) {
  const 体 = 发了[0].体
 报('私聊体：user_id=123 + 一条 text 段', 体.user_id === 123 && 体.message && 体.message[0].type === 'text' && 体.message[0].data.text === '宝宝，我想你了', JSON.stringify(体))
}

// ② 中间步骤：先 pm 再看表那种多步，只发**最后一步**（同 turn 后面那条）。
const 之前 = 发了.length
监听[0](会话, 助手消息(8, 1, [块('text', '第一步（别发这个）')], false))
监听[0](会话, 助手消息(8, 2, [块('text', '最后一句（发这个）')], false))
监听[0](会话, 转完(8))
await new Promise((r) => setTimeout(r, 20))
报('多步只发最后一步', 发了.length === 之前 + 1 && JSON.stringify(发了.at(-1).体.message[0].data.text).includes('最后一句'), JSON.stringify(发了.at(-1).体.message[0].data.text))

// ③ interrupted 那轮不发
const 之前3 = 发了.length
监听[0](会话, 助手消息(9, 1, [块('text', '被打断的话')], true))
监听[0](会话, 转完(9))
await new Promise((r) => setTimeout(r, 20))
报('interrupted 那轮不转发', 发了.length === 之前3)

// ④ turn/end 不是 completed → 不发
const 之前4 = 发了.length
监听[0](会话, 助手消息(10, 1, [块('text', '中断的话')], false))
监听[0](会话, 转完(10, 'interrupted'))
await new Promise((r) => setTimeout(r, 20))
报('reason 不是 completed 不转发', 发了.length === 之前4)

// ⑤ 别的会话不转
const 之前5 = 发了.length
监听[0](别的会话, 助手消息(11, 1, [块('text', '别的屋')], false))
监听[0](别的会话, 转完(11))
await new Promise((r) => setTimeout(r, 20))
报('不是目标会话不转发', 发了.length === 之前5)

// ⑥ 试运行开 → fetch 不被打
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: true, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前6 = 发了.length
监听[0](会话, 助手消息(12, 1, [块('text', 'try')], false))
监听[0](会话, 转完(12))
await new Promise((r) => setTimeout(r, 20))
报('试运行开 → 只记账不真发', 发了.length === 之前6)

// ⑦ 总开关关 → fetch 不被打
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: false, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前7 = 发了.length
监听[0](会话, 助手消息(13, 1, [块('text', 'off')], false))
监听[0](会话, 转完(13))
await new Promise((r) => setTimeout(r, 20))
报('总开关关 → 不转发', 发了.length === 之前7)

// ⑧ /state 路由能回配置 + NapCat 探活
const 存储 = []
let 回复 = null
const fakeRes = { setHeader: () => {}, end: (s) => { 存储.push(JSON.parse(s)) } }
await 路由.get('/dsh-qq-bridge/state')([], fakeRes)
const 状态 = 存储[0]
报('/state 回出配置', 状态 && 状态.ok === true && 状态.配置 && 状态.配置.总开关 === false, JSON.stringify(状态 && 状态.配置))
报('/state 探到 NapCat 那个号', 状态 && 状态.NapCat状态 && 状态.NapCat状态.昵称 === '测试号' && 状态.NapCat状态.用户 === 10001, JSON.stringify(状态 && 状态.NapCat状态))

// ⑨ QQ → DSH：/receive 把她说的话转进目标会话（followup）
const 收 = (body) => {
  存储.length = 0
  return new Promise((resolve) => {
    路由.get('/dsh-qq-bridge/receive')([JSON.stringify(body)], fakeRes).then(() => resolve(存储[0]))
  })
}
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')

let 收到 = await 收({ text: '宝宝你在吗' })
报('/receive：把她的话 followup 进会话', 收到 && 收到.ok === true && 转进的.length === 1, JSON.stringify(收到))
if (转进的[0]) {
  const m = 转进的[0]
  const 文 = String(m.content[0].text || '')
  报('/receive 消息形状：role=user + source.kind=qq + 正文对',
    m.role === 'user' && m.source && m.source.kind === 'qq'
      && 文.includes('宝宝你在吗') && 文.startsWith('【本机注入·不是QQ·不是主人】'), JSON.stringify(m))
  报('/receive 的来源头说清了「不是主人」', 文.includes('不是主人') && !文.includes('【QQ私聊】'), 文.slice(0, 40))
}
报('/receive 之后 DSH→QQ 那半也会把伙伴的回话发回 QQ（联动靠 session/event，不在这里再验）', true)

// ⑩ 总开关关 → receive 拒绝
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: false, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前收 = 转进的.length
收到 = await 收({ text: '还开着吗' })
报('/receive：总开关关 → 拒绝、不再 followup', 收到 && 收到.ok === false && 转进的.length === 之前收, JSON.stringify(收到))

// ⑪ 空 text → 拒绝
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
收到 = await 收({ text: '   ' })
报('/receive：空 text → 拒绝', 收到 && 收到.ok === false, JSON.stringify(收到))

// ⑫ 目标会话没活着 → 拒绝（session-Z 拿不到 agent）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-Z', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
收到 = await 收({ text: '在吗' })
报('/receive：目标会话没活着 → 拒绝', 收到 && 收到.ok === false && String(收到.说).includes('没活着'), JSON.stringify(收到))

// ⑬ 轮询收消息（QQ → DSH 这半的正式入口，不赖 BOT）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前转 = 转进的.length
私聊消息文本 = '宝宝你在吗'
私聊消息id = 9001
私聊消息时间 = Math.floor(Date.now() / 1000) + 100
await 轮询回调()
await new Promise((r) => setTimeout(r, 20))
报('轮询收消息 → 她新发的私聊被 followup 进 DSH', 转进的.length === 之前转 + 1 && JSON.stringify(转进的.at(-1).content[0].text).includes('宝宝你在吗'), JSON.stringify(转进的.at(-1)))
// 再跑一次同一条：不该重复转
私聊消息文本 = '宝宝你在吗'
私聊消息id = 9001
私聊消息时间 = Math.floor(Date.now() / 1000) + 101
await 轮询回调()
await new Promise((r) => setTimeout(r, 20))
报('轮询：同一条消息不重复转', 转进的.length === 之前转 + 1, '转进条数=' + 转进的.length)

// ⑭ 轮询：总开关关 → 不转
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: false, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息文本 = '还开着吗'
私聊消息id = 9002
私聊消息时间 = Math.floor(Date.now() / 1000) + 120
await 轮询回调()
await new Promise((r) => setTimeout(r, 20))
报('轮询：总开关关 → 不转', 转进的.length === 之前转 + 1, '转进条数=' + 转进的.length)

// ⑮ B站 分享卡片（json 段）→ 变成文字递进去（以前整条被当空消息丢掉）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 卡 = { app: 'com.tencent.structmsg', meta: { news: {
  title: '【测试】一条 B站 视频', desc: '简介在这里',
  jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=qq', tag: '哔哩哔哩',
  preview: 'https://i0.hdslb.com/x.jpg' } }, prompt: '[QQ小程序]哔哩哔哩' }
私聊消息段 = [
  { type: 'json', data: { data: JSON.stringify(卡) } },
]
私聊消息id = 9010
私聊消息时间 = Math.floor(Date.now() / 1000) + 200
const 之前卡 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 30))
const 卡片正文 = 转进的.length > 之前卡 ? String(转进的.at(-1).content[0].text) : ''
报('B站 卡片能读：转进去了', 转进的.length === 之前卡 + 1, 卡片正文.slice(0, 120))
报('卡片正文有标题', 卡片正文.includes('一条 B站 视频'), 卡片正文)
报('卡片正文认出是视频、带 BV 号', 卡片正文.includes('[分享视频卡片]') && 卡片正文.includes('BV1xx411c7mD'), 卡片正文)
报('卡片正文带原链接', 卡片正文.includes('bilibili.com'), 卡片正文)

// ⑯ 合并转发的聊天记录（forward 段）→ 取一次内容、压成几行
转发节点 = [
  { sender: { nickname: '阿甲' }, content: [{ type: 'text', data: { text: '你看这个' } }, { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } }] },
  { sender: { card: '阿乙' }, content: [{ type: 'text', data: { text: '哈哈我也看了' } }] },
]
私聊消息段 = [
  { type: 'forward', data: { id: 'fw-001' } },
]
私聊消息id = 9011
私聊消息时间 = Math.floor(Date.now() / 1000) + 300
const 之前转2 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 30))
const 转发正文 = 转进的.length > 之前转2 ? String(转进的.at(-1).content[0].text) : ''
报('合并转发能读：转进去了', 转进的.length === 之前转2 + 1, 转发正文.slice(0, 160))
报('转发正文有「共 N 条」', 转发正文.includes('合并转发的聊天记录') && 转发正文.includes('2'), 转发正文)
报('转发正文带昵称和内容', 转发正文.includes('阿甲') && 转发正文.includes('你看这个') && 转发正文.includes('阿乙'), 转发正文)
报('转发里的图记成 [图片]', 转发正文.includes('[图片]'), 转发正文)

// ⑰ 私聊 / 群分两间屋：各进各的会话（2026-10-25）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息段 = null
私聊消息文本 = '私聊这边一句话'
私聊消息id = 9020
私聊消息时间 = Math.floor(Date.now() / 1000) + 400
群消息文本 = '群里一句话'
群消息id = 9021
群消息时间 = Math.floor(Date.now() / 1000) + 400
const 之前两间 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('私聊和群各转一条进来', 转进的.length === 之前两间 + 2, '转进条数=' + 转进的.length)
报('私聊那一条进的是私聊会话（source 带 qq + 正文对上）', JSON.stringify(转进的.at(-2)?.content?.[0]?.text || '').includes('私聊这边一句话'), JSON.stringify(转进的.at(-2)?.content?.[0]?.text))
报('群那一条进的是群会话', JSON.stringify(转进的.at(-1)?.content?.[0]?.text || '').includes('群里一句话'), JSON.stringify(转进的.at(-1)?.content?.[0]?.text))

// ⑱ 回话只回对应的那一边
const 要问 = []
globalThis.__记录 = 要问
发了.length = 0
监听[0](会话, 助手消息(20, 1, [块('text', '这句是私聊那间屋的')], false))
监听[0](会话, 转完(20))
await new Promise((r) => setTimeout(r, 30))
报('私聊会话说完 → 只发私聊', 发了.length === 1 && 发了[0].url.endsWith('/send_private_msg'), 发了.map((x) => x.url).join(','))
发了.length = 0
监听[0](假群agent.session, 助手消息(21, 1, [块('text', '这句是群那间屋的')], false))
监听[0](假群agent.session, 转完(21))
await new Promise((r) => setTimeout(r, 30))
报('群会话说完 → 只发群', 发了.length === 1 && 发了[0].url.endsWith('/send_group_msg'), 发了.map((x) => x.url).join(','))

// ⑲ 同一间会话绑两条（私聊 + 群）→ **两边都发**（1.4.0 起支持）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false,
  绑定: [
    { 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' },
    { 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人' },
  ],
  NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
发了.length = 0
监听[0](会话, 助手消息(22, 1, [块('text', '同一间屋')], false))
监听[0](会话, 转完(22))
await new Promise((r) => setTimeout(r, 30))
报('同一间会话绑两条 → 私聊和群都发', 发了.length === 2
  && 发了.some((x) => x.url.endsWith('/send_private_msg'))
  && 发了.some((x) => x.url.endsWith('/send_group_msg')), 发了.map((x) => x.url).join(','))

// ⑲b 其中一条被关掉 → 只发开着的那条（用群那间会话，别动 session-X 的状态）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false,
  绑定: [
    { 类型: '群', 号码: '456', 会话: 'session-G', 称呼: '群里的人' },
    { 类型: '群', 号码: '457', 会话: 'session-G', 称呼: '二号群', 开: false },
  ],
  NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
发了.length = 0
监听[0](假群agent.session, 助手消息(23, 1, [块('text', '只发开着的那条')], false))
监听[0](假群agent.session, 转完(23))
await new Promise((r) => setTimeout(r, 30))
报('同一间会话绑两个群、其中一个关掉 → 只发开着那个', 发了.length === 1
  && String(发了[0].体.group_id) === '456', JSON.stringify(发了.map((x) => [x.url.slice(-12), x.体 && x.体.group_id])))

// ⑳ 称呼分两套：私聊用「私聊称呼」，群里用「群称呼」（群里不止一个人）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true,
  称呼: '小明', 群称呼: '群里的人', NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息段 = [
  { type: 'text', data: { text: '私聊发你张图' } },
  { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } },
]
私聊消息id = 9030
私聊消息时间 = Math.floor(Date.now() / 1000) + 500
群消息文本 = '群里也发一张'
群消息段 = [
  { type: 'text', data: { text: '群里也发一张' } },
  { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } },
]
群消息id = 9031
群消息时间 = Math.floor(Date.now() / 1000) + 500
const 之前称呼 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 私聊文案 = String(转进的.at(-2)?.content?.[0]?.text || '')
const 群文案 = String(转进的.at(-1)?.content?.[0]?.text || '')
报('私聊的图 → 用私聊称呼「小明」', 私聊文案.includes('小明发了 1 张图'), 私聊文案.slice(0, 80))
报('群里的图 → 用群称呼「群里的人」，不用小明的名字', 群文案.includes('群里的人发了 1 张图') && !群文案.includes('小明'), 群文案.slice(0, 80))

// ㉑ 转发里套转发：要展开（最多 2 层）
内层节点 = [
  { sender: { nickname: '阿丙' }, content: [{ type: 'text', data: { text: '里层的一句话' } }] },
  { sender: { nickname: '阿丁' }, content: [{ type: 'image', data: { url: 'http://x/2.jpg' } }] },
]
转发节点 = [
  { sender: { nickname: '阿甲' }, content: [{ type: 'text', data: { text: '你看这个' } }, { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } }] },
  { sender: { nickname: '阿乙' }, content: [{ type: 'forward', data: { id: 'fw-inner' } }] },
]
私聊消息段 = [{ type: 'forward', data: { id: 'fw-outer' } }]
私聊消息id = 9040
私聊消息时间 = Math.floor(Date.now() / 1000) + 600
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true, 收图: true, 收图最多: 4, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前嵌套 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 嵌套正文 = String(转进的.at(-1)?.content?.[0]?.text || '')
报('转发里套转发会展开', 嵌套正文.includes('里层的一句话'), 嵌套正文.slice(0, 200))
报('内层的人名也在', 嵌套正文.includes('阿丙'), 嵌套正文.slice(0, 200))
报('内层的图也标了 [图片]', 嵌套正文.includes('[图片]'), 嵌套正文.slice(0, 200))

// ㉒ 转发里的图跟着「收图」开关走
const 嵌套文案 = String(转进的.at(-1)?.content?.[0]?.text || '')
报('收图开着 → 第一层的图会被收进来（文案里有「发了 1 张图」）', 嵌套文案.includes('发了 1 张图'), 嵌套文案.slice(-120))
报('内层的图不重复收（只收第一层）', !嵌套文案.includes('发了 2 张图'), 嵌套文案.slice(-120))

// ㉓ 里外分开：内层转发另起一段（不像上一版挤成一坨）
const 嵌套行们 = 嵌套文案.split(String.fromCharCode(10))
报('外层是一行一句（阿甲那行单独一行）', 嵌套行们.some((l) => l.includes('阿甲：') && !l.includes('里层的一句话')), JSON.stringify(嵌套行们.slice(0, 4)))
报('内层另起一段、有缩进', 嵌套行们.some((l) => /^\s{4,}\[合并转发的聊天记录/.test(l)), JSON.stringify(嵌套行们))
报('内层的人自己占一行', 嵌套行们.some((l) => l.includes('阿丙：里层的一句话')), JSON.stringify(嵌套行们))

// ㉔ 一条转发里套了两个转发 → 两段各自展开
内层节点 = [{ sender: { nickname: '丙一' }, content: [{ type: 'text', data: { text: '第一段内容' } }] }]
转发节点 = [
  { sender: { nickname: '甲' }, content: [{ type: 'forward', data: { id: 'fw-inner' } }] },
  { sender: { nickname: '乙' }, content: [{ type: 'forward', data: { id: 'fw-inner-2' } }] },
]
私聊消息段 = [{ type: 'forward', data: { id: 'fw-outer2' } }]
私聊消息id = 9050
私聊消息时间 = Math.floor(Date.now() / 1000) + 700
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 两段正文 = String(转进的.at(-1)?.content?.[0]?.text || '')
const 段头数 = (两段正文.match(/\[合并转发的聊天记录 · 共/g) || []).length
报('两个嵌套各展开成一段（一共 3 个「聊天记录」标题：外层 + 两个内层）', 段头数 === 3, '标题数=' + 段头数 + ' :: ' + 两段正文)

// ㉕ access_token：填了「令牌」就带 Bearer，没填就照旧
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: '', 私聊QQ: '123', 群号: '',
  转私聊: true, 转群: false, 令牌: 'my-secret-token', NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息段 = null
私聊消息文本 = '带令牌的一句'
私聊消息id = 9060
私聊消息时间 = Math.floor(Date.now() / 1000) + 800
请求头们.length = 0
const 令牌前 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('带令牌时轮询请求带 Authorization: Bearer', 请求头们.some((x) => String(x.headers.authorization || '') === 'Bearer my-secret-token'), JSON.stringify(请求头们.map((x) => [x.url.slice(-28), x.headers.authorization || '(无)'])))
报('带令牌时那一轮照样转进来', 转进的.length === 令牌前 + 1)

writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: '', 私聊QQ: '123', 群号: '',
  转私聊: true, 转群: false, 令牌: '', NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息id = 9061
私聊消息时间 = Math.floor(Date.now() / 1000) + 900
请求头们.length = 0
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('没填令牌时不带 Authorization（老 NapCat 零变化）', 请求头们.length > 0 && 请求头们.every((x) => !x.headers.authorization), JSON.stringify(请求头们.map((x) => x.headers.authorization || '(无)')))

// ㉖ 回复门槛：挂工具 / 只在被 QQ 叫醒时能关闸 / 关掉就卸下来
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 回复门槛: true, 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: true }],
  NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
// ⭐ 0.9.9：门槛现在会看「这轮是群还是私聊」，所以这里要喂一条**群里的**新消息
群消息段 = null
群消息文本 = '群里有人说：今天好热'
群消息id = 9070
群消息时间 = Math.floor(Date.now() / 1000) + 1000
私聊消息id = 8990            // 让私聊那条变「旧的」，别把群唤醒覆盖成私聊
私聊消息时间 = 1
注册的工具.length = 0
取消.length = 0
await 轮询回调()          // 心跳：挂工具 + 拉消息
await new Promise((r) => setTimeout(r, 40))
报('门槛开着 → 给绑了 QQ 的会话挂上 qq_reply_gate', 注册的工具.some((x) => x.name === 'qq_reply_gate'), 注册的工具.map((x) => x.name).join(','))
const 闸 = 注册的工具.find((x) => x.name === 'qq_reply_gate')
// ① 配置保持「群 + 门槛开」不变（0.8.2 起没有总开关了，只看这一行）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: true }],
}, null, 2), 'utf8')
const 前取消 = 取消.length
await new Promise((r) => setTimeout(r, 5))
// ② 正常判定：reply=false → **不调 cancel**（免得 UI 冒出 tool call aborted + 重试），
//    只把「这轮不往 QQ 发」记下来，等这一轮结束再跳过发送。
const r1 = await 闸.execute({ reply: false, reason: '在跟别人聊' })
报('reply=false → 返回「这轮不接」', r1.ok === true && String(r1.说).includes('不接'), JSON.stringify(r1))
await new Promise((r) => setTimeout(r, 20))
报('「真停轮」关着（默认）→ 不 cancel（界面最干净）', 取消.length === 前取消, '取消次数=' + (取消.length - 前取消))
发了.length = 0
监听[0](会话, 助手消息(23, 1, [块('text', '这轮说了话但不该发出去')], false))
监听[0](会话, 转完(23))
await new Promise((r) => setTimeout(r, 40))
报('判定不接之后那一轮：一个字都不发到 QQ', 发了.length === 0, '发了=' + 发了.length)
// ③ 再调一次（不在 QQ 唤醒窗口内）→ 拒绝
const r2 = await 闸.execute({ reply: false })
报('不是 QQ 叫醒的那一轮 → 门槛放行（不让它瞎判）',
  r2.ok === true && String(r2.说).includes('不是 QQ 消息叫起来'), JSON.stringify(r2))
// ④ 把那一行的门槛取消 → 下一跳卸下来
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: false }],
}, null, 2), 'utf8')
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('门槛关掉 → 工具被卸下', 闸.__卸了 === true, String(闸.__卸了))
const r3 = await 闸.execute({ reply: false })
报('门槛关着时调用 → 放行并说清「门槛只对群有效」',
  r3.ok === true && String(r3.说).includes('没开门槛'), JSON.stringify(r3))

// ㉗ 0.6.0：老配置自动变成「绑定」两行；多群各回各的；私聊不挂门槛
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 迁 = await (async () => {
  存储.length = 0
  await 路由.get('/dsh-qq-bridge/save')([JSON.stringify(JSON.parse(readFileSync(join(家, 'qq-bridge-config.json'), 'utf8')))], fakeRes)
  return 存储[0]
})()
报('老配置（私聊会话+群会话）→ 自动变成两条绑定', 迁 && 迁.配置 && Array.isArray(迁.配置.绑定) && 迁.配置.绑定.length === 2, JSON.stringify((迁 && 迁.配置 && 迁.配置.绑定 || []).map((x) => x.类型 + ':' + x.号码)))
报('第一条是私聊、称呼沿用', 迁.配置.绑定[0].类型 === '私聊' && 迁.配置.绑定[0].号码 === '123')
报('第二条是群、称呼是「群里的人」', 迁.配置.绑定[1].类型 === '群' && 迁.配置.绑定[1].号码 === '456')

// 两个群 → 两间会话：各回各的群
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 转私聊: true, 转群: true, NapCat: 'http://127.0.0.1:3000',
  绑定: [
    { 类型: '群', 号码: '111', 会话: 'session-X', 称呼: '一号群的大家' },
    { 类型: '群', 号码: '222', 会话: 'session-G', 称呼: '二号群的大家' },
  ],
}, null, 2), 'utf8')
发了.length = 0
监听[0](会话, 助手消息(30, 1, [块('text', '一号群这边')], false))
监听[0](会话, 转完(30))
监听[0](假群agent.session, 助手消息(31, 1, [块('text', '二号群这边')], false))
监听[0](假群agent.session, 转完(31))
await new Promise((r) => setTimeout(r, 40))
报('两个群各发到自己的群号（不串）', 发了.length === 2
  && 发了.some((x) => String(x.体.group_id) === '111') && 发了.some((x) => String(x.体.group_id) === '222'),
  JSON.stringify(发了.map((x) => [x.url.slice(-16), x.体.group_id])))

// 只有私聊绑定 + 门槛开着 → 私聊不挂工具
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 回复门槛: true, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明', 门槛: true }],
}, null, 2), 'utf8')
注册的工具.length = 0
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('私聊不挂回复门槛（主人私聊就是在跟它说话）', !注册的工具.some((x) => x.name === 'qq_reply_gate'), 注册的工具.map((x) => x.name).join(','))

// ㉘ 0.7.0 出站两闸：[QQ] 块 / 只回 QQ 唤醒
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 只发标记内: true, 只回QQ唤醒: false, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
发了.length = 0
监听[0](会话, 助手消息(40, 1, [块('text', '这块不要发' + String.fromCharCode(10) + '[QQ]发这句就够了[/QQ]' + String.fromCharCode(10) + '这块也不要')], false))
监听[0](会话, 转完(40))
await new Promise((r) => setTimeout(r, 30))
报('「只发标记内」开着：只发 [QQ] 块里那句', 发了.length === 1 && JSON.stringify(发了[0].体.message[0].data.text) === JSON.stringify('发这句就够了'), JSON.stringify(发了.map((x) => x.体.message && x.体.message[0] && x.体.message[0].data && x.体.message[0].data.text)))
发了.length = 0
监听[0](会话, 助手消息(41, 1, [块('text', '这轮没写块')], false))
监听[0](会话, 转完(41))
await new Promise((r) => setTimeout(r, 30))
报('「只发标记内」开着：没写块 → 一句都不发', 发了.length === 0, String(发了.length))

writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 只发标记内: false, 只回QQ唤醒: true, NapCat: 'http://127.0.0.1:3000',
  绑定: [
    { 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' },
    { 类型: '群', 号码: '456', 会话: 'session-G', 称呼: '群里的人' },
  ],
}, null, 2), 'utf8')
发了.length = 0
// 让群那边没有新消息进来（不然轮询会把群消息也转进去、把 session-G 也标成「QQ 叫醒」）
群消息段 = null
群消息文本 = '旧的群消息，不该被投'
群消息id = 9140
群消息时间 = Math.floor(Date.now() / 1000) - 3600
await 轮询回调()
// 用「从没被 QQ 叫醒过」的那间（session-G）来验：不是 QQ 唤醒 → 不推
// ⭐ 1.0.1 起还有「尾巴」：明确清掉，才是真的「没被 QQ 叫醒过」
桥.测试.清唤醒(假群agent.session.id)
桥.测试.清尾巴(假群agent.session.id)
监听[0](假群agent.session, 助手消息(42, 1, [块('text', '我在 DSH 里自己聊的')], false))
监听[0](假群agent.session, 转完(42))
await new Promise((r) => setTimeout(r, 30))
报('「只回 QQ 唤醒」开着：不是 QQ 叫的 → 不推手机', 发了.length === 0, String(发了.length))
私聊消息段 = null
私聊消息文本 = 'QQ 里问一句'
私聊消息id = 9080
私聊消息时间 = Math.floor(Date.now() / 1000) + 2000
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
发了.length = 0
监听[0](会话, 助手消息(43, 1, [块('text', 'QQ 里回你一句')], false))
监听[0](会话, 转完(43))
await new Promise((r) => setTimeout(r, 30))
报('「只回 QQ 唤醒」开着：QQ 叫醒的那一轮 → 正常回', 发了.length === 1, String(发了.length))

// ㉙ 会话当时是死的 → 这条不丢；把它点活之后，下一跳自己就转进去了，也不会跑到别的会话
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, onlyThis: true, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
X活着 = false
私聊消息段 = null
私聊消息文本 = '这间屋死着的时候说的话'
私聊消息id = 9090
私聊消息时间 = Math.floor(Date.now() / 1000) + 3000
const 之前死 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('会话是死的：这条不会转进去（也不假装转过）', 转进的.length === 之前死, '转进=' + 转进的.length)
X活着 = true
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('把它点活之后：下一跳自己就转进去了（不丢）', 转进的.length === 之前死 + 1 && JSON.stringify(转进的.at(-1)?.content?.[0]?.text || '').includes('死着的时候说的话'), JSON.stringify(转进的.at(-1)?.content?.[0]?.text))

// ㉚ 语音转写：语音条 → 交给外部命令 → 变成文字（插件自己不带模型）
const 假ASR = join(家, '假asr.js')
// 可控的合成子进程延迟，覆盖启动耗时超过旧 300ms 窗口的情况。
const ASR延迟 = Number(process.env.QQ_TEST_ASR_DELAY_MS || 0)
if (!Number.isFinite(ASR延迟) || ASR延迟 < 0 || ASR延迟 > 3000) throw new Error('QQ_TEST_ASR_DELAY_MS 必须在 0..3000')
writeFileSync(假ASR, `setTimeout(() => process.stdout.write('这条语音说的是：晚上吃什么'), ${ASR延迟})\n`, 'utf8')
const 坏ASR = join(家, '坏asr.js')
writeFileSync(坏ASR, "process.stderr.write('模型没装'); process.exit(1)" + String.fromCharCode(10), 'utf8')
const 语音段 = (f) => [
  { type: 'text', data: { text: '发你条语音' } },
  { type: 'record', data: { file: f } },
]
const 跑一遍 = async (配置补, id, 段) => {
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
    ...配置补,
  }, null, 2), 'utf8')
  const 标记 = `[voice-case:${id}]`
  私聊消息段 = [{ type: 'text', data: { text: 标记 } }, ...段]
  私聊消息id = id
  私聊消息时间 = Math.floor(Date.now() / 1000) + 4000 + (id % 100)
  // timer 回调是 fire-and-forget；await 它不会等 ASR/入站完成。
  // 在触发前订阅精确 case 的 followup，避免上一条迟到后满足下一条断言。
  const 完成 = new Promise((resolve, reject) => {
    const 接到 = (m) => {
      const text = String(m.content[0].text)
      if (!text.includes(标记)) return
      clearTimeout(超时)
      入站事件.off('followup', 接到)
      resolve(text)
    }
    const 超时 = setTimeout(() => {
      入站事件.off('followup', 接到)
      reject(new Error(`等待 ${标记} followup 超时（5s）`))
    }, 5000)
    入站事件.on('followup', 接到)
  })
  // 新宿主返回整轮 Promise 时也等到 finally；旧宿主返回 undefined 仍靠事件。
  const [text] = await Promise.all([完成, 轮询回调()])
  // 排空 followup 后的 Promise continuation（含落水位），再改下一条配置。
  await 下一跳()
  return text
}
const 真音频 = join(家, 'voice.silk')
writeFileSync(真音频, Buffer.from([1, 2, 3]))
const 转写命令 = (脚本) => '"' + process.execPath + '" "' + 脚本 + '" "{file}"'
const 转写开 = await 跑一遍({ 语音转写: true, 转写命令: 转写命令(假ASR), 转写超时秒: 20 }, 9100, 语音段(真音频))
报('语音转写开着 → 语音条变成文字', 转写开.includes('（语音）') && 转写开.includes('晚上吃什么'), 转写开)
const 转写关 = await 跑一遍({ 语音转写: false, 转写命令: 转写命令(假ASR) }, 9101, 语音段(真音频))
报('语音转写关着 → 还是 [语音]', 转写关.includes('[语音]') && !转写关.includes('晚上吃什么'), 转写关)
const 转写坏 = await 跑一遍({ 语音转写: true, 转写命令: 转写命令(坏ASR), 转写超时秒: 20 }, 9102, 语音段(真音频))
报('命令失败 → 明说转写失败（不吞掉整条消息）', 转写坏.includes('转写失败') && 转写坏.includes('发你条语音'), 转写坏)
// ⭐ 她实测报的那条：QQ 给的 file 是 https://multimedia.nt.qq.com.cn/download?appid=…
const 转写链 = await 跑一遍({ 语音转写: true, 转写命令: 转写命令(假ASR), 转写超时秒: 20 }, 9103,
  语音段('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&spec=0'))
报('语音的 file 是网络地址时 → 先下载到本地再转写（她实测报的那个）', 转写链.includes('（语音）') && 转写链.includes('晚上吃什么'), 转写链)
const 音频目录 = join(家, 'audio')
const 落下的 = (() => { try { return readFileSync(join(音频目录, 'qq-voice-9103.amr')).length } catch (e) { return -1 } })()
报('下下来的音频确实落在 qq-bridge/audio 里', 落下的 === 4, String(落下的))

// ㉛ 语音依赖：状态接口（没装好时是「未就绪」）+ 一键装立刻返回不挂住请求
存储.length = 0
await 路由.get('/dsh-qq-bridge/asr-status')([], fakeRes)
const asr状态 = 存储[0]
报('/asr-status 能回状态（没装时未就绪）', asr状态 && asr状态.ok === true && asr状态.就绪 === false && Array.isArray(asr状态.步骤), JSON.stringify({ ok: asr状态 && asr状态.ok, 就绪: asr状态 && asr状态.就绪 }))
报('状态里带了「装好之后该填的命令」（含 asr_cli.py 和 {file}）', String(asr状态.命令 || '').includes('asr_cli.py') && String(asr状态.命令 || '').includes('{file}'), String(asr状态.命令))
// ⚠ 不在这里真的点「装依赖」—— 那会起 pip，把临时目录占住、清理不掉。
//   这里只验「路有、状态能取」，真装交给插件页上的按钮（人工点）。

// ㉜ 旧消息不补投（会话关着攒下来的，别一打开就冒出来）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 补投窗口分: 10, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
X活着 = false
私聊消息段 = null
私聊消息文本 = '半小时前发的'
私聊消息id = 9110
私聊消息时间 = Math.floor(Date.now() / 1000) - 30 * 60   // 半小时前
const 之前旧 = 转进的.length
await 轮询回调()
X活着 = true
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
报('超过补投窗口的旧消息：不再补投（不会一打开就冒一条旧回复）', 转进的.length === 之前旧, '转进=' + 转进的.length)

// ㉝ 重启不重投：水位落盘 + 没记录过的聊天从「此刻」开始
const 状态文件 = join(家, 'qq-bridge-state.json')
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 补投窗口分: 60, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
私聊消息段 = null
私聊消息文本 = '刚发的一条'
私聊消息id = 9120
私聊消息时间 = Math.floor(Date.now() / 1000) + 5000
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
let 水位 = null
try { 水位 = JSON.parse(readFileSync(状态文件, 'utf8')) } catch (e) {}
报('水位和已转 id 会落盘（重启后不用从零开始）', Boolean(水位 && 水位.上次 && 水位.上次['私聊:123'] === 私聊消息时间 && Array.isArray(水位.已转) && 水位.已转.includes(9120)), JSON.stringify(水位 && 水位.上次))

// 没记录过的聊天：历史消息不该被当成新的补投
writeFileSync(状态文件, JSON.stringify({ 上次: {}, 已转: [] }, null, 2), 'utf8')
私聊消息文本 = '五分钟前的旧消息'
私聊消息id = 9121
私聊消息时间 = Math.floor(Date.now() / 1000) - 5 * 60
const 之前补 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('没水位记录的聊天：历史消息不补投（从此刻开始算）', 转进的.length === 之前补, '转进=' + 转进的.length)

// ㉞ 下载进度：状态接口里要能拿到「已下 / 总 / 百分比 / 速度」
存储.length = 0
await 路由.get('/dsh-qq-bridge/asr-status')([], fakeRes)
const asr2 = 存储[0]
报('/asr-status 带下载进度字段（没在下载时是 null）', asr2 && asr2.下载 === null, JSON.stringify(asr2 && asr2.下载))
报('/asr-status 带「模型就绪 / 模型目录」', asr2 && typeof asr2.模型就绪 === 'boolean' && String(asr2.模型目录 || '').includes('models'), JSON.stringify({ 就绪: asr2 && asr2.模型就绪, 目: asr2 && asr2.模型目录 }))

// ㉟ 开了「只发 [QQ] 块」时，转进去的消息里要点明这个约定（不然它压根不会写块）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 只发标记内: true, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
私聊消息段 = null
私聊消息文本 = '这条消息要提醒它写块'
私聊消息id = 9130
私聊消息时间 = Math.floor(Date.now() / 1000) + 6000
const 之前块 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
const 带块提示 = 转进的.length > 之前块 ? String(转进的.at(-1).content[0].text) : ''
报('「只发 [QQ] 块」开着 → 转进去的消息里会说明这个约定', 带块提示.includes('[QQ]') && 带块提示.includes('块外'), 带块提示.slice(-90))

// ㊱ 老的两个「转私聊/转群」开关不该再拦发送（她报的：加了群绑定，群里却收不到回复）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 转私聊: false, 转群: false, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-G', 称呼: '群里的人' }],
}, null, 2), 'utf8')
发了.length = 0
监听[0](假群agent.session, 助手消息(50, 1, [块('text', '群绑定就该能发出去')], false))
监听[0](假群agent.session, 转完(50))
await new Promise((r) => setTimeout(r, 40))
报('有群绑定就发得出去（老开关 转群=false 不再拦）', 发了.length === 1 && 发了[0].url.endsWith('/send_group_msg'), 发了.map((x) => x.url).join(','))

// ㊲ 群消息要标「谁发的：昵称（QQ号）」；门槛工具必须声明 output（不然注册失败）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 回复门槛: true, NapCat: 'http://127.0.0.1:3000',
  绑定: [
    { 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' },
    { 类型: '群', 号码: '456', 会话: 'session-G', 称呼: '群里的人', 门槛: true },
  ],
}, null, 2), 'utf8')
// 先关一次门槛让旧的卸下来，再打开 → 保证这次会真的重新注册（否则注册表里还是旧对象）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-G', 称呼: '群里的人', 门槛: false }],
}, null, 2), 'utf8')
await 轮询回调()
注册的工具.length = 0
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-G', 称呼: '群里的人', 门槛: true }],
}, null, 2), 'utf8')
群消息段 = [{ type: 'text', data: { text: '群里测试测试' } }]
群消息id = 9150
群消息时间 = Math.floor(Date.now() / 1000) + 8000
const 之前群 = 转进的.length
await 轮询回调()
console.log('   [调试] 注册数=' + 注册的工具.length + '；最近日志：' + String((globalThis.__桥日志 || []).slice(-4).join(' ｜ ')).slice(0, 300))
await new Promise((r) => setTimeout(r, 60))
const 群文 = 转进的.length > 之前群 ? String(转进的.at(-1).content[0].text) : ''
报('群消息带了「昵称（QQ号）：」', 群文.includes('（123）：') && 群文.includes('群里测试测试'), 群文.slice(0, 90))
const 工具 = 注册的工具.find((x) => x.name === 'qq_reply_gate')
报('门槛工具声明了 output（DSH 硬要求）', Boolean(工具 && 工具.output && 工具.output.schema && typeof 工具.output.render === 'function'), '注册过的工具：' + 注册的工具.map((x) => x.name + '[' + Object.keys(x).join('/') + ']').join(', '))

// ㊴ 0.9.8（她 20:04 的截图）：parameters 必须是完整 JSON Schema，不能是「属性表」，
//     否则上游报 `Invalid schema for function 'qq_reply_gate': ... got 'type: null'`，整间会话一句话都说不了
{
  const 参 = 工具 && 工具.parameters
  报('门槛的 parameters 是 JSON Schema（type=object）', Boolean(参 && 参.type === 'object'), JSON.stringify(参).slice(0, 160))
  报('parameters.properties 里有 reply / reason',
    Boolean(参 && 参.properties && 参.properties.reply && 参.properties.reason), JSON.stringify(参 && 参.properties).slice(0, 160))
  报('required 是数组且包含 reply',
    Boolean(参 && Array.isArray(参.required) && 参.required.includes('reply')), JSON.stringify(参 && 参.required))
  报('属性上没再写 required:true（老的错写法）',
    Boolean(参 && 参.properties && !('required' in (参.properties.reply || {}))), JSON.stringify(参 && 参.properties && 参.properties.reply).slice(0, 160))
}

// ㊳ 门槛的 reply 用字符串 "false" 也要认（模型常这么传）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: true }],
}, null, 2), 'utf8')
注册的工具.length = 0
群消息段 = null
群消息文本 = '字符串 false 的测试'
群消息id = 9160
群消息时间 = Math.floor(Date.now() / 1000) + 9000
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 闸2 = 注册的工具.find((x) => x.name === 'qq_reply_gate')
const 前取 = 取消.length
const r2s = 闸2 ? await 闸2.execute({ reply: 'false', reason: '字符串形式' }) : { ok: false, 说: '没挂上' }
报('reply 传字符串 "false" 也认（返回「不接」）', r2s.ok === true && String(r2s.说).includes('不接'), JSON.stringify(r2s))

// ㊴ 「真停轮」打开 → 会真的 cancel（下一拍），关着 → 不 cancel
// 先关一次门槛，让旧的卸下来（否则闸门挂着里还是旧对象，这次不会重新注册）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: false }],
}, null, 2), 'utf8')
await 轮询回调()
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 门槛真停轮: true, NapCat: 'http://127.0.0.1:3000', 群里听所有人: true,
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: true }],
}, null, 2), 'utf8')
群消息段 = null
群消息文本 = '真停轮测试（群）'
群消息id = 9170
群消息时间 = Math.floor(Date.now() / 1000) + 9500
注册的工具.length = 0
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 闸3 = 注册的工具.find((x) => x.name === 'qq_reply_gate')
const 前3 = 取消.length
const r3x = 闸3 ? await 闸3.execute({ reply: false, reason: '真停轮' }) : { ok: false }
await new Promise((r) => setTimeout(r, 30))
报('「真停轮」开着 → 会调 agent.cancel（真的停掉这一轮）', 取消.length === 前3 + 1, '取消=' + (取消.length - 前3) + ' 工具=' + (闸3 ? '有' : '没挂上') + ' 返回=' + JSON.stringify(r3x))
报('cancel 传 kind=user（跟用户按停止一样）', 取消.at(-1) && 取消.at(-1).kind === 'user', JSON.stringify(取消.at(-1)))

// ㊵ 长回复拆段可关：关掉 = 一整段只发一条
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 长回复拆段: false, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
// 先空跑一轮，把前面「真停轮」留下的静默标记消耗掉
监听[0](会话, 助手消息(59, 1, [块('text', '（清标记）')], false))
监听[0](会话, 转完(59))
await new Promise((r) => setTimeout(r, 40))
发了.length = 0
const 多段 = ['第一段话', '第二段话', '第三段话'].join(String.fromCharCode(10) + String.fromCharCode(10))
监听[0](会话, 助手消息(60, 1, [块('text', 多段)], false))
监听[0](会话, 转完(60))
await new Promise((r) => setTimeout(r, 80))
报('「长回复拆段」关掉 → 一整段只发一条消息', 发了.length === 1 && String(发了[0].体.message[0].data.text).includes('第三段话'), '发了 ' + 发了.length + ' 条')
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 长回复拆段: true, 拆段间隔毫秒: 0, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
发了.length = 0
监听[0](会话, 助手消息(61, 1, [块('text', 多段)], false))
监听[0](会话, 转完(61))
await new Promise((r) => setTimeout(r, 120))
报('「长回复拆段」开着 → 按空行拆成 3 条', 发了.length === 3, '发了 ' + 发了.length + ' 条')

// ㉛ 0.9.7 用户反馈：设置页「试一句」老是说「这间会话没绑任何 QQ 聊天」
//   —— 手动测试没有会话可反查，以前直接判定没绑定，于是永远发不出去。
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 私聊QQ: '', 群号: '',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}, null, 2), 'utf8')
发了.length = 0
const 试发回 = { 体: null, end(串) { this.体 = JSON.parse(串) } }
await 路由.get('/dsh-qq-bridge/test-send')([JSON.stringify({})], 试发回)
报('「试一句」按绑定发得出去（不再说没绑）',
  发了.length === 1 && 发了[0].url.endsWith('/send_private_msg') && Number(发了[0].体.user_id) === 123,
  '发了 ' + 发了.length + ' 条 :: ' + JSON.stringify(发了.map((x) => x.体.user_id)))
报('「试一句」回话里说清发给了谁',
  !!(试发回.体 && 试发回.体.ok && String(试发回.体.说).includes('123')), JSON.stringify(试发回.体))

// 没绑定时要说人话（别再报「会话没绑」这种让人以为是 bug 的句子）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 绑定: [],
}, null, 2), 'utf8')
发了.length = 0
const 空绑回 = { 体: null, end(串) { this.体 = JSON.parse(串) } }
await 路由.get('/dsh-qq-bridge/test-send')([JSON.stringify({})], 空绑回)
报('没绑定时明说「还没绑定任何聊天」',
  !!(空绑回.体 && 空绑回.体.ok === false && String(空绑回.体.说).includes('还没绑定任何聊天')), JSON.stringify(空绑回.体))
报('没绑定时一条都不发', 发了.length === 0, String(发了.length))

// ㊶ 0.9.9（她 20:36 说的「群里 @ 它不理人」）
//   ① 点名识别只用纯函数测，不依赖轮询时序
报('@ 了我 → 算点名', 模.识别点名([{ type: 'at', data: { qq: '10001' } }], '10001', new Set()) === true)
报('@ 了别人 → 不算点名', 模.识别点名([{ type: 'at', data: { qq: '20002' } }], '10001', new Set()) === false)
报('@ 全体 → 不算点名', 模.识别点名([{ type: 'at', data: { qq: 'all' } }], '10001', new Set()) === false)
报('引用我发过的消息 → 算点名', 模.识别点名([{ type: 'reply', data: { id: '777' } }], '10001', new Set(['777'])) === true)
报('引用别人的消息 → 不算点名', 模.识别点名([{ type: 'reply', data: { id: '888' } }], '10001', new Set(['777'])) === false)
报('普通文字 → 不算点名', 模.识别点名([{ type: 'text', data: { text: '大肥鱼在吗' } }], '10001', new Set()) === false)

//   ② 门槛：点名 / 私聊 一律放行（不让模型犹豫着判 false 把整轮停掉）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '群', 号码: '456', 会话: 'session-X', 称呼: '群里的人', 门槛: true }],
}, null, 2), 'utf8')
注册的工具.length = 0
await 轮询回调()
await new Promise((r) => setTimeout(r, 80))
const 闸6 = 注册的工具.find((x) => x.name === 'qq_reply_gate') || 闸3 || 闸2
报('门槛工具还挂着（后面两项要用）', Boolean(闸6), 注册的工具.map((x) => x.name).join(','))

桥.测试.记唤醒('session-X', '群', true)
const r6 = await 闸6.execute({ reply: false, reason: '它犹豫了' })
报('点了名的这一轮 → 门槛直接放行（不会被判成不接）', r6.ok === true && String(r6.说).includes('点了你的名'), JSON.stringify(r6))

桥.测试.记唤醒('session-X', '私聊', false)
const r7 = await 闸6.execute({ reply: false })
报('私聊那一轮调门槛 → 一律放行（私聊没有门槛开关）', r7.ok === true && String(r7.说).includes('私聊'), JSON.stringify(r7))

桥.测试.记唤醒('session-X', '群', false)
const r8 = await 闸6.execute({ reply: false, reason: '在跟别人聊' })
报('群里没点名 + 判不接 → 还是照常判（没被短路掉）', r8.ok === true && String(r8.说).includes('不接'), JSON.stringify(r8))

// ㊷ 0.9.10：NapCat 不回应时，设置页也不能永远「读取中…」
//   做法：探活带超时（测试里压到 300ms）+ /state 兜底返回版本/配置/日志
{
  const 原fetch = globalThis.fetch
  globalThis.fetch = (url, 选项) => {
    if (String(url).includes('get_login_info')) {
      // 这个假 fetch 认 abort（真 fetch 也认）：不认的话超时根本发不出去
      return new Promise((_, 拒) => {
        const 信 = 选项 && 选项.signal
        if (信) 信.addEventListener('abort', () => 拒(new Error('aborted')))
      })
    }
    return 原fetch(url, 选项)
  }
  const 起 = Date.now()
  const 桶 = {}
  const res = { setHeader() {}, end(串) { 桶.体 = JSON.parse(串) } }
  await 路由.get('/dsh-qq-bridge/state')([], res)
  const 用时 = Date.now() - 起
  globalThis.fetch = 原fetch
  报('NapCat 不回应时 /state 也会回来（不等死）', Boolean(桶.体 && 桶.体.ok === true), JSON.stringify(桶.体).slice(0, 120))
  报('超时生效（0.3 秒超时 → 1 秒内回来）', 用时 < 1500, 用时 + 'ms')
  报('兜底里仍然有版本和配置', Boolean(桶.体 && 桶.体.版本 && 桶.体.配置), JSON.stringify(桶.体 && 桶.体.版本))
  报('兜底里说明了 NapCat 为什么没连上', Boolean(桶.体 && 桶.体.NapCat状态 && 桶.体.NapCat状态.错), JSON.stringify(桶.体 && 桶.体.NapCat状态))
}

// ⭐ 1.0.3（issue #13）①：转发套三层，第三层也要看得到
{
  深层节点 = [{ sender: { nickname: '阿戊' }, content: [{ type: 'text', data: { text: '第三层的话' } }] }]
  内层节点 = [{ sender: { nickname: '阿丙' }, content: [{ type: 'forward', data: { id: 'fw-deep' } }] }]
  转发节点 = [{ sender: { nickname: '阿甲' }, content: [{ type: 'forward', data: { id: 'fw-inner' } }] }]
  私聊消息人 = 789
  私聊消息段 = [{ type: 'forward', data: { id: 'fw-outer3' } }]
  私聊消息id = 9055
  私聊消息时间 = Math.floor(Date.now() / 1000) + 720
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: '',
    绑定: [{ 类型: '私聊', 号码: '789', 会话: 'session-X' }],
    私聊QQ: '789', 群号: '', 转私聊: true, 转群: false, 收图: true, NapCat: 'http://127.0.0.1:3000',
  }, null, 2), 'utf8')
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 80))
  const 深文 = String(转进的.at(-1)?.content?.[0]?.text || '')
  报('三层的转发：第三层的话也看得到（issue #13）', 深文.includes('第三层的话'), 深文.slice(0, 200))

  // ②：第四层实在套太深 → 截断时必须带上「还有几条」
  深层节点 = [{ sender: { nickname: '阿戊' }, content: [{ type: 'forward', data: { id: 'fw-inner' } }] }]
  私聊消息id = 9056
  私聊消息时间 = Math.floor(Date.now() / 1000) + 740
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 80))
  const 截断文 = String(转进的.at(-1)?.content?.[0]?.text || '')
  报('套太深时会说「里面还有 N 条」而不是干截断', /里面还有 \d+ 条转发/.test(截断文), 截断文.slice(-160))
}

// ⭐ 1.1.5（issue #16）：同一条「取不到」的合并转发，别每 2 秒重拉一遍刷爆日志
{
  深层节点 = null
  内层节点 = null
  转发节点 = []        // ← 取不到，就像 NapCat 一直报错
  私聊消息人 = 789
  私聊消息段 = [{ type: 'forward', data: { id: 'fw-坏掉的' } }]
  私聊消息id = 9300
  私聊消息时间 = Math.floor(Date.now() / 1000) + 750
  转发拉取次数 = 0
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 80))
  const 第一次 = 转发拉取次数
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 80))
  const 第二次 = 转发拉取次数
  报('取不到的转发：第一次会拉一次', 第一次 >= 1, String(第一次))
  报('取不到的转发：下一跳不再重拉（缓存兜住）', 第二次 === 第一次, 第一次 + ' → ' + 第二次)
  报('取不到也要有话说，不是静默丢掉', String(转进的.at(-1)?.content?.[0]?.text || '').includes('内容取不到'))
  转发节点 = null
}

// ⭐ 1.0.3（issue #13）②：大表情没有 url → 至少留一句，别让整条消失
{
  深层节点 = null
  私聊消息段 = [{ type: 'mface', data: { summary: '[大表情]', emoji_id: 'abc123' } }]
  私聊消息id = 9270
  私聊消息时间 = Math.floor(Date.now() / 1000) + 760
  const 前m = 转进的.length
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 60))
  报('大表情（没 url）也转进来了，不会被当成空消息丢掉', 转进的.length === 前m + 1, '转进 ' + (转进的.length - 前m) + ' 条')
  const 表情文 = String(转进的.at(-1)?.content?.[0]?.text || '')
  报('大表情留下「[表情:…]」让人知道发了啥', /\[表情[:：]/.test(表情文), 表情文.slice(0, 120))

  // 图有 url 但一张都取不到 → 也要说清楚（不然「没字没图」会被丢掉）
  私聊消息段 = [{ type: 'image', data: { url: 'http://127.0.0.1:9/nope.png' } }]
  私聊消息id = 9271
  私聊消息时间 = Math.floor(Date.now() / 1000) + 780
  const 前图 = 转进的.length
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 120))
  报('图全都没取到 → 照样转进来（不静默丢）', 转进的.length === 前图 + 1, '转进 ' + (转进的.length - 前图) + ' 条')
  const 失败文 = String(转进的.at(-1)?.content?.[0]?.text || '')
  报('还会说明「一张都没取到」', 失败文.includes('一张都没取到'), 失败文.slice(-120))
  私聊消息段 = null
}


// ⭐ 1.0.2：连着发的几条攒成一条（别处报的「发一串图，DSH 一张一张回」）
{
  const 段 = (文) => [{ type: 'text', data: { text: 文 } }]
  const 睡 = (毫秒) => new Promise((r) => setTimeout(r, 毫秒))
  const 写 = (号, 窗口) => writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: 号, 群号: '',
    转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000', 合并窗口秒: 窗口,
  }, null, 2), 'utf8')

  // ① 三条都已经「说完」了 → 一次转成一条（用将来的时间戳，省得跟水位打架）
  const 现在1 = Math.floor(Date.now() / 1000)
  写('781', 3)
  私聊消息们 = []
  await 轮询回调()                     // 先让它给这个号记个水位
  私聊消息们 = [
    { user_id: 781, time: 现在1 + 5, message_id: 9501, message_type: 'private', message: 段('图一') },
    { user_id: 781, time: 现在1 + 6, message_id: 9502, message_type: 'private', message: 段('图二') },
    { user_id: 781, time: 现在1 + 7, message_id: 9503, message_type: 'private', message: 段('图三') },
  ]
  const 前1 = 转进的.length
  await 轮询回调()
  await 睡(60)
  报('连着发的三条 → 只转成一条', 转进的.length === 前1 + 1, '转进 ' + (转进的.length - 前1) + ' 条')
  const 攒好的 = String((转进的.at(-1) || { content: [{}] }).content[0].text || '')
  报('那一条里三条都在', 攒好的.includes('图一') && 攒好的.includes('图二') && 攒好的.includes('图三'), 攒好的.slice(0, 120))

  // ② 最后一条刚发完（在合并窗口里）→ 先攒着，不转
  const 现在2 = Math.floor(Date.now() / 1000)
  写('782', 1)
  私聊消息们 = []
  await 轮询回调()                     // 记水位
  await 睡(1100)
  const 现在3 = Math.floor(Date.now() / 1000)
  私聊消息们 = [
    { user_id: 782, time: 现在3, message_id: 9511, message_type: 'private', message: 段('还在发一') },
    { user_id: 782, time: 现在3, message_id: 9512, message_type: 'private', message: 段('还在发二') },
  ]
  const 前2 = 转进的.length
  await 轮询回调()
  await 睡(60)
  报('最后一条刚发完 → 先不转（等对方说完）', 转进的.length === 前2, '转进 ' + (转进的.length - 前2) + ' 条')

  // ③ 窗口过去了 → 下一跳把它俩一起转
  await 睡(1400)
  await 轮询回调()
  await 睡(60)
  报('窗口过去后 → 两条一起转', 转进的.length === 前2 + 1, '转进 ' + (转进的.length - 前2) + ' 条')
  const 后补 = String((转进的.at(-1) || { content: [{}] }).content[0].text || '')
  报('后补的那条里两条都在', 后补.includes('还在发一') && 后补.includes('还在发二'), 后补.slice(0, 120))

  // ④ 合并窗口 0 → 回到「来一条转一条」
  const 现在4 = Math.floor(Date.now() / 1000)
  写('783', 0)
  私聊消息们 = []
  await 轮询回调()
  私聊消息们 = [
    { user_id: 783, time: 现在4 + 5, message_id: 9521, message_type: 'private', message: 段('一条一') },
    { user_id: 783, time: 现在4 + 6, message_id: 9522, message_type: 'private', message: 段('一条二') },
  ]
  const 前3 = 转进的.length
  await 轮询回调()
  await 睡(80)
  报('合并窗口 0 → 来一条转一条（不攒）', 转进的.length === 前3 + 2, '转进 ' + (转进的.length - 前3) + ' 条')
  私聊消息们 = null
}


// ⭐ 1.0.4（她发的截图）：[QQ] 标记本身绝不能出现在手机上
{
  const 换 = (s) => String(s)
  const 甲 = 模.抠QQ标记(换('[QQ]\n啧，本鱼都喊破音了'), false)
  报('开关关着：正文照发，但把 [QQ] 剥掉',
    甲.发 === true && !甲.文字.includes('[QQ]') && 甲.文字.includes('啧，本鱼都喊破音了'), JSON.stringify(甲))
  const 乙 = 模.抠QQ标记(换('这块不发\n[QQ]发这句[/QQ]\n这块也不发'), true)
  报('开关开着 + 有完整块：只发块里那句', 乙.发 === true && 乙.文字 === '发这句', JSON.stringify(乙))
  const 丙 = 模.抠QQ标记(换('[QQ]\n只写了开头没写闭合'), true)
  报('开关开着 + 忘了闭合：还是发（发 [QQ] 之后的内容）',
    丙.发 === true && 丙.文字 === '只写了开头没写闭合' && !!丙.原因, JSON.stringify(丙))
  const 丁 = 模.抠QQ标记(换('这轮压根没写块'), true)
  报('开关开着 + 没写块：这一轮不发', 丁.发 === false, JSON.stringify(丁))
  const 戊 = 模.抠QQ标记(换('[\u3000QQ\u3000]  带空格的标记也该剥'), false)
  报('带空格的标记也剥掉', 戊.发 === true && !戊.文字.includes('QQ'), JSON.stringify(戊))
}
// 模拟插件重启：每次 apply 重新创建内存状态，只从临时磁盘恢复。
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 补投窗口分: 60, NapCat: 'http://127.0.0.1:3000',
  绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
}), 'utf8')
const 重启时间 = Math.floor(Date.now() / 1000)
async function 重启拉取(水位值, 已转, id, time) {
  writeFileSync(状态文件, JSON.stringify({ 上次: { '私聊:123': 水位值 }, 已转 }), 'utf8')
  私聊消息人 = 123; 私聊消息段 = null; 私聊消息文本 = '重启恢复测试'; 私聊消息id = id; 私聊消息时间 = time
  let tick
  模.apply({ ...ctx, on: () => () => {}, webServer: { register: () => () => {} }, interval: (fn) => { tick = fn; return () => {} } })
  const before = 转进的.length
  tick()
  await new Promise((resolve) => setTimeout(resolve, 100))
  return 转进的.length - before
}
报('模拟重启：恢复水位后接收启动前尚未处理的新消息', await 重启拉取(重启时间 - 60, [9901], 9902, 重启时间 - 30) === 1)
报('模拟重启：同水位时间的已转消息 ID 不重投', await 重启拉取(重启时间 + 60, [9903], 9903, 重启时间 + 60) === 0)
报('模拟重启：水位前未登记 ID 的旧消息不重投', await 重启拉取(重启时间 + 60, [9903], 9904, 重启时间 + 59) === 0)
// ⭐ 1.1.4：#18 「会话清单列不全」—— 没在标签页里打开过的会话，也要能从盘上读出来
{
  const { mkdirSync } = await import('node:fs')
  const 会话目录 = join(家, 'storages', 'session_projcache', 'sessions')
  mkdirSync(会话目录, { recursive: true })
  // 一个普通会话（盘上有、内存里没有）
  writeFileSync(join(会话目录, 'aaaa-1111.json'), JSON.stringify({
    version: 1,
    record: { identity: { cwd: '/x' }, rows: { title: { ver: 1, seq: 3, val: '盘上的会话' } } },
  }), 'utf8')
  // 一个子智能体会话（必须被滤掉）
  writeFileSync(join(会话目录, 'bbbb-2222.json'), JSON.stringify({
    version: 1,
    record: { identity: {}, rows: { subagent: { val: { identity: { mode: 'continuable', label: '刷B站' } } } } },
  }), 'utf8')
  模.apply({ ...ctx, on: () => () => {}, webServer: { register: () => () => {} }, interval: () => () => {} })
  await new Promise((resolve) => setTimeout(resolve, 50))
  存储.length = 0
  await 路由.get('/dsh-qq-bridge/state')([], fakeRes)
  const 清单 = (存储[0] && (存储[0].活着的会话 || 存储[0].会话清单)) || []
  const id们 = 清单.map((x) => x.值 || x.id || x.会话)
  报('会话清单读得到「盘上有、内存里没有」的会话', id们.includes('aaaa-1111'))
  报('会话清单滤掉了子智能体会话', !id们.includes('bbbb-2222'))
  报('盘上那个会话的标题也读出来了', 清单.some((x) => String(x.标题 || x.名 || '').includes('盘上的会话')))
}

// ⭐ 1.1.8：绑定行自己的开关 —— 关掉就整个静音（不收也不发），不用删掉那一行
{
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '私聊', 号码: '789', 会话: 'session-X', 开: false }],
  }, null, 2), 'utf8')
  私聊消息人 = 789
  私聊消息段 = null
  私聊消息文本 = '关着的时候不该转进来'
  私聊消息id = 9400
  私聊消息时间 = Math.floor(Date.now() / 1000) + 900
  const 前 = 转进的.length
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 80))
  报('关掉的绑定：消息不转进来', 转进的.length === 前, '转进 ' + (转进的.length - 前) + ' 条')

  const 配置2 = JSON.parse(readFileSync(join(家, 'qq-bridge-config.json'), 'utf8'))
  配置2.绑定 = [{ 类型: '私聊', 号码: '789', 会话: 'session-X', 开: true }]
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify(配置2, null, 2), 'utf8')
  私聊消息id = 9401
  私聊消息时间 = Math.floor(Date.now() / 1000) + 920
  await 轮询回调()
  await new Promise((r) => setTimeout(r, 80))
  报('勾回来以后照常转进来', 转进的.length === 前 + 1, '转进 ' + (转进的.length - 前) + ' 条')
}

// ⭐ 1.1.7：@ 要变成真的 at 段（OneBot 11 的 `at`），不再只是几个字
{
  const 拆 = 模.拆成消息段
  const 段们 = 拆('你好 @123456789 看这个')
  报('@数字号 → 真的 at 段', 段们.some((x) => x.type === 'at' && x.data.qq === '123456789'), JSON.stringify(段们))
  报('at 前后的文字还在，并且拼成一段', 段们.filter((x) => x.type === 'text').length === 2
    && String(段们[0].data.text).includes('你好'), JSON.stringify(段们))
  报('默认不许 @ 全体（怕炸群）', !拆('@全体成员 开会了').some((x) => x.type === 'at' && x.data.qq === 'all'), '')
  报('打开了才认 @ 全体', 拆('@全体成员 开会了', { 允许全体: true }).some((x) => x.type === 'at' && x.data.qq === 'all'), '')
  const 按名 = (名) => (名 === '阿甲' ? '10001' : '')
  报('@昵称 能在成员表里换成号', 拆('@阿甲 你来', { 按名字: 按名 }).some((x) => x.type === 'at' && x.data.qq === '10001'), '')
  报('找不到的昵称保持普通文字（不乱 @ 人）', 拆('@查无此人 你在吗', { 按名字: 按名 }).every((x) => x.type !== 'at'), '')
  报('没有 @ 的照样只有一段文本', 拆('普通一句话').length === 1 && 拆('普通一句话')[0].type === 'text', '')
}

// ⭐ 1.2.0：私聊进来的话要不要标来源（默认关；开了才加）
{
  const 试私聊 = async (署名值) => {
    writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
      总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 私聊署名: 署名值, 合并窗口秒: 0,
      绑定: [{ 类型: '私聊', 号码: '789', 会话: 'session-X' }],
    }, null, 2), 'utf8')
    私聊消息人 = 789
    私聊消息段 = null
    私聊消息文本 = '从手机发的话'
    私聊消息们 = null
    发送者昵称 = '阿明'
    const 序 = Math.floor(Date.now() % 1000)
    私聊消息id = 9600 + 序
    私聊消息时间 = Math.floor(Date.now() / 1000) + 1000
    const 前 = 转进的.length
    await 轮询回调()
    await new Promise((r) => setTimeout(r, 80))
    return String(转进的.at(-1)?.content?.[0]?.text || '')
  }
  const 原 = await 试私聊('关')
  报('私聊默认不标来源（原样一行）', 原.includes('从手机发的话') && !原.includes('[QQ]') && !/：从手机发的话/.test(原), 原)
  const 前2 = await 试私聊('前缀')
  报('开了「前缀」：正文里带 [QQ]', 前2.includes('[QQ] 从手机发的话'), 前2)
  const 署 = await 试私聊('署名')
  报('开了「署名」：昵称 + 号一起带', 署.includes('阿明（789）：从手机发的话'), 署)
}

// ⭐ 1.4.1：点名之后「接着听」—— 先单独喂纯函数（收 / 不收 / 条数用光 / 超时 / 关掉）
{
  const 判 = 模.该收这条
  const 现在 = 1000000
  const 点名 = 判({ 全听: false, 点名: true, 条: 3, 秒: 60, 现在 })
  报('该收这条：点了名 → 收，并开成「还剩 3 条 / 60 秒」',
    点名.收 === true && Boolean(点名.接听) && 点名.接听.剩 === 3 && 点名.接听.到 === 现在 + 60000, JSON.stringify(点名))
  const 第一条 = 判({ 全听: false, 点名: false, 接听: 点名.接听, 条: 3, 秒: 60, 现在: 现在 + 1000 })
  报('该收这条：接听中的普通消息 → 收，条数减一',
    第一条.收 === true && 第一条.用掉一条 === true && 第一条.接听.剩 === 2, JSON.stringify(第一条))
  const 第二条 = 判({ 全听: false, 点名: false, 接听: 第一条.接听, 条: 3, 秒: 60, 现在: 现在 + 2000 })
  const 第三条 = 判({ 全听: false, 点名: false, 接听: 第二条.接听, 条: 3, 秒: 60, 现在: 现在 + 3000 })
  报('该收这条：最后一条接完 → 接听结束（退回只听点名）',
    第三条.收 === true && 第三条.接听 === null, JSON.stringify(第三条))
  const 第四条 = 判({ 全听: false, 点名: false, 接听: 第三条.接听, 条: 3, 秒: 60, 现在: 现在 + 4000 })
  报('该收这条：条数用光之后的普通消息 → 不收', 第四条.收 === false, JSON.stringify(第四条))
  const 超时 = 判({ 全听: false, 点名: false, 接听: 点名.接听, 条: 3, 秒: 60, 现在: 现在 + 60001 })
  报('该收这条：过了接听时间 → 不收，状态清掉',
    超时.收 === false && 超时.接听 === null && String(超时.原因).includes('时间'), JSON.stringify(超时))
  const 关掉 = 判({ 全听: false, 点名: true, 条: 0, 秒: 120, 现在 })
  报('该收这条：接听条数填 0（关掉）→ 点名那条照收，但不接着听',
    关掉.收 === true && 关掉.接听 === null, JSON.stringify(关掉))
  const 全听 = 判({ 全听: true, 点名: false, 接听: null, 条: 5, 秒: 120, 现在 })
  报('该收这条：全听的群 → 照旧全收', 全听.收 === true && 全听.接听 === null, JSON.stringify(全听))
  const 没接听 = 判({ 全听: false, 点名: false, 接听: null, 条: 5, 秒: 120, 现在 })
  报('该收这条：没点名也没在接听 → 不收（老行为）', 没接听.收 === false, JSON.stringify(没接听))
}

// ⭐ 1.5.0：定时发说说的纯函数 —— 本地时间命中 / 今天发过 / 没到点 / 那条关着 / 没有定时
{
  const 判 = 模.该发说说
  // 用本地时间构造这一刻（宿主也是按本地时间比的，别拿 Date.UTC 去喂）
  const 现在 = new Date(2026, 9, 30, 9, 30, 0).getTime()
  const 表 = [{ 时: '09:30', 权: 1, 开: true }, { 时: '18:00', 权: 4, 开: true }]
  const 中 = 判(表, 现在, new Set())
  报('该发说说：命中且今天没发过 → 发，带回行号和键',
    中.发 === true && 中.行 === 0 && 中.键 === '2026-10-30 09:30', JSON.stringify(中))
  const 发过 = 判(表, 现在, ['2026-10-30 09:30'])
  报('该发说说：命中但今天发过 → 不再发（键照样指回那条）',
    发过.发 === false && 发过.行 === 0 && String(发过.原因).includes('已经发过'), JSON.stringify(发过))
  const 没到 = 判([{ 时: '10:31', 权: 1, 开: true }], 现在, new Set())
  报('该发说说：没到点 → 不发', 没到.发 === false && 没到.行 === -1, JSON.stringify(没到))
  const 关着 = 判([{ 时: '09:30', 权: 1, 开: false }], 现在, new Set())
  报('该发说说：那条关着 → 不发', 关着.发 === false && String(关着.原因).includes('关着'), JSON.stringify(关着))
  const 空表 = 判([], 现在, new Set())
  报('该发说说：定时表是空的 → 不发', 空表.发 === false && 空表.行 === -1, JSON.stringify(空表))
  const 单数 = 判([{ 时: '9:30', 权: 1, 开: true }], 现在, new Set())
  报('该发说说：没补零的时间也认（9:30）', 单数.发 === true, JSON.stringify(单数))
}

// ⭐ 1.4.1：被点名之后，同一个群后面紧跟着的普通消息也放进来（接够条数就停）
{
  const 睡 = (毫秒) => new Promise((r) => setTimeout(r, 毫秒))
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, 群里听所有人: false, 合并窗口秒: 0, 补投窗口分: 60,
    点名后接听条: 2, 点名后接听秒: 60, NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '群', 号码: '654', 会话: 'session-G', 称呼: '群里的人' }],
  }, null, 2), 'utf8')
  群消息们 = []
  await 轮询回调()                 // 先给这个群记个水位（从此刻开始算）
  const 现在 = Math.floor(Date.now() / 1000)
  const 句 = (文) => [{ type: 'text', data: { text: 文 } }]
  const 群条 = (id, 秒, 段) => ({ user_id: 456, time: 秒, message_id: id, message_type: 'group', message: 段 })
  const 点名段 = [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '在吗' } }]
  const 前 = 转进的.length

  群消息们 = [群条(9701, 现在 + 10, 点名段)]
  await 轮询回调()
  await 睡(40)
  报('被 @ 之后：点名那条照常转进来', 转进的.length === 前 + 1, '转进 ' + (转进的.length - 前))
  报('被 @ 之后：这个群开成「接着听 2 条」', 桥.测试.接听('654')?.剩 === 2, JSON.stringify(桥.测试.接听('654')))

  群消息们 = [群条(9702, 现在 + 11, 句('接着说第一句'))]
  await 轮询回调()
  await 睡(40)
  报('接听中：普通消息也转进来（1/2）',
    转进的.length === 前 + 2 && String(转进的.at(-1).content[0].text).includes('接着说第一句'), '转进 ' + (转进的.length - 前))
  报('接听中：每收一条就减一条', 桥.测试.接听('654')?.剩 === 1, JSON.stringify(桥.测试.接听('654')))

  群消息们 = [群条(9703, 现在 + 12, 句('接着说第二句'))]
  await 轮询回调()
  await 睡(40)
  报('接听中：第二条也转进来（2/2）',
    转进的.length === 前 + 3 && String(转进的.at(-1).content[0].text).includes('接着说第二句'), '转进 ' + (转进的.length - 前))
  报('接够条数之后：退回「只听点名」', 桥.测试.接听('654') === null, JSON.stringify(桥.测试.接听('654')))

  群消息们 = [群条(9704, 现在 + 13, 句('没人叫你的话'))]
  await 轮询回调()
  await 睡(40)
  报('条数用光之后的普通消息：不再转进来', 转进的.length === 前 + 3, '转进 ' + (转进的.length - 前))

  群消息们 = [群条(9705, 现在 + 14, 点名段)]
  await 轮询回调()
  await 睡(40)
  报('再被点名 → 又开成接听', 桥.测试.接听('654')?.剩 === 2, JSON.stringify(桥.测试.接听('654')))
  群消息们 = null
}

// ⭐ 1.4.1：QQ 空间的四个工具（看说说 / 看详情 / 好友动态 / 发说说）
{
  // 先清空绑定让空间工具卸下来，再挂回去 —— 挂过一次就不重复挂，不复位一下拿不到新对象
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 绑定: [],
  }, null, 2), 'utf8')
  await 轮询回调()
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 允许发空间动态: false,
    绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X' }],
  }, null, 2), 'utf8')
  注册的工具.length = 0
  await 轮询回调()
  const 找工具 = (名) => 注册的工具.find((x) => x.name === 名)
  const 四个 = ['qq_space_list', 'qq_space_detail', 'qq_space_feeds', 'qq_space_post']
  报('QQ 空间的四个工具都挂上了', 四个.every((名) => Boolean(找工具(名))), 注册的工具.map((x) => x.name).join(','))
  报('空间工具的 parameters 是完整 JSON Schema、并且声明了 output',
    四个.every((名) => {
      const t = 找工具(名)
      return Boolean(t) && t.parameters && t.parameters.type === 'object'
        && t.output && t.output.schema && typeof t.output.render === 'function'
    }), 四个.map((名) => String(找工具(名) && 找工具(名).parameters && 找工具(名).parameters.type)).join(','))

  // ① 闸关着：一调就说没开，一个请求都不发
  const 发说说 = 找工具('qq_space_post')
  空间请求.length = 0
  const 关着 = await 发说说.execute({ content: '这条不该发出去' })
  报('发说说：闸关着 → 明说没开', 关着.ok === false && /没开|关着/.test(String(关着.说)), JSON.stringify(关着))
  报('发说说：闸关着 → 真的一个请求都没发', 空间请求.length === 0, JSON.stringify(空间请求.map((x) => x.url)))

  // ② 闸开着：真发，带回 tid
  writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
    总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000', 允许发空间动态: true,
    绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X' }],
  }, null, 2), 'utf8')
  空间请求.length = 0
  const 发了说说 = await 发说说.execute({ content: '今天的云很好看', images: ['https://x.test/a.jpg'] })
  const 发请求 = 空间请求.find((x) => x.url.endsWith('/send_qzone_msg'))
  报('发说说：闸开着 → 真发出去，带回 tid',
    发了说说.ok === true && String(发了说说.说).includes('发好了') && String(发了说说.说).includes('tid-9988'), JSON.stringify(发了说说))
  报('发说说：正文 / 配图 / 默认所有人可见都带上了',
    Boolean(发请求) && 发请求.体.content === '今天的云很好看' && 发请求.体.ugc_right === 1 && Array.isArray(发请求.体.images),
    JSON.stringify(发请求 && 发请求.体))
  报('发说说：走的是同一套请求头（不另起一套）',
    Boolean(发请求) && String(发请求.headers['user-agent'] || '') === 'dsh-qq-bridge', JSON.stringify(发请求 && 发请求.headers))

  // ③ 16 / 128 没给名单 → 不发、说清原因
  空间请求.length = 0
  const 没名单 = await 发说说.execute({ content: '只给几个人看', ugc_right: 16 })
  报('发说说：部分可见没给名单 → 不发并说清原因',
    没名单.ok === false && String(没名单.说).includes('名单') && 空间请求.length === 0, JSON.stringify(没名单))

  // ④ 看说说
  空间列表回 = { status: 'ok', retcode: 0, data: { total: 2, msglist: [
    { tid: 555, content: '第一条说说', time: 1700000000, comment_num: 3, is_private: true, images: ['a.jpg', 'b.jpg'] },
    { tid: 556, content: '长'.repeat(300), time: 1700000100, comment_num: 0, is_private: false, images: [] },
  ] } }
  const 列表 = await 找工具('qq_space_list').execute({})
  报('看说说：带回总数和每一条的 tid',
    String(列表.说).includes('共 2 条说说') && String(列表.说).includes('tid 555') && String(列表.说).includes('tid 556'), 列表.说)
  报('看说说：时间 / 评论数 / 私密 / 图片数都在',
    String(列表.说).includes('评论 3') && String(列表.说).includes('私密') && String(列表.说).includes('图 2 张'), 列表.说)
  报('看说说：长正文截断到 200 字', !String(列表.说).includes('长'.repeat(201)), '长度 ' + String(列表.说).length)

  // ⑤ 空空间（retcode 100 + wording 里带 msglist:null）不是崩溃
  空间列表回 = { status: 'failed', retcode: 100, wording: '{"retcode":100,"data":{"msglist":null}}' }
  const 空 = await 找工具('qq_space_list').execute({})
  报('空空间：翻译成「还没有说说」，不当成故障', 空.ok === true && String(空.说).includes('还没有说说'), JSON.stringify(空))

  // ⑥ 别的错误：把后端的中文说明带出来，不吐 JSON
  空间列表回 = { status: 'failed', retcode: 1200, wording: '这个号没登录空间' }
  const 错 = await 找工具('qq_space_list').execute({})
  报('被拒：把后端的中文说明带出来（不吐 JSON）', 错.ok === false && String(错.说) === '这个号没登录空间', JSON.stringify(错))

  // ⑦ 好友动态：html 要去标签、压空白
  空间动态回 = { status: 'ok', retcode: 0, data: { has_more: true, feeds: [
    { uin: 10002, nickname: '阿甲', time: 1700000200, appid: 311, key: 'k1',
      html: '<div class="fd"><p>今天  去看了海</p><br/><span>好蓝</span></div>' },
  ] } }
  const 动态 = await 找工具('qq_space_feeds').execute({})
  报('好友动态：去掉了 HTML 标签', !String(动态.说).includes('<') && String(动态.说).includes('阿甲'), 动态.说)
  报('好友动态：多余的空白压掉了', String(动态.说).includes('今天 去看了海 好蓝'), 动态.说)
  报('好友动态：说了还有更多', String(动态.说).includes('还有更多'), 动态.说)

  // ⑧ 一条说说的详情 + 评论
  空间详情回 = { status: 'ok', retcode: 0, data: { tid: 555, content: '第一条说说', comment_num: 1,
    comments: [{ uin: 10002, nickname: '阿甲', content: '好看', time: 1700000300 }] } }
  const 详情 = await 找工具('qq_space_detail').execute({ tid: 555 })
  报('看详情：正文和评论都出来了',
    String(详情.说).includes('第一条说说') && String(详情.说).includes('阿甲') && String(详情.说).includes('好看'), 详情.说)
}

// ⭐ 1.5.0：配置规整 —— 空间定时发（补零 / 坏值丢掉 / 权只认 1·4·64 / 最多 12 条）、看圈分钟的上下限
{
  const 存配置 = async (配置) => {
    writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify(配置, null, 2), 'utf8')
    存储.length = 0
    await 路由.get('/dsh-qq-bridge/save')([JSON.stringify(配置)], fakeRes)
    return 存储[0]
  }
  const 基 = {
    总开关: true, 试运行: false, NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X' }],
  }
  const 一次 = await 存配置({ ...基, 空间定时发: [{ 时: '9:05', 权: 4 }] })
  const 项 = (一次 && 一次.配置 && 一次.配置.空间定时发) || []
  报('规整：9:05 补成 09:05', 项.length === 1 && 项[0].时 === '09:05', JSON.stringify(项))
  报('规整：权 4 留着、没写「开」默认开', 项.length === 1 && 项[0].权 === 4 && 项[0].开 === true, JSON.stringify(项))

  const 坏 = await 存配置({ ...基, 空间定时发: [{ 时: '25:00', 权: 1 }, { 时: '9:5', 权: 1 }, { 时: '09:05', 权: 99 }] })
  const 坏项 = (坏 && 坏.配置 && 坏.配置.空间定时发) || []
  报('规整：坏时间被丢、权 99 当 1', 坏项.length === 1 && 坏项[0].时 === '09:05' && 坏项[0].权 === 1, JSON.stringify(坏项))

  const 多 = []
  for (let i = 0; i < 15; i++) 多.push({ 时: '0' + (i % 10) + ':' + String(i).padStart(2, '0'), 权: 1 })
  const 截 = await 存配置({ ...基, 空间定时发: 多 })
  报('规整：超过 12 条只留前 12 条', ((截 && 截.配置 && 截.配置.空间定时发) || []).length === 12,
    String(((截 && 截.配置 && 截.配置.空间定时发) || []).length))

  const 分钟 = await 存配置({ ...基, 空间看圈分: 9999, 空间看圈开: 'true', 空间点赞开: 1, 空间评论开: true })
  报('规整：看圈分钟拉到 1440、开关只认 === true',
    分钟.配置.空间看圈分 === 1440 && 分钟.配置.空间看圈开 === false
      && 分钟.配置.空间点赞开 === false && 分钟.配置.空间评论开 === true,
    JSON.stringify([分钟.配置.空间看圈分, 分钟.配置.空间看圈开, 分钟.配置.空间点赞开, 分钟.配置.空间评论开]))
  const 低 = await 存配置({ ...基, 空间看圈分: 1 })
  报('规整：看圈分钟低于 5 拉回 5', 低.配置.空间看圈分 === 5, String(低.配置.空间看圈分))
}

rmSync(家, { recursive: true, force: true, maxRetries: 3 })
console.log(`\n${挂了 === 0 ? '全部通过 ✅' : `有 ${挂了} 条没过 ❌`}`)
process.exitCode = 挂了 === 0 ? 0 : 1
