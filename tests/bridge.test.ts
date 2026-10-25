// meshmash-bridge: upgrade checks, control messages and the byte pipe, against a fake radio.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { configPath, parseTarget, validConfig, validRadio, type BridgeConfig } from '../bridge/src/config.ts'
import { startBridge, type Bridge } from '../bridge/src/server.ts'

const ORIGIN = 'https://page.example'

interface FakeRadio {
  port: number
  received: Buffer[]
  sockets: Socket[]
  server: Server
}

function fakeRadio(): Promise<FakeRadio> {
  const r: FakeRadio = { port: 0, received: [], sockets: [], server: createServer() }
  r.server.on('connection', (s) => {
    r.sockets.push(s)
    s.on('data', (b) => r.received.push(b))
  })
  return new Promise((done) => r.server.listen(0, '127.0.0.1', () => done({ ...r, port: (r.server.address() as { port: number }).port })))
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

async function setup(over: Partial<BridgeConfig> = {}, serveDir?: string) {
  const radio = await fakeRadio()
  cleanup.push(() => new Promise((d) => radio.server.close(d)), () => radio.sockets.forEach((s) => s.destroy()))
  const config: BridgeConfig = {
    port: 0,
    origins: [ORIGIN],
    radios: [{ name: 'r1', host: '127.0.0.1', port: radio.port, protocol: 'meshcore' }],
    ...over,
  }
  const bridge: Bridge = await startBridge({ config, version: 'test', port: 0, serveDir, connectTimeoutMs: 1000 })
  cleanup.push(() => bridge.close())
  return { radio, bridge }
}

/** A client that queues what it receives. */
function client(port: number, o: { origin?: string; protocols?: string[]; host?: string } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`, o.protocols ?? ['meshmash.v1'], {
    origin: o.origin ?? ORIGIN,
    headers: o.host ? { Host: o.host } : undefined,
  })
  cleanup.push(() => ws.terminate())
  const queue: (string | Buffer)[] = []
  const waiters: (() => void)[] = []
  ws.on('message', (d, binary) => {
    queue.push(binary ? Buffer.from(d as Buffer) : String(d))
    waiters.splice(0).forEach((w) => w())
  })
  const closed = new Promise<{ code: number; reason: string }>((done) =>
    ws.on('close', (code, reason) => done({ code, reason: String(reason) })),
  )
  const refused = new Promise<number>((done) => ws.on('unexpected-response', (_req, res) => done(res.statusCode ?? 0)))
  ws.on('error', () => {})
  async function next(): Promise<string | Buffer> {
    while (!queue.length) await new Promise<void>((w) => waiters.push(w))
    return queue.shift()!
  }
  const json = async () => JSON.parse(String(await next()))
  const open = (radio: string, takeover = false) => ws.send(JSON.stringify({ t: 'open', radio, takeover }))
  return { ws, next, json, open, closed, refused }
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('bridge upgrade checks', () => {
  it('greets an allowed page with the radio list, without addresses', async () => {
    const { bridge } = await setup()
    const hello = await client(bridge.port).json()
    expect(hello).toEqual({ t: 'hello', v: 1, bridge: 'test', radios: [{ name: 'r1', protocol: 'meshcore', inUse: false }] })
  })

  it('refuses other origins and hosts with 403', async () => {
    const { bridge } = await setup()
    expect(await client(bridge.port, { origin: 'https://evil.example' }).refused).toBe(403)
    expect(await client(bridge.port, { host: `rebind.example:${bridge.port}` }).refused).toBe(403)
  })

  it('accepts its own origin', async () => {
    const { bridge } = await setup()
    expect((await client(bridge.port, { origin: `http://127.0.0.1:${bridge.port}` }).json()).t).toBe('hello')
  })

  it('requires the token when one is set', async () => {
    const { bridge } = await setup({ token: 'abcdefghijklmnop' })
    expect((await client(bridge.port).closed).code).toBe(4401)
    const ok = client(bridge.port, { protocols: ['meshmash.v1', 'token.abcdefghijklmnop'] })
    expect((await ok.json()).t).toBe('hello')
    expect(ok.ws.protocol).toBe('meshmash.v1')
  })
})

