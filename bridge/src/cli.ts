#!/usr/bin/env node
// meshmash-bridge: lets the meshmash web page reach radios on WiFi.
import { readFileSync } from 'node:fs'
import { configPath, loadConfig, newToken, parseTarget, saveConfig, validConfig, validRadio, type BridgeConfig } from './config.ts'
import { startBridge } from './server.ts'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const PAGE = 'https://www.simol.in/meshmash/'

const USAGE = `meshmash-bridge ${version}

Usage:
  meshmash-bridge [--serve <dir>]      run the bridge
  meshmash-bridge add <name> <host>[:port] [--meshtastic | --meshcore]
  meshmash-bridge remove <name>
  meshmash-bridge list
  meshmash-bridge origin add|remove <origin>
  meshmash-bridge token on|off

Ports default to 4403 for Meshtastic and 5000 for MeshCore; the protocol defaults
from the port. --serve also serves a built meshmash (npm run build: dist/) at
http://127.0.0.1:<port>/.

Config: ${configPath()}`

function fail(msg: string): never {
  console.error(`meshmash-bridge: ${msg}`)
  process.exit(1)
}

function describe(c: BridgeConfig) {
  if (!c.radios.length) console.log('No radios. Add one: meshmash-bridge add <name> <host>[:port]')
  for (const r of c.radios) console.log(`  ${r.name}  ${r.host}:${r.port}  ${r.protocol}`)
}

function pairingLink(c: BridgeConfig): string | null {
  if (c.port === 4404 && !c.token) return null
  const p = new URLSearchParams({ bridge: `127.0.0.1:${c.port}` })
  if (c.token) p.set('token', c.token)
  return `${PAGE}#${p}`
}

async function run(args: string[]) {
  const path = configPath()
  const config = (() => {
    try {
      return loadConfig(path)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  })()
  const edit = (change: (c: BridgeConfig) => void) => {
    change(config)
    try {
      saveConfig(path, validConfig(config))
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
    }
  }
  const [cmd, ...rest] = args
  const flags = new Set(rest.filter((a) => a.startsWith('--')))
  const words = rest.filter((a) => !a.startsWith('--'))

  switch (cmd) {
    case 'add': {
      const [name, target] = words
      if (!name || !target) fail('usage: add <name> <host>[:port] [--meshtastic | --meshcore]')
      const t = parseTarget(target)
      const protocol = flags.has('--meshtastic') ? 'meshtastic' : flags.has('--meshcore') ? 'meshcore' : undefined
      let radio
      try {
        radio = validRadio({ name, host: t.host, port: t.port, protocol })
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e))
      }
      edit((c) => (c.radios = [...c.radios.filter((r) => r.name.toLowerCase() !== name.toLowerCase()), radio]))
      console.log(`Added ${radio.name}: ${radio.host}:${radio.port} (${radio.protocol})`)
      return
    }
    case 'remove': {
      const [name] = words
      if (!config.radios.some((r) => r.name === name)) fail(`no radio named "${name}"`)
      edit((c) => (c.radios = c.radios.filter((r) => r.name !== name)))
      console.log(`Removed ${name}`)
      return
    }
    case 'list':
      describe(config)
      console.log(`Pages allowed: ${config.origins.join(', ') || 'none'} and the bridge's own`)
      console.log(`Token: ${config.token ? 'required' : 'off'}`)
      return
    case 'origin': {
      const [op, origin] = words
      if ((op !== 'add' && op !== 'remove') || !origin) fail('usage: origin add|remove <origin>')
      edit((c) => (c.origins = op === 'add' ? [...new Set([...c.origins, origin])] : c.origins.filter((o) => o !== origin)))
      console.log(`Pages allowed: ${config.origins.join(', ')}`)
      return
    }
    case 'token': {
      const [op] = words
      if (op !== 'on' && op !== 'off') fail('usage: token on|off')
      edit((c) => (c.token = op === 'on' ? (c.token ?? newToken()) : undefined))
      const link = pairingLink(config)
      console.log(op === 'on' ? `Token required. Pair the page by opening:\n  ${link}` : 'Token off')
      return
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE)
      return
    case undefined:
    case '--serve':
      break
    default:
      fail(`unknown command "${cmd}". See meshmash-bridge --help`)
  }

  const i = args.indexOf('--serve')
  const serveDir = i >= 0 ? args[i + 1] : undefined
  if (i >= 0 && !serveDir) fail('--serve needs a directory')
  const time = () => new Date().toTimeString().slice(0, 8)
  const bridge = await startBridge({ config, version, serveDir, log: (l) => console.log(`${time()} ${l}`) }).catch((e: Error) =>
    fail((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `port ${config.port} is in use (another bridge running?)` : e.message),
  )
  console.log(`meshmash-bridge ${version} on 127.0.0.1:${bridge.port}`)
  console.log(`Config: ${path}`)
  describe(config)
  const link = pairingLink(config)
  if (link) console.log(`Pair the page by opening:\n  ${link}`)
  else console.log(`Open ${PAGE} and choose a network radio.`)
  if (serveDir) console.log(`Or open http://127.0.0.1:${bridge.port}/`)
  const stop = () => void bridge.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

void run(process.argv.slice(2))
