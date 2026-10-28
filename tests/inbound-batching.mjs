import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Synthetic apply-level tests. Timers and wall-clock advance explicitly; no QQ,
// host, ASR, model, real network or elapsed-time sleep is needed.
const originals = { fetch, setTimeout, clearTimeout, now: Date.now, home: process.env.DSH_HOME, fast: process.env.QQ_BRIDGE_不加速 }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }
const response = data => ({ json: async () => ({ status: 'ok', data }) })
let serial = 0, failures = 0

async function fixture(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'qq-inbound-batching-'))
  process.env.DSH_HOME = home
  delete process.env.QQ_BRIDGE_不加速
  let now = 2000000000000
  Date.now = () => now
  const key = options.group ? '群:456' : '私聊:123'
  let config = { 总开关: true, 试运行: true, 收图: true, 合并窗口秒: 1, 群里听所有人: true,
    绑定: [{ 类型: options.group ? '群' : '私聊', 号码: options.group ? '456' : '123', 会话: 'session-X', 门槛: Boolean(options.group) }],
    NapCat: 'http://synthetic.invalid', ...options.config }
  const configure = patch => { config = { ...config, ...patch }; writeFileSync(join(home, 'qq-bridge-config.json'), JSON.stringify(config)) }
  configure({})
  writeFileSync(join(home, 'qq-bridge-state.json'), JSON.stringify({ 上次: { [key]: now / 1000 - 100 }, 已转: [] }))
  const message = (id, { age = 0, user = 123, segments } = {}) => ({ user_id: user, message_id: id, time: now / 1000 - age,
    message: segments || [{ type: 'text', data: { text: 'synthetic-' + id } }] })
  let messages = [message(1)], fetchImpl = null
  const timers = new Map(), requests = [], instances = []
  globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.set(timer, timer); return timer }
  globalThis.clearTimeout = timer => timers.delete(timer)
  const defaultFetch = async url => response(url.endsWith('/get_login_info') ? { user_id: 10001 } : { messages })
  globalThis.fetch = (...args) => { requests.push(args); return (fetchImpl || defaultFetch)(...args) }
  const host = await import(pathToFileURL(resolve(process.env.QQ_TEST_HOST || 'lib/host.js')).href + '?batch=' + ++serial)
  const mount = () => {
    const calls = [], effects = [], tools = [], logs = []
    let tick, interval, follow = async () => {}, admit = async content => content, flush = async () => {}, stopped = false
    const agent = { session: { id: 'session-X' }, followup: m => { calls.push(m); return follow(m) },
      ctx: { tools: { register(tool) { tools.push(tool); return () => {} } } } }
    const bridge = host.apply({ effect(fn) { effects.push(fn()) }, on: () => () => {}, webServer: { register() {} },
      interval(fn, ms) { tick = fn; interval = ms; return () => { stopped = true } }, agents: { get: () => agent },
      attachments: { admitPromptContent: content => admit(content) }, sessions: { flush: () => flush() },
      logger: { info: msg => logs.push(msg) }, get() {} })
    const instance = { calls, tools, logs, bridge, tick: () => tick(), interval,
      dispose: () => effects.forEach(fn => fn?.()), stopped: () => stopped,
      follow: fn => { follow = fn }, admit: fn => { admit = fn }, flush: fn => { flush = fn } }
    instances.push(instance); return instance
  }
  const readDeadline = timer => timer.ms === 5000 || timer.ms === 8000
  const matchingTimers = () => [...timers.values()].filter(t => !readDeadline(t))
  const fire = timer => { assert.ok(timer, 'expected timer'); timers.delete(timer); return timer.fn() }
  return { key, message, mount, configure, requests, defaultFetch, advance: ms => { now += ms },
    messages: value => { messages = value }, fetch: fn => { fetchImpl = fn },
    historyCalls: () => requests.filter(([url]) => url.endsWith('_msg_history')).length,
    fastTimers: () => matchingTimers(), deadlines: () => [...timers.values()].filter(readDeadline),
    fireFast: () => fire(matchingTimers()[0]), expire: () => [...timers.values()].filter(readDeadline).forEach(fire),
    state: () => JSON.parse(readFileSync(join(home, 'qq-bridge-state.json'), 'utf8')),
    save: state => writeFileSync(join(home, 'qq-bridge-state.json'), JSON.stringify(state)),
    close() {
      instances.forEach(i => i.dispose())
      Object.assign(globalThis, { fetch: originals.fetch, setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout })
      Date.now = originals.now
      if (originals.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originals.home
      if (originals.fast === undefined) delete process.env.QQ_BRIDGE_不加速; else process.env.QQ_BRIDGE_不加速 = originals.fast
      rmSync(home, { recursive: true, force: true })
    } }
}

