// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   伙伴在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），走标准的 OneBot 11 HTTP。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, renameSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'qq-bridge'

/** 需要宿主提供：webServer（路由）+ sessions/sessionTitle（目标会话清单 + 标题）+ agents（followup）+ timer（轮询收消息）+ attachments（图片）。 */
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'tools']

// ---------- 常量 ----------

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'qq-bridge-config.json')
const 路由前缀 = '/dsh-qq-bridge'
const 日志上限 = 60

const 默认配置 = {
  总开关: false, // 关着 = 一句都不发（安全默认）
  试运行: true, // 开着 = 只记账、不真发到 QQ
  目标会话: '', // ⚠️ 老字段（= 私聊会话）。还认，读的时候会搬进「私聊会话」
  私聊会话: '', // ⭐ QQ 私聊那一路进哪一间（2026-10-25 拆开）
  群会话: '', //   ⭐ QQ 群里那一路进哪一间（可以留空 = 不看群）
  私聊QQ: '', // 发到哪个私聊（QQ 号，字符串）
  群号: '', // 发到哪个群（可空）
  转私聊: true,
  转群: false,
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口
  令牌: '', // ⭐ access_token（2026-10-25）：NapCat / SnowLuma 开了鉴权就填这里，留空 = 不鉴权
  // ⭐ 2026-10-22：图片两个方向
  收图: true, // QQ → DSH：她发的图片也转进来
  收图最多: 4, // 一条消息最多转几张
  发图: true, // DSH → QQ：伙伴发的图片也发过去
  图上限MB: 5, // 单张最大多少 MB（两个方向共用）
  图片根目录: '', // 正文里 `![名字](相对路径)` 按哪个目录去找（留空 = 自动猜）
  称呼: '对方', // ⭐ 私聊时怎么称呼跟它说话的那个人（写进转给它的文案里，比如「小明发来了图片」）
  回复门槛: false, // ⚠ 已废弃（2026-10-25）：门槛改成「按绑定行走」——老配置里是 true 的会在迁移时变成那一行的门槛
  // ⭐ 0.7.0（用户 GAME-66 的建议，issue #2）出站两个闸，默认都关
  只发标记内: false, // 开着 = 只发正文里 [QQ]…[/QQ] 那一段（块外的解释/路径/思考留在本地）
  只回QQ唤醒: false, // 开着 = 只有「这一轮是被 QQ 消息叫醒的」才发（你在 DSH 里自己聊的不推到手机）
  // ⭐ 0.8.0：语音转写（QQ 语音条 → 文字）。插件自己不带模型，只负责把音频交给「你指定的命令」。
  语音转写: false,
  转写命令: '', // 模板，里面必须带 {file}；例如：python D:sr.py "{file}"
  语音模型目录: '', // 语音模型放哪（SenseVoice 的 model.int8.onnx + tokens.txt 所在目录）
  转写超时秒: 60,
  补投窗口分: 10, // 会话关着期间攒下的消息，超过这么多分钟就不再补投
  // ⭐ 2026-10-25（QQ 桥用户反馈「一次回一堆消息」）：长回复按空行拆成几条连发，以前是写死的。
  长回复拆段: true, // 关掉 = 一整段只发一条消息（不再刷屏）
  拆段间隔毫秒: 450, // 每段之间隔多久（太短像刷屏，太长像卡住）
  // ⭐ 1.4.3：按**句子**拆（不再是「按空行」）。默认关 —— 老用户升级后行为不变。
  //   开着时：按中英文句末标点（。！？；… 和 .!?;）切，每句一条；括号里的标点不算断句。
  //   为什么要有：模型经常一整段不带空行，按空行拆等于没拆，发出去一大坨。
  按句拆: false,
  // ⭐ 2026-10-25：门槛判定「不接」时，要不要**真把这一轮停掉**。
  //   · 关（默认）：不停轮，只把这轮的「出站」掐掉 —— 界面干净，但模型会把这轮想完（费一点 token）
  //   · 开：调用 agent.cancel() 停轮 —— 这才是真的「停止思考」，代价是界面上会出现
  //        `Error: tool call aborted`（那是停轮的**表现**，不是故障），有的宿主还会「重试模型请求」
  门槛真停轮: false,
  // ⭐⭐ 2026-10-25：绑定列表 —— 一行 = 一个聊天（私聊/群）→ 一间 DSH 会话
  //   { 类型: '私聊' | '群', 号码: 'QQ号或群号', 会话: 'session-…', 称呼: '小明', 门槛: false }
  绑定: [],
  群称呼: '群里的人', // ⭐ 群聊时怎么称呼（群里不止一个人，一般别填某个人的名字）
  // ⭐ 1.0.1（issue #6）：一次 QQ 消息触发的**整个回复过程**都算「QQ 起的头」。
  //   第一轮发完之后，还留这么长的「尾巴」——尾巴内的后续轮次也往外发。
  //   0 = 关掉尾巴（回到老行为：只有紧跟的那一轮能发）。
  唤醒尾巴秒: 90,
  // ⭐ 0.9.9：群里**只收点了名的**（@ 你 / 引用你）。开了这个就把群里所有人的话都转进来，
  //    交给「门槛」去判断要不要接 —— 更自然，但更贵、也更吵。
  群里听所有人: false,
  // ⭐ 1.4.1：被点名（@ / 引用）之后，同一个群里**后面紧跟着的普通消息**也放进来，
  //    接够这么多条 / 过了这么多秒就停，回到「只听点名」——不然接话接不上前文。
  //    · 点名后接听条 = 0 → 关掉（回到老行为：只有点了名的那一条进得来）
  //    · 状态按聊天分开记（见 接听中），一个群接听不影响别的群；私聊没有这一层
  点名后接听条: 5,
  点名后接听秒: 120,
  // ⭐ 1.4.1：QQ 空间。看说说 / 好友动态不需要开闸；**发说说**单独一道闸，默认关。
  允许发空间动态: false,
  // ⭐ 1.5.0：空间的自动节奏。
  //   · 空间定时发 = 到点往会话里递一句提醒（说什么由它自己写，这里只定时间）
  //   · 空间看圈开/空间看圈分 = 定时拉一圈好友动态；点赞、评论两个开关管这一圈里做什么
  空间定时发: [],          // [{ 时: 'HH:MM', 权: 1|4|64, 开: true }]，最多 12 条
  空间看圈开: false,
  空间看圈分: 30,          // 5~1440
  空间点赞开: false,
  空间评论开: false,
  // ⭐ 1.0.2（别处报的「发一串图，DSH 一张一张回」）：连着发的几条**攒成一条**再转进来。
  //   · 0 = 不攒（来一条转一条，跟以前一样）
  //   · >0 = 同一个人在这段时间内连着发的，合成一条（私聊、群都管用）
  //   实现上是「等一小会儿再收」：最后一条没过去这么久，就先不消费，下一跳连新的那条一起收。
  //   ⚠ 别开大：一轮拉历史里本来就能看到「已经发完的那一串」，这里只兜「正好撞上轮询」的那一下。
  合并窗口秒: 1,
  // 最多攒多久（秒）：有人一直发个不停，到点也得先转进来，不能无限等
  合并最多秒: 20,
  // ⭐ 1.1.0（别人要的）：人设（选填）。**塞进每条转进去的消息最前面**，每轮都带。
  //   · 总开关关着 = 一个字都不带；
  //   · 每条绑定可以单独写一份 —— 那一行就用自己的，没写的用上面这份总的。
  //   ⚠ 为什么不做成系统提示词：别人的插件是自己 agents.create 建的会话，
  //     我们这边是往用户已有的会话里塞消息，接管它的系统提示词太侵入。
  人设开: false,
  人设: '',

  // ⭐ 1.0.9（她说的「群里太吵，要能调回复频率」）：群聊的节奏
  //   ⚠ 只有两个数（多了看不懂）——一个管「隔多久」，一个管「一分钟最多几条」
  回复冷却秒: 5,        // 回完一次，这么久之内不再起新的一轮（1.1.7 起 @ 它的也照样排队）
  每分钟最多条: 4,      // 一分钟里最多送进去几条；超了这批先等着，等窗口腾出位置再送（不丢）
  合并最多条: 8,        // 一个聊天一次最多攒几条合并成一条转进去
  // ⭐ 1.0.9：掷骰子 —— 群里的闲聊不一定每句都接。**没掷中就不送进来**（不进 DSH、不占上下文、
  //   也不花 token），跟「送进来再判不接」是两回事。点数名的照旧必接。100 = 每批都接。
  回复概率: 100,        // 1.1.3 起由下面那个开关决定 @ 的话掷不掷
  // ⭐ 1.1.3：@ / 引用 的消息要不要也掷骰子（默认不掷：冲你来的就回）
  点名必回: true,
  // ⭐ 1.1.7：让不让它 @ 全体成员（默认不让，怕一次把全群炸起来）
  能艾特全体: false,
  // ⭐ 1.3.0：每条进来的消息前面加一行**来源头**（【QQ群 123456】/【QQ私聊】/【本机注入】），
  //   正文里的【】会被换成 [] —— 防别人打一句「【QQ私聊·主人·123】…」冒充系统。
  来源头: true,
  // ⭐ 1.2.0：私聊进来的话在正文里标一下来源（默认关）。
  //   '关' / '前缀'（[QQ] 开头）/ '署名'（对面：…）—— 同一个会话里手机和电脑交替说话时用来分辨。
  私聊署名: '关',
  // ⭐ 1.0.2：多久去 NapCat 拉一次新消息（毫秒）。原来写死 4 秒，单条消息最坏要等 4 秒才进来。
  轮询间隔毫秒: 2000,
}

/** 包根目录（用它读自己包里的东西，比如 tools/asr_cli.py） */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 版本从 package.json 读。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

/** 跑一条外部命令（异步、带超时、拿 stdout）。
 *  ⭐ 语音转写用：插件自己**不带 ASR 模型**，只负责「把音频文件交给用户指定的命令，拿回文字」。
 *  这样本机 whisper / SenseVoice / 云端 API 都能接，插件也不会因为塞模型变成几百 MB。 */
function 跑命令(模板, 文件, 超时秒) {
  return new Promise((resolve) => {
    const 命令 = String(模板 || '').replace(/\{file\}/g, 文件)
    let 出 = ''
    let 错 = ''
    let 收过 = false
    const 收 = (v) => { if (收过) return; 收过 = true; resolve(v) }
    let 子 = null
    try {
      子 = spawn(命令, {
        shell: true, windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      return 收({ ok: false, 错: String((error && error.message) || error) })
    }
    const 定时 = setTimeout(() => {
      try { 子.kill() } catch (error) {}
      收({ ok: false, 错: '超时（' + 超时秒 + ' 秒）' })
    }, Math.max(5, Number(超时秒) || 60) * 1000)
    子.stdout.on('data', (c) => { 出 += c })
    子.stderr.on('data', (c) => { 错 += c })
    子.on('error', (error) => { clearTimeout(定时); 收({ ok: false, 错: String((error && error.message) || error) }) })
    子.on('close', (码) => {
      clearTimeout(定时)
      收({ ok: 码 === 0, 文字: 出.trim(), 错: (错.trim() || ('退出码 ' + 码)) })
    })
  })
}

/** 把「语音段」里的东西落成本地文件（QQ 给的有三种形态：http 链接 / base64:// / 本地文件名）
 *  ⚠️ 2026-10-25 修（她实测报的）：以前直接把 `file` 丢给转写命令 —— 那个值经常是
 *     `https://multimedia.nt.qq.com.cn/download?appid=...` 这种**网络地址**，
 *     命令当然找不到文件，就报「找不到音频文件」。现在先下载/解码到本地再交给它。 */
async function 语音落文件(段, 拉任意, 家目录, 名) {
  const d = (段 && 段.data) || {}
  const 原 = String(d.file || d.url || '')
  const 直链 = String(d.url || '') || (/^https?:/i.test(原) ? 原 : '')
  const 落盘 = (字节, 扩展) => {
    try {
      const 目录 = join(家目录, 'audio')
      mkdirSync(目录, { recursive: true })
      const 文件 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.' + 扩展)
      writeFileSync(文件, 字节)
      return 文件
    } catch (error) { return '' }
  }
  const 从地址取扩展 = (u) => {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(u || ''))
    const e = m ? m[1].toLowerCase() : ''
    return ['wav', 'mp3', 'amr', 'silk', 'ogg', 'm4a', 'flac'].includes(e) ? e : 'amr'
  }
  // ① 先问后端：get_record 能直接给 wav（它自己会解 silk）—— 这是最省事的一条路
  if (原) {
    try {
      const r = await 拉任意('get_record', { file: 原, out_format: 'wav' })
      if (r) {
        const 本地 = r.file || r.path
        if (本地 && existsSync(String(本地))) return String(本地)
        if (r.base64) {
          try {
            const f = 落盘(Buffer.from(String(r.base64).replace(/^data:[^,]*,/, ''), 'base64'), 'wav')
            if (f) return f
          } catch (error) {}
        }
      }
    } catch (error) {}
  }
  // ② 网络地址 → 下载
  const 拿地址 = 直链 || (/^https?:/i.test(原) ? 原 : '')
  if (拿地址) {
    try {
      const r = await fetch(拿地址)
      if (r && r.ok) {
        const 字节 = Buffer.from(await r.arrayBuffer())
        const f = 落盘(字节, 从地址取扩展(拿地址))
        if (f) return f
      }
    } catch (error) {}
  }
  // ③ base64:// 或本来就是本地文件
  if (原.startsWith('base64://')) {
    try {
      const f = 落盘(Buffer.from(原.slice('base64://'.length), 'base64'), 'amr')
      if (f) return f
    } catch (error) {}
  }
  if (原 && existsSync(原)) return 原
  return ''
}

/** 不是 wav 就转成 16k 单声道 wav（用 ffmpeg；找不到就原样交给命令，让命令自己想办法） */
async function 转成wav(路径, ffmpeg, 家目录, 名) {
  if (!路径 || /\.wav$/i.test(路径)) return 路径
  if (!ffmpeg) return 路径
  try {
    const 目录 = join(家目录, 'audio')
    mkdirSync(目录, { recursive: true })
    const 出 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.wav')
    const 结果 = await new Promise((resolve) => {
      let 子 = null
      try {
        子 = spawn(ffmpeg, ['-y', '-i', 路径, '-ar', '16000', '-ac', '1', 出], { windowsHide: true })
      } catch (error) { return resolve(false) }
      子.on('error', () => resolve(false))
      子.on('close', (码) => resolve(码 === 0 && existsSync(出)))
    })
    return 结果 ? 出 : 路径
  } catch (error) { return 路径 }
}

/** 一条 QQ 语音 → 文字。插件只做三件事：拿到音频 → 交给命令 → 拿回文字。
 *  ⚠️ 没配命令、或者没开开关，就退化成 `[语音]` 三个字（跟以前一样）。 */
async function 转写语音(段, 拉任意, 配置, 选项 = {}) {
  const 模板 = String((配置 && 配置.转写命令) || '')
  if (!配置 || !配置.语音转写 || !模板.includes('{file}')) return '[语音]'
  const 家目录 = 选项.家目录 || ''
  const 名 = 'qq-voice-' + (选项.消息id || Date.now())
  const 本地 = await 语音落文件(段, 拉任意, 家目录, 名)
  if (!本地) return '[语音（没下到音频）]'
  const 就绪 = await 转成wav(本地, 选项.ffmpeg || '', 家目录, 名)
  const 结果 = await 跑命令(模板, 就绪, 配置.转写超时秒)
  if (结果.ok && 结果.文字) return '（语音）' + 结果.文字
  return '[语音（转写失败：' + String(结果.错 || '没输出').slice(0, 60) + '）]'
}

/** 找 ffmpeg：环境变量 → PATH → 装依赖时随手装的那份 imageio-ffmpeg。
 *  语音要转成 wav 才能喂给识别命令，没有 ffmpeg 就只能把原始文件交出去。 */
let ffmpeg缓存 = null
async function 找ffmpeg() {
  if (ffmpeg缓存 !== null) return ffmpeg缓存
  const 试 = async (命令, 参数) => {
    try {
      const 码 = await new Promise((resolve) => {
        let 子 = null
        try { 子 = spawn(命令, 参数, { windowsHide: true }) } catch (error) { return resolve(-1) }
        子.on('error', () => resolve(-1))
        子.on('close', (c) => resolve(c === null ? -1 : c))
      })
      return 码 === 0
    } catch (error) { return false }
  }
  if (process.env.FFMPEG && await 试(process.env.FFMPEG, ['-version'])) return (ffmpeg缓存 = process.env.FFMPEG)
  if (await 试('ffmpeg', ['-version'])) return (ffmpeg缓存 = 'ffmpeg')
  // 装依赖时装了 imageio-ffmpeg 的话，它自带一个静态 ffmpeg
  try {
    const 脚本 = 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'
    const r = await 跑命令('"' + ASRpython + '" -c "' + 脚本.replace(/"/g, '\\"') + '"', '', 20)
    if (r && r.ok && r.文字 && existsSync(r.文字)) return (ffmpeg缓存 = r.文字.trim())
  } catch (error) {}
  return (ffmpeg缓存 = '')
}

// ---------- 配置读写 ----------

function 布(值, 兜) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜
}

/** 把「绑定」整成干净的清单：类型只能是私聊/群；号码和会话都要有；
 *  **同一个会话只能绑一条**、**同一个聊天也只能绑一条**（串消息就是从这里来的）。
 *  老配置（只有一个私聊会话 + 一个群会话）会自动变成两行，不用手动搬。 */
function 规整绑定(raw, 混, 字, 布) {
  const 出 = []
  const 见聊天 = new Set()
  const 收一条 = (x) => {
    const t = String((x && x.类型) || '').trim()
    const 类型 = t === '私聊' ? '私聊' : (t === '群' ? '群' : '')
    if (!类型) return null
    const 号码 = 字(x && x.号码)
    const 会话 = 字(x && x.会话)
    if (!号码 || !会话) return null
    const 称呼 = (字(x && x.称呼) || (类型 === '群' ? '群里的人' : '对方')).slice(0, 16)
    const 聊天键 = 类型 + ':' + 号码
    if (见聊天.has(聊天键)) return null
    // ⭐ 1.4.0：**一个会话可以绑多个聊天**（比如私聊 + 一个群，两边都收/都发）。
    //   以前这里挡「一个会话只绑一条」，于是「同一间会话既绑私聊又绑群」做不到。
    见聊天.add(聊天键)
    return {
      类型, 号码, 会话, 称呼, 门槛: 布(x && x.门槛, false),
      // ⭐ 1.1.0：这一条聊天可以有自己的「人设」（空 = 用上面那个总的人设）
      // ⭐ 1.4.3：不再截到 2000 字 —— 以前超出的部分被**静默**截掉，用户不知道后半截没生效。
      //   现在只做上限保护（2 万字），超了由设置页明确提示，不再悄悄砍。
      人设: String((x && x.人设) || '').slice(0, 20000),
      // ⭐ 1.1.8：这一条聊天自己的开关
      //   开 = false：这个群/私聊整个静音（不收也不发），配置留着，随时勾回来
      开: 布(x && x.开, true),
      //   只听点名 = true：这个群平时不读，只有 @ / 引用它才进来（null = 跟全局「群里听所有人」走）
      只听点名: x && x.只听点名 == null ? null : 布(x.只听点名, false),
      // ⭐ 1.4.3：不听点名也直接收的 QQ 号（逗号/空格/换行分隔）。
      //   「只听点名」对**群里所有人**生效（包括自己、包括机器人自己以外的任何号），
      //   只有这里列出来的号例外 —— 他们说的话不用点名也收。
      点名例外: String((x && x.点名例外) || '')
        .split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean).slice(0, 30).join(','),
    }
  }
  if (Array.isArray(raw)) {
    for (const x of raw.slice(0, 30)) {
      const r = 收一条(x)
      if (r) 出.push(r)
    }
  }
  if (!出.length) {
    // 老配置迁移：私聊会话 / 群会话 → 两行
    const 私会话 = 字(混.私聊会话) || 字(混.目标会话)
    const 私号 = 字(混.私聊QQ)
    const 群会话 = 字(混.群会话)
    const 群号2 = 字(混.群号)
    if (私会话 && 私号) 出.push({ 类型: '私聊', 号码: 私号, 会话: 私会话, 称呼: (字(混.称呼) || '对方').slice(0, 16), 门槛: false })
    if (群会话 && 群号2) 出.push({ 类型: '群', 号码: 群号2, 会话: 群会话, 称呼: (字(混.群称呼) || '群里的人').slice(0, 16), 门槛: false })
  }
  return 出
}

function 归一化(原始) {
  const 是对象 = 原始 && typeof 原始 === 'object' && !Array.isArray(原始)
  const 混 = 是对象 ? { ...默认配置, ...原始 } : { ...默认配置 }
  const 字 = (v) => (typeof v === 'string' ? v.trim() : '')
  const 数 = (v, 兜, 低, 高) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return 兜
    return Math.max(低, Math.min(n, 高))
  }
  const 绑定 = 规整绑定(混.绑定, 混, 字, 布)
  // 老配置迁移：以前是「总开关」带动全部，现在按行走 —— 总开关开过的话，把群那几行补上
  if (布(混.回复门槛, false)) {
    for (const 行 of 绑定) if (行.类型 === '群' && !行.门槛) 行.门槛 = true
  }
  const 私聊行 = 绑定.find((x) => x.类型 === '私聊') || null
  const 群行 = 绑定.find((x) => x.类型 === '群') || null
  // ⭐ 1.5.0：空间定时发 —— 只认对象数组；时间用 HH:MM 校验并补成两位；权只留 1/4/64；最多 12 条
  const 空间定时发 = []
  for (const x of Array.isArray(混.空间定时发) ? 混.空间定时发 : []) {
    if (空间定时发.length >= 12) break
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(x.时 == null ? '' : x.时).trim())
    if (!m) continue
    空间定时发.push({
      时: String(m[1]).padStart(2, '0') + ':' + m[2],
      权: [1, 4, 64].includes(Number(x.权)) ? Number(x.权) : 1,
      开: 布(x.开, true),
    })
  }
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    // ⭐ 下面这几个老字段现在**从绑定反推**（只留一份真数据，避免两套说法打架）：
    //    私聊会话/群会话 = 绑定里第一条私聊 / 第一条群；老代码还看它们，行为不变。
    私聊会话: 私聊行 ? 私聊行.会话 : '',
    群会话: 群行 ? 群行.会话 : '',
    目标会话: 私聊行 ? 私聊行.会话 : '',
    私聊QQ: 私聊行 ? 私聊行.号码 : 字(混.私聊QQ),
    群号: 群行 ? 群行.号码 : '',
    // ⚠️ 2026-10-25（她报的「群里没收到它的回复」）：这两个老开关界面上已经不显示了，
    //    却还在拦发送 —— 她加了群绑定、但 转群 还是默认 false，于是群里一条都收不到。
    //    现在**有那一行就代表要发**：直接从绑定推。
    转私聊: 绑定.some((b) => b.类型 === '私聊'),
    转群: 绑定.some((b) => b.类型 === '群'),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
    令牌: 字(混.令牌),
    绑定,
    收图: 布(混.收图, 默认配置.收图),
    发图: 布(混.发图, 默认配置.发图),
    收图最多: 数(混.收图最多, 默认配置.收图最多, 1, 10),
    图上限MB: 数(混.图上限MB, 默认配置.图上限MB, 1, 30),
    图片根目录: 字(混.图片根目录),
    称呼: (私聊行 ? 私聊行.称呼 : (字(混.称呼) || 默认配置.称呼)),
    // ⚠ 老字段，只用来迁移：以前「总开关 + 每行」两个一起管太难懂，
    //    现在**只认每一行自己的门槛**；老配置里总开关是开的，就给群那几行默认打开。
    回复门槛: 布(混.回复门槛, 默认配置.回复门槛),
    只发标记内: 布(混.只发标记内, 默认配置.只发标记内),
    只回QQ唤醒: 布(混.只回QQ唤醒, 默认配置.只回QQ唤醒),
    语音转写: 布(混.语音转写, 默认配置.语音转写),
    转写命令: 字(混.转写命令).slice(0, 400),
    语音模型目录: 字(混.语音模型目录).slice(0, 400),
    转写超时秒: 数(混.转写超时秒, 默认配置.转写超时秒, 5, 600),
    补投窗口分: 数(混.补投窗口分, 默认配置.补投窗口分, 1, 240),
    长回复拆段: 布(混.长回复拆段, 默认配置.长回复拆段),
    拆段间隔毫秒: 数(混.拆段间隔毫秒, 默认配置.拆段间隔毫秒, 0, 5000),
    门槛真停轮: 布(混.门槛真停轮, 默认配置.门槛真停轮),
    群称呼: (群行 ? 群行.称呼 : (字(混.群称呼) || 默认配置.群称呼)),
    // ⭐ 0.9.9：群里只收「点了名」的；开了这个就收全群（交给门槛判）
    群里听所有人: 布(混.群里听所有人, 默认配置.群里听所有人),
    // ⭐ 1.4.1：点名之后接着听几条 / 几秒（条 = 0 就是关掉）
    点名后接听条: 数(混.点名后接听条, 默认配置.点名后接听条, 0, 50),
    点名后接听秒: 数(混.点名后接听秒, 默认配置.点名后接听秒, 0, 600),
    允许发空间动态: 布(混.允许发空间动态, 默认配置.允许发空间动态),
    // ⭐ 1.5.0：空间自动节奏（三个开关一律 === true 才算开，别的值都当关）
    空间定时发,
    空间看圈开: 混.空间看圈开 === true,
    空间看圈分: 数(混.空间看圈分, 默认配置.空间看圈分, 5, 1440),
    空间点赞开: 混.空间点赞开 === true,
    空间评论开: 混.空间评论开 === true,
    唤醒尾巴秒: 数(混.唤醒尾巴秒, 默认配置.唤醒尾巴秒, 0, 600),
    // ⭐ 1.0.2：连着发的几条攒成一条（0 = 不攒）
    合并窗口秒: 数(混.合并窗口秒, 默认配置.合并窗口秒, 0, 60),
    合并最多秒: 数(混.合并最多秒, 默认配置.合并最多秒, 3, 300),
    // ⭐ 1.0.9：群聊的节奏（两个数：隔几秒 / 一分钟最多几条）
    回复冷却秒: 数(混.回复冷却秒, 默认配置.回复冷却秒, 0, 300),
    每分钟最多条: 数(混.每分钟最多条, 默认配置.每分钟最多条, 1, 120),
    合并最多条: 数(混.合并最多条, 默认配置.合并最多条, 1, 50),
    回复概率: 数(混.回复概率, 默认配置.回复概率, 0, 100),
    点名必回: 布(混.点名必回, 默认配置.点名必回),
    能艾特全体: 布(混.能艾特全体, 默认配置.能艾特全体),
    来源头: 布(混.来源头, 默认配置.来源头),
    私聊署名: ['关', '前缀', '署名'].includes(String(混.私聊署名 || '').trim())
      ? String(混.私聊署名).trim()
      : (混.私聊署名 === true ? '前缀' : 默认配置.私聊署名),
    // ⭐ 1.1.0：人设（选填）
    人设开: 布(混.人设开, 默认配置.人设开),
    人设: 字(混.人设).slice(0, 20000),
    轮询间隔毫秒: 数(混.轮询间隔毫秒, 默认配置.轮询间隔毫秒, 800, 30000),
  }
}

