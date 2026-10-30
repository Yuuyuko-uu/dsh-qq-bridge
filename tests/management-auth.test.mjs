// 设置页路由只认 owner（DSH Connection admission）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bridge-auth-'))
process.env.QQ_BRIDGE_不加速 = '1'
const host = await import('../lib/host.js')

function harness(admit) {
  const routes = new Map(), listeners = new Map()
  const ctx = {
    connection: admit === undefined ? undefined : { admit },
    on: (name, fn) => { listeners.set(name, fn); return () => {} },
    effect: fn => fn(), interval: () => () => {}, get: () => undefined,
    webServer: { register: o => { routes.set(o.path, o.handler); return () => {} } },
    agents: { get: () => undefined }, sessions: { flush: async () => {} },
  }
  host.apply(ctx)
  return { routes, listeners }
}
function call(handler) {
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, setHeader() {}, writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers) },
      end(body) { resolve({ status: this.statusCode, body: String(body ?? '') }) } }
    Promise.resolve(handler({ method: 'GET', url: '/', headers: {} }, res)).catch(() => {})
  })
}

test('every Bridge route, including self-update, requires an owner', async () => {
  for (const [admit, status] of [[undefined, 503], [() => ({ rejection: 401 }), 401],
    [() => ({ peer: { principal: { kind: 'guest' } } }), 403]]) {
    const { routes } = harness(admit)
    assert.ok(routes.size > 5)
    for (const [path, handler] of routes) {
      const result = await call(handler)
      assert.equal(result.status, status, path)
      assert.match(result.body, /authentication_|management_forbidden/)
    }
  }
})

test('owner reaches the original route handler', async () => {
  const { routes } = harness(() => ({ peer: { principal: { kind: 'owner' } } }))
  const state = [...routes].find(([path]) => path.endsWith('/state'))
  assert.ok(state, 'state route exists')
  const result = await call(state[1])
  assert.equal(result.status, 200)
  assert.doesNotMatch(result.body, /authentication_|management_forbidden/)
})
