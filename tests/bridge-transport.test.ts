// The page side of meshmash-bridge (BridgeTransport) against the real bridge and a fake radio.
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startBridge } from '../bridge/src/server.ts'
import { BridgeError, listRadios, openBridgeRadio } from '../src/lib/transport/bridge'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

async function setup() {
  const sockets: Socket[] = []
  const received: number[] = []
  const radio = createServer((s) => {
    sockets.push(s)
    s.on('data', (b) => received.push(...b))
  })
  await new Promise<void>((d) => radio.listen(0, '127.0.0.1', d))
  cleanup.push(() => new Promise((d) => radio.close(d)), () => sockets.forEach((s) => s.destroy()))
  const bridge = await startBridge({
    config: {
      port: 0,
      origins: [],
      radios: [{ name: 'Vuores', host: '127.0.0.1', port: (radio.address() as { port: number }).port, protocol: 'meshcore' }],
    },
    version: 'test',
    port: 0,
  })
  cleanup.push(() => bridge.close())
  return { settings: { address: `127.0.0.1:${bridge.port}` }, sockets, received }
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('BridgeTransport', () => {
  it('lists radios and opens one with the protocol the bridge reports', async () => {
    const { settings, sockets, received } = await setup()
    expect((await listRadios(settings)).radios).toEqual([{ name: 'Vuores', protocol: 'meshcore', inUse: false }])

    const { transport, protocol } = await openBridgeRadio(settings, 'Vuores')
    cleanup.push(() => transport.close())
    expect(protocol).toBe('meshcore')
    expect(transport.label).toBe('WiFi Vuores')

    // Sent unchanged, and nothing is sent before the client writes (no detection probe).
    await until(() => sockets.length > 0)
    expect(received).toEqual([])
    await transport.write(Uint8Array.of(0x3c, 0x01, 0x00, 0x16))
    await until(() => received.length === 4)
    expect(received).toEqual([0x3c, 0x01, 0x00, 0x16])

    const got: number[] = []
    transport.onData = (c) => got.push(...c)
    sockets[0].write(Uint8Array.of(0x3e, 0x01, 0x00, 0x0d))
    await until(() => got.length === 4)
    expect(got).toEqual([0x3e, 0x01, 0x00, 0x0d])
  })

  it('reports the radio closing, with a reason', async () => {
    const { settings, sockets } = await setup()
    const { transport } = await openBridgeRadio(settings, 'Vuores')
    const closed = new Promise<string | undefined>((d) => (transport.onClose = d))
    await until(() => sockets.length > 0)
    sockets[0].end()
    expect(await closed).toMatch(/radio closed the connection/)
    expect(transport.final).toBe(false)
  })

  it('marks a takeover as final so the old window does not reconnect', async () => {
    const { settings } = await setup()
    const first = await openBridgeRadio(settings, 'Vuores')
    const closed = new Promise<string | undefined>((d) => (first.transport.onClose = d))
    await expect(openBridgeRadio(settings, 'Vuores')).rejects.toMatchObject({ code: 4409, message: 'Vuores is in use by another meshmash window' })
    const second = await openBridgeRadio(settings, 'Vuores', { takeover: true })
    cleanup.push(() => second.transport.close())
    expect(await closed).toBe('Another meshmash window took over Vuores')
    expect(first.transport.final).toBe(true)
  })

  it('closes quietly when the page disconnects', async () => {
    const { settings, sockets } = await setup()
    const { transport } = await openBridgeRadio(settings, 'Vuores')
    const closed = new Promise<string | undefined>((d) => (transport.onClose = d))
    await transport.close()
    expect(await closed).toBeUndefined()
    await until(() => sockets[0]?.destroyed || sockets[0]?.readableEnded)
  })

  it('explains a missing bridge and an unknown radio', async () => {
    await expect(listRadios({ address: '127.0.0.1:9' })).rejects.toThrow(/No bridge answering at 127.0.0.1:9/)
    const { settings } = await setup()
    const e = await openBridgeRadio(settings, 'nope').catch((x) => x)
    expect(e).toBeInstanceOf(BridgeError)
    expect(e.message).toBe('The bridge has no radio named "nope"')
  })
})