async function check(label, run, options) {
  const f = await fixture(options)
  try { await run(f); console.log('PASS ' + label) }
  catch (error) { failures++; console.error('FAIL ' + label + ': ' + error.stack) }
  finally { f.close() }
}

for (const interval of [undefined, 3300]) await check(`polling interval preserves ${interval || 'default 2000'} ms`, async f => {
  assert.equal(f.mount().interval, interval || 2000)
}, { config: interval ? { 轮询间隔毫秒: interval } : {} })

await check('merge window schedules a fast tick that flushes once and persists every batch ID', async f => {
  f.messages([f.message(1), f.message(2)])
  const a = f.mount(); await a.tick()
  assert.equal(a.calls.length, 0); assert.equal(f.fastTimers().length, 1); assert.deepEqual(f.state().已转, [])
  f.advance(2000); await f.fireFast(); await settle()
  assert.equal(a.calls.length, 1); assert.match(a.calls[0].content[0].text, /synthetic-1\nsynthetic-2/)
  assert.deepEqual(f.state().已转, [1, 2]); await a.tick(); assert.equal(a.calls.length, 1)
})

for (const first of ['regular', 'fast']) await check(`${first} tick owns the same pending task when fast and regular polling overlap`, async f => {
  const a = f.mount(); await a.tick(); f.advance(2000)
  const historyGate = deferred(); f.fetch(url => url.endsWith('_msg_history') ? historyGate.promise : f.defaultFetch(url))
  const firstTask = first === 'regular' ? a.tick() : f.fireFast()
  const secondTask = first === 'regular' ? f.fireFast() : a.tick()
  await settle(); const count = f.historyCalls()
  historyGate.resolve(response({ messages: [f.message(1, { age: 2 })] })); await Promise.all([firstTask, secondTask]); await settle()
  assert.equal(count, 2); assert.equal(firstTask, secondTask); assert.equal(a.calls.length, 1)
})

await check('pending batch followup blocks ordinary and saved fast callbacks until actual acceptance', async f => {
  const a = f.mount(); await a.tick(); const saved = f.fastTimers()[0].fn
  f.advance(2000); const gate = deferred(); a.follow(() => gate.promise)
  const pending = f.fireFast(); await settle()
  const second = a.tick(), third = saved(); const count = a.calls.length, reads = f.historyCalls(), deadlines = f.deadlines().length
  gate.resolve(); await Promise.all([pending, second, third]); await settle()
  assert.equal(count, 1); assert.equal(reads, 2); assert.equal(deadlines, 0)
  assert.equal(second, pending); assert.equal(third, pending); assert.deepEqual(f.state().已转, [1])
})

await check('maximum batch age flushes despite a fresh final message', async f => {
  f.messages([f.message(1, { age: 25 }), f.message(2)])
  const a = f.mount(); await a.tick(); assert.equal(a.calls.length, 1); assert.deepEqual(f.state().已转, [1, 2])
  assert.equal(f.fastTimers().length, 0)
}, { config: { 合并窗口秒: 10, 合并最多秒: 20 } })

await check('a repeated history ID is included only once inside a pending batch', async f => {
  const duplicate = f.message(1, { age: 2 })
  f.messages([duplicate, duplicate, f.message(2, { age: 2 })])
  const a = f.mount(); await a.tick()
  assert.equal(a.calls.length, 1); assert.equal(a.calls[0].content[0].text.match(/synthetic-1/g)?.length, 1)
  assert.deepEqual(f.state().已转, [1, 2])
})