describe('bridge sessions', () => {
  it('relays bytes both ways unchanged', async () => {
    const { bridge, radio } = await setup()
    const c = client(bridge.port)
    await c.json()
    c.open('r1')
    expect(await c.json()).toEqual({ t: 'opened', radio: 'r1', protocol: 'meshcore' })
    const out = Buffer.from([0x3c, 0x02, 0x00, 0x16, 0x03])
    c.ws.send(out)
    await until(() => radio.received.length > 0)
    expect(Buffer.concat(radio.received)).toEqual(out)
    const back = Buffer.from([0x3e, 0x01, 0x00, 0x0d])
    radio.sockets[0].write(back)
    expect(await c.next()).toEqual(back)
  })

  it('closes with a code for an unknown radio and for bytes before open', async () => {
    const { bridge } = await setup()
    const a = client(bridge.port)
    await a.json()
    a.open('nope')
    expect((await a.closed).code).toBe(4404)
    const b = client(bridge.port)
    await b.json()
    b.ws.send(Buffer.from([1, 2, 3]))
    expect((await b.closed).code).toBe(4400)
  })

  it('refuses a second session unless it takes over', async () => {
    const { bridge, radio } = await setup()
    const first = client(bridge.port)
    await first.json()
    first.open('r1')
    await first.json()
    const second = client(bridge.port)
    expect((await second.json()).radios[0].inUse).toBe(true)
    second.open('r1')
    expect((await second.closed).code).toBe(4409)

    const third = client(bridge.port)
    await third.json()
    third.open('r1', true)
    expect((await first.closed).code).toBe(4410)
    expect((await third.json()).t).toBe('opened')
    await until(() => radio.sockets.length === 2)
    expect(radio.sockets.length).toBe(2)
  })

  it('reports an unreachable radio', async () => {
    const free = await fakeRadio()
    await new Promise((d) => free.server.close(d))
    const { bridge } = await setup({ radios: [{ name: 'gone', host: '127.0.0.1', port: free.port, protocol: 'meshtastic' }] })
    const c = client(bridge.port)
    await c.json()
    c.open('gone')
    expect((await c.json()).t).toBe('closed')
    expect((await c.closed).code).toBe(4502)
  })

  it('reports the radio closing the connection', async () => {
    const { bridge, radio } = await setup()
    const c = client(bridge.port)
    await c.json()
    c.open('r1')
    await c.json()
    await until(() => radio.sockets.length > 0)
    radio.sockets[0].end()
    expect(await c.json()).toMatchObject({ t: 'closed', reason: expect.stringContaining('radio closed') })
    expect((await c.closed).code).toBe(4503)
  })

  it('closes the radio connection when the page goes', async () => {
    const { bridge, radio } = await setup()
    const c = client(bridge.port)
    await c.json()
    c.open('r1')
    await c.json()
    await until(() => radio.sockets.length > 0)
    const gone = new Promise((d) => radio.sockets[0].on('close', d))
    c.ws.close()
    await gone
  })
})

describe('bridge static files', () => {
  it('serves the app and nothing outside its directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html>app')
    const { bridge } = await setup({}, dir)
    const base = `http://127.0.0.1:${bridge.port}`
    const index = await fetch(`${base}/`)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toBe('<!doctype html>app')
    expect((await fetch(`${base}/%2e%2e/%2e%2e/package.json`)).status).toBeGreaterThanOrEqual(403)
  })
})

describe('bridge config', () => {
  it('defaults the protocol from the port and the port from the protocol', () => {
    expect(validRadio({ name: 'a', host: '10.0.0.2', port: 5000 })).toMatchObject({ port: 5000, protocol: 'meshcore' })
    expect(validRadio({ name: 'a', host: 'x.local', protocol: 'meshtastic' })).toMatchObject({ port: 4403 })
    expect(() => validRadio({ name: 'a', host: 'x', port: 8000 })).toThrow(/protocol/)
    expect(() => validRadio({ name: '', host: 'x', port: 5000 })).toThrow(/name/)
    expect(() => validRadio({ name: 'a', host: 'x y', port: 5000 })).toThrow(/host/)
  })
  it('rejects duplicate names, bad origins and short tokens', () => {
    const r = { name: 'A', host: 'h', port: 5000 }
    expect(() => validConfig({ radios: [r, { ...r, name: 'a' }] })).toThrow(/twice/)
    expect(() => validConfig({ origins: ['https://x.example/'] })).toThrow(/should be/)
    expect(() => validConfig({ token: 'short' })).toThrow(/token/)
    expect(validConfig({})).toMatchObject({ port: 4404, origins: ['https://www.simol.in'], radios: [] })
  })
  it('parses host and port targets', () => {
    expect(parseTarget('192.168.1.5:5000')).toEqual({ host: '192.168.1.5', port: 5000 })
    expect(parseTarget('radio.local')).toEqual({ host: 'radio.local' })
    expect(parseTarget('[fe80::1]:4403')).toEqual({ host: 'fe80::1', port: 4403 })
  })
  it('stores the config per user on each platform', () => {
    expect(configPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toMatch(/meshmash-bridge[\\/]config\.json$/)
    expect(configPath({ XDG_CONFIG_HOME: '/home/u/.config' }, 'linux')).toBe(join('/home/u/.config', 'meshmash-bridge', 'config.json'))
    expect(configPath({ MESHMASH_BRIDGE_CONFIG: '/x.json' }, 'linux')).toBe('/x.json')
  })
})