// ---------- 图片小工具（两个方向共用）----------
// ⭐ 2026-10-22 加：QQ 的图片段（OneBot）可能给 http url、本地路径、base64 三种形态，
//    这里统一成字节；大小和类型都在收的时候判，判不了就当 jpeg。

/** 收进来的图存一份到这儿（纯文本模型看不见图，至少能从文字里找到路径） */
/**
 * ⭐ 2026-10-23：会话 id 有两种写法（`xxx` / `session-xxx`）。找agent 两种都认，
 *    但事件过滤、归档判断、设置页高亮这些地方原来是**字面比较** ⇒ 存的是裸 id 时就对不上。
 *    统一用「去掉 session- 前缀」的键来比。
 */
const 会话键 = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 收图目录 = join(目录, 'qq-bridge-inbox')

/**
 * ⭐ 2026-10-22：DSH 存图时会留一份「归一化副本」（官方文档原话：may be resized or re-encoded），
 *    GIF 到这一步就变成静态 webp 了 —— 所以回发时必须用**我们自己留的原图**。
 *    这张表记「附件 id → 我们存的原图路径」，回发时先查它。
 */
const 收图表 = join(目录, 'qq-bridge-received.json')

function 读收图表() {
  try {
    const j = JSON.parse(readFileSync(收图表, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch (error) {
    return {}
  }
}

/** 路径统一：去掉两头引号/空格，Windows 下大小写不敏感 */
const 清路径 = (p) => String(p || '').trim().replace(/^["']+|["']+$/g, '').trim()

/**
 * 记「附件 / DSH 那份只读副本 → 我们存的原图」。
 * ⚠ 两个键都要记：伙伴回发时可能用附件 id（附件块），也可能照抄 DSH 给的那条
 *   只读副本路径（正文里的 markdown 图）—— 后者是常见情况，第一次就漏了。
 */
function 记收图(附件id, 副本路径, 原图路径) {
  const 原 = String(原图路径 || '').trim()
  if (!原) return
  const id = String(附件id || '').trim()
  const 副 = 清路径(副本路径)
  if (!id && !副) return
  try {
    const 表 = 读收图表()
    const 记 = { p: 原, t: Date.now() }
    if (id) 表['id:' + id] = 记
    if (副) 表['p:' + 副.toLowerCase()] = 记
    // 只留最近 200 条，别让这个文件无限长
    const 留 = Object.entries(表).sort((a, b) => Number((b[1] && b[1].t) || 0) - Number((a[1] && a[1].t) || 0)).slice(0, 200)
    writeFileSync(收图表, JSON.stringify(Object.fromEntries(留)), 'utf8')
  } catch (error) {}
}

/** 这张图能不能换回原图？键可以是 `id:<附件id>`，也可以是 `p:<副本路径>` */
function 原图路径(键) {
  const k = String(键 || '').trim()
  if (!k) return ''
  const 表 = 读收图表()
  const 记 = 表[k] || 表[k.toLowerCase()] || 表[String(k).replace(/^id:/, '')]
  const p = 记 && typeof 记.p === 'string' ? 记.p : ''
  if (!p) return ''
  try { return existsSync(p) ? p : '' } catch (error) { return '' }
}

const 扩展 = (类) => (类 === 'image/png' ? 'png' : 类 === 'image/gif' ? 'gif' : 类 === 'image/webp' ? 'webp' : 'jpg')

function 看图类(字节) {
  try {
    if (字节[0] === 0x89 && 字节[1] === 0x50) return 'image/png'
    if (字节[0] === 0x47 && 字节[1] === 0x49) return 'image/gif'
    if (字节[0] === 0x52 && 字节[1] === 0x49 && 字节[8] === 0x57) return 'image/webp'
  } catch (error) {}
  return 'image/jpeg'
}

/** 从 OneBot 的图片段里把字节抠出来：url → file(本地/base64://) 依次试 */
async function 取图字节(数据) {
  const d = 数据 || {}
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (url) {
    if (url.startsWith('file://')) {
      try { return readFileSync(new URL(url)) } catch (error) {}
    } else if (/^https?:/i.test(url)) {
      try {
        const r = await fetch(url)
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      } catch (error) {}
    }
  }
  const f = typeof d.file === 'string' ? d.file.trim() : ''
  if (f.startsWith('base64://')) {
    try { return Buffer.from(f.slice('base64://'.length), 'base64') } catch (error) {}
  }
  if (f && (f.includes('\\') || f.includes('/'))) {
    try { return readFileSync(f) } catch (error) {}
  }
  return null
}

/** 存一份到收图目录，返回路径（存不下就返回空串，不影响转图） */
function 存一张(名字, 字节, 类) {
  try {
    mkdirSync(收图目录, { recursive: true })
    const p = join(收图目录, `${名字}.${扩展(类)}`)
    writeFileSync(p, 字节)
    return p
  } catch (error) {
    return ''
  }
}

function 读配置() {
  try {
    return 归一化(JSON.parse(readFileSync(配置文件, 'utf8')))
  } catch (error) {
    return 归一化(null)
  }
}

function 写配置(配置) {
  try {
    mkdirSync(目录, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(配置, null, 2), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// ---------- 纯函数（导出给冒烟测试喂） ----------

/** 从一条 assistant 消息里只抽出正文（text 块拼起来；reasoning / image 都不要）。 */
/**
 * ⭐ 0.9.9：「这条是不是点了我的名」——@ 了我，或引用的是我发过的消息。纯函数，方便自测。
 */
export function 识别点名(段们, 自己QQ, 己方消息) {
  const 我 = String(自己QQ || '')
  let 点名 = false
  for (const 段 of Array.isArray(段们) ? 段们 : []) {
    if (!段 || !段.data) continue
    const 型 = String(段.type || '')
    if (型 === 'at' && 我 && String(段.data.qq || '') === 我) 点名 = true      // at 全体（qq='all'）不算
    if (型 === 'reply' && 段.data.id != null && 己方消息 && typeof 己方消息.has === 'function'
        && 己方消息.has(String(段.data.id))) 点名 = true
  }
  return 点名
}

/**
 * ⭐ 1.4.1：群里这一条要不要放进来 —— 纯函数，方便单独喂。
 *
 * 群里默认「只听点名」时，只认 @ 我 / 引用我的；但被点名之后**后面紧跟着那几句**才是
 * 真正在跟我说话的内容，全丢掉就会接不上前文。所以点名之后开一段「接听」：
 *   · 点名的那一条：收，并且把接听状态重置成「还剩 点名后接听条 条 / 到 现在 + 点名后接听秒 为止」；
 *   · 接听中进来的普通消息：收，**每收一条把剩余条数减一**（这条不算点名，不重置条数）；
 *   · 条数用光 / 过了时间：这个群自己退回「只听点名」。
 * 状态按聊天分开存（调用方按「类型:号码」存），这里只算「这一条怎么处理、下一个状态是什么」。
 *
 * @param {object} 选项
 * @param {boolean} 选项.全听 这个群是不是「谁都听」（是的话下面几个参数都不用看）
 * @param {boolean} 选项.点名 这一条是不是 @ 了我 / 引用了我
 * @param {{剩: number, 到: number}|null} 选项.接听 这个群现在的接听状态（null = 没在接听）
 * @param {number} 选项.条 配置：点名后接听条
 * @param {number} 选项.秒 配置：点名后接听秒
 * @param {number} 选项.现在 现在（毫秒时间戳）
 * @returns {{收: boolean, 接听: {剩: number, 到: number}|null, 用掉一条: boolean, 原因: string}}
 */
export function 该收这条(选项 = {}) {
  const 全听 = 选项.全听 === true
  const 点名 = 选项.点名 === true
  const 现在 = Number(选项.现在)
  const 时 = Number.isFinite(现在) ? 现在 : Date.now()
  const 条 = Math.max(0, Math.round(Number(选项.条) || 0))
  const 秒 = Math.max(0, Math.round(Number(选项.秒) || 0))
  const 旧 = 选项.接听 && typeof 选项.接听 === 'object' ? 选项.接听 : null
  if (全听) return { 收: true, 接听: null, 用掉一条: false, 原因: '这个群谁都听' }
  if (点名) {
    if (条 <= 0) return { 收: true, 接听: null, 用掉一条: false, 原因: '点了名（接听关着）' }
    return { 收: true, 接听: { 剩: 条, 到: 时 + 秒 * 1000 }, 用掉一条: false, 原因: '点了名，接着听 ' + 条 + ' 条' }
  }
  if (!旧) return { 收: false, 接听: null, 用掉一条: false, 原因: '没点名，也没在接听' }
  const 剩 = Math.round(Number(旧.剩) || 0)
  const 到 = Number(旧.到) || 0
  if (剩 <= 0) return { 收: false, 接听: null, 用掉一条: false, 原因: '接听的条数已经用光' }
  if (!(时 < 到)) return { 收: false, 接听: null, 用掉一条: false, 原因: '接听的时间过了' }
  const 下一份 = { 剩: 剩 - 1, 到 }
  return {
    收: true,
    接听: 下一份.剩 > 0 ? 下一份 : null,
    用掉一条: true,
    原因: '接听中，还剩 ' + 下一份.剩 + ' 条',
  }
}

/**
 * ⭐ 1.4.3：这个群里的某个人，能不能**不听点名**就进来。
 *
 * 「只听点名」现在对群里**所有人**生效（包括自己发的话）—— 以前自己发的话有个短路，
 * 在群里随手发点东西也会被当成对着它说。例外只写在这一行的「点名例外」名单里。
 *
 * @param {string} 名单 逗号/空格分隔的 QQ 号（配置里已经规整过）
 * @param {number|string} 发信人 这条消息的 user_id
 * @returns {boolean} true = 这个人不用点名也收
 */
export function 在点名例外名单(名单, 发信人) {
  const 号 = String(发信人 == null ? '' : 发信人).trim()
  if (!号) return false
  const 表 = String(名单 || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean)
  return 表.some((x) => x === 号)
}

/**
 * ⭐ 1.5.0：定时发说说 —— 此刻这一分钟该不该往会话里递一句提醒（纯函数，方便单独喂）。
 *
 * 规则：当前**本地时间**的 HH:MM 命中某一条、那一条没被关掉、这个「日期 + 时间」今天还没发过 → 该发。
 *   · 日期时间一律用本地时区（不转 UTC）—— 配的是墙上钟点的那一分钟；
 *   · 键 = 'YYYY-MM-DD HH:MM'，一天之内只递一次（跨天自然换键，旧键留着也不影响）；
 *   · 同时命中好几条时，只认第一条还没发过的。
 *
 * @param {Array} 定时们 配置项 空间定时发：[{ 时: 'HH:MM', 权: 1|4|64, 开: true }]
 * @param {number} 现在 现在（毫秒时间戳）
 * @param {Set|Array} 已发过 今天已经递过的键
 * @returns {{发: boolean, 行: number, 键: string, 原因: string}}
 */
export function 该发说说(定时们, 现在, 已发过) {
  const 毫秒 = Number(现在)
  const d = new Date(Number.isFinite(毫秒) ? 毫秒 : Date.now())
  const 补 = (n) => String(n).padStart(2, '0')
  const 日期 = d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
  const 此刻 = 补(d.getHours()) + ':' + 补(d.getMinutes())
  const 键 = 日期 + ' ' + 此刻
  const 已 = 已发过 && typeof 已发过.has === 'function'
    ? 已发过
    : new Set((Array.isArray(已发过) ? 已发过 : []).map(String))
  const 表 = Array.isArray(定时们) ? 定时们 : []
  if (!表.length) return { 发: false, 行: -1, 键: '', 原因: '没有定时' }
  let 命中 = -1
  let 关着 = false
  for (let i = 0; i < 表.length; i++) {
    const x = 表[i]
    if (!x || typeof x !== 'object') continue
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(x.时 == null ? '' : x.时).trim())
    if (!m) continue
    if (补(Number(m[1])) + ':' + m[2] !== 此刻) continue
    if (命中 < 0) 命中 = i
    if (x.开 === false) { 关着 = true; continue }
    if (已.has(键)) continue
    return { 发: true, 行: i, 键, 原因: '' }
  }
  if (命中 >= 0 && 已.has(键)) return { 发: false, 行: 命中, 键, 原因: '这个时间今天已经发过了' }
  if (命中 >= 0 && 关着) return { 发: false, 行: 命中, 键: '', 原因: '这一条关着' }
  return { 发: false, 行: -1, 键: '', 原因: '没到点' }
}

export function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 拼一个 OneBot「私聊 text 段」消息体。 */
export function 私人消息体(text) {
  return { user_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** 拼一个 OneBot「群 text 段」消息体。 */
/**
 * ⭐ 1.1.7：把要发出去的一段文字拆成 OneBot 消息段 —— 让「@」变成真的 @。
 *
 * 以前只能发纯文本（`{type:'text'}`），模型写「@123456」到 QQ 里就是几个字。
 * 现在（规矩跟别的 OneBot 插件一样，见 OneBot 11 的 `at` 段）：
 *   · `@123456789`（纯数字，5～12 位）→ `{type:'at', data:{qq:'123456789'}}`
 *   · `@全体成员` / `@所有人` → `{type:'at', data:{qq:'all'}}`（要「能@全体」打开才认）
 *   · `@昵称` → 到群成员表里找同名的（缓存十分钟）；找到且只有一个才真 @，找不到就当普通文字
 * 返回值里相邻的纯文本会自动拼回去，别一段一个字地发。
 */
export function 拆成消息段(text, 选项 = {}) {
  const 原 = String(text == null ? '' : text)
  if (!原) return [{ type: 'text', data: { text: '' } }]
  const 允许全体 = 选项.允许全体 === true
  const 认名字 = typeof 选项.按名字 === 'function' ? 选项.按名字 : null
  const 段们 = []
  const 加文本 = (t) => {
    if (!t) return
    const 最后 = 段们[段们.length - 1]
    if (最后 && 最后.type === 'text') 最后.data.text += t
    else 段们.push({ type: 'text', data: { text: t } })
  }
  // 逐个找 @：数字号 / 全体 / 昵称
  const 正则 = /@([0-9]{5,12}|全体成员|所有人|[^\s@，。！？、：;,.!?:]{1,24})/g
  let 上个位置 = 0
  let 匹配
  while ((匹配 = 正则.exec(原)) !== null) {
    const 起 = 匹配.index
    const 待 = 匹配[1]
    加文本(原.slice(上个位置, 起))
    if (/^[0-9]{5,12}$/.test(待)) {
      段们.push({ type: 'at', data: { qq: String(待) } })
      上个位置 = 起 + 匹配[0].length
      continue
    }
    if (待 === '全体成员' || 待 === '所有人') {
      if (允许全体) 段们.push({ type: 'at', data: { qq: 'all' } })
      else 加文本(匹配[0])
      上个位置 = 起 + 匹配[0].length
      continue
    }
    // 昵称：找得到就真 @，找不到就原样留着
    let 号 = ''
    if (认名字) {
      try {
        号 = String(认名字(待) || '')
      } catch (error) {
        号 = ''
      }
    }
    if (号 && /^[0-9]{5,12}$/.test(号)) {
      段们.push({ type: 'at', data: { qq: 号 } })
      上个位置 = 起 + 匹配[0].length
      continue
    }
    加文本(匹配[0])
    上个位置 = 起 + 匹配[0].length
  }
  加文本(原.slice(上个位置))
  if (!段们.length) return [{ type: 'text', data: { text: 原 } }]
  return 段们
}

export function 群消息体(text) {
  return { group_id: 0, message: [{ type: 'text', data: { text } }] }
}

/**
 * ⭐ 1.4.3：按**句子**拆 —— 每条消息一句话，读起来更像人在打字。
 *
 * 规则（故意做得保守，宁可少切不要切坏）：
 *   · 断在句末标点后面：`。！？；…` 和英文的 `.!?;`；连续标点（`？！`、`……`）算一处，不重复切。
 *   · 标点后如果紧跟右引号/右括号，一起留在这一句里。
 *   · **括号里的标点不算断句**（中英文括号都算）—— 不然一句话被切成两半，念起来是断的。
 *   · 空段丢掉。
 * 关掉「按句拆」时完全走原来的按空行拆，一个字节都不变。
 */
export function 按句拆(文字) {
  const 原 = String(文字 || '').trim()
  if (!原) return []
  const 出 = []
  // ⚠ 空行是**硬边界**：先按空行分段，段内再按句切。
  //   不然「一段话 + 空行 + 另一段」会被当成一句，白白丢了原有的分段。
  for (const 段 of 原.split(/\n\s*\n/)) {
    const 本段 = String(段 || '').trim()
    if (!本段) continue
    let 起 = 0
    let 括号深 = 0
    for (let i = 0; i < 本段.length; i++) {
      const c = 本段[i]
      if (c === '（' || c === '(' || c === '【' || c === '[') 括号深++
      else if (c === '）' || c === ')' || c === '】' || c === ']') 括号深 = Math.max(0, 括号深 - 1)
      if (括号深 > 0) continue
      if (!'。！？；…!?;'.includes(c)) continue
      // 把连续标点吃干净（`？！`、`……`、`。！`）
      let j = i + 1
      while (j < 本段.length && '。！？；…!?;，,、'.includes(本段[j])) j++
      // 紧跟的右引号/右括号也算这一句的
      while (j < 本段.length && '”’」』）)】]'.includes(本段[j])) j++
      const 句 = 本段.slice(起, j).trim()
      if (句) 出.push(句)
      起 = j
      i = j - 1
    }
    const 尾 = 本段.slice(起).trim()
    if (尾) 出.push(尾)
  }
  // 一句都没切出来（例如整段没标点）→ 退回整段，别把话丢了
  return 出.length ? 出 : [原]
}

/** ⭐ 2026-10-22：从一条 assistant 消息里挑出图片块（要发到 QQ 的那几张）。 */export function 提取图块(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 10)
}

/** 拼一个 OneBot「图片段」（base64 直接塞，不依赖 QQ 那边能不能访问本地文件）。 */
export function 图片段(base64) {
  return { type: 'image', data: { file: 'base64://' + String(base64) } }
}

/**
 * ⭐ 2026-10-22：正文里那种 markdown 图片 `![名字](路径)` 也当图片发。
 *    伙伴发贴纸就是这么发的（`![小肥鱼](_stickers/feiyu-test.webp)`）——
 *    以前只认附件块，这种一律被当成普通文字发过去，QQ 那边看到的是一串 markdown。
 * @returns {净文字, 图: [{kind:'url'|'path', value}]}
 */
export function 抠正文图(文字) {
  const 图 = []
  const 净文字 = String(文字 || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (全, 路径) => {
      const p = String(路径 || '').trim()
      if (!p) return ''
      if (/^https?:\/\//i.test(p)) {
        if (!图.some((x) => x.value === p)) 图.push({ kind: 'url', value: p })
        return ''
      }
      if (!图.some((x) => x.value === p)) 图.push({ kind: 'path', value: p })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { 净文字, 图 }
}

// 包根：用来读自己的 package.json（版本 + 仓库地址）
const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ⭐ 1.0.4：把 `[QQ]…[/QQ]` 处理成「真正要发出去的文字」。
 *
 * 三种情况：
 * 1. `只发标记内` 关：整段都发，但**标记本身要剥掉**（以前会原样发到手机上，她截图看到过 `[QQ]`）；
 * 2. 开 + 有完整 `[QQ]…[/QQ]`：只发块里那段；
 * 3. 开 + 只写了开头没写 `[/QQ]`：按「[QQ] 之后全是想发的」发（以前整条都不发，手机上什么都收不到）。
 * 开 + 连 `[QQ]` 都没有 → `发:false`（这一轮不往 QQ 发）。
 * @param 文字 这一轮的正文
 * @param 只发标记内 配置开关
 * @returns {{发: boolean, 文字: string, 原因?: string}}
 */
export function 抠QQ标记(文字, 只发标记内) {
  const 全 = String(文字 || '')
  const 洗 = (s) => String(s || '')
    .replace(/\[\s*\/?\s*QQ\s*\]/gi, '')
    .replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10))
    .trim()
  if (!只发标记内) return { 发: true, 文字: 洗(全) }
  const 块 = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(全)
  if (块 && String(块[1] || '').trim()) return { 发: true, 文字: 洗(块[1]) }
  const 开 = 全.indexOf('[QQ]')
  const 尾 = 开 >= 0 ? 全.slice(开 + 4) : ''
  if (String(尾).trim()) {
    return { 发: true, 文字: 洗(尾), 原因: '只写了 [QQ] 没写 [/QQ]，按「[QQ] 之后全是要发的」处理' }
  }
  return { 发: false, 文字: '', 原因: '没写块' }
}
export function apply(ctx) {
  // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库
  createSelfUpdate({ packageRoot: 包根, diag: 记账 }).register(ctx, 路由前缀)
  // ---------- 状态 ----------

  const 日志 = []
  // ⚠ 2026-10-23 修（反馈：换过「目标会话」之后，新会话第 2 轮起就静默不发）
  //   真因：这两个表原来都是**全局一份**，只认「轮号」，不认「哪个会话」。
  //     从 A 换到 B 之后，B 的轮号一旦跟 A 撞上，就被当成「这轮已经发过了」跳过；
  //     而调用处是 `void 落地一发(...)`，没有日志 → 日志里一片空白，很难查。
  //   → 现在都按会话分开：上一轮按会话键存一份；已发的键是「会话键:轮号」。
  const 空轮 = () => ({ 轮号: -1, 文本: '', 图们: [] })
  const 上一轮们 = new Map() // 会话键 -> { 轮号, 文本, 图们 }
  const 已发轮 = new Set() // 「会话键:轮号」
  // ⭐ 0.6.0：每个「聊天」各自记「看到哪儿了」（键 = 类型:号码）—— 多群多私聊才不会互相串
  const 上次时间 = new Map() // 水位必须先初始化，再恢复磁盘状态
  const 已转消息 = new Set() // 已经转发进 DSH 的 QQ 消息 id（防重复转）
  // ⚠️ 2026-10-25（她报的「我没发新消息，它却自己回了一条」）：
  //   这两个东西以前**只存在内存里** —— 插件一重启（今天改了鱼的心情 / 换插件都要重启），
  //   「看到哪儿了」就归零 ⇒ 最近那十几条历史消息会**被当成新消息重投一遍**，
  //   于是她一点开会话就冒出一条自动回复。现在落盘到 qq-bridge-state.json，重启接着上次。
  const 状态文件 = join(dirname(配置文件), 'qq-bridge-state.json')
  const 读水位 = () => {
    try {
      const j = JSON.parse(readFileSync(状态文件, 'utf8'))
      if (j && j.上次 && typeof j.上次 === 'object') for (const [k, v] of Object.entries(j.上次)) 上次时间.set(String(k), Number(v) || 0)
      if (j && Array.isArray(j.已转)) for (const id of j.已转.slice(-300)) 已转消息.add(id)
    } catch (error) { /* 没有就算了，第一次跑 */ }
  }
  读水位()
  const 存水位 = (成功) => {
    try {
      // 卸载中的旧实例也可能刚被宿主受理；只合并成功这批，不能覆盖新实例的进度。
      let 盘 = {}
      try { 盘 = JSON.parse(readFileSync(状态文件, 'utf8')) || {} } catch (error) {}
      const 上次 = { ...(盘.上次 || {}) }
      const 合并时间 = (键, 值) => { 上次[键] = Math.max(Number(上次[键]) || 0, Number(值) || 0) }
      if (成功) 合并时间(成功.键, 成功.时间)
      else for (const [键, 值] of 上次时间) 合并时间(键, 值)
      const 盘已转 = Array.isArray(盘.已转) ? 盘.已转 : []
      // 正常收尾以磁盘最近的成功记录为准；迟到成功只追加自己的这批消息 id。
      const 全已转 = 成功 ? [...盘已转, ...成功.ids] : [...已转消息, ...盘已转]
      writeFileSync(状态文件, JSON.stringify({
        上次, 已转: [...new Set(全已转)].slice(-300),
      }, null, 2), 'utf8')
    } catch (error) { /* 存不下不影响转消息 */ }
  }

  function 记账(文本) {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    const 时间 = `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    日志.push({ 时间, 文本 })
    if (日志.length > 日志上限) 日志.shift()
    try {
      ctx.logger?.info(`qq-bridge: ${文本}`)
    } catch (error) {}
  }

  /** 请求头：填了「令牌」就带 Bearer；没填就照旧（老 NapCat 不鉴权，零变化） */
  const 请求头 = (配置, 带体 = true) => {
    const h = 带体 ? { 'content-type': 'application/json', 'user-agent': 'dsh-qq-bridge' } : { 'user-agent': 'dsh-qq-bridge' }
    const t = String((配置 && 配置.令牌) || '').trim()
    if (t) h.authorization = 'Bearer ' + t
    return h
  }

  async function 发一个(base, action, 体, 配置) {
    try {
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: 请求头(配置),
        body: JSON.stringify(体),
      })
      const j = await r.json()
      const 好 = !!(j && j.status === 'ok' && j.retcode === 0)
      try {
        const 新id = j && j.data ? (j.data.message_id != null ? j.data.message_id : j.data.messageId) : null
        if (好 && 新id != null) 记己方消息(新id)
      } catch (error) {}
      return { action, ok: 好, 数据: j }
    } catch (error) {
      return { action, ok: false, 数据: { 错: String((error && error.message) || error) } }
    }
  }

  /** 把一段长文字按空行拆成自然段（没有空行就整段）。 */
  function 按段拆(文字) {
    const 段 = String(文字 || '')
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return 段
  }

  /**
   * 相对路径的图按哪儿找：
   *   ① 设置里的「图片根目录」（填了就以它为准）
   *   ② **目标会话所在的那个工作区**（自动的，一般不用填）
   *   ③ 其它登记过的工作区
   *   ④ 进程当前目录 ⑤ <DSH_HOME>/workspace ⑥ 用户主目录
   * 找到就返回绝对路径。
   */
  function 找本地图(p, 配置) {
    const 原 = String(p || '').trim()
    if (!原) return ''
    const 试 = []
    if (/^[a-zA-Z]:[\\/]/.test(原) || 原.startsWith('\\\\') || 原.startsWith('/')) 试.push(原)
    else {
      const 根们 = []
      const 设 = String(配置.图片根目录 || '').trim()
      if (设) 根们.push(设)
      try {
        const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
        const 列表 = (登记 && typeof 登记.list === 'function' ? 登记.list() : []) || []
        const 目标 = String(配置.目标会话 || '')
        // ⭐ 先把「目标会话所在的工作区」排到前面 —— 这个才是它平时待的地方
        const 排 = 列表.slice().sort((a, b) => {
          const A = a && Array.isArray(a.sessionIds) && a.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          const B = b && Array.isArray(b.sessionIds) && b.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          return A - B
        })
        for (const w of 排) {
          const d = w && (typeof w.path === 'string' ? w.path : (w.directory || w.dir || w.root))
          if (typeof d === 'string' && d) 根们.push(d)
        }
      } catch (error) {}
      根们.push(process.cwd(), join(目录, 'workspace'), homedir())
      for (const r of 根们) 试.push(join(String(r), 原))
    }
    for (const 全 of 试) {
      try { if (existsSync(全)) return 全 } catch (error) {}
    }
    记账('找不到这张图：' + 原 + '（试过：' + 试.slice(0, 4).join(' ｜ ') + ' 等 ' + 试.length + ' 个位置；可在设置里填「图片根目录」）')
    return ''
  }

  /**
   * ⭐ 1.1.7：群成员表（昵称 → QQ 号），给「@昵称」用。缓存十分钟，拉不到就当没有。
   */
  const 群成员表 = new Map() // 群号 -> { 表, 时 }
  const 群成员表毫秒 = 10 * 60 * 1000

  const 拿群成员表 = async (配置, 群号, 拉) => {
    const 键 = String(群号)
    const 旧记 = 群成员表.get(键)
    if (旧记 && Date.now() - 旧记.时 < 群成员表毫秒) return 旧记.表
    let 表 = null
    try {
      const r = await 带超时(`${配置.NapCat}/get_group_member_list`, {
        method: 'POST',
        headers: 请求头(配置),
        body: JSON.stringify({ group_id: Number(群号) }),
      })
      const j = await r.json()
      const 单 = (j && (j.data || (j.data && j.data.list))) || null
      const 列 = Array.isArray(单) ? 单 : []
      if (列.length) {
        表 = new Map()
        for (const m of 列) {
          const 号 = String((m && (m.user_id || m.qq)) || '')
          if (!号) continue
          for (const 名 of [m.card, m.nickname]) {
            const 净 = String(名 || '').trim()
            if (净 && !表.has(净)) 表.set(净, 号)
          }
        }
      }
    } catch (error) {}
    群成员表.set(键, { 表, 时: Date.now() })
    return 表
  }

  /** 把一句正文发到该发的地方（私聊 / 群）；按空行拆段，一段一条连发。⭐ 末尾再加上图片。 */
  async function 发到QQ(配置, 原文字, 图们, 方向 = '') {
    // ⭐ 1.4.0：方向 = 会话键；**这间会话绑了几个聊天就发几个**（私聊 + 群都要发的情况）
    const 键 = 会话键(方向)
    const 候选 = 键
      ? (配置.绑定 || []).filter((b) => 会话键(b.会话) === 键)
      // ⭐ 0.9.7：手动测试没有会话可反查 → 用第一条绑定
      : (配置.绑定 || []).slice(0, 1)
    const 出 = []
    // 正文里的 markdown 图（贴纸就是这么发的）也当图片发；抠掉之后正文更干净
    const 抠过 = 配置.发图 ? 抠正文图(原文字) : { 净文字: String(原文字 || ''), 图: [] }
    const 文字 = 抠过.净文字
    // ⭐ 2026-10-25：拆段和间隔都能配：不拆 = 一整条发出去
    const 要拆 = 配置.长回复拆段 !== false
    // ⭐ 1.4.3：可选「按句子拆」（默认关）；开了就按标点切，每句一条
    const 用按句 = 要拆 && 配置.按句拆 === true
    const 段们 = 用按句
      ? 按句拆(文字).filter((s) => s.length > 0)
      : (要拆 && 按段拆(文字).length
        ? 按段拆(文字)
        : [String(文字 || '').trim()].filter((s) => s.length > 0))
    const 发段延迟 = Math.max(0, Math.min(Number(配置.拆段间隔毫秒) || 0, 5000))
    const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
    // ⭐ 图片：base64 或网络地址，QQ 那边直接收，不用访问本机文件
    const 图数据 = []
    const 加图 = (源) => {
      if (!源 || 图数据.length >= 4) return
      if (源.kind === 'url') { 图数据.push({ url: 源.value }); return }
      let 值 = 源.value
      const 换 = 原图路径('p:' + 清路径(值).toLowerCase())
      if (换) 值 = 换
      const 全 = 找本地图(值, 配置) || 值
      try {
        const buf = readFileSync(全)
        if (buf.length > 最大) { 记账(`这张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); return }
        图数据.push({ b64: buf.toString('base64') })
      } catch (error) {
        记账('读图失败，跳过：' + String((error && error.message) || error))
      }
    }
    if (配置.发图) {
      for (const 源 of 抠过.图) 加图(源)
      if (Array.isArray(图们) && 图们.length) {
        const 附件 = ctx.attachments || ctx.get('attachments')
        for (const 块 of 图们) {
          try {
            const 原 = 原图路径('id:' + String((块.attachment && 块.attachment.attachmentId) || ''))
            if (原) { 加图({ kind: 'path', value: 原 }); continue }
            const p = 附件 && typeof 附件.imageHostPath === 'function' ? 附件.imageHostPath(块.attachment) : undefined
            if (!p) { 记账('这张图拿不到本地文件，跳过'); continue }
            加图({ kind: 'path', value: p })
          } catch (error) {
            记账('读图失败，跳过：' + String((error && error.message) || error))
          }
        }
      }
    }
    // 一条 OneBot 图片段：本地图走 base64，网络图直接把 url 交给 QQ
    const 一段图 = (x) => (x.url ? { type: 'image', data: { file: x.url, url: x.url } } : 图片段(x.b64))

    if (!候选.length) {
      记账(键
        ? '这间会话（' + 短id(方向) + '）没有绑定聊天 —— 这一轮不往 QQ 发（去「绑定」页加一条）'
        : '还没绑定任何一个聊天 —— 去「绑定」页加一条（一行 = 一个聊天 → 一间会话）')
      return 出
    }
    // 被关掉的那几行不发（配置还在，随时勾回来）
    const 行们 = 候选.filter((b) => b.开 !== false)
    if (!行们.length) {
      记账('这间会话绑的聊天都被关掉了（设置页「绑定」里那一行的开关）—— 这一轮不往 QQ 发')
      return 出
    }

    for (const 行 of 行们) {
      const 要私聊 = 行.类型 !== '群' && 配置.转私聊
      const 要群 = 行.类型 === '群' && 配置.转群
      if (要私聊) {
        for (let i = 0; i < 段们.length; i++) {
          const 体 = 私人消息体(段们[i])
          体.user_id = Number(行.号码)
          出.push(await 发一个(配置.NapCat, 'send_private_msg', 体, 配置))
          if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
        }
        for (const x of 图数据) {
          出.push(await 发一个(配置.NapCat, 'send_private_msg', { user_id: Number(行.号码), message: [一段图(x)] }, 配置))
          await new Promise((r) => setTimeout(r, 发段延迟))
        }
      }
      if (要群) {
        // ⭐ 1.1.7：群里发的时候把「@…」拆成真的 at 段（见 拆成消息段）。
        let 成员表 = null
        if (段们.some((x) => String(x).includes('@'))) {
          try {
            成员表 = await 拿群成员表(配置, 行.号码)
          } catch (error) {
            成员表 = null
          }
        }
        const 认名字 = (名) => {
          if (!成员表) return ''
          const 净 = String(名 || '').trim()
          return 成员表.get(净) || ''
        }
        const 允许全体 = 配置.能艾特全体 === true
        for (let i = 0; i < 段们.length; i++) {
          const 段们2 = 拆成消息段(段们[i], { 允许全体, 按名字: 认名字 })
          const 体 = { group_id: Number(行.号码), message: 段们2 }
          出.push(await 发一个(配置.NapCat, 'send_group_msg', 体, 配置))
          if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
        }
        for (const x of 图数据) {
          出.push(await 发一个(配置.NapCat, 'send_group_msg', { group_id: Number(行.号码), message: [一段图(x)] }, 配置))
          await new Promise((r) => setTimeout(r, 发段延迟))
        }
      }
    }
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字, 图们, 方向 = '', 是QQ唤醒 = false) {
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    // ⭐ 0.6.0：方向就是「哪一间会话」—— 下面按它去绑定里反查该发到哪个聊天
    const 这份会话 = String(方向 || '')
    if (!这份会话) return 记账('这一轮认不出是哪间会话，这轮不转')
    配置 = { ...配置, 目标会话: 这份会话 }   // 下游（图片根目录、归档检查）都看这一个
    // ⭐ 盯的会话已经归档了：别转（人已经不在这儿说话了）
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 归档 = new Set((((登记 && 登记.archivedSessionIds) || [])).map(String))
      if (归档.has(会话键(这份会话))) return 记账('这间会话已经归档了，这轮不转（去绑定里换一间）')
    } catch (error) {}
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    // ⭐ 0.7.0 出站闸一：只发 [QQ]…[/QQ] 里的那一段（块外的解释/路径/思考留在本地）
    // ⭐ 1.0.4：标记本身永远不往 QQ 里发；只写了开头没写结尾也照发（见 抠QQ标记）
    const 标记 = 抠QQ标记(文字, 配置.只发标记内)
    if (!标记.发) {
      记账('这一轮没写 [QQ]…[/QQ] 块（「只发标记内」开着）—— 这轮不往 QQ 发')
      return
    }
    if (标记.原因) 记账(标记.原因)
    let 待发文字 = 标记.文字
    // ⭐ 0.7.0 出站闸二：只发「被 QQ 消息叫醒的那一轮」（你坐在 DSH 里自己聊的不推到手机）
    if (配置.只回QQ唤醒) {
      if (!是QQ唤醒) {
        记账('这一轮不是 QQ 消息叫醒的（「只回 QQ 唤醒」开着）—— 只在 DSH 里说，不推 QQ')
        return
      }
    }
    const 抠过 = 配置.发图 ? 抠正文图(待发文字) : { 净文字: 待发文字, 图: [] }
    const 几张 = (Array.isArray(图们) ? 图们.length : 0) + 抠过.图.length
    const 图标 = 几张 ? `（还有 ${几张} 张图）` : ''
    const 净文 = String(抠过.净文字 || '')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${净文.slice(0, 40)}${净文.length > 40 ? '…' : ''}」${图标}`)
    }
    const 结果 = await 发到QQ(配置, 待发文字, 图们, 方向)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    if (结果.length === 0) {
      记账('这一边（' + (方向 || '私聊+群') + '）没开或没填号，或者这轮既没有文字也没有图（而且图都没转成）：没地方发')
      return
    }
    记账(`${全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：'}「${净文.slice(0, 50)}${净文.length > 50 ? '…' : ''}」${图标}`)
    for (const r of 结果) {
      if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    }
  }

  /** 盯会话事件：记住这一轮最后一句，在 turn/end 时落地。 */
  function 收到事件(session, event) {
    const 配置 = 读配置()
    if (!(配置.绑定 || []).length) return
    const 键 = 会话键(session && session.id)
    // ⭐ 0.6.0：哪一间会话说的话，就按它的绑定只回那一个聊天
    const 是这条 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 键) || null
    if (!是这条) return
    const 方向 = 键
    // 这一轮的「最后一句」按会话分开记（两个会话同时说话时不会串）
    const 上一轮 = 上一轮们.get(键) || 空轮()
    const 记上一轮 = (v) => 上一轮们.set(键, v)

    // 新一轮一开，上一轮的静默标记就必须作废。
    //   正常路径上面 turn/end 会清；这里兜底那些**没发 turn/end 就没了**的轮次
    //   （宿主被杀、会话被换掉），否则标记会一直挂着，把这个会话接下来的回复全吞掉。
    if (event && event.type === 'turn/start') {
      静默轮.delete(键)
      return
    }

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        记上一轮(空轮())
        return
      }
      const 文 = String(提取正文(d.message) || '').trim()
      const 图们 = 提取图块(d.message)
      if (文) 记上一轮({ 轮号: d.turn, 文本: 文, 图们 })
      // ⭐ 有的回合是先出图、后出字（或只出图）：别把图丢了
      else if (图们.length) 记上一轮({ 轮号: d.turn, 文本: 上一轮.轮号 === d.turn ? 上一轮.文本 : '', 图们: (上一轮.轮号 === d.turn ? 上一轮.图们 : []).concat(图们).slice(0, 10) })
      return
    }

    // ⭐ 1.0.1：她自己在这间会话里打了字（source 不是 qq）→ 尾巴立刻清掉，
    //   不然「QQ 叫醒一次」会把后面她自己聊的几轮也推去手机（老坑）。
    if (event && event.type === 'user/message') {
      const 源 = event.data && event.data.message && event.data.message.source
      const 类 = String((源 && 源.kind) || '')
      if (!类 || 类 === 'user') 尾巴.delete(键)
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 有东西 = 上一轮.文本 || (上一轮.图们 && 上一轮.图们.length)
      // ⚠ 去重的键必须是「会话 + 轮号」：只按轮号的话，换过目标会话就会静默漏发
      const 轮标 = 键 + ':' + String(d.turn)
      if (完成 && 上一轮.轮号 === d.turn && 有东西 && !已发轮.has(轮标)) {
        已发轮.add(轮标)
        // ⚠️ 「这轮是不是 QQ 叫的」在**这里**算一次就消费掉 —— 不然 10 分钟的窗口会把
        //    后面别的轮次也当成 QQ 叫的（实测踩过：群里一条旧消息叫醒之后，之后几轮都往外发）。
        const 醒 = 唤醒时间.get(键) || null
        const 醒着 = Boolean(醒 && 醒.时 && Date.now() - 醒.时 < QqWalake窗口)
        // ⭐ 1.0.1（issue #6）：这次真被 QQ 唤醒 → 给它留一条尾巴，
        //    「这次触发」下面紧接着的几轮也照样往外发（以前只有第一轮能出去）。
        if (醒着) {
          const 尾巴毫秒 = Math.max(0, Number(读配置().唤醒尾巴秒) || 0) * 1000
          if (尾巴毫秒 > 0) 尾巴.set(键, Date.now() + 尾巴毫秒)
        }
        唤醒时间.delete(键)
        const 尾到 = 尾巴.get(键) || 0
        const 是QQ唤醒 = 醒着 || 尾到 > Date.now()
        if (尾到 && 尾到 <= Date.now()) 尾巴.delete(键)
        // 门槛判了「不接」→ 这一轮一个字都不往外发（但会话里照常留着）
        if (静默轮.has(键)) {
          静默轮.delete(键)
          记账('回复门槛：这一轮按判定跳过发送（' + 短id(键) + '）')
        } else {
          void 落地一发(配置, 上一轮.文本, 上一轮.图们, 方向, 是QQ唤醒)
        }
      } else if (静默轮.has(键)) {
        // 这一轮没走到「要不要发」那一步 —— 被门槛 cancel 成 aborted，或者干脆没说话。
        // 静默标记必须在**这一轮**就收尾：它本来就只对触发它的那一轮有效。
        // 以前它漏到下一轮，下一轮 completed 时被当成「判定过的不接」跳过发送，
        // 而且一条日志都没有 —— 表现就是「它明明回了，群里却没有」。
        静默轮.delete(键)
        记账('回复门槛：静默标记在这轮结束（' + 短id(键) + '），不带进下一轮')
      }
      记上一轮(空轮())
    }
  }

  // ---------- 路由（将来给设置页用；现在也能用来手动试） ----------

  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 短id = (id) => {
    const s = String(id)
    return s.length <= 8 ? s : s.slice(-8)
  }

  /* 拿目标会话活着的 agent：带 / 不带 `session-` 前缀两个方向都试（照 speak-up 的写法）。 */
  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 新id = () => {
    try {
      return randomUUID()
    } catch (error) {
      return 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  /** 手搓一条 user 消息（跟 speak-up 一样：role=user，source.kind 标成 qq，不冒充她亲手打的）。 */
  const 手搓用户消息 = (文案) => ({
    id: 新id(),
    role: 'user',
    content: [{ type: 'text', text: String(文案) }],
    source: { kind: 'qq' },
  })

  /**
   * 盘上的会话（没在标签页里打开过的也算）。
   * ⭐ 1.1.4：只靠「活着的会话」列不全 —— 那只是当前装进内存的那些，
   *   一直用但从没在这台机器上打开过的会话根本不在里面。
   */
  const 扫盘会话 = () => {
    const 出 = []
    try {
      const 会话目录 = join(目录, 'storages', 'session_projcache', 'sessions')
      for (const 名 of readdirSync(会话目录)) {
        if (!名.endsWith('.json')) continue
        const id = 名.slice(0, -5)
        let 记 = null
        try {
          记 = JSON.parse(readFileSync(join(会话目录, 名), 'utf8'))
        } catch (error) {
          continue
        }
        const rows = (记 && 记.record && 记.record.rows) || {}
        // 子智能体的会话不列（不然设置页会被几十个 subagent 淹掉）
        const 子 = rows.subagent && rows.subagent.val && rows.subagent.val.identity
        if (子) continue
        let 标题 = ''
        if (rows.title && typeof rows.title.val === 'string') 标题 = rows.title.val
        出.push({ id, 标题 })
      }
    } catch (error) {}
    return 出
  }

  /** 会话清单（id + 标题），给设置页挑「目标会话」用 —— 不手填。 */
  const 会话清单 = () => {
    const 出 = []
    const 已有 = new Set()
    // ⭐ 归档的会话不列（归档只是藏起来，内存里还在 —— 得单独查 workspaceRegistry 的名单）
    const 归档 = new Set()
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(String(x))
    } catch (error) {}
    const 加 = (id, 标题) => {
      const 净 = String(id || '')
      if (!净 || 已有.has(净) || 归档.has(净)) return
      已有.add(净)
      出.push({ id: 净, 标题: 标题 ? String(标题) : '' })
    }

    let 标题服务 = null
    try {
      标题服务 = ctx.get('sessionTitle')
    } catch (error) {}

    // ① 活着的会话：本版本 list() 是函数；新版本是快照对象（.getSnapshot()）
    let 活们 = []
    try {
      const 会话服务 = ctx.get('sessions') || ctx.sessions
      if (会话服务) {
        if (typeof 会话服务.list === 'function') {
          活们 = 会话服务.list() || []
        } else if (会话服务.list && typeof 会话服务.list.getSnapshot === 'function') {
          const 快 = 会话服务.list.getSnapshot() || {}
          活们 = Array.isArray(快.items) ? 快.items : (快.byId ? Object.values(快.byId) : [])
        }
        if (!活们.length && typeof 会话服务.getSnapshot === 'function') {
          const 快 = 会话服务.getSnapshot() || {}
          活们 = Array.isArray(快.items) ? 快.items : (快.byId ? Object.values(快.byId) : [])
        }
      }
    } catch (error) {}
    for (const s of 活们) {
      if (!s) continue
      const id = s.id || s.sessionId
      if (!id) continue
      // 子智能体的会话不列
      try {
        if (s.header && s.header.origin === 'subagent') continue
      } catch (error) {}
      let 标题 = ''
      try {
        const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
        标题 = 快照 && 快照.title ? String(快照.title) : ''
      } catch (error) {}
      加(id, 标题)
    }

    // ② 盘上的（关掉标签页也还在）
    for (const x of 扫盘会话()) 加(x.id, x.标题)

    // ③ 最后兜一层：现在有 agent 的会话
    try {
      const 有代理 = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      for (const a of 有代理 || []) 加(a && (a.session && a.session.id) || (a && a.sessionId), '')
    } catch (error) {}

    return 出
  }

  /** ⭐ 0.9.10：连 NapCat 一律带超时。
   *  以前没超时：地址填错 / NapCat 没开 / 防火墙吞包时，fetch 会一直挂着 →
   *  /state 永远不回 → 设置页卡在「读取中…」（用户截图报的就是这个）。 */
  const 探活超时 = Math.max(200, Number(process.env.QQ_BRIDGE_探活超时) || 6000)
  const 带超时 = async (地址, 选项 = {}, 毫秒 = 探活超时) => {
    const 控 = new AbortController()
    const 定 = setTimeout(() => 控.abort(), Math.max(500, 毫秒))
    try {
      return await fetch(地址, { ...选项, signal: 控.signal })
    } finally {
      clearTimeout(定)
    }
  }

  const 概况 = async () => {
    const 配置 = 读配置()
    const 清单 = 会话清单()
    let NapCat状态 = null
    try {
      const r = await 带超时(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: 请求头(配置), body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    const 在清单里 = (id) => (id && 清单.length ? 清单.filter((x) => 会话键(x.id) === 会话键(id)) : [])
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.标题 || ('…' + 短id(x.id))]))
    const 绑定们 = (配置.绑定 || []).map((x) => ({
      ...x,
      会话标题: 标题表.get(会话键(x.会话)) || '',
      活着: 清单.some((y) => 会话键(y.id) === 会话键(x.会话)),
    }))
    return {
      ok: true, 版本, 配置, 配置文件, NapCat状态, 活着的会话: 清单, 日志,
      // ⭐ 2026-10-25：私聊 / 群两个方向各自的会话（老字段 目标情况 还留着 = 私聊那份）
      私聊情况: 在清单里(配置.私聊会话),
      群情况: 在清单里(配置.群会话),
      目标情况: 在清单里(配置.私聊会话),
      绑定: 绑定们,
    }
  }

  // ── 语音转写依赖：一键装（2026-10-25）─────────────────────────────
  //  她说的对：不能「我替她装就装了」—— 插件页里要有开关 + 一个按钮，点了才装，
  //  装的时候能看见进度和报错。这里只负责**起进程 + 记日志**，前端轮询看进度。
  const ASR家 = join(dirname(配置文件), 'qq-bridge-asr')
  const ASR日志 = join(ASR家, 'install.log')
  const ASRvenv = join(ASR家, '.venv')
  const ASRpython = process.platform === 'win32'
    ? join(ASRvenv, 'Scripts', 'python.exe')
    : join(ASRvenv, 'bin', 'python')
  let ASR装 = { 进行中: false, 步骤: [], 开始于: 0, 结束于: 0, 失败: '', 完成: false, 下载: null }

  const ASR写 = (行) => {
    try {
      mkdirSync(ASR家, { recursive: true })
      writeFileSync(ASR日志, '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + 行 + String.fromCharCode(10), { flag: 'a' })
    } catch (error) {}
  }
  const ASR读日志 = (行数 = 40) => {
    try {
      const 全部 = readFileSync(ASR日志, 'utf8').split(String.fromCharCode(10))
      return 全部.slice(-行数).join(String.fromCharCode(10)).trim()
    } catch (error) { return '' }
  }
  const ASR就绪 = () => existsSync(ASRpython)
  // ⭐ 2026-10-25（她说的「别人哪知道模型目录填什么」）：模型由插件自己下、自己放，
  //   用户不需要知道任何路径。「语音模型目录」那一栏只是**给你看/改**的，不该让人手填。
  const ASR模型根 = join(ASR家, 'models')
  const ASR模型名 = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
  const ASR模型目录 = () => join(ASR模型根, ASR模型名)
  const ASR模型就绪 = () => existsSync(join(ASR模型目录(), 'model.int8.onnx')) && existsSync(join(ASR模型目录(), 'tokens.txt'))
  // ⚠️ 2026-10-25（她实测）：官方那个 tar.bz2 有 **999MB** —— 因为把 fp32 模型也打进去了。
  //    我们只需要 int8 的 model.int8.onnx + tokens.txt（约 230MB + 1MB），
  //    所以改成**按文件下**（HuggingFace 上单个文件，另配 hf-mirror 兜底）。
  const ASR文件 = [
    { 名: 'model.int8.onnx', 约MB: 230 },
    { 名: 'tokens.txt', 约MB: 1 },
  ]
  const ASR文件地址们 = (名) => [
    'https://huggingface.co/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
    'https://hf-mirror.com/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
  ]

  /** 起一条命令，输出追加进日志；返回 {码} */
  const ASR跑 = (命令, 参数, 说明) => new Promise((resolve) => {
    ASR写('▶ ' + 说明 + '：' + 命令 + ' ' + 参数.join(' '))
    let 子 = null
    try {
      子 = spawn(命令, 参数, { cwd: ASR家, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (error) {
      ASR写('✗ 起不来：' + String((error && error.message) || error))
      return resolve({ 码: -1 })
    }
    子.stdout.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.stderr.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.on('error', (e) => { ASR写('✗ ' + String((e && e.message) || e)); resolve({ 码: -1 }) })
    子.on('close', (码) => resolve({ 码: 码 === null ? -1 : 码 }))
  })

  async function 装语音依赖() {
    if (ASR装.进行中) return { ok: false, 说: '正在装，别急' }
    ASR装 = { 进行中: true, 步骤: [], 开始于: Date.now(), 结束于: 0, 失败: '', 完成: false, 下载: null }
    const 推 = (名, 态, 附) => {
      const 已 = ASR装.步骤.find((x) => x.名 === 名)
      if (已) { 已.态 = 态; if (附) 已.附 = 附 } else ASR装.步骤.push({ 名, 态, 附: 附 || '' })
    }
    const 找python = async () => {
      for (const 候选 of (process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]])) {
        const r = await ASR跑(候选[0], [...候选[1], '-V'], '看看有没有 ' + 候选[0])
        if (r.码 === 0) return 候选
      }
      return null
    }
    try {
      mkdirSync(ASR家, { recursive: true })
      ASR写('== 开始装语音识别依赖 ==')
      推('找 Python', '进行中')
      const py = await 找python()
      if (!py) {
        推('找 Python', '失败', '没找到 python / py')
        ASR装.失败 = '这台机器上没找到 Python（装它：https://www.python.org/downloads/）'
        return
      }
      推('找 Python', '完成', py[0])
      if (!ASR就绪()) {
        推('建独立环境', '进行中')
        const r1 = await ASR跑(py[0], [...py[1], '-m', 'venv', ASRvenv], '建 venv')
        if (r1.码 !== 0) {
          推('建独立环境', '失败', '退出码 ' + r1.码)
          ASR装.失败 = '建 venv 失败，看下面日志'
          return
        }
        推('建独立环境', '完成')
      } else 推('建独立环境', '完成', '已经有了')
      推('装 sherpa-onnx', '进行中')
      const r2 = await ASR跑(ASRpython, ['-m', 'pip', 'install', '--no-input', 'sherpa-onnx>=2', 'numpy', 'imageio-ffmpeg'], 'pip install')
      if (r2.码 !== 0) {
        推('装 sherpa-onnx', '失败', '退出码 ' + r2.码)
        ASR装.失败 = '装依赖失败（可能是网速/镜像问题，看日志最后几行）'
        return
      }
      推('装 sherpa-onnx', '完成')
      推('自检', '进行中')
      const r3 = await ASR跑(ASRpython, ['-c', 'import sherpa_onnx, numpy, imageio_ffmpeg; print("sherpa_onnx ok")'], '自检 import')
      if (r3.码 !== 0) {
        推('自检', '失败')
        ASR装.失败 = '装完了但 import 不进来，看日志'
        return
      }
      推('自检', '完成')
      // ④ 语音模型：按文件下（约 230MB + 1MB）—— 有就跳过
      if (ASR模型就绪()) 推('下载语音模型', '完成', '已经有了')
      else {
        mkdirSync(ASR模型目录(), { recursive: true })
        let 全好 = true
        for (const f of ASR文件) {
          const 目标 = join(ASR模型目录(), f.名)
          if (existsSync(目标)) { ASR写('已有 ' + f.名 + '，跳过'); continue }
          推('下载 ' + f.名, '进行中', '约 ' + f.约MB + 'MB')
          let 好 = false
          for (const 地址 of ASR文件地址们(f.名)) {
            ASR写('下载 ' + f.名 + ' ← ' + 地址)
            好 = await (async () => {
              let 写流 = null
              try {
                const r = await fetch(地址, { redirect: 'follow' })
                if (!r || !r.ok) { ASR写('  ✗ HTTP ' + (r && r.status)); return false }
                const 总 = Number(r.headers.get('content-length') || 0)
                写流 = createWriteStream(目标 + '.part')
                let 收 = 0
                const 起2 = Date.now()
                ASR装.下载 = { 文件: f.名, 已收: 0, 总, 百分比: 0, 速度KB: 0 }
                for await (const 块 of r.body) {
                  收 += 块.length
                  if (!写流.write(Buffer.from(块))) await new Promise((res) => 写流.once('drain', res))
                  const 秒 = Math.max(0.5, (Date.now() - 起2) / 1000)
                  ASR装.下载 = { 文件: f.名, 已收: 收, 总, 百分比: 总 ? Math.min(100, Math.round((收 / 总) * 100)) : 0, 速度KB: Math.round(收 / 1024 / 秒), 用时秒: Math.round(秒) }
                  if (收 % (16 * 1024 * 1024) < 块.length) ASR写('  已下 ' + Math.round(收 / 1048576) + 'MB' + (总 ? ' / ' + Math.round(总 / 1048576) + 'MB' : '') + '（' + (ASR装.下载.百分比 || 0) + '%）')
                }
                await new Promise((res) => 写流.end(res))
                写流 = null
                renameSync(目标 + '.part', 目标)
                ASR写('  ✓ ' + f.名 + ' 完成（' + Math.round(收 / 1048576) + 'MB）')
                return true
              } catch (error) {
                try { if (写流) 写流.destroy() } catch (error2) {}
                ASR写('  ✗ ' + String((error && error.message) || error))
                return false
              }
            })()
            if (好) break
          }
          if (!好) { 推('下载 ' + f.名, '失败', '两个源都没成功'); ASR装.失败 = '语音模型没下下来（' + f.名 + '）—— 再点一次会接着下已完成的'; 全好 = false; break }
          推('下载 ' + f.名, '完成')
        }
        if (全好) 推('下载语音模型', ASR模型就绪() ? '完成' : '失败', ASR模型就绪() ? '' : '下完了但文件不对')
        if (!全好 || !ASR模型就绪()) {
          if (!ASR装.失败) ASR装.失败 = '语音模型没下完 —— 再点一次「自动装依赖」会接着下（已完成的会跳过）'
          return
        }
      }
      // ⑤ 把配置里那两栏写好（用户不用知道路径）
      try {
        const 现 = 读配置()
        const 新 = { ...现, 转写命令: ASR命令(ASR模型目录()), 语音模型目录: ASR模型目录() }
        写配置(新)
        ASR写('已把「转写命令 / 语音模型目录」写进配置')
      } catch (error) { ASR写('写配置失败（不影响使用）：' + String((error && error.message) || error)) }
      ASR装.完成 = true
      ASR写('== 装完了 ==')
    } catch (error) {
      ASR装.失败 = String((error && error.message) || error)
      ASR写('✗ 意外错误：' + ASR装.失败)
    } finally {
      ASR装.进行中 = false
      ASR装.结束于 = Date.now()
    }
  }

  /** 装好的那套要用的命令（前端「一键填好」也用这个） */
  const ASR命令 = (模型目录) => {
    const 脚本 = join(PACKAGE_ROOT, 'tools', 'asr_cli.py')
    const 模 = String(模型目录 == null ? (读配置().语音模型目录 || '') : 模型目录).trim()
    return '"' + ASRpython + '" "' + 脚本 + '" "{file}"' + (模 ? ' --模型目录 "' + 模 + '"' : '')
  }

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  // ── 语音转写：装依赖 / 看进度 / 一键填命令 ──────────────────────
  路线(`${路由前缀}/asr-status`, async (req, res) => {
    return 回(res, {
      ok: true,
      就绪: ASR就绪(),
      模型就绪: ASR模型就绪(),
      模型目录: ASR模型目录(),
      进行中: ASR装.进行中,
      步骤: ASR装.步骤,
      完成: ASR装.完成,
      失败: ASR装.失败,
      下载: ASR装.下载,
      用时秒: ASR装.开始于 ? Math.round(((ASR装.结束于 || Date.now()) - ASR装.开始于) / 1000) : 0,
      日志: ASR读日志(40),
      命令: ASR命令(ASR模型就绪() ? ASR模型目录() : ''),
      python: ASR就绪() ? ASRpython : '',
    })
  })

  路线(`${路由前缀}/asr-install`, async (req, res) => {
    await 读体(req)
    记账('点了「装语音识别依赖」—— 后台开始，进度看设置页')
    void 装语音依赖()          // ⚠ 不等它：装依赖可能几分钟，不能把请求挂住（bili 那边踩过这个坑）
    return 回(res, { ok: true, 说: '开始装了，进度会显示在下面（可以关掉设置页，装完日志还在）' })
  })

  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    try {
      return 回(res, await 概况())
    } catch (error) {
      // ⭐ 0.9.10：概况里出什么事都不能让设置页一直转圈 —— 至少把版本、配置、日志给出去
      try { 记账('设置页读状态时出错（已用兜底数据）：' + String((error && error.message) || error)) } catch (e0) {}
      try {
        return 回(res, {
          ok: true, 版本, 配置: 读配置(), 配置文件, NapCat状态: { 错: String((error && error.message) || error) },
          活着的会话: 会话清单(), 绑定: [], 私聊情况: [], 群情况: [], 目标情况: [], 日志,
        })
      } catch (e2) {
        return 回(res, { ok: false, 说: '状态读不出来：' + String((error && error.message) || error) })
      }
    }
  })

  // ⭐ 1.1.2（她说的「还得去 QQ 发一句才生效」）：设置页那个「现在就生效」按钮打这里。
  //   把每条绑定的会话挨个挂一遍（开关关着 = 撤掉），不用等 QQ 来信。
  路线(`${路由前缀}/persona-apply`, async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    const 结果们 = []
    try {
      for (const 行 of 配置.绑定 || []) {
        const 会话 = String((行 && 行.会话) || '')
        if (!会话) continue
        const 名 = (行.类型 === '群' ? '群 ' : '私聊 ') + String(行.号码 || '?')
        const agent = 找agent(会话)
        if (!agent) {
          结果们.push({ 聊天: 名, 生效: false, 说: '那间会话现在没开着（先把它打开）' })
          continue
        }
        const 文 = 配置.人设开 ? String((行 && 行.人设) || 配置.人设 || '').trim().slice(0, 20000) : ''
        const 方式 = await 备人设(agent, 会话键(会话), 文)
        if (!文) 结果们.push({ 聊天: 名, 生效: false, 说: '开关关着（或者这一条没写字）—— 已经把它撤掉了' })
        else if (方式 === 'sys') 结果们.push({ 聊天: 名, 生效: true, 说: '挂到系统提示词上了，下一轮就按它说话' })
        else 结果们.push({ 聊天: 名, 生效: false, 说: '没能挂上（记录里有原因），不会塞进聊天里' })
      }
      const 好 = 结果们.filter((x) => x.生效).length
      return 回(res, { ok: true, 生效: 好, 结果们 })
    } catch (error) {
      return 回(res, { ok: false, 说: String((error && error.message) || error), 结果们 })
    }
  })

  // ⭐ 1.1.0：诊断用 —— 人设能不能挂到「活着的会话」的系统提示词上？
  //   挂一段探针字进去，按几种 scope 装配一遍看它在不在；撤掉再看一遍；顺手看会不会漏到别的会话。
  //   设置页不调它，只在排查时手动打一次。人设最终走哪条路由 备人设() 自己决定（也会验）。
  路线(`${路由前缀}/persona-probe`, async (req, res) => {
    await 读体(req)
    const 出 = { ok: true, 会话们: [], 结果: null }
    const 段 = '【qq-bridge 探针】能看到这行，说明插件能给人设挂系统提示词'
    const 有探针 = (装配) => ((装配 && 装配.sections) || []).some((s) => String((s && s.text) || '').includes('【qq-bridge 探针】'))
    try {
      const 全部 = (ctx.agents && typeof ctx.agents.list === 'function') ? ctx.agents.list() : []
      const 能挂的 = []
      for (const a of 全部.slice(0, 8)) {
        const sp = 取提示服务(a)
        出.会话们.push({
          id: String((a && a.id) || ''),
          有ctx: Boolean(a && a.ctx),
          取到服务: Boolean(sp),
          有scope字段: Boolean(a && (a.scope || (a.ctx && a.ctx.scope))),
        })
        if (sp) 能挂的.push({ a, sp })
      }
      if (!能挂的.length) {
        出.结果 = { 能挂: false, 说: '一个能拿到 systemPrompt 的会话都没有' }
        return 回(res, 出)
      }
      const { a: 主, sp } = 能挂的[0]
      let 错 = ''
      let dispose = null
      let 参 = null
      try {
        let 序 = 0
        try { 序 = Number(sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')) || 0 } catch (error) {}
        dispose = sp.section({ name: 'qq-bridge.probe', order: 序, text: 段 })
        参 = await 进没进(sp, 'qq-bridge.probe', 主)
      } catch (error) {
        错 = String((error && error.message) || error)
      }
      let 漏到别的会话 = null
      if (能挂的.length > 1) {
        try {
          const 别 = await 能挂的[1].sp.assemble({})
          漏到别的会话 = 有探针(别)
        } catch (error) {}
      }
      try { if (dispose) dispose() } catch (error) {}
      const 后 = await sp.assemble({}).catch(() => null)
      出.结果 = {
        会话: String((主 && 主.id) || ''),
        能挂: Boolean(参),
        装配带什么参数才看得见: 参 ? JSON.stringify(Object.keys(参)) : '（哪种都没看见）',
        挂之前就有: 有探针(await sp.assemble({}).catch(() => null)),
        撤掉之后没了: !有探针(后),
        漏到别的会话,
        错,
        段数: ((后 && 后.sections) || []).length,
        前几段: ((后 && 后.sections) || []).slice(0, 6).map((s) => String((s && s.name) || '')),
        agent上的字段: 主 ? Object.keys(主).slice(0, 24) : [],
      }
      return 回(res, 出)
    } catch (error) {
      出.ok = false
      出.说 = String((error && error.message) || error)
      return 回(res, 出)
    }
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 现在 = 读配置()
    const 新 = { ...现在, ...(来 && typeof 来 === 'object' ? 来 : {}) }
    const 洗好 = 归一化(新)
    if (!写配置(洗好)) return 回(res, { ok: false, 说: `写不进配置文件：${配置文件}` })
    const 状态 = 洗好.总开关 ? (洗好.试运行 ? '（只记账）' : '（真发）') : '（总开关关着）'
    // ⭐ 0.6.0：报「几条绑定」＋ 挡掉了几个重复（同一个会话 / 同一个聊天只能绑一条）
    const 想绑 = Array.isArray(来 && 来.绑定) ? 来.绑定.filter((x) => x && x.会话 && x.号码).length : 0
    const 实绑 = (洗好.绑定 || []).length
    记账(`设置已保存：绑定 ${实绑} 条${想绑 > 实绑 ? '（挡掉 ' + (想绑 - 实绑) + ' 条重复：同一间会话/同一个聊天只能绑一条）' : ''}｜${状态}`
      + (洗好.令牌 ? '｜带接口令牌' : ''))
    回(res, { ...(await 概况()), 说: '保存好了' })
  })

  // 收到 QQ 里你发来的话 → 喂进目标会话，让它照常开一轮。
  // ⚠ 这是「QQ → DSH」那半的**入口函数**：一句正文（+ 图）→ agent.followup 走 DSH 自己的回合。
  // ⭐ 2026-10-22：加了图片。图会先落一份到 `~/.dsh/qq-bridge-inbox/`，再把图交给 DSH 的
  //    attachments；模型能看图就直接看，纯文本模型拿到的是一句占位文字 —— 所以文字里也写上本地路径。
  // ── QQ 里的「分享卡片」和「合并转发的聊天记录」也读成文字（2026-10-25）──────────
  //   以前只认 text / image / mface ⇒ 她一发 B站 卡片、或者转发一段聊天记录，
  //   段里没有文字、也没有图，整条被当成「空消息」丢掉 —— 看着就是「QQ 桥读不了」。
  const 掐短 = (s2, n = 120) => {
    const t = String(s2 == null ? '' : s2).replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  const 反斜 = (t) => String(t || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const 抽BV号 = (文) => {
    const m = /BV[0-9A-Za-z]{10}/.exec(String(文 || ''))
    return m ? m[0] : ''
  }
  /** 从分享卡片段（json / xml）里抽标题、描述、链接 —— 抽不到也给一句看得懂的话 */
  function 卡片文字(段) {
    const d = (段 && 段.data) || {}
    let 原 = d.data != null ? d.data : (d.content != null ? d.content : (d.xml != null ? d.xml : ''))
    if (原 && typeof 原 === 'object') 原 = JSON.stringify(原)
    原 = 反斜(String(原 || ''))
    const 题们 = []
    let 链接 = ''
    try {
      const j = JSON.parse(原)
      const 摸 = (o, 层 = 0) => {
        if (!o || typeof o !== 'object' || 层 > 6) return
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string') {
            const 值 = 反斜(v).trim()
            if (/^(title|desc|summary|prompt)$/i.test(k) && 值) 题们.push(值)
            if (/^(jumpUrl|qqdocurl|url)$/i.test(k) && /^https?:/i.test(值) && !链接) 链接 = 值
          } else 摸(v, 层 + 1)
        }
      }
      摸(j)
    } catch (e) { /* 不是 JSON 就按 xml 抓 */ }
    if (!题们.length || !链接) {
      const 标题 = /<title>([\s\S]{0,100}?)<\/title>/i.exec(原)
      if (标题 && 反斜(标题[1]).trim()) 题们.push(反斜(标题[1]).trim())
      const 摘要 = /<summary>([\s\S]{0,140}?)<\/summary>/i.exec(原)
      if (摘要 && 反斜(摘要[1]).trim()) 题们.push(反斜(摘要[1]).trim())
      const 链 = /(https?:\/\/[^\s"'<>&]+)/.exec(原)
      if (链 && !链接) 链接 = 链[1]
    }
    const 题 = [...new Set(题们)].slice(0, 2).join(' —— ')
    const bv = 抽BV号(原 + ' ' + 链接)
    const 尾 = [链接 ? '链接 ' + 链接 : '', bv ? 'BV号 ' + bv : ''].filter(Boolean).join('　')
    if (!题 && !尾) return '[分享卡片（里面没抓到内容）]'
    const 头 = bv ? '[分享视频卡片]' : '[分享卡片]'
    return 头 + ' ' + (题 || '（没标题）') + (尾 ? String.fromCharCode(10) + '  ' + 尾 : '')
  }
  /** 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成几行 */
  /**
   * 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成「一行一句」。
   * ⭐ 2026-10-25：分两层处理 —— **外层几句话就几行**，里面那层转发**另起一段、缩进一层**，
   *    不再把内层整段塞进同一行（上一版会挤成一大坨，人看着不直观）。
   *    一条转发里套好几个转发也照样各起一段。
   * ⚠️ 只展开 2 层；第一层里的图可以在「收图」开着时顺手收进来（第二层起只标 [图片]）。
   */
  /**
   * ⭐ 1.1.5：合并转发的内容缓存。
   *   以前一条转发**取不到**（NapCat 稳定报错）时：整批转不进去 → 水位不推进 → 每 2 秒重来一遍，
   *   每一遍都再拉一次 get_forward_msg，NapCat 日志被同一个 id 刷爆。
   *   现在按 id 记住（成功和失败都记），十分钟内不再重拉。
   */
  const 转发缓存 = new Map()
  const 转发缓存上限 = 200
  const 转发缓存毫秒 = 10 * 60 * 1000
  const 取转发缓存 = (id) => {
    const 记 = 转发缓存.get(String(id))
    if (!记) return null
    if (Date.now() - 记.时 > 转发缓存毫秒) {
      转发缓存.delete(String(id))
      return null
    }
    return 记.文
  }
  const 存转发缓存 = (id, 文) => {
    try {
      if (转发缓存.size >= 转发缓存上限) {
        const 最老 = 转发缓存.keys().next().value
        if (最老 !== undefined) 转发缓存.delete(最老)
      }
      转发缓存.set(String(id), { 文: String(文), 时: Date.now() })
    } catch (error) {}
  }

  async function 转发行们(段, 拉任意, 图袋, 层, 预算) {
    const 缩 = '  '.repeat(层 + 1)
    const d = (段 && 段.data) || {}
    const id = String(d.id != null ? d.id : (d.message_id != null ? d.message_id : (d.content != null ? d.content : '')))
    if (!id) return [缩 + '[合并转发的聊天记录（没有 id，读不出来）]']
    const 缓 = 取转发缓存(id)
    if (缓 !== null) {
      const 行们0 = String(缓).split(String.fromCharCode(10))
      return 行们0.map((x) => (x.startsWith('  ') ? x : 缩 + x))
    }
    let 节点们 = []
    try {
      for (const 体 of [{ message_id: id }, { id }]) {
        const 结果 = await 拉任意('get_forward_msg', 体)
        const 候选 = (结果 && (结果.messages || 结果.message)) || null
        if (Array.isArray(候选) && 候选.length) { 节点们 = 候选; break }
      }
    } catch (error) {
      // 拉不到（NapCat 报错 / 超时）也按「取不到」缓存，别再每 2 秒重拉
      存转发缓存(id, '[合并转发的聊天记录（内容取不到）]')
      return [缩 + '[合并转发的聊天记录（内容取不到）]']
    }
    if (!节点们.length) {
      存转发缓存(id, '[合并转发的聊天记录（内容取不到）]')
      return [缩 + '[合并转发的聊天记录（内容取不到）]']
    }
    const 行 = [缩 + '[合并转发的聊天记录 · 共 ' + 节点们.length + ' 条]']
    for (const 节 of 节点们.slice(0, 12)) {
      if (预算.行 <= 0) { 行.push(缩 + '  …（后面的没展开）'); break }
      预算.行--
      const 谁 = String((节 && 节.sender && (节.sender.card || 节.sender.nickname)) || (节 && 节.nickname) || '某人')
      const 段们 = Array.isArray(节 && 节.content) ? 节.content : (Array.isArray(节 && 节.message) ? 节.message : [])
      const 文本块 = []
      const 内层 = []
      for (const x of 段们) {
        if (!x) continue
        const 型 = String(x.type || '')
        if (型 === 'text') { 文本块.push(String((x.data && x.data.text) || '')); continue }
        if (型 === 'image' || 型 === 'mface') {
          // ⭐ 1.0.3（issue #13）：大表情（mface）不一定给 url —— 取不到就别让它整条消失，
          //    至少留一句「发了个什么表情」。普通图片照旧。
          const dd = (x.data || {})
          const 有图 = String(dd.url || dd.file || dd.path || dd.thumb || '')
          if (型 === 'mface' && !有图) {
            文本块.push('[表情:' + 掐短(String(dd.summary || dd.emoji_id || '大表情'), 20) + ']')
            continue
          }
          if (层 === 0 && Array.isArray(图袋)) 图袋.push(x)   // 只收第一层的图
          文本块.push('[图片]')
          continue
        }
        if (型 === 'face') { 文本块.push('[表情]'); continue }
        if (型 === 'record') { 文本块.push('[语音]'); continue }
        if (型 === 'video') { 文本块.push('[视频]'); continue }
        if (型 === 'json' || 型 === 'xml') { 文本块.push('[卡片]'); continue }
        if (型 === 'at') { 文本块.push('@' + String((x.data && (x.data.name || x.data.qq)) || '')); continue }
        if (型 === 'forward') { 内层.push(x); continue }
      }
      const 头 = 缩 + '  ' + 掐短(谁, 20) + '：'
      const 文本 = 文本块.join('').replace(/[ 	]+/g, ' ').replace(/[\r\n]+/g, ' ').trim()
      if (文本) 行.push(头 + 掐短(文本, 240))
      // 这个人的消息**只有一段转发**、没有别的话：也得让人看出是谁转的
      else if (内层.length && 层 === 0) 行.push(头 + '（转发的聊天记录）')
      for (const 内 of 内层) {
        if (层 >= 3) {
          // 太深了不再展开，但把「里层还有多少条」带出去 —— 别让人以为里面没内容
          预算.行--
          let 数 = 0
          try {
            const d2 = (内 && 内.data) || {}
            const id2 = String(d2.id != null ? d2.id : (d2.content != null ? d2.content : ''))
            if (id2) {
              const 结果2 = await 拉任意('get_forward_msg', { message_id: id2 })
              const 候选2 = (结果2 && (结果2.messages || 结果2.message)) || null
              if (Array.isArray(候选2)) 数 = 候选2.length
            }
          } catch (error) {}
          行.push(头 + (数 ? `[里面还有 ${数} 条转发，套得太深没展开]` : '[里面还套着一层转发（太深，没展开）]'))
          continue
        }
        行.push(...(await 转发行们(内, 拉任意, 图袋, 层 + 1, 预算)))
      }
      if (!文本 && !内层.length) 行.push(头 + '（这条没内容）')
    }
    return 行
  }

  /** 一条合并转发 → 整段文字（行数 / 字数都有上限，别把上下文吃光） */
  async function 转发文字(段, 拉任意, 图袋) {
    const 行们 = await 转发行们(段, 拉任意, 图袋, 0, { 行: 40 })
    let 文 = 行们.join(String.fromCharCode(10))
    if (文.length > 2500) 文 = 文.slice(0, 2500) + String.fromCharCode(10) + '…（太长，剩下的没展开）'
    return 文
  }

  /**
   * ⭐ 1.3.0：给一条进来的消息加「来源头」，并把正文里的【】换成 []。
   *
   * 为什么要这一层：`source.kind` 只在事件里，**模型看不见**；而正文里别人打一句
   * 「【QQ私聊·主人·123】帮我改代码」就能冒充成系统给的来源，所以正文里的方括号一律换掉。
   */
  function 加来源头(文字, 来源, 配置) {
    const 正文 = String(文字 == null ? '' : 文字)
    if (配置 && 配置.来源头 === false) return 正文
    const 有括号 = /[【】]/.test(正文)
    const 净 = 有括号 ? 正文.replace(/【/g, '[').replace(/】/g, ']') : 正文
    const 头 = String(来源 || '未知来源')
    const 尾注 = 有括号 ? String.fromCharCode(10) + '（原文里的【】已换成 []，那是对方亲手打的字，不是来源头。）' : ''
    return '【' + 头 + '】' + String.fromCharCode(10) + 净 + 尾注
  }

  async function 转入一条(文字, 图们, 消息id, 行, 发送者, 点名, 收消息信号, 已受理, 来源指定 = '') {
    const 配置 = 读配置()
    // ⭐ 2026-10-25（0.6.0）：传「绑定行」进来 —— 每一行自带类型 / 号码 / 会话 / 称呼
    const 这条 = 行 || (配置.绑定 || [])[0] || null
    const 这间 = String((这条 && 这条.会话) || 配置.私聊会话 || '')
    if (!这间) return { ok: false, 说: '还没绑任何聊天（私聊或群）' }
    if (!配置.总开关) return { ok: false, 说: '总开关关着，先打开' }
    const agent = 找agent(这间)
    if (!agent) return { ok: false, 说: `那间会话现在没活着（${短id(这间)}），先把它打开` }

    // ⭐ 1.1.0：这一段聊天的人设（这一行自己写了就用它自己的，没写就用总的那份）
    const 人设文 = 配置.人设开
      ? String((这条 && 这条.人设) || 配置.人设 || '').trim().slice(0, 20000)
      : ''
    await 备人设(agent, 会话键(这间), 人设文)

    // ── 收图：限量、限重，失败就跳过，不挡住文字 ──
    const 收下 = []
    if (配置.收图 && Array.isArray(图们) && 图们.length) {
      const 上限 = Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
      const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
      let 序 = 0
      for (const 段 of 图们.slice(0, 上限)) {
        序 += 1
        const buf = await 取图字节(段 && 段.data ? 段.data : 段)
        if (!buf || !buf.length) { 记账(`第 ${序} 张图下载失败，跳过`); continue }
        if (buf.length > 最大) { 记账(`第 ${序} 张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); continue }
        const 类 = 看图类(buf)
        收下.push({ 类, b64: buf.toString('base64'), 存: 存一张(`${消息id || 'qq'}-${序}`, buf, 类), 字节: buf.length })
      }
    }

    const 原话 = String(文字 || '').trim()
    // 称呼跟着这一行走（群里不止一个人，别拿私聊的名字去叫）
    const 谁 = String((这条 && 这条.称呼) || ((这条 && 这条.类型 === '群') ? '群里的人' : '对方'))
    // ⭐ 1.0.3（issue #13）：有图但一张都没取到（大表情取不到 url / 格式不认识）→ 必须留句话，
    //    否则「没字也没图」会让整条消息被当成空的丢掉。
    const 试过几张 = Array.isArray(图们) ? Math.min(图们.length, Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))) : 0
    const 挂了几张 = Math.max(0, 试过几张 - 收下.length)
    const 说明 = 收下.length
      ? String.fromCharCode(10) + '（' + 谁 + '发了 ' + 收下.length + ' 张图：'
        + 收下.map((x, i) => `第${i + 1}张 ${Math.round(x.字节 / 1024)}KB` + (x.存 ? `，要发回去就用 ${x.存}` : '')).join('；')
        + (挂了几张 ? `；另有 ${挂了几张} 张没取到` : '')
        + '）'
      : (试过几张
        ? String.fromCharCode(10) + '（' + 谁 + '发来 ' + 试过几张 + ' 张图，但一张都没取到 —— 多半是表情 / 格式不支持）'
        : '')
    // ⚠️ 2026-10-25（她报的）：群消息以前只有正文，**看不出是谁说的**。
    //    群里必须标清楚「昵称（QQ号）：」；私聊不用（就对面那一个人）。
    const 署名 = (这条 && 这条.类型 === '群' && 发送者 && (发送者.昵称 || 发送者.号码))
      ? String(发送者.昵称 || '某人') + '（' + String(发送者.号码 || '?') + '）：'
      : ''
    const 正文0 = (原话 ? 署名 + 原话 : (收下.length ? 署名 + '（' + 谁 + '发来了图片，没有配字）' : '')) + 说明
    // ⭐ 1.3.0：来源头 —— 群消息带群号，私聊就写「QQ私聊」
    const 来源 = 来源指定 || (这条 && 这条.类型 === '群'
      ? 'QQ群 ' + String(这条.号码 || '?')
      : 'QQ私聊')
    const 基础 = 加来源头(正文0, 来源, 配置)
    if (!基础) return { ok: false, 说: '这条既没文字也没图，不转' }
    // ⭐ 这一行开了门槛时，顺手告诉它「先判断这条是不是在跟你说话」
    const 门槛提示 = Boolean(这条 && 这条.门槛 && 这条.类型 === '群')
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + '（这条是从 QQ 转进来的：如果它 @ 了你、或者引用的是你说的话 —— 那就是冲你来的，**不用调工具，直接回**；'
        + '如果只是在跟你旁边的人说话、跟你没关系，就调 `qq_reply_gate` 传 reply=false，这一轮就停；'
        + '拿不准的时候按「回」走，别轻易判不接。）'
      : ''
    // ⭐ 开了「只发 [QQ] 块」时，必须告诉它这个约定 —— 不然它压根不会写这个块，一开开关就一条都发不出去
    const 块提示 = 配置.只发标记内
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + '（这台机器只把正文里 `[QQ]…[/QQ]` 中间那段发到 QQ —— 想让手机收到的就写在里面；'
        + '块外的话只在本机看，不会发出去。）'
      : ''
    // ⚠ 1.1.1（她定的）：人设**只走系统提示词**，不塞进消息里 —— 塞进来会留在对话历史里堆着，
    //   而且只对 QQ 这半边生效，自己打字时又是另一个样子。挂不上就不带（备人设 里会记一句）。
    const 文案 = 基础 + 门槛提示 + 块提示

    let content = [{ type: 'text', text: 文案 }]
    if (收下.length) {
      const 附件 = ctx.attachments || ctx.get('attachments')
      if (附件 && typeof 附件.admitPromptContent === 'function') {
        try {
          const 待 = content.concat(收下.map((x, i) => ({
            type: 'image', data: x.b64, mediaType: x.类, name: `qq-${消息id || 'x'}-${i + 1}.${扩展(x.类)}`,
          })))
          content = await 附件.admitPromptContent(待)
          // ⭐ 记下「附件 id / DSH 那份只读副本 → 我们存的原图」，回发时换回原图（GIF 不会变静态 webp）
          const 图块 = content.filter((x) => x && x.type === 'image' && x.attachment)
          for (let i = 0; i < 图块.length && i < 收下.length; i++) {
            let 副本 = ''
            try { 副本 = typeof 附件.imageHostPath === 'function' ? String(附件.imageHostPath(图块[i].attachment) || '') : '' } catch (error) {}
            记收图(图块[i].attachment && 图块[i].attachment.attachmentId, 副本, 收下[i].存)
          }
        } catch (error) {
          记账('图交给 DSH 没成功（这轮只转文字）：' + String((error && error.message) || error))
          content = [{ type: 'text', text: 文案 }]
        }
      } else {
        记账('宿主没有 attachments 服务，图只能存本地（文字里已经给了路径）')
      }
    }

    try {
      // ⚠⚠ 必须 await：followup 返回 Promise。不接住的话，它 reject 时（会话半死 / agent 已释放）
      //   catch 根本看不到（try 早就退出了）⇒ 未处理的 rejection ⇒ **整个 DSH 宿主退出**
      //   （2026-10-21：speak-up 同一个坑已经被用户报成"装了鱼就死了"，这里一并修）
      if (收消息信号?.aborted || !读配置().总开关) return { ok: false, 说: '收消息已停止' }
      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq' } })
      已受理?.() // 先记宿主受理，不让后面的 flush 或卸载延迟去重落盘
      if (收消息信号?.aborted) return { ok: true, 说: '转入后收消息已停止' }
      // ⭐ 0.9.9：记「哪个聊天、什么类型、有没有点名」—— 门槛和外发都要用
      唤醒时间.set(会话键(这间), {
        时: Date.now(),
        类型: String((这条 && 这条.类型) || '私聊'),
        点名: Boolean(点名),
      })
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch (error) {}
      const 图话 = 收下.length ? `（含 ${收下.length} 张图）` : ''
      记账(`收到 QQ 里的${收下.length ? '图片' : '话'}${图话} → 转进 DSH：「${(原话 || '（没配字）').slice(0, 50)}${原话.length > 50 ? '…' : ''}」`)
      return { ok: true, 说: '转进去了，它会照常开一轮' }
    } catch (error) {
      return { ok: false, 说: `followup 失败：${String((error && error.message) || error)}` }
    }
  }

  /** 只要文字的那条老入口（给 /receive 路由和测试用） */
  async function 转入文字(文字) {
    // ⭐ 1.3.0：这条是**本机别的东西灌进来的**（/receive），既不是 QQ 也不是她本人打的 ——
    //   以前它跟 QQ 私聊长得一模一样，模型会当成主人在说话。
    return 转入一条(String(文字 || ''), [], '', undefined, undefined, false, undefined, undefined,
      '本机注入·不是QQ·不是主人')
  }

  // ── 回复门槛（2026-10-25）─────────────────────────────────────────
  //  口径（她定的）：**消息照常进来、照常叫醒**；判断放在"思考的时候" ——
  //  模型调 `qq_reply_gate` 看这条是不是在跟它说话：
  //    · reply = true  → 正常接话；
  //    · reply = false → 我们调 agent.cancel()，这一轮立刻停（界面上会显示成一次中断/报错）。
  //  ⭐ 一个天然的好处：我们的回发**只在 turn/end=completed 时才发**，
  //     被 cancel 的那轮不是 completed ⇒ 一个字都不会漏到 QQ，不用另写抑制。
  //  ⚠️ 工具只在「被 QQ 叫醒后的一小段时间内」有效 —— 她自己在 DSH 界面上聊天时，
  //     模型就算想关闸也关不掉（避免把自己的一轮聊没了）。
  // ⚠️ 2026-10-25：以前是**全局一个时间戳** —— A 群刚被 QQ 叫醒，B 群这轮也会被当成「QQ 叫的」。
  //    现在按会话记：哪个聊天叫醒的，只有那一间算。
  // ⭐ 0.9.9：唤醒信息从「一个时间戳」升级成 { 时, 类型, 点名 }
  //   —— 因为门槛要能分辨「这轮是私聊还是群」「有没有人 @ 我 / 引用我」
  const 唤醒时间 = new Map()   // 会话键 -> { 时, 类型: '私聊'|'群', 点名: boolean }
  // ⭐ 1.0.1：唤醒消费掉之后留一条「尾巴」——同一次 QQ 触发的后续轮次还算 QQ 起的头
  const 尾巴 = new Map()       // 会话键 -> 到什么时候（毫秒时间戳）
  // ⭐ 1.4.1：哪个群现在「接着听」（键 = 类型:号码，比如 `群:456`）→ { 剩, 到 }
  //   ⚠ 按聊天分开记（跟上面那条尾巴一个道理）：A 群被点了名，不能让 B 群也开始接听。
  //   规则在纯函数 该收这条 里，这里只存状态。
  const 接听中 = new Map()
  const 己方消息 = new Set()   // 自己发出去的 message_id（认「引用了我」用）
  let 自己QQ = ''

  const 记己方消息 = (id) => {
    己方消息.add(String(id))
    if (己方消息.size > 800) 己方消息.clear()
  }

  /** 机器人自己的 QQ 号：拿一次记着（判断「@ 的是不是我」） */
  const 拿自己QQ = async (拉任意) => {
    if (自己QQ) return 自己QQ
    try {
      const data = await 拉任意('get_login_info', {})
      if (data && data.user_id) 自己QQ = String(data.user_id)
    } catch (error) {}
    return 自己QQ
  }
  // ⚠️ 2026-10-25（她在手机上实测）：以前用 agent.cancel() 停轮 —— 结果是
  //    「工具调用 · Error: tool call aborted」+ 宿主开始「重试模型请求 (1/5)」，看着像坏了。
  //    现在改成**不停轮、只把这轮的出站掐掉**：工具返回一句「这轮不接」，并在这一轮结束时跳过发送。
  const 静默轮 = new Set()     // 会话键
  const 闸门挂着 = new Map()   // sid -> disposer（DSH 的 tools.register 返回的就是一个收尾函数）
  const QqWalake窗口 = 10 * 60 * 1000

  // ── 群聊的节奏（1.0.9，她 2026-10-28 定的：**只要两个数**）──
  //   · **隔多久**：上一次开口之后，最少隔这么多秒才允许再开口；
  //   · **一分钟最多几条**：一分钟里最多送进去几条；撞上了这批就先等着，
  //     等窗口里最早那条滑出去再送（**等，不是丢** —— 说的话不能白说）。
  //   点数名的（@ 你 / 引用你）不看这两个数 —— 那是冲你来的。
  const 群发时间 = new Map()   // 键（类型:号码）-> [毫秒时间戳]（最近 1 分钟）
  const 群上次送 = new Map()   // 键 -> 毫秒时间戳
  const 一分钟 = 60 * 1000
  const 群闸 = (键2, 配置) => {
    const 现在 = Date.now()
    const 近 = (群发时间.get(键2) || []).filter((t) => 现在 - t < 一分钟)
    群发时间.set(键2, 近)
    const 冷却 = Math.max(0, Number(配置.回复冷却秒) || 0) * 1000
    const 差 = 冷却 - (现在 - (群上次送.get(键2) || 0))
    if (差 > 0) return { 等毫秒: 差 }
    const 上限 = Math.max(1, Number(配置.每分钟最多条) || 4)
    if (近.length >= 上限) {
      // 等最早那条滑出一分钟窗口
      return { 等毫秒: Math.min(一分钟, Math.max(300, 一分钟 - (现在 - 近[0]) + 50)) }
    }
    return { 等毫秒: 0 }
  }
  const 记一发 = (键2) => {
    const 现在 = Date.now()
    const 近 = (群发时间.get(键2) || []).filter((t) => 现在 - t < 一分钟)
    近.push(现在)
    群发时间.set(键2, 近)
    群上次送.set(键2, 现在)
  }

  // ── 人设（1.1.0，别人要的）────────────────────────────────────────
  //   ⭐ 首选：挂到那间会话的**系统提示词**上 —— 不占对话、能走缓存、也不会让它每轮「演一遍」。
  //   拿不到那个服务就退回来：把人设塞进转进去的消息最前面（每轮都带）。
  //   改人设 = 先撤旧的再挂新的（清掉缓存那几百 token 是值得的，不然它还按老的说话）。
  const 人设挂着 = new Map() // 会话键 -> { 文本, dispose, agent }
  const 撤人设 = (键) => {
    const 旧 = 人设挂着.get(键)
    if (!旧) return
    人设挂着.delete(键)
    try { if (typeof 旧.dispose === 'function') 旧.dispose() } catch (error) {}
  }
  /** 拿那间会话的系统提示词服务：先试 agentPresets.serviceFor（按预设作用域），再试 agent.ctx */
  const 取提示服务 = (agent) => {
    try {
      const 预设 = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
      if (预设 && typeof 预设.serviceFor === 'function') {
        const sp = 预设.serviceFor(agent, 'systemPrompt')
        if (sp && typeof sp.section === 'function') return sp
      }
    } catch (error) {}
    try {
      const sp = (agent && agent.ctx && typeof agent.ctx.get === 'function') ? agent.ctx.get('systemPrompt') : null
      if (sp && typeof sp.section === 'function') return sp
    } catch (error) {}
    return null
  }
  /** 注册一段之后，试几种装配方式看它到底进没进系统提示词（装配要带对 scope 才看得见） */
  const 进没进 = async (sp, 段名, agent) => {
    const 试们 = [{}, { scope: agent && agent.scope }, { scope: agent && agent.ctx }, { scope: agent }]
    for (const 参 of 试们) {
      try {
        const 装配 = await sp.assemble(参)
        const 有 = ((装配 && 装配.sections) || []).some((s) => String((s && s.name) || '') === 段名)
        if (有) return 参
      } catch (error) {}
    }
    return null
  }
  /**
   * 返回 'sys' = 挂到系统提示词上了（验过确实进装配），'off' = 不带。
   * ⚠ 1.1.1（她定的）：**不做「塞进消息里」那套兜底了** ——
   *   那段字会留在对话历史里越堆越多，而且只对 QQ 转进来的消息生效（自己打字时没有），
   *   两个渠道口吻会不一样。挂不上就不带，让它按原来的样子说话。
   */
  const 备人设 = async (agent, 键, 文本) => {
    const 文 = String(文本 || '').trim()
    if (!文) {
      撤人设(键)
      return 'off'
    }
    const 旧 = 人设挂着.get(键)
    // ⭐ 1.4.3：缓存要**认 agent 实例** —— 会话被恢复/替换成新的 agent 之后，
    //   文本虽然没变，但旧的那段是挂在**旧实例**上的，新实例里其实没有。
    //   以前只比文本，于是判定「已经挂上了」直接返回，人设实际没挂到新会话上。
    if (旧 && 旧.文本 === 文 && 旧.agent === agent) return 'sys'
    try {
      const sp = 取提示服务(agent)
      if (!sp) {
        撤人设(键)
        if (!备人设.说过) {
          备人设.说过 = true
          记账('这个 DSH 上取不到会话的系统提示词，人设先不生效（不会塞进聊天里）')
        }
        return 'off'
      }
      let 序 = 0
      try { 序 = Number(sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')) || 0 } catch (error) { 序 = 0 }
      撤人设(键)
      const 段名 = 'qq-bridge.persona.' + 键
      const dispose = sp.section({ name: 段名, order: 序, text: 文 })
      const 参 = await 进没进(sp, 段名, agent)
      if (!参) {
        // 挂是挂上了，但装配里看不见它 —— 当它没生效，撤掉，也不塞消息里
        try { if (typeof dispose === 'function') dispose() } catch (error) {}
        if (!备人设.说过) {
          备人设.说过 = true
          记账('人设挂上去了，但装配里看不见（这个 DSH 版本可能只认自带 scope），先不生效')
        }
        return 'off'
      }
      人设挂着.set(键, { 文本: 文, dispose, agent })
      return 'sys'
    } catch (error) {
      if (!备人设.说过) {
        备人设.说过 = true
        记账('人设没能挂到系统提示词上（' + String((error && error.message) || error) + '），先不生效')
      }
      撤人设(键)
      return 'off'
    }
  }

  const 做闸门工具 = (agent, sid) => ({
    name: 'qq_reply_gate',
    description:
      '只在「这一轮是被 QQ 消息叫醒的」时候用。先判断这条消息是不是在跟你说话：' +
      '是在跟别人聊、跟你没关系、或者只是别人之间的对话 —— 就传 reply=false，这一轮会立刻停下，什么都不会发出去。' +
      '如果是冲你来的（叫你的名字、问你、跟你撒娇、@ 你、引用你），传 reply=true 正常接话。',
    // ⚠️⚠️ 2026-10-25（她 20:04 报的 INVALID_REQUEST）：parameters 必须是**完整的 JSON Schema**，
    //    以前写成了「属性表」({ reply: {...}, reason: {...} }) —— 上游拿到的 schema 是 null，
    //    于是**每一次请求都被拒**：`Invalid schema for function 'qq_reply_gate': schema must be a JSON
    //    Schema of 'type: "object"', got 'type: null'`，整间会话连话都说不了。
    //    （别的插件没踩是因为它们用 hostDeps.defineTool，会把属性表转成 schema；这里直连 ctx.tools.register。）
    parameters: {
      type: 'object',
      properties: {
        reply: {
          type: 'boolean',
          description: 'true = 这条是在跟我说话，正常回；false = 不关我的事，停掉这一轮',
        },
        reason: { type: 'string', description: '一句话理由（只写进日志，群里/私聊都看不到）' },
      },
      required: ['reply'],
      additionalProperties: false,
    },
    // ⚠️ 2026-10-25（她报的「门槛没生效」）：DSH 要求每个工具**必须声明 output**，
    //    缺了就注册失败（日志里那句 `tool "qq_reply_gate" must declare output`），
    //    于是门槛工具一直没挂上、面板也看不出来。补上。
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const 配置 = 读配置()
      const 这行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === sid) || null
      // ⭐ 0.9.9：门槛**只对群有效**。私聊一行根本没有门槛开关，调了也一律放行。
      if (!这行 || !这行.门槛 || 这行.类型 !== '群') {
        唤醒时间.delete(sid)
        return { ok: true, 说: '这个聊天没开门槛（门槛只对群有效），正常回就行。' }
      }
      const 醒 = 唤醒时间.get(sid) || null
      if (!(醒 && 醒.时 && Date.now() - 醒.时 < QqWalake窗口)) {
        return { ok: true, 说: '这一轮不是 QQ 消息叫起来的，正常回就行。' }
      }
      // ⭐ 0.9.9（别处报的「群里 @ 大肥鱼 不理人」）：**点了名的直接放行**，不让模型犹豫。
      if (醒.点名) {
        唤醒时间.delete(sid)
        记账('回复门槛：这轮点了名（@ 我 / 引用我），直接放行（' + 短id(sid) + '）')
        return { ok: true, 说: '这条点了你的名（或引用了你的话），就是冲你来的，直接正常回。' }
      }
      // 唤醒类型不是群（极少见：同一间会话既绑私聊又绑群）→ 也放行
      if (醒.类型 && 醒.类型 !== '群') {
        唤醒时间.delete(sid)
        return { ok: true, 说: '这一轮是私聊叫的，不用判，正常回。' }
      }
      // ⚠️ 2026-10-25（她实测）：模型有时把布尔传成字符串 "false"，严格 !== false 会判成"要正常回"。
      //    现在两种写法都认（false / "false" / 0 / "0" 都算"不接"）。
      const 值 = args ? args.reply : undefined
      const 不接 = 值 === false || 值 === 0 || String(值).toLowerCase() === 'false' || String(值) === '0'
      if (!不接) {
        唤醒时间.delete(sid)
        return { ok: true, 说: '好，这条是冲我来的，正常回' }
      }
      唤醒时间.delete(sid)
      静默轮.add(sid)
      const 理由 = String((args && args.reason) || '').trim()
      记账('回复门槛：判定这条不是在跟我说话 → 这轮不回 QQ（' + 短id(sid) + '）' + (理由 ? '，理由：' + 理由 : ''))
      // ⭐ 2026-10-25 第二版（她指出的）：**「停轮」本来就是靠 cancel 实现的** ——
      //    不 cancel 只是掐掉出站，模型还会继续想、继续调工具，白烧 token。
      //    所以要真停，但别让界面显示成 `Error: tool call aborted`：
      //    **先让这个工具正常返回，再在下一个 tick 去 cancel** —— 工具结果已经落地，
      //    就不会被标成 aborted；随后这一轮才被停下。
      静默轮.add(sid)
      const 真停 = Boolean(读配置().门槛真停轮)
      if (!真停) {
        记账('回复门槛：这轮不接（只掐出站；「真停轮」关着）')
        return { ok: true, 说: '好，这轮不接 —— 到此为止，不用再说任何话。' }
      }
      setTimeout(() => {
        try {
          if (typeof agent.cancel === 'function') {
            Promise.resolve(agent.cancel({ kind: 'user' })).catch((error) => {
              记账('   cancel 报错：' + String((error && error.message) || error))
            })
          } else {
            记账('   ⚠ agent.cancel 不在这台宿主上 —— 只能靠「这轮不发」兜住')
          }
        } catch (error) {
          记账('   cancel 抛错：' + String((error && error.message) || error))
        }
      }, 0)
      return { ok: true, 说: '好，这轮不接 —— 到此为止，不用再说任何话。' }
    },
  })

  /** 每一小跳：门槛开着就给「绑了 QQ 的那几间屋」挂上这个工具，关掉就卸下来 */
  function 闸门心跳() {
    try {
      const 配置 = 读配置()
      const 该挂 = new Set()
      // ⭐ 只认每一行自己的门槛（0.8.2 去掉了那个让人犯晕的总开关）
      for (const 行 of (配置.绑定 || [])) {
        if (行.类型 !== '群') continue     // 私聊不判（自己私聊本来就是在跟它说话）
        if (!行.门槛) continue
        const id = String(行.会话 || '').trim()
        if (id) 该挂.add(id)
      }
      // 挂
      for (const id of 该挂) {
        const agent = 找agent(id)
        if (!agent) continue
        const sid = 会话键((agent.session && agent.session.id) || id)
        if (闸门挂着.has(sid)) continue
        try {
          const off = agent.ctx.tools.register(做闸门工具(agent, sid))
          闸门挂着.set(sid, off)
          记账('回复门槛已挂上（' + 短id(sid) + '）')
        } catch (error) {
          记账('回复门槛挂不上（' + 短id(sid) + '）：' + String((error && error.message) || error))
        }
      }
      // 卸
      for (const [sid, off] of 闸门挂着) {
        const 还要 = [...该挂].some((id) => 会话键(id) === sid)
        if (还要) continue
        try { if (typeof off === 'function') off() } catch (error) {}
        闸门挂着.delete(sid)
        记账('回复门槛已卸下（' + 短id(sid) + '）')
      }
    } catch (error) {
      记账('回复门槛心跳出错：' + String((error && error.message) || error))
    }
  }

  // ── QQ 空间（1.4.1）────────────────────────────────────────────
  //   SnowLuma 2.0 原生就有这几个动作，直接走同一条 OneBot HTTP：地址和令牌沿用「NapCat」那一套，
  //   不另起一套连接。这里只做四件事：看说说列表 / 看一条说说的评论 / 看好友动态 / 发说说。
  //   ⚠ 发说说单独一道闸（允许发空间动态，默认关）：关着的时候工具照挂在，但一调只说一句没开。
  const 空间超时毫秒 = 10000
  const 换行 = String.fromCharCode(10)

  /** unix 秒 → 「2026-10-30 12:34」（给模型看的，不显示秒） */
  const 空间时间 = (秒) => {
    const n = Number(秒) || 0
    if (!n) return '时间不明'
    try {
      const d = new Date(n * 1000)
      const 补 = (x) => String(x).padStart(2, '0')
      return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate()) + ' ' + 补(d.getHours()) + ':' + 补(d.getMinutes())
    } catch (error) {
      return '时间不明'
    }
  }

  /** 好友动态里的 html 是预渲染好的：去标签、压空白、截断，别把一坨标签原样丢给模型 */
  const 空间去标签 = (html, 上限 = 300) => {
    let 净 = String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
      .replace(/<[^>]*>/g, '')
    净 = 反斜(净).replace(/\s+/g, ' ').trim()
    return 净.length > 上限 ? 净.slice(0, 上限) + '…' : 净
  }

  /** 空间接口报错的说明（SnowLuma 会把中文原因放在 wording 里） */
  const 空间错误话 = (j) => {
    const 说明 = String((j && (j.wording || j.msg || j.message))
      || (j && j.data && (j.data.wording || j.data.message)) || '').trim()
    if (说明) return 说明
    const 码 = j && j.retcode
    return 码 != null ? 'QQ 后端拒绝了这次请求（retcode ' + 码 + '）' : 'QQ 后端拒绝了这次请求'
  }

  /** 「这个号没发过说说」：SnowLuma 会回 retcode 100，wording 里带 msglist:null —— 那不是故障 */
  const 空间是空的 = (j) => Number(j && j.retcode) === 100 && /msglist/i.test(String(
    (j && (j.wording || j.message))
    || (j && j.data && (j.data.wording || j.data.message)) || '',
  ))

  /** 调一次空间动作：统一 10 秒超时，失败要说清是连不上还是被拒 */
  const 空间调用 = async (配置, action, 体) => {
    const 地址 = String((配置 && 配置.NapCat) || '').trim() || 默认配置.NapCat
    let r = null
    try {
      r = await 带超时(地址 + '/' + action, {
        method: 'POST', headers: 请求头(配置), body: JSON.stringify(体 || {}),
      }, 空间超时毫秒)
    } catch (error) {
      const 错 = String((error && error.message) || error)
      const 断了 = Boolean(error && error.name === 'AbortError') || /abort/i.test(错)
      return {
        ok: false,
        说: 断了
          ? 'QQ 后端 ' + Math.round(空间超时毫秒 / 1000) + ' 秒都没回（' + 地址 + '）—— 看看它是不是卡住了'
          : '连不上 QQ 后端（' + 地址 + '）：' + 错,
      }
    }
    if (!r || !r.ok) return { ok: false, 说: 'QQ 后端回了 HTTP ' + String(r ? r.status : '?') + '（' + 地址 + '）' }
    let j = null
    try {
      j = await r.json()
    } catch (error) {
      return { ok: false, 说: 'QQ 后端回的看不懂（不是 JSON）' }
    }
    if (!j || j.status !== 'ok') {
      if (空间是空的(j)) return { ok: false, 空: true, 说: '这个号的空间里还没有说说' }
      return { ok: false, 说: 空间错误话(j) }
    }
    return { ok: true, 数据: j.data }
  }

  /** 四个工具共用的 output：模型看到的是一句人话，不是一段 JSON */
  const 空间输出 = () => ({
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, 说: { type: 'string' } },
      additionalProperties: true,
    },
    render: (_参数, 值) => [{
      type: 'text',
      text: String((值 && 值.说) || (typeof 值 === 'string' ? 值 : '（没有内容）')),
    }],
  })

  /** QQ 号：纯数字就给数字，别的一律原样传（不同版本对 target_uin 的脾气不一样） */
  const 取QQ号 = (值) => {
    const 净 = String(值 == null ? '' : 值).trim()
    if (!净) return ''
    return /^[0-9]{4,12}$/.test(净) ? Number(净) : 净
  }

  const 做空间工具 = () => [
    {
      name: 'qq_space_list',
      description: '看 QQ 空间里的说说：时间、正文（长文会截断）、评论数、是不是私密、带几张图，每条前面有 tid。',
      parameters: {
        type: 'object',
        properties: {
          qq: { type: 'string', description: '看谁的 QQ 空间（QQ 号）。不填 = 机器人自己的' },
          num: { type: 'integer', minimum: 1, maximum: 50, description: '最多看几条，默认 10' },
          pos: { type: 'integer', minimum: 0, description: '从第几条开始（0 = 最新那条），默认 0' },
        },
        additionalProperties: false,
      },
      output: 空间输出(),
      async execute(args = {}) {
        const 配置 = 读配置()
        const 条数 = Math.max(1, Math.min(Math.round(Number(args.num) || 10), 50))
        const 起 = Math.max(0, Math.round(Number(args.pos) || 0))
        const 体 = { pos: 起, num: 条数 }
        const 号 = 取QQ号(args.qq)
        if (号) 体.target_uin = 号
        const 回 = await 空间调用(配置, 'get_qzone_msg_list', 体)
        if (!回.ok) {
          if (回.空) return { ok: true, 说: 回.说 }
          return { ok: false, 说: 回.说 }
        }
        const 数据 = 回.数据 || {}
        const 列表 = Array.isArray(数据.msglist) ? 数据.msglist : []
        const 共 = Number(数据.total)
        if (!列表.length) return { ok: true, 说: '这个号的空间里还没有说说' }
        const 行们 = []
        for (let i = 0; i < 列表.length; i++) {
          const m = 列表[i]
          if (!m) continue
          const 图数 = Array.isArray(m.images) ? m.images.length : 0
          行们.push((起 + i + 1) + '. ' + 空间时间(m.time)
            + (m.tid != null ? '　tid ' + String(m.tid) : '')
            + '　评论 ' + (Number(m.comment_num) || 0)
            + (m.is_private ? '　私密' : '')
            + '　图 ' + 图数 + ' 张'
            + 换行 + '   ' + (掐短(m.content, 200) || '（没有文字）'))
        }
        return {
          ok: true,
          说: '共 ' + (Number.isFinite(共) ? 共 : 列表.length) + ' 条说说（这次取 ' + 行们.length + ' 条）：' + 换行 + 行们.join(换行),
        }
      },
    },
    {
      name: 'qq_space_detail',
      description: '看一条 QQ 说说的正文和评论。tid 从 qq_space_list 里拿。',
      parameters: {
        type: 'object',
        properties: {
          tid: { type: 'integer', description: '说说的 tid（qq_space_list 里每条前面那个）' },
          qq: { type: 'string', description: '这条说说属于谁的 QQ 号。不填 = 机器人自己的' },
          num: { type: 'integer', minimum: 1, maximum: 50, description: '评论最多看几条，默认 20' },
          pos: { type: 'integer', minimum: 0, description: '评论从第几条开始，默认 0' },
        },
        required: ['tid'],
        additionalProperties: false,
      },
      output: 空间输出(),
      async execute(args = {}) {
        const 配置 = 读配置()
        const tid = Math.round(Number(args.tid))
        if (!Number.isFinite(tid) || tid <= 0) return { ok: false, 说: '要给一个说说的 tid（数字，从 qq_space_list 里拿）' }
        const 条数 = Math.max(1, Math.min(Math.round(Number(args.num) || 20), 50))
        const 起 = Math.max(0, Math.round(Number(args.pos) || 0))
        const 体 = { tid, pos: 起, num: 条数 }
        const 号 = 取QQ号(args.qq)
        if (号) 体.target_uin = 号
        const 回 = await 空间调用(配置, 'get_qzone_msg_detail', 体)
        if (!回.ok) return { ok: false, 说: 回.说 }
        const 数据 = 回.数据 || {}
        const 评论们 = Array.isArray(数据.comments) ? 数据.comments : []
        const 共评 = Number(数据.comment_num)
        const 行们 = ['正文：' + (掐短(数据.content, 200) || '（没有文字）')]
        if (!评论们.length) {
          行们.push('还没有评论。')
        } else {
          行们.push('评论（' + (Number.isFinite(共评) ? 共评 : 评论们.length) + ' 条，下面列 ' + 评论们.length + ' 条）：')
          for (const c of 评论们) {
            if (!c) continue
            const 号2 = c.uin != null ? c.uin : c.user_id
            const 谁 = String(c.nickname || c.name || (号2 != null ? 'QQ ' + 号2 : '某人'))
            const 文 = 掐短(c.content != null ? c.content : (c.text || c.msg), 160) || '（空）'
            行们.push('· ' + (c.time ? 空间时间(c.time) + '　' : '') + 谁 + '：' + 文)
          }
        }
        return { ok: true, 说: '说说 ' + tid + 换行 + 行们.join(换行) }
      },
    },
    {
      name: 'qq_space_feeds',
      description: '看 QQ 空间的好友动态流：谁发的、什么时候、说了什么（正文已经去掉 HTML）。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 50, description: '看几条，默认 10' },
          page: { type: 'integer', minimum: 1, description: '第几页（从 1 开始）。只有第一页可靠，后面的可能重复或缺' },
        },
        additionalProperties: false,
      },
      output: 空间输出(),
      async execute(args = {}) {
        const 配置 = 读配置()
        const 条数 = Math.max(1, Math.min(Math.round(Number(args.count) || 10), 50))
        const 页 = Math.max(1, Math.round(Number(args.page) || 1))
        const 回 = await 空间调用(配置, 'get_qzone_feeds', { page_num: 页, count: 条数 })
        if (!回.ok) return { ok: false, 说: 回.说 }
        const 数据 = 回.数据 || {}
        const 动态们 = Array.isArray(数据.feeds) ? 数据.feeds : []
        if (!动态们.length) return { ok: true, 说: '这一页没有好友动态' }
        const 行们 = []
        for (const f of 动态们) {
          if (!f) continue
          const 谁 = String(f.nickname || (f.uin != null ? 'QQ ' + f.uin : '某人'))
          const 文 = 空间去标签(f.html, 300) || '（这条没有文字，可能只有图或视频）'
          行们.push('· ' + 空间时间(f.time) + '　' + 谁 + 换行 + '   ' + 文)
        }
        return {
          ok: true,
          说: '好友动态 ' + 行们.length + ' 条' + (数据.has_more ? '（还有更多）' : '') + '：' + 换行 + 行们.join(换行),
        }
      },
    },
    {
      name: 'qq_space_post',
      description: '往机器人自己的 QQ 空间发一条说说，可以带图。「允许发 QQ 空间动态」关着的时候不会发出去，'
        + '只会说明没开 —— 那不是故障，别重试。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '说说的正文' },
          images: {
            type: 'array', items: { type: 'string' },
            description: '配图，最多 9 张。本地路径、http(s) 网址、base64:// 都行，QQ 那边会自己上传',
          },
          ugc_right: {
            type: 'integer', enum: [1, 4, 16, 64, 128],
            description: '谁看得见：1 所有人（默认）、4 好友、16 部分可见、64 仅自己、128 部分不可见',
          },
          target_uins: {
            type: 'array', items: { type: 'string' },
            description: '16 / 128 时要用的 QQ 号名单：16 = 这几个人能看见，128 = 这几个人看不见',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      output: 空间输出(),
      async execute(args = {}) {
        const 配置 = 读配置()
        if (配置.允许发空间动态 !== true) {
          return { ok: false, 说: '「允许发 QQ 空间动态」还关着，这条没发出去。要发说说，得先去设置页把那个开关打开。' }
        }
        const 正文 = String(args.content == null ? '' : args.content).trim()
        const 图们 = (Array.isArray(args.images) ? args.images : [args.images])
          .map((x) => String(x == null ? '' : x).trim())
          .filter(Boolean)
          .slice(0, 9)
        if (!正文 && !图们.length) return { ok: false, 说: '正文和图片都是空的，没东西可发。' }
        const 权利 = [1, 4, 16, 64, 128].includes(Number(args.ugc_right)) ? Number(args.ugc_right) : 1
        const 名单 = (Array.isArray(args.target_uins) ? args.target_uins : [args.target_uins])
          .map((x) => String(x == null ? '' : x).trim())
          .filter(Boolean)
          .map((x) => (/^[0-9]{4,12}$/.test(x) ? Number(x) : x))
        if ((权利 === 16 || 权利 === 128) && !名单.length) {
          return { ok: false, 说: '「部分可见 / 部分不可见」得给名单（target_uins），这次没给，所以没发。' }
        }
        const 体 = { content: 正文, ugc_right: 权利 }
        if (图们.length) 体.images = 图们
        if (名单.length && (权利 === 16 || 权利 === 128)) 体.target_uins = 名单
        const 回 = await 空间调用(配置, 'send_qzone_msg', 体)
        if (!回.ok) return { ok: false, 说: '没发出去：' + 回.说 }
        // 有的版本回 { tid }，有的直接回一个字符串 / 数字
        const 数据 = 回.数据
        const tid = 数据 && typeof 数据 === 'object'
          ? (数据.tid != null ? 数据.tid : (数据.data && 数据.data.tid != null ? 数据.data.tid : ''))
          : (数据 == null ? '' : 数据)
        记账('往 QQ 空间发了一条说说' + (tid ? '（tid ' + String(tid) + '）' : ''))
        return { ok: true, 说: '发好了' + (tid ? '，tid ' + String(tid) : '') }
      },
    },
  ]

  // 空间工具挂在「绑了 QQ 的那几间会话」上：跟门槛工具一样按会话记，挂过一次就不重复挂。
  const 空间挂着 = new Map() // 会话键 -> 卸下的函数
  function 空间工具心跳() {
    try {
      const 配置 = 读配置()
      const 该挂 = new Set()
      for (const 行 of 配置.绑定 || []) {
        const id = String((行 && 行.会话) || '').trim()
        if (id) 该挂.add(id)
      }
      for (const id of 该挂) {
        const agent = 找agent(id)
        // 宿主没给 tools 服务（或者那间会话没开）就跳过 —— 下一跳再看
        if (!agent || !agent.ctx || !agent.ctx.tools || typeof agent.ctx.tools.register !== 'function') continue
        const sid = 会话键((agent.session && agent.session.id) || id)
        if (空间挂着.has(sid)) continue
        const 卸们 = []
        for (const 工具 of 做空间工具()) {
          try {
            const off = agent.ctx.tools.register(工具)
            if (typeof off === 'function') 卸们.push(off)
          } catch (error) {
            记账('QQ 空间的工具挂不上（' + 短id(sid) + '，' + 工具.name + '）：' + String((error && error.message) || error))
          }
        }
        if (!卸们.length) continue
        空间挂着.set(sid, () => {
          for (const off of 卸们) {
            try { off() } catch (error) {}
          }
        })
        记账('QQ 空间的工具挂上了（' + 短id(sid) + '）')
      }
      for (const [sid, off] of 空间挂着) {
        if ([...该挂].some((id) => 会话键(id) === sid)) continue
        try { off() } catch (error) {}
        空间挂着.delete(sid)
        记账('QQ 空间的工具卸下了（' + 短id(sid) + '）')
      }
    } catch (error) {
      记账('QQ 空间的工具心跳出错：' + String((error && error.message) || error))
    }
  }

  // ── 空间的定时活（1.5.0）────────────────────────────────────────
  //   统一由文件末尾那一个 60 秒的 setInterval 驱动：
  //     · 定时发说说：到点往会话里递一句提醒，**正文一个字都不预置** —— 说什么由它自己写；
  //     · 定时看一圈：隔 N 分钟拉一次好友动态，顺手点赞 / 把新动态递进会话。
  //   ⚠ 这两件事都可能失败（会话没开、后端没回）；失败只记账，不能让定时器停掉。

  /** 本地日期 'YYYY-MM-DD'（跟 该发说说 里同一套口径，别混 UTC） */
  const 本地日期 = (毫秒) => {
    const d = new Date(Number.isFinite(Number(毫秒)) ? Number(毫秒) : Date.now())
    const 补 = (x) => String(x).padStart(2, '0')
    return d.getFullYear() + '-' + 补(d.getMonth() + 1) + '-' + 补(d.getDate())
  }

  /** 到点递的那一句：只是提醒它「想发就发」，不是替它写的文案 */
  const 定时说说提醒话 = '（到点了。想往空间发条说说就说点什么 —— 想发就直接用那个工具；不想发就当我没提。）'
  let 说过 = new Set()
  let 说说日 = ''
  const 定时说说一跳 = async (配置) => {
    const 表 = Array.isArray(配置.空间定时发) ? 配置.空间定时发 : []
    if (!表.length) return
    const 今天 = 本地日期(Date.now())
    if (说说日 !== 今天) { 说说日 = 今天; 说过 = new Set() }   // 跨天自动清：同一天只递一次
    const 判 = 该发说说(表, Date.now(), 说过)
    if (!判.发) return
    const 行 = (配置.绑定 || []).find((x) => String((x && x.会话) || '').trim())
    if (!行) return 记账('定时说说：' + 判.键 + ' 到点了，但还没有绑定会话，这句没递出去')
    const agent = 找agent(行.会话)
    if (!agent) return 记账('定时说说：' + 判.键 + ' 到点了，但那间会话没开着，这句没递出去')
    try {
      // ⚠ 必须 await：followup 是 Promise，reject 没接住就是未处理的 rejection（宿主会整个退出）
      await agent.followup(手搓用户消息(定时说说提醒话))
      说过.add(判.键)   // 真递进去了才算「这个时间今天发过」；没递进去下一跳还能再试
      记账('定时说说：' + 判.键 + ' 到点了，提醒了 ' + 短id(行.会话))
    } catch (error) {
      记账('定时说说：' + 判.键 + ' 的提醒没递进去（' + String((error && error.message) || error) + '）')
    }
  }

  // 点过赞的 tid 别再点；每天一个计数，跨天清零
  let 点过赞 = new Set()
  let 点赞日 = ''
  let 今日点赞 = 0
  let 自己的号 = 0

  /** 机器人自己是谁（拿来跳过自己发的动态）；拿不到就当 0 = 不跳过 */
  const 取自己号 = async (配置) => {
    if (自己的号) return 自己的号
    try {
      const 回 = await 空间调用(配置, 'get_login_info', {})
      if (回 && 回.ok && 回.数据) 自己的号 = Number(回.数据.user_id) || 0
    } catch (error) {}
    return 自己的号
  }

  /** 顺手点几个赞：最近 3 天、没点过、不是自己发的；每次最多 3 条、每天最多 20 条 */
  const 点赞一圈 = async (配置, 动态们) => {
    const 今天 = 本地日期(Date.now())
    if (点赞日 !== 今天) { 点赞日 = 今天; 今日点赞 = 0 }
    if (今日点赞 >= 20) return
    const 自己 = await 取自己号(配置)
    let 这圈 = 0
    for (const f of 动态们) {
      if (这圈 >= 3 || 今日点赞 >= 20) break
      if (!f || typeof f !== 'object') continue
      const tid = f.tid != null ? f.tid : ''
      const uin = Number(f.uin != null ? f.uin : f.target_uin) || 0
      if (tid === '' || !uin) continue
      if (自己 && uin === 自己) continue                              // 自己发的不点
      const 秒 = Number(f.time || f.abstime) || 0
      if (秒 > 0 && Date.now() / 1000 - 秒 > 3 * 86400) continue       // 只点最近 3 天的
      const 键 = 'tid:' + String(tid)
      if (点过赞.has(键)) continue
      const 回 = await 空间调用(配置, 'like_qzone', {
        tid, target_uin: uin, abstime: Number(f.abstime) || 秒,
      })
      if (!回.ok) { 记账('空间点赞：这一圈没点上（' + 回.说 + '），先不点了'); break }
      点过赞.add(键)
      今日点赞 += 1
      这圈 += 1
      记账('空间点赞：给 ' + String(f.nickname || ('QQ ' + uin)) + ' 的动态点了一下（今天第 ' + 今日点赞 + ' 个）')
    }
    if (点过赞.size > 1000) 点过赞 = new Set([...点过赞].slice(-500))
  }

  /** 把这一圈动态递进会话：评不评、评什么由它自己决定，这里不写评论内容 */
  const 递一圈 = async (配置, 动态们) => {
    const 行 = (配置.绑定 || []).find((x) => String((x && x.会话) || '').trim())
    if (!行) return 记账('空间看一圈：拉到 ' + 动态们.length + ' 条动态，但还没有绑定会话，没地方递')
    const agent = 找agent(行.会话)
    if (!agent) return 记账('空间看一圈：那间会话没开着，这 ' + 动态们.length + ' 条动态没递进去')
    const 行们 = 动态们.slice(0, 10).map((f) => {
      const 谁 = String(f.nickname || (f.uin != null ? 'QQ ' + f.uin : '某人'))
      const 号 = f.uin != null ? String(f.uin) : '?'
      return 谁 + '（' + 号 + '）' + 空间时间(f.time) + '：' + (空间去标签(f.html, 80) || '（没有文字，可能只有图）')
    })
    const 文案 = '（空间里这几条新动态，想评论就评，不想理就算了。）' + 换行 + 行们.join(换行)
    try {
      await agent.followup(手搓用户消息(文案))
      记账('空间看一圈：把 ' + 行们.length + ' 条动态递给 ' + 短id(行.会话) + ' 了')
    } catch (error) {
      记账('空间看一圈：动态没递进去（' + String((error && error.message) || error) + '）')
    }
  }

  let 看圈下次 = 0
  let 看圈在跑 = false
  const 定时看圈一跳 = async (配置) => {
    // 关着就什么都不做（顺手清掉下次时间：再打开时先等一个完整间隔）
    if (配置.空间看圈开 !== true) { 看圈下次 = 0; return }
    const 分钟 = Math.max(5, Math.min(Math.round(Number(配置.空间看圈分) || 30), 1440))
    const 现在 = Date.now()
    if (!看圈下次) { 看圈下次 = 现在 + 分钟 * 60000; return }   // 首次启动先等一个间隔，别一上来就拉
    if (现在 < 看圈下次) return
    看圈下次 = 现在 + 分钟 * 60000
    if (看圈在跑) return
    // 点赞、评论都关着：这一圈什么都不做，连请求都不发
    if (配置.空间点赞开 !== true && 配置.空间评论开 !== true) return
    看圈在跑 = true
    try {
      const 回 = await 空间调用(配置, 'get_qzone_feeds', { page_num: 1, count: 10 })
      if (!回.ok) return 记账('空间看一圈：好友动态没拉到（' + 回.说 + '），这一圈跳过')
      const 数据 = 回.数据 || {}
      const 动态们 = (Array.isArray(数据.feeds) ? 数据.feeds : []).filter(Boolean)
      if (!动态们.length) return 记账('空间看一圈：这一圈没有好友动态')
      if (配置.空间点赞开 === true) await 点赞一圈(配置, 动态们)
      if (配置.空间评论开 === true) await 递一圈(配置, 动态们)
    } finally {
      看圈在跑 = false
    }
  }

  /** 60 秒一跳：每件事各自兜住错误 —— 这一件抛了，另一件和下一跳都照常 */
  const 空间定时一跳 = async () => {
    let 配置 = null
    try { 配置 = 读配置() } catch (error) { return }
    try {
      await 定时说说一跳(配置)
    } catch (error) {
      记账('空间定时任务：定时说说出错（下一跳照常）：' + String((error && error.message) || error))
    }
    try {
      await 定时看圈一跳(配置)
    } catch (error) {
      记账('空间定时任务：定时看一圈出错（下一跳照常）：' + String((error && error.message) || error))
    }
  }

  // ⭐ 1.4.3：人设补挂心跳。
  //   以前人设**只在「收到 QQ 消息」和「点现在就生效」那两个时刻**去挂，
  //   所以 Harness 重启之后，如果第一个回合是定时任务 / speak-up 触发的，那一轮就没有人设。
  //   现在跟着心跳每跳一次就补一遍：已经挂好的（同一个 agent、同一段文本）会秒返回。
  let 人设心跳说过 = false
  async function 人设心跳() {
    try {
      const 配置 = 读配置()
      if (!配置.人设开) return
      for (const 行 of (配置.绑定 || [])) {
        if (行.开 === false) continue
        const 会话 = String(行.会话 || '').trim()
        if (!会话) continue
        const agent = 找agent(会话)
        if (!agent) continue // 会话没起来就不管，等它起来
        const 文 = String(行.人设 || 配置.人设 || '').trim().slice(0, 20000)
        if (!文) continue
        await 备人设(agent, 会话键(会话), 文)
      }
      if (!人设心跳说过) {
        人设心跳说过 = true
        记账('人设补挂心跳已启动（重启 / 换实例之后也会自动挂回去）')
      }
    } catch (error) {
      if (!人设心跳.报过) {
        人设心跳.报过 = true
        记账('人设补挂心跳出错：' + String((error && error.message) || error))
      }
    }
  }

  // ⭐ 1.0.2：有攒着等的那一批时，别干等下一跳 —— 快跑一跳把它发出去。
  //   最坏情况：撞上轮询时最后一条还新鲜（< 合并窗口秒）→ 1 秒后补跑 → 大约 1.5 秒落地。
  let 补跑定时 = null
  let 收消息任务 = null
  let 已停止 = false
  let 当前控制 = null
  const 清补跑 = () => { if (补跑定时) clearTimeout(补跑定时); 补跑定时 = null }
  // 普通轮询与攒条补跑共用这个入口；不要给不可撤回的 followup 超时解锁。
  const 开始收消息 = () => {
    if (已停止) return
    if (!读配置().总开关) {
      清补跑()
      当前控制?.abort()
    }
    闸门心跳()
    空间工具心跳()
    void 人设心跳()
    if (收消息任务) return 收消息任务
    当前控制 = new AbortController()
    // 1.0.7 的慢轮询诊断跟着实际任务；忙着的普通/补跑 tick 不重复计时。
    const 起 = Date.now()
    收消息任务 = 轮询收消息(当前控制).catch((error) => {
      try { ctx.logger?.info(`qq-bridge: 轮询出错：${String((error && error.message) || error)}`) } catch (e2) {}
    }).finally(() => {
      收消息任务 = null; 当前控制 = null
      const 用了 = Date.now() - 起
      if (用了 > 3000) {
        try { 记账('这一次收消息花了 ' + (用了 / 1000).toFixed(1) + ' 秒（QQ 端回得慢，超过 8 秒的请求会被掐掉重试）') } catch (e2) {}
      }
    })
    return 收消息任务
  }
  const 快跑一次 = (毫秒 = 1200) => {
    if (已停止) return
    if (process.env.QQ_BRIDGE_不加速 === '1') return      // 自测用：别让定时器插进来
    if (补跑定时) return
    补跑定时 = setTimeout(() => {
      补跑定时 = null
      return 开始收消息()
    }, Math.max(300, 毫秒))
    try { if (typeof 补跑定时.unref === 'function') 补跑定时.unref() } catch (error) {}
  }

  /**
   * 轮询 NapCat 的 HTTP 历史接口，把「她新发的私聊 / 群消息」一条条转进 DSH。
   * ⚠ 纯 HTTP 轮询：不连 WebSocket、不依赖 BOT。
   * ⚠ 只认 `私聊QQ` 这个人发的（群也一样按这个号过滤），自己的回话不会自我繁殖。
   */
  async function 轮询收消息(控制) {
    const 信号 = 控制.signal
    const 配置 = 读配置()
    // 总开关关 / 一条绑定都没有：只把「上次时间」推到此刻，别开的时候就补一大串旧的
    if (!配置.总开关 || !(配置.绑定 || []).length) {
      for (const k of [...上次时间.keys()]) 上次时间.set(k, Math.floor(Date.now() / 1000))
      return
    }
    // 群里只认「私聊那行绑的那个号」（就是你自己）；没绑私聊行的话，群里谁的话都不转
    const 本人号 = Number(((配置.绑定 || []).find((x) => x.类型 === '私聊') || {}).号码) || 0

    // 1.0.7：历史/转发等读取 8 秒，登录号 5 秒；下一跳（默认 2 秒）可重试。
    // 截止时间包含 fetch 和 JSON body；即使适配器忽略 abort，也不能锁住后续轮询。
    // 只取消可重试的读取，绝不给不可撤回的 followup 设置超时解锁。
    const 拉JSON = async (action, 体) => {
      if (信号.aborted) throw 信号.reason || new Error('收消息已停止')
      let 停止
      const 中止 = new Promise((resolve, reject) => {
        停止 = () => reject(信号.reason || new Error('收消息已停止'))
        信号.addEventListener('abort', 停止, { once: true })
      })
      const 超时毫秒 = action === 'get_login_info' ? 5000 : 8000
      const 定时 = setTimeout(() => 控制.abort(new Error(`QQ 收消息请求超时（${超时毫秒 / 1000} 秒）`)), 超时毫秒)
      try {
        return await Promise.race([(async () => {
          const r = await fetch(配置.NapCat + '/' + action, {
            signal: 信号, method: 'POST', headers: 请求头(配置), body: JSON.stringify(体 || {}),
          })
          return await r.json()
        })(), 中止])
      } finally {
        clearTimeout(定时)
        信号.removeEventListener('abort', 停止)
      }
    }
    const 拉 = async (action, 体) => {
      try {
        const j = await 拉JSON(action, 体)
        return j && j.status === 'ok' && Array.isArray(j.data && j.data.messages) ? j.data.messages : []
      } catch (error) { return [] }
    }
    // 合并转发 / get_record 返回 data，和历史接口的 data.messages 不同。
    const 拉任意 = async (action, 体) => {
      try {
        const j = await 拉JSON(action, 体)
        return (j && j.status === 'ok' && j.data) || null
      } catch (error) { return null }
    }
    // ⚠️ 2026-10-25（用户报「读不了 B站 卡片 / 转发记录」）：以前这里只看 text / image / mface，
    //    卡片和合并转发既没文字也没图 ⇒ 整条被当成空消息丢掉。现在它们也会变成文字。
    const 收图上限 = () => Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
    const 条转片段 = async (条) => {
      const 段们 = Array.isArray(条.message) ? 条.message : []
      const 图们 = []
      const 文们 = []
      let 点名 = false          // ⭐ 0.9.9：这条是不是点了我的名（@ 我 / 引用我的消息）
      const 我 = await 拿自己QQ(拉任意)
      for (const 段 of 段们) {
        if (信号.aborted) break
        if (!段 || !段.data) continue
        const 型 = String(段.type || '')
        if (型 === 'at') {
          const at谁 = String(段.data.qq || '')
          if (我 && at谁 === 我) 点名 = true          // at全体（qq='all'）不算点名
          if (!我 || at谁 !== 我) 文们.push('@' + String((段.data && (段.data.name || 段.data.qq)) || ''))
          else 文们.push('@' + String((段.data && (段.data.name || '你')) || '你'))
          continue
        }
        if (型 === 'reply') {
          const 被引 = String(段.data.id || '')
          if (被引 && 己方消息.has(被引)) 点名 = true   // 引用的是我发的 → 就是冲我来的
          文们.push('[引用了一条消息]')
          continue
        }
        if (型 === 'text') { 文们.push(String(段.data.text || '')); continue }
        if (型 === 'image' || 型 === 'mface') {
          // ⭐ 1.0.3（issue #13）：大表情的字段和普通图不一样（emoji_id / key），很多根本没有 url。
          //    取不到可下载地址时至少留一句，别让整条消息变成「空的」被丢掉。
          const dd = (段.data || {})
          const 有图 = String(dd.url || dd.file || dd.path || dd.thumb || '')
          if (型 === 'mface' && !有图) {
            文们.push('[表情:' + 掐短(String(dd.summary || dd.emoji_id || '大表情'), 20) + ']')
            continue
          }
          图们.push(段);
          continue
        }
        if (型 === 'json' || 型 === 'xml') { 文们.push(卡片文字(段)); continue }
        if (型 === 'forward') {
          // ⭐ 转发里的图**跟着「收图」这个开关走**（不另加开关）：开着收几张，关着只标 [图片]
          const 袋 = 配置.收图 ? [] : null
          try {
            const 文 = await 转发文字(段, 拉任意, 袋)
            文们.push(文)
            if (Array.isArray(袋) && 袋.length) {
              const 余量 = Math.max(0, 收图上限() - 图们.length)
              for (const x of 袋.slice(0, 余量)) 图们.push(x)
            }
          } catch (error) { 文们.push('[合并转发的聊天记录（读失败了）]') }
          continue
        }
        if (型 === 'face') { 文们.push('[表情]'); continue }
        if (型 === 'record') {
          // ⭐ 0.8.0：开着「语音转写」且配了命令 → 把语音条变成文字；否则还是 [语音]
          文们.push(await 转写语音(段, 拉任意, 配置, {
            家目录: dirname(配置文件), ffmpeg: await 找ffmpeg(), 消息id: 条.message_id,
          }))
          continue
        }
        if (型 === 'video') { 文们.push('[视频]'); continue }
      }
      // 用同一份判定再兜一遍（免得以后两边规则走散）
      点名 = 点名 || 识别点名(段们, 我, 己方消息)
      return { 文字: 文们.join(String.fromCharCode(10)).trim(), 图们, 点名 }
    }

    // ⭐ 0.6.0：一行一行地拉 —— 一个聊天 → 一间会话，各自记各自的「看到哪儿了」
    for (const 行 of 配置.绑定) {
      if (信号.aborted) return
      // ⭐ 1.1.8：这一行被关掉了 —— 不收也不发，配置留着
      if (行.开 === false) continue
      const 是群 = 行.类型 === '群'
      const 动作 = 是群 ? 'get_group_msg_history' : 'get_friend_msg_history'
      const 体 = 是群
        ? { group_id: Number(行.号码), count: 30 }
        : { user_id: Number(行.号码), count: 10 }
      const 列表 = await 拉(动作, 体)
      if (信号.aborted) return
      const 键2 = 行.类型 + ':' + 行.号码
      // ⚠️ 没记录过这个聊天（比如刚加绑定 / 第一次跑）时，从**此刻**开始算 ——
      //   否则历史消息会全被当成新的补投一遍（她报的那个「没发消息却自己回了」就有这一层）。
      let 上次 = 上次时间.has(键2) ? (上次时间.get(键2) || 0) : Math.floor(Date.now() / 1000)

      // ⭐ 1.0.2：这一个聊天里「攒着还没转进去」的一批（同一个人连着发的）
      let 攒 = null
      const 是群行 = 行.类型 === '群'
      /** 把这批转进去；返回 false = 还在等人说完（或这轮没转成），调用方别推进水位 */
      const 落袋 = async () => {
        if (信号.aborted) return false
        if (!攒) return true
        const 窗口 = Number(配置.合并窗口秒) || 0
        const 现在秒 = Math.floor(Date.now() / 1000)
        const 最长 = Number(配置.合并最多秒) || 20
        const 差 = 现在秒 - (攒.末 || 0)
        const 满了 = 攒.条目.length >= (Number(配置.合并最多条) || 8)
        // 差 < 0 说明是「未来的时间戳」（时钟歪了 / 老测试造的），别傻等
        if (!满了 && 窗口 > 0 && 差 >= 0 && 差 < 窗口 && (现在秒 - 攒.起) < 最长) {
          快跑一次(Math.max(300, Math.round(窗口 * 1000) + 200))
          return false      // 最后一条刚过去没多久 —— 再等等，下一跳连新的那条一起收
        }
        // ⭐ 1.0.9：先掷骰子 —— **没掷中就不送了**（这批根本不进 DSH，不占上下文、不花 token）
        // ⭐ 1.1.3：以前 @ / 引用 的批次**永远不掷骰子** —— 而默认「群里只听 @ 的」，
        //   于是概率这个数在实际使用里从来没生效过（填 50 也照回）。现在由「点名必回」决定。
        const 掷骰子 = 是群行 && !(攒.点名 && 配置.点名必回 !== false)
        if (掷骰子) {
          if (!攒.掷过) {
            攒.掷过 = true
            const 概率 = Math.max(0, Math.min(100, Number(配置.回复概率 == null ? 100 : 配置.回复概率)))
            攒.中 = Math.random() * 100 < 概率
          }
          if (!攒.中) {
            const 丢 = 攒
            攒 = null
            for (const id of 丢.ids) 已转消息.add(id)
            上次 = Math.max(上次, 丢.末 || 上次)
            记账('群里这 ' + 丢.条目.length + ' 条没掷中（回复概率 ' + Number(配置.回复概率) + '%），这次不接')
            return true
          }
        }
        // ⭐ 1.0.9：群聊的节奏。
        // ⭐ 1.1.7：**@ 它的也照样排队** —— 以前点名直接穿过去，群里一有人 @ 它，冷却和
        //   「一分钟最多几条」就等于没有，看起来就是「没有冷却、刷屏」。现在只是晚几秒回，不会漏。
        if (是群行) {
          const 闸 = 群闸(键2, 配置)
          if (闸.等毫秒 > 0) {
            快跑一次(Math.min(3000, Math.max(300, Math.round(闸.等毫秒) + 200)))
            return false    // 还没到点 —— 这一批留着，别丢
          }
        }
        const 一批 = 攒
        攒 = null
        // ⭐ 1.0.9：群里可能好几个人在说话 —— 名字写到每一行前面（这样合起来也不会认错人）
        const 文字 = 一批.条目.map((x) => {
          const 名 = (是群行 && x.发送者)
            ? String(x.发送者.昵称 || '某人') + '（' + String(x.发送者.号码 || '?') + '）：'
            : ''
          return 名 + String(x.文字 || '')
        }).filter((s) => s.trim()).join(String.fromCharCode(10))
        if (一批.ids.length > 1) 记账('连着发的 ' + 一批.ids.length + ' 条攒成一条转进去')
        const 结果 = await 转入一条(文字, 一批.图们, 一批.ids[0], 行, 是群行 ? null : 一批.发送者, 一批.点名, 信号, () => {
          for (const id of 一批.ids) 已转消息.add(id)
          上次 = Math.max(上次, 一批.末 || 上次)
          存水位({ 键: 键2, 时间: 上次, ids: 一批.ids })
          if (是群行) 记一发(键2)
        })
        if (信号.aborted) return false
        if (结果 && 结果.ok) return true
        记账('这条先没转进去（' + 短id(行.会话) + '：' + String((结果 && 结果.说) || '原因不明') + '），下一跳再试')
        return false
      }
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (信号.aborted) return
        if (!条) continue
        // ⚠️ 这两条要放在「点名 / 接听」那道过滤**前面**（都不用等、也不解析正文）：
        //   拉回来的历史里一直躺着已经转过的旧消息，先滤掉它们，接听的条数才不会被旧消息吃掉。
        if ((条.time || 0) < 上次) continue           // 旧的，跳过
        if (已转消息.has(条.message_id) || 攒?.ids.includes(条.message_id)) continue // 转过了或已在本批里
        // 私聊：只认对面那个号；群：只认你自己—— 别人的话不转（防噪音，也防被别人的话牵着走）
        if (!是群) {
          // 私聊：只认对面那个号
          if (!本人号 || Number(条.user_id) !== Number(行.号码)) continue
        } else {
          // ⭐ 0.9.9（别处报的「群里 @ 大肥鱼 不理人」）：群里以前**只收她自己发的**，
          //    别人 @ 它、引用它的消息**根本没转进来**（连门槛都没机会判）。
          //    现在：别人的消息**只要点了名（@ 我 / 引用我）就收**；想收全群的话把
          //    「群里也听别人的话」打开。
          // ⭐ 1.1.6（issue #14）：**机器人自己发出去的话绝不能再收回来** ——
          //   开了「听所有人」之后，它的回话会被当成群友的话再转进来，一句话能无限套娃。
          try {
            const 机器人号 = await 拿自己QQ(拉JSON)
            if (机器人号 && String(条.user_id) === String(机器人号)) continue
          } catch (error) {}
          // ⭐ 1.1.8：这一行自己说了算（只听点名 / 全听），没说才跟全局走
          const 全听 = 行.只听点名 == null ? Boolean(配置.群里听所有人) : !行.只听点名
          if (!全听) {
            // ⭐ 1.4.3：「只听点名」对**群里所有人**生效 —— 以前自己发的会跳过这道过滤
            //   （`自己的` 那个短路），于是在群里随手发的东西也会被当成对着它说话收进来。
            //   例外只写在每行的「点名例外」名单里；名单里的人直接收，但**不算点名**
            //   （不触发「点名必回」，也不消耗接听条数）。
            const 在例外 = 在点名例外名单(行.点名例外, 条.user_id)
            if (!在例外) {
              const 试 = await 条转片段(条)
              if (信号.aborted) return
              // ⭐ 1.4.1：点了名 → 收，并且把这个群开成「接着听」；接听中进来的普通消息也收，
              //    每收一条减一条，条数用光 / 超时自己就退回「只听点名」（规则在 该收这条 里）。
              //    ⚠ 接听中进来的话**不算点名**：点名只看 @ / 引用，它不会把条数又重置一遍。
              const 判 = 该收这条({
                全听: false,
                点名: 试.点名,
                接听: 接听中.get(键2) || null,
                条: 配置.点名后接听条,
                秒: 配置.点名后接听秒,
                现在: Date.now(),
              })
              if (判.接听) 接听中.set(键2, 判.接听)
              else 接听中.delete(键2)
              if (!判.收) continue
            }
          }
        }
        const { 文字, 图们, 点名 } = await 条转片段(条)
        if (信号.aborted) return
        // 纯表情（没图没字）就别转了，记掉别再反复拉
        if (!文字 && !图们.length) { 已转消息.add(条.message_id); 上次 = 条.time || 上次; continue }
        // ⚠️ 2026-10-25（她问的）：那间会话要是**当时没开着**（死的），这条不能算「转过了」——
        //   否则她一会儿把它点活了，这条就永远丢了（还不会补）。
        //   所以：**真转进去了**才算数；没转进去就不动「上次」和「已转」，下一跳（4 秒后）自己再来一遍。
        // ⚠️ 2026-10-25（她报的「打开会话就被自动回一条」）：会话关着的时候攒下的旧消息，
        //    隔太久（默认 10 分钟）就别补投了 —— 否则她一点进那间屋，就会突然冒出一条「自动回复」。
        const 太旧 = (条.time || 0) > 0 && (Math.floor(Date.now() / 1000) - 条.time) > (Number(配置.补投窗口分) || 10) * 60
        if (太旧) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          记账('这条 QQ 消息已经是 ' + Math.round((Date.now() / 1000 - 条.time) / 60) + ' 分钟前的了，不再补投（怕一打开会话就冒出一条旧回复）—— 想看内容可以回 QQ 里翻聊天记录')
          continue
        }
        const 发送者 = {
          昵称: String((条.sender && (条.sender.card || 条.sender.nickname)) || 条.nickname || (条.user_id ? 'QQ ' + 条.user_id : '')),
          号码: Number(条.user_id) || 0,
        }
        // ⭐ 1.0.2：连着的几条攒一起转（发一串图就不会一张一张回了）
        // ⭐ 1.0.9：群里**换人也照攒**（名字会写在每行前面）—— 一波人说话只起一轮
        if (攒 && !是群行 && 攒.发送者.号码 !== 发送者.号码) {
          const 好 = await 落袋()
          if (信号.aborted) return
          if (!好) break
        }
        if (!攒) {
          攒 = {
            条目: [], 图们: [], ids: [], 点名: false, 发送者,
            起: 条.time || 0, 末: 条.time || 0,
          }
        }
        // ⭐ 1.2.0：私聊默认不标来源；开了就给它一个能一眼认出的标记
        let 这行文字 = 文字
        if (!是群行) {
          const 标 = String(配置.私聊署名 || '关')
          if (标 === '前缀') {
            这行文字 = '[QQ] ' + String(文字 || '')
          } else if (标 === '署名') {
            // ⭐ 1.2.1：昵称 + 号 一起带 —— 只有号的话在私聊里看不出是谁
            const 名 = String((发送者 && 发送者.昵称) || '').trim()
            const 号 = String((发送者 && 发送者.号码) || '').trim()
            const 头 = 名 && 号 && 名 !== 号 && !名.includes(号)
              ? 名 + '（' + 号 + '）'
              : (名 && 名 !== 号 ? 名 : (号 ? 'QQ ' + 号 : '对方'))
            这行文字 = 头 + '：' + String(文字 || '')
          }
        }
        攒.条目.push({ 文字: 这行文字, 发送者 })
        if (图们.length) 攒.图们.push(...图们)
        攒.ids.push(条.message_id)
        攒.点名 = 攒.点名 || Boolean(点名)
        攒.末 = 条.time || 攒.末
        if (!(Number(配置.合并窗口秒) > 0)) {
          const 好 = await 落袋()
          if (信号.aborted) return
          if (!好) break
        }
      }
      {
        const 好 = await 落袋()
        if (信号.aborted) return
        if (!好 && 攒) {
          // 还在等对方说完 —— 这一行这次就先不推进水位，下一跳连新的一起收
          上次时间.set(键2, 上次)
          continue
        }
      }
      上次时间.set(键2, 上次)
    }

    if (已转消息.size > 300) {
      // 别 clear（clear 会让下一跳把旧的又当新的）—— 只留最近 300 个
      const 全 = [...已转消息]
      for (const id of 全.slice(0, Math.max(0, 全.length - 300))) 已转消息.delete(id)
    }
    存水位()
  }

  路线(`${路由前缀}/receive`, async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = typeof 来.text === 'string' ? 来.text.trim() : ''
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    回(res, await 转入文字(文字))
  })

  // 手动试一发：**真发**（绕过试运行），只发一条固定测试句，动不了已发轮
  路线(`${路由前缀}/test-send`, async (req, res) => {
    const 来 = await 读体(req)
    const 配置 = 读配置()
    const 绑定 = 配置.绑定 || []
    if (!绑定.length) {
      return 回(res, { ok: false, 说: '还没绑定任何聊天 —— 去「绑定」页加一条（一行 = 一个聊天 → 一间会话）' })
    }
    // 0.9.7：体里指定了哪条就发哪条，没指定就发第一条；一律按绑定发（不再看老字段 私聊QQ/群号）
    const 选 = 绑定.find((b) => 会话键(b.会话) === 会话键(来.会话)) || 绑定[0]
    const 谁 = (选.类型 === '群' ? '群 ' : '私聊 ') + 选.号码
    const 文字 = '（这是一条测试消息：DSH → QQ 通了）'
    const 结果 = await 发到QQ(配置, 文字, [], 选.会话)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    记账(`手动测试（发给 ${谁}）：${全过 ? '✅ 已发' : '⚠ 有问题'}「${文字}」`)
    for (const r of 结果) if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    回(res, {
      ok: 全过,
      说: 全过 ? ('测试句已经发到 ' + 谁 + ' 了') : ('发给 ' + 谁 + ' 时没发出去（看下面的记录）'),
      记录: 日志,
    })
  })

  // ---------- 挂监听 ----------

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        收到事件(session, event)
      } catch (error) {
        记账(`转发时出错：${String((error && error.message) || error)}`)
      }
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  }, 'qq-bridge: 盯伙伴说话')

  // 轮询 NapCat 收「她新发的 QQ」→ 转进 DSH（QQ → DSH 这半，不赖 BOT）
  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') {
      记账('拿不到 timer（ctx.interval 不在）—— QQ → DSH 的轮询收消息跑不起来，但 DSH → QQ 照常能用')
      return () => {}
    }
    const 停 = ctx.interval(开始收消息, 读配置().轮询间隔毫秒)
    return () => {
      已停止 = true
      清补跑()
      当前控制?.abort()
      try {
        if (typeof 停 === 'function') 停()
      } catch (error) {}
    }
  }, 'qq-bridge: 轮询收 QQ 消息')

  // ⭐ 1.5.0：空间的两件定时活，共用一个 60 秒的 setInterval（定时说说 + 定时看一圈）。
  //   ⚠ 整跳都在 空间定时一跳 里各自 try/catch —— 抛一次错不能让后面的跳停掉。
  //   宿主没给 setTimeout / setInterval 就安静跳过（跟上面 ctx.interval 不在一处，别混）。
  ctx.effect(() => {
    if (typeof setInterval !== 'function') {
      记账('拿不到定时器（setInterval 不在）—— 空间定时发说说 / 定时看一圈跑不起来，别的照常')
      return () => {}
    }
    let 表 = null
    try {
      表 = setInterval(() => {
        // 再兜一层：万一 空间定时一跳 自己都 rejected，也不能变成未处理的 rejection（宿主会整个退出）
        空间定时一跳().catch((error) => {
          try { 记账('空间定时任务：整跳出错（下一跳照常）：' + String((error && error.message) || error)) } catch (e2) {}
        })
      }, 60000)
      // 不让它拖着进程不退（Node 的定时器才有 unref，别的地方可能没有）
      if (typeof 表.unref === 'function') 表.unref()
    } catch (error) {
      记账('空间定时任务排不上（' + String((error && error.message) || error) + '），跳过')
      return () => {}
    }
    return () => {
      try { clearInterval(表) } catch (error) {}
    }
  }, 'qq-bridge: 空间定时任务（每 60 秒一跳）')

  记账(`已装好 v${版本}：DSH↔QQ 两半都在｜总开关 ${读配置().总开关 ? '开' : '关'}｜试运行 ${读配置().试运行 ? '开（只记账）' : '关（真发）'}｜收消息 ${读配置().轮询间隔毫秒} 毫秒轮询一次`)

  // ---------- 自测用的小钩子（只造状态，不改行为） ----------
  const 测试 = {
    记唤醒: (会话, 类型, 点名) => 唤醒时间.set(会话键(会话), { 时: Date.now(), 类型: String(类型 || '群'), 点名: Boolean(点名) }),
    清唤醒: (会话) => 唤醒时间.delete(会话键(会话)),
    清尾巴: (会话) => 尾巴.delete(会话键(会话)),
    有尾巴: (会话) => Boolean((尾巴.get(会话键(会话)) || 0) > Date.now()),
    接听: (群号) => 接听中.get('群:' + String(群号)) || null,
    记己方: (id) => 记己方消息(id),
    己方数量: () => 己方消息.size,
  }

  return { 记账, 概况, 落地一发, 发到QQ, 收到事件, 日志, 测试 }
}