await check('group always skips the bot own text, image, and @ message before parsing, then remembers IDs', async f => {
  f.messages([
    f.message(1, { age: 2, user: '10001' }),
    f.message(2, { age: 2, user: 10001, segments: [{ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/own' } }] }),
    f.message(3, { age: 2, user: 10001, segments: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: 'own mention' } }] }),
  ])
  const a = f.mount()
  await a.tick()
  assert.equal(a.calls.length, 0)
  assert.deepEqual(f.state().已转, [1, 2, 3])
  assert.equal(f.requests.some(([url]) => String(url).includes('multimedia.nt.qq.com.cn')), false)
  await a.tick()
  assert.equal(a.calls.length, 0)
}, { group: true })

await check('group listen-all still delivers other members and owner, never the bot', async f => {
  f.messages([
    f.message(1, { age: 2, user: 10001 }),
    f.message(2, { age: 2, user: 123 }),
    f.message(3, { age: 2, user: 124 }),
  ])
  const a = f.mount()
  await a.tick()
  assert.equal(a.calls.length, 1)
  assert.match(a.calls[0].content[0].text, /synthetic-2/)
  assert.match(a.calls[0].content[0].text, /synthetic-3/)
  assert.doesNotMatch(a.calls[0].content[0].text, /synthetic-1/)
  assert.deepEqual(f.state().已转, [1, 2, 3])
}, { group: true })

// ⭐ 1.0.9：群里换人**也照攒**（以前换人就切开 → 两个人说话起两轮）
await check('group batches across senders into one followup and disposal prevents any second batch', async f => {
  f.messages([f.message(1, { age: 2 }), f.message(2, { age: 2, user: 124 })])
  const a = f.mount(), gate = deferred(); a.follow(() => gate.promise)
  const pending = a.tick(); await settle(); const started = a.calls.length
  a.dispose(); gate.resolve(); await pending
  assert.equal(started, 1); assert.equal(a.calls.length, 1); assert.deepEqual(f.state().已转, [1, 2])
}, { group: true, config: { 回复冷却秒: 0 } })

await check('zero merge window keeps individual delivery and retries a rejected batch', async f => {
  f.messages([f.message(1), f.message(2)])
  const a = f.mount(); let reject = true
  a.follow(async () => { if (reject) throw Error('synthetic rejection') })
  await a.tick(); assert.equal(a.calls.length, 1); assert.deepEqual(f.state().已转, [])
  reject = false; await a.tick(); assert.equal(a.calls.length, 3); assert.deepEqual(f.state().已转, [1, 2])
}, { config: { 合并窗口秒: 0 } })

for (const named of [true, false]) await check(`group batch preserves wakeup metadata and ${named ? '@ bypass' : 'reply gate refusal'}`, async f => {
  f.messages([f.message(1, { age: 2 }), f.message(2, { age: 2, segments: named
    ? [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: 'named synthetic' } }]
    : [{ type: 'text', data: { text: 'plain synthetic' } }] })])
  const a = f.mount(); await a.tick(); assert.equal(a.calls.length, 1)
  const gate = a.tools.find(tool => tool.name === 'qq_reply_gate'); assert.ok(gate)
  const result = await gate.execute({ reply: false })
  assert.match(result.说, named ? /点了你的名/ : /不接/)
}, { group: true })

await check('dispose clears a queued flush timer and stale callbacks cannot start new history', async f => {
  const a = f.mount(); await a.tick(); const saved = f.fastTimers()[0].fn
  a.dispose(); const remaining = f.fastTimers().length; await saved(); await settle()
  assert.equal(remaining, 0); assert.equal(a.stopped(), true); assert.equal(f.historyCalls(), 1); assert.equal(a.calls.length, 0)
})

for (const stop of ['dispose', 'disable']) await check(`${stop} during batch attachment admission prevents any late followup`, async f => {
  f.messages([f.message(1, { age: 2, segments: [{ type: 'image', data: { file: 'base64://iVBORw0KGgo=' } }] })])
  const a = f.mount(), gate = deferred(); let admitted = 0
  a.admit(() => { admitted++; return gate.promise })
  const pending = a.tick(); await settle(); assert.equal(admitted, 1)
  if (stop === 'dispose') a.dispose(); else f.configure({ 总开关: false })
  gate.resolve([{ type: 'text', text: 'synthetic attachment' }]); await pending
  assert.equal(a.calls.length, 0); assert.deepEqual(f.state().已转, [])
})

