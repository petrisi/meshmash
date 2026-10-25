// HTTP + WebSocket server on loopback. Each WebSocket session relays bytes to one radio's
// TCP port; the bridge does not parse either radio protocol.
import { timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { BridgeConfig, RadioConfig } from './config.ts'

export const SUBPROTOCOL = 'meshmash.v1'
export const PATH = '/v1'
export const MAX_MESSAGE = 64 * 1024

/** WebSocket close codes the page understands. */
export const Close = {
  normal: 1000,
  badMessage: 4400,
  badToken: 4401,
  noRadio: 4404,
  inUse: 4409,
  takenOver: 4410,
  unreachable: 4502,
  radioClosed: 4503,
} as const

export interface BridgeOptions {
  config: BridgeConfig
  version: string
  /** Directory of a built meshmash to serve at /. */
  serveDir?: string
  log?: (line: string) => void
  connectTimeoutMs?: number
  /** 0 picks a free port (tests). */
  port?: number
}

export interface Bridge {
  port: number
  close(): Promise<void>
}

interface Session {
  ws: WebSocket
  radio: RadioConfig
  socket: Socket
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

export function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const { config, version } = opts
  const log = opts.log ?? (() => {})
  const sessions = new Map<string, Session>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE,
    handleProtocols: (offered) => (offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  })

  let port = opts.port ?? config.port
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const origins = () => new Set([...config.origins, `http://127.0.0.1:${port}`, `http://localhost:${port}`])

  const server = createServer((req, res) => void serveHttp(req, res))

  async function serveHttp(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!hosts().has(req.headers.host ?? '')) return void res.writeHead(403).end()
    if (!opts.serveDir || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(opts.serveDir ? 405 : 200, { 'Content-Type': 'text/plain; charset=utf-8' })
      return void res.end(opts.serveDir ? '' : `meshmash-bridge ${version}\n`)
    }
    const root = resolve(opts.serveDir)
    let rel: string
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      return void res.writeHead(400).end()
    }
    let file = normalize(join(root, rel))
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end()
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404).end()
    }
  }

  server.on('upgrade', (req: IncomingMessage, sock: Duplex, head: Buffer) => {
    const origin = req.headers.origin
    const refuse = (why: string) => {
      log(`refused ${origin ?? 'no origin'}: ${why}`)
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    }
    if (new URL(req.url ?? '/', 'http://x').pathname !== PATH) return refuse('path')
    // Browsers always send Origin; other local programs could reach the radios directly anyway.
    if (!hosts().has(req.headers.host ?? '')) return refuse(`host ${req.headers.host}`)
    if (origin !== undefined && !origins().has(origin)) return refuse('origin not allowed')
    wss.handleUpgrade(req, sock, head, (ws) => accept(ws, req))
  })

  function tokenOk(req: IncomingMessage): boolean {
    if (!config.token) return true
    const want = Buffer.from(`token.${config.token}`)
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
    return offered.some((p) => {
      const got = Buffer.from(p)
      return got.length === want.length && timingSafeEqual(got, want)
    })
  }

  function accept(ws: WebSocket, req: IncomingMessage) {
    const from = req.headers.origin ?? 'local program'
    if (!tokenOk(req)) {
      log(`refused ${from}: token`)
      return ws.close(Close.badToken, 'token missing or wrong')
    }
    const send = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg))
    send({
      t: 'hello',
      v: 1,
      bridge: version,
      radios: config.radios.map((r) => ({ name: r.name, protocol: r.protocol, inUse: sessions.has(r.name) })),
    })

    let session: Session | null = null
    ws.on('message', (data: RawData, binary: boolean) => {
      if (binary) {
        if (!session) return ws.close(Close.badMessage, 'open a radio first')
        const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        if (!session.socket.write(chunk)) {
          ws.pause()
          session.socket.once('drain', () => ws.resume())
        }
        return
      }
      let msg: { t?: unknown; radio?: unknown; takeover?: unknown }
      try {
        msg = JSON.parse(String(data))
      } catch {
        return ws.close(Close.badMessage, 'not JSON')
      }
      if (msg.t !== 'open' || session) return ws.close(Close.badMessage, 'unexpected message')
      const radio = config.radios.find((r) => r.name === msg.radio)
      if (!radio) return ws.close(Close.noRadio, 'no such radio')
      const current = sessions.get(radio.name)
      if (current && msg.takeover !== true) return ws.close(Close.inUse, 'radio in use by another session')
      if (current) {
        log(`${radio.name}: taken over by ${from}`)
        current.ws.close(Close.takenOver, 'taken over by another session')
        current.socket.destroy()
        sessions.delete(radio.name)
      }
      session = open(ws, radio, from)
    })
    ws.on('close', () => {
      if (!session) return
      session.socket.destroy()
      if (sessions.get(session.radio.name) === session) sessions.delete(session.radio.name)
    })
    ws.on('error', () => ws.terminate())
  }

  function open(ws: WebSocket, radio: RadioConfig, from: string): Session {
    const socket = connect({ host: radio.host, port: radio.port })
    const s: Session = { ws, radio, socket }
    sessions.set(radio.name, s)
    let connected = false
    socket.setTimeout(opts.connectTimeoutMs ?? 5000, () => {
      if (!connected) socket.destroy(new Error('timed out'))
    })
    socket.on('connect', () => {
      connected = true
      socket.setTimeout(0)
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 30_000)
      log(`${radio.name}: connected for ${from}`)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'opened', radio: radio.name, protocol: radio.protocol }))
    })
    socket.on('data', (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true })
    })
    let error = ''
    socket.on('error', (e: Error) => (error = e.message))
    socket.on('close', () => {
      if (sessions.get(radio.name) === s) sessions.delete(radio.name)
      if (ws.readyState !== ws.OPEN) return
      const reason = connected ? `radio closed the connection${error ? `: ${error}` : ''}` : `radio unreachable: ${error || 'closed'}`
      log(`${radio.name}: ${reason}`)
      ws.send(JSON.stringify({ t: 'closed', reason }))
      // Close reasons are limited to 123 bytes.
      ws.close(connected ? Close.radioClosed : Close.unreachable, reason.slice(0, 120))
    })
    return s
  }

  return new Promise((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      port = (server.address() as { port: number }).port
      resolveStart({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sessions.values()) {
              s.socket.destroy()
              s.ws.terminate()
            }
            for (const c of wss.clients) c.terminate()
            wss.close()
            server.close(() => done())
          }),
      })
    })
  })
}