await check('disable on a tick aborts an in-flight history and clears its queued flush', async f => {
  const a = f.mount(); await a.tick()
  const gate = deferred(); f.fetch(() => gate.promise)
  const pending = a.tick(); await settle(); f.configure({ 总开关: false }); const stopped = a.tick()
  const aborted = f.requests.at(-1)[1].signal?.aborted, timers = f.fastTimers().length
  gate.resolve(response({ messages: [f.message(1)] })); await Promise.all([pending, stopped])
  assert.equal(aborted, true); assert.equal(timers, 0); assert.equal(a.calls.length, 0); assert.deepEqual(f.state().已转, [])
})

await check('accepted batch is durable before flush and reload uses the actual main watermark initialization', async f => {
  f.messages([f.message(1, { age: 2 }), f.message(2, { age: 2 })])
  const a = f.mount(), gate = deferred(); a.flush(() => gate.promise)
  const pending = a.tick(); await settle(); const accepted = f.state().已转
  a.dispose(); gate.resolve(); await pending
  const reloaded = f.mount(); await reloaded.tick()
  assert.deepEqual(accepted, [1, 2]); assert.equal(reloaded.calls.length, 0)
})

await check('late accepted batch merges all IDs without overwriting a newer instance watermark', async f => {
  f.messages([f.message(1, { age: 2 }), f.message(2, { age: 2 })])
  const old = f.mount(), gate = deferred(); old.follow(() => gate.promise)
  const pending = old.tick(); await settle(); old.dispose()
  f.save({ 上次: { [f.key]: 2000000010, '群:789': 2000000020 }, 已转: [50, 51] })
  gate.resolve(); await pending
  assert.deepEqual(f.state(), { 上次: { [f.key]: 2000000010, '群:789': 2000000020 }, 已转: [50, 51, 1, 2] })
  const reloaded = f.mount(); await reloaded.tick(); assert.equal(reloaded.calls.length, 0)
})

for (const phase of ['fetch', 'json']) await check(`login lookup ${phase} shares the read deadline and ignores late completion`, async f => {
  const a = f.mount(), gate = deferred()
  f.messages([f.message(1, { age: 2 })])
  f.fetch(url => url.endsWith('/get_login_info') ? phase === 'fetch' ? gate.promise : Promise.resolve({ json: () => gate.promise }) : f.defaultFetch(url))
  const pending = a.tick(); await settle(); const deadlineCount = f.deadlines().length
  const deadlineMillis = f.deadlines().map(timer => timer.ms)
  const request = f.requests.at(-1)
  f.expire()
  gate.resolve(phase === 'fetch' ? response({ user_id: 10001 }) : { status: 'ok', data: { user_id: 10001 } })
  await pending; const lateCalls = a.calls.length
  f.fetch(null); await a.tick()
  assert.equal(deadlineCount, 1); assert.equal(request[1].signal?.aborted, true)
  assert.deepEqual(deadlineMillis, [5000])
  assert.equal(lateCalls, 0); assert.equal(a.calls.length, 1); assert.equal(f.deadlines().length, 0)
})

for (const source of ['regular', 'fast']) for (const duration of [3000, 3001]) {
  await check(`${source} polling reports ${duration} ms once per task, never per overlapping tick`, async f => {
    const a = f.mount(); await a.tick(); const savedFast = f.fastTimers()[0].fn; f.advance(2000)
    const gate = deferred()
    f.fetch(url => url.endsWith('_msg_history') ? gate.promise : f.defaultFetch(url))
    const pending = source === 'regular' ? a.tick() : f.fireFast()
    const joined = [a.tick(), savedFast(), a.tick()]
    await settle(); assert.deepEqual(f.deadlines().map(timer => timer.ms), [8000])
    f.advance(duration); gate.resolve(response({ messages: [f.message(1, { age: 10 })] }))
    await Promise.all([pending, ...joined])
    assert.ok(joined.every(task => task === pending)); assert.equal(f.historyCalls(), 2)
    const diagnostics = a.bridge.日志.filter(entry => entry.文本.startsWith('这一次收消息花了 '))
    assert.equal(diagnostics.length, duration > 3000 ? 1 : 0)
    if (diagnostics.length) assert.match(diagnostics[0].文本, /超过 8 秒的请求会被掐掉重试/)
  })
}

// ⭐ 1.0.9：群聊的节奏（冷却 / 封顶 / 跨人合并）
await check('group batch in cooldown is held, not dropped, and goes out once the cooldown passes', async f => {
  f.messages([f.message(1, { age: 2 })])
  const a = f.mount(); await a.tick()
  assert.equal(a.calls.length, 1)                     // 第一批发得出去
  f.messages([f.message(1, { age: 2 }), f.message(2, { age: 1 })])
  await a.tick()
  assert.equal(a.calls.length, 1)                     // 冷却里：这一批先挂着
  assert.deepEqual(f.state().已转, [1])
  assert.ok(f.fastTimers().length >= 1)               // 约好冷完再来
  f.advance(6000); await f.fireFast(); await settle()
  assert.equal(a.calls.length, 2)                     // 冷完了，补发出去
  assert.deepEqual(f.state().已转, [1, 2])
}, { group: true, config: { 合并窗口秒: 0, 回复冷却秒: 5 } })

await check('group per-minute cap holds the batch and releases it once the window frees', async f => {
  f.messages([f.message(1, { age: 2 })])
  const a = f.mount()
  await a.tick(); assert.equal(a.calls.length, 1)     // 这一分钟的名额用掉了
  f.messages([f.message(1, { age: 2 }), f.message(2, { age: 1 })])
  await a.tick(); await settle()
  assert.equal(a.calls.length, 1)                     // 撞上「一分钟最多 1 条」→ 挂着，不回也不丢
  assert.deepEqual(f.state().已转, [1])
  assert.ok(f.fastTimers().length >= 1)
  f.advance(61000); await f.fireFast(); await settle()
  assert.equal(a.calls.length, 2)                     // 名额滑出来了，补发
  assert.deepEqual(f.state().已转, [1, 2])
}, { group: true, config: { 合并窗口秒: 0, 回复冷却秒: 0, 每分钟最多条: 1 } })

await check('group batch merges different senders and keeps every name inline', async f => {
  f.messages([f.message(1, { age: 2, user: 123 }), f.message(2, { age: 2, user: 124 })])
  const a = f.mount(); await a.tick()
  assert.equal(a.calls.length, 1)
  const text = String(a.calls[0].content[0].text)
  assert.match(text, /synthetic-1/)
  assert.match(text, /synthetic-2/)
  assert.equal((text.match(/（\d+）：/g) || []).length, 2)   // 两行各带一次名字
}, { group: true, config: { 合并窗口秒: 1, 回复冷却秒: 0, 合并最多条: 8 } })

await check('group reply probability 0 skips the batch entirely: no followup, water mark advanced', async f => {
  f.messages([f.message(1, { age: 2 })])
  const a = f.mount(); await a.tick(); await settle()
  assert.equal(a.calls.length, 0)                     // 没掷中 → 压根不送进来
  assert.deepEqual(f.state().已转, [1])                // 但也记下了，不会反复拉
  assert.ok(a.bridge.日志.some(entry => entry.文本.includes('没掷中')))
}, { group: true, config: { 合并窗口秒: 0, 回复冷却秒: 0, 回复概率: 0 } })

await check('group reply probability 100 keeps every batch', async f => {
  f.messages([f.message(1, { age: 2 })])
  const a = f.mount(); await a.tick(); await settle()
  assert.equal(a.calls.length, 1)
}, { group: true, config: { 合并窗口秒: 0, 回复冷却秒: 0, 回复概率: 100 } })

// ⭐ 1.1.1（她定的）：人设只走系统提示词 —— 挂不上就**不塞进消息里**
await check('persona never rides the message, even when the agent has no system prompt', async f => {
  f.messages([f.message(1, { age: 2 })])
  const a = f.mount(); await a.tick()
  assert.equal(a.calls.length, 1)
  assert.ok(!String(a.calls[0].content[0].text).includes('你是小满'))
}, { config: { 合并窗口秒: 0, 回复冷却秒: 0, 人设开: true, 人设: '你是小满，说话很短。' } })

await check('persona stays out of the message when the switch is off', async f => {
  f.messages([f.message(1, { age: 2 })])
  const a = f.mount(); await a.tick()
  assert.equal(a.calls.length, 1)
  assert.ok(!String(a.calls[0].content[0].text).includes('你是小满'))
}, { config: { 合并窗口秒: 0, 回复冷却秒: 0, 人设开: false, 人设: '你是小满，说话很短。' } })

process.exitCode = failures ? 1 : 0
