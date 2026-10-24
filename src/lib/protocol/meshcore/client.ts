import { initials } from '../../format'
import { REPEAT_WINDOW_MS } from '../../model/capabilities'
import type { Channel, MeshNode, NodeKind, RadioInfo, ThreadKey } from '../../model/types'
import type { SerialTransport } from '../../transport/serial'
import { endsWith, hex, LeReader, utf8Encode } from '../bytes'
import type { RadioClient, RadioSink } from '../types'
import {
  cmdBinaryReq,
  cmdLogin,
  cmdSendCli,
  cmdStatusReq,
  cmdTelemetryReq,
  cmdTracePath,
  decodeBinaryResponse,
  decodeLoginSuccess,
  decodeLpp,
  decodeNeighbours,
  decodeStatus,
  decodeTraceData,
  NEIGHBOURS_PER_PAGE,
  neighboursReq,
  pushPrefix,
  ReqType,
} from './remote'
import {
  cmdAdvert,
  cmdAppStart,
  cmdDeviceQuery,
  cmdGetBattery,
  cmdGetChannel,
  cmdGetContactByKey,
  cmdGetContacts,
  cmdGetTime,
  cmdSetTime,
  cmdName,
  cmdPathDiscovery,
  cmdRemoveContact,
  cmdResetPath,
  cmdSendChannelText,
  cmdSendText,
  cmdShareContact,
  cmdSyncNext,
  codeName,
  type Contact,
  ContactType,
  decodeChannelInfo,
  decodeChannelMsg,
  decodeContact,
  decodeContactMsg,
  decodeDeviceInfo,
  decodePath,
  decodePathDiscovery,
  decodeRxLog,
  decodeSelfInfo,
  decodeSent,
  OUT_PATH_FLOOD,
  groupTextCiphertext,
  PayloadType,
  type DeviceInfo,
  encodeFrame,
  ERR_NAMES,
  FrameDecoder,
  PAYLOAD_TYPES,
  pathHops,
  Push,
  type RecvMessage,
  Resp,
  type SelfInfo,
  TxtType,
} from './codec'

const KIND: Record<number, NodeKind> = {
  [ContactType.CHAT]: 'chat',
  [ContactType.REPEATER]: 'repeater',
  [ContactType.ROOM]: 'room',
  [ContactType.SENSOR]: 'sensor',
}

/** Node ids are the first 6 bytes of the public key, as used in message frames. */
const idOf = (pk: Uint8Array) => hex(pk.subarray(0, 6))

/** Handles response frames for one command; returns true when the response is complete. */
type Collector = (frame: Uint8Array) => boolean

interface Request {
  name: string
  collect: Collector
  resolve: () => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class CommandError extends Error {}

export class MeshCoreClient implements RadioClient {
  readonly protocol = 'meshcore' as const

  private decoder = new FrameDecoder()
  private queue: Request[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private device: DeviceInfo | null = null
  private self: SelfInfo | null = null
  private contacts = new Map<string, Contact>()
  /** Radio clock minus our clock, ms. MeshCore radios often have no RTC source. */
  private clockOffset = 0
  private syncing = false
  private ready = false
  private acks = new Map<number, { localId: string; timer: ReturnType<typeof setTimeout> }>()
  private discoveries = new Set<string>()
  private secrets = new Map<number, Uint8Array>()
  /**
   * The radio matches only one outstanding remote request (login, status, telemetry, binary,
   * path discovery); a new one replaces the old. Requests therefore run one at a time.
   */
  private remoteChain: Promise<unknown> = Promise.resolve()
  private remoteWait: { codes: number[]; match: (f: Uint8Array) => boolean; done: (f: Uint8Array) => void } | null = null
  /** Our recent channel messages, matched against overheard repeats. */
  private echoes: { ct: Uint8Array; localId: string; count: number }[] = []

  constructor(
    private t: SerialTransport,
    private sink: RadioSink,
  ) {
    t.onData = (c) => this.onData(c)
  }

  // Transport and request plumbing

  private onData(chunk: Uint8Array) {
    for (const item of this.decoder.push(chunk)) {
      if (item.type === 'junk') {
        const text = new TextDecoder().decode(item.bytes).trim()
        if (text) this.sink.log({ dir: 'text', kind: 'console', summary: text, bytes: item.bytes })
        continue
      }
      const f = item.payload
      this.sink.log({ dir: 'rx', kind: codeName(f[0]), summary: this.describe(f), bytes: f })
      try {
        if (f[0] >= 0x80) this.onPush(f)
        else this.onResponse(f)
      } catch (e) {
        this.sink.log({ dir: 'error', kind: codeName(f[0]), summary: String(e) })
      }
    }
  }

  private onResponse(f: Uint8Array) {
    const req = this.queue[0]
    if (!req) {
      this.sink.log({ dir: 'info', kind: codeName(f[0]), summary: 'unsolicited response' })
      return
    }
    if (f[0] === Resp.ERR) {
      this.finish(req, new CommandError(`${req.name}: ${ERR_NAMES[f[1]] ?? `error ${f[1]}`}`))
    } else if (req.collect(f)) {
      this.finish(req)
    }
  }

  private finish(req: Request, err?: Error) {
    clearTimeout(req.timer)
    this.queue.shift()
    if (err) req.reject(err)
    else req.resolve()
  }

  /** Sends one command and waits until its collector reports completion. Serialized. */
  private request(payload: Uint8Array, collect: Collector, timeoutMs = 5000): Promise<void> {
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const name = cmdName(payload[0])
        const req: Request = {
          name,
          collect,
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = this.queue.indexOf(req)
            if (i >= 0) this.queue.splice(i, 1)
            reject(new Error(`${name}: no response`))
          }, timeoutMs),
        }
        this.queue.push(req)
        this.sink.log({ dir: 'tx', kind: name, summary: '', bytes: payload })
        this.t.write(encodeFrame(payload)).catch((e) => this.finish(req, e))
      })
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => {})
    return p
  }

  /** Request whose single response frame must have the given code. */
  private async expect(payload: Uint8Array, code: number, timeoutMs?: number): Promise<Uint8Array> {
    let got: Uint8Array | undefined
    await this.request(
      payload,
      (f) => {
        if (f[0] !== code) throw new Error(`expected ${codeName(code)}, got ${codeName(f[0])}`)
        got = f
        return true
      },
      timeoutMs,
    )
    return got!
  }

  // Handshake

  async start() {
    this.sink.progress('Querying device…')
    this.device = decodeDeviceInfo(await this.expect(cmdDeviceQuery(), Resp.DEVICE_INFO))
    this.self = decodeSelfInfo(await this.expect(cmdAppStart('meshmash'), Resp.SELF_INFO))

    const t = await this.expect(cmdGetTime(), Resp.CURR_TIME)
    this.clockOffset = new LeReader(t.subarray(1)).u32() * 1000 - Date.now()
    if (Math.abs(this.clockOffset) > 60_000)
      this.sink.log({ dir: 'info', kind: 'clock', summary: `radio clock off by ${Math.round(this.clockOffset / 1000)} s` })
    // Firmware only accepts forward adjustments.
    if (this.clockOffset < -5_000) {
      try {
        await this.expect(cmdSetTime(Math.floor(Date.now() / 1000)), Resp.OK)
        this.clockOffset = 0
        this.sink.log({ dir: 'info', kind: 'clock', summary: 'radio clock set' })
      } catch (e) {
        this.sink.log({ dir: 'info', kind: 'clock', summary: `clock set failed: ${(e as Error).message}` })
      }
    }

    let millivolts = 0
    try {
      millivolts = new LeReader((await this.expect(cmdGetBattery(), Resp.BATT_AND_STORAGE)).subarray(1)).u16()
    } catch {
      /* older firmware */
    }

    this.sink.progress('Loading contacts…')
    await this.loadContacts()

    this.sink.progress('Loading channels…')
    const channels = await this.loadChannels()

    const s = this.self
    const info: RadioInfo = {
      protocol: 'meshcore',
      firmware: this.device.firmware ?? `ver ${this.device.verCode}`,
      hwModel: this.device.manufacturer ?? 'unknown',
      nodeId: idOf(s.publicKey),
      longName: s.name,
      shortName: initials(s.name),
      radio: { freqMHz: s.freqMHz, bwKHz: s.bwKHz, sf: s.sf, cr: s.cr, txPowerDbm: s.txPower },
      voltage: millivolts ? millivolts / 1000 : undefined,
      position: s.lat || s.lon ? { lat: s.lat, lon: s.lon } : undefined,
    }
    // Channel text is sent as "<name>: <text>" within 160 bytes.
    this.sink.info(info, {
      maxChannels: this.device.maxChannels ?? 8,
      messageMaxBytes: 160 - utf8Encode(s.name).length - 2,
    })
    this.sink.node({
      id: info.nodeId,
      longName: s.name,
      shortName: info.shortName,
      kind: 'chat',
      hwModel: info.hwModel,
      publicKey: hex(s.publicKey),
      hops: 0,
      position: info.position,
      voltage: info.voltage,
    })
    for (const c of this.contacts.values()) this.sink.node(this.toNode(c))
    this.sink.channels(channels)
    this.ready = true
    this.sink.ready()
    void this.syncMessages()
  }

  private async loadContacts() {
    await this.request(
      cmdGetContacts(),
      (f) => {
        if (f[0] === Resp.CONTACTS_START) return false
        if (f[0] === Resp.CONTACT) {
          const c = decodeContact(f)
          this.contacts.set(idOf(c.publicKey), c)
          if (this.contacts.size % 25 === 0) this.sink.progress(`Loading contacts… ${this.contacts.size}`)
          return false
        }
        if (f[0] === Resp.END_OF_CONTACTS) return true
        throw new Error(`unexpected ${codeName(f[0])} in contact list`)
      },
      30_000,
    )
  }

  private async loadChannels(): Promise<Channel[]> {
    const out: Channel[] = []
    const max = this.device?.maxChannels ?? 8
    for (let i = 0; i < max; i++) {
      try {
        const c = decodeChannelInfo(await this.expect(cmdGetChannel(i), Resp.CHANNEL_INFO))
        if (!c.name) continue
        this.secrets.set(c.index, c.secret)
        out.push({
          index: c.index,
          name: c.name,
          kind: c.index === 0 && c.name === 'Public' ? 'public' : c.name.startsWith('#') ? 'hashtag' : 'private',
          encryption: c.name.startsWith('#') ? 'hashtag key' : c.index === 0 ? 'public key' : 'AES-128',
        })
      } catch (e) {
        if (e instanceof CommandError) break
        throw e
      }
    }
    return out
  }

  async close() {
    for (const a of this.acks.values()) clearTimeout(a.timer)
    for (const r of this.queue) clearTimeout(r.timer)
    this.queue = []
  }

  // Mapping

  private radioTime(secs: number) {
    return secs * 1000 - this.clockOffset
  }

  private toNode(c: Contact): MeshNode {
    const path = decodePath(c.outPathLen, c.outPath)
    return {
      id: idOf(c.publicKey),
      longName: c.name || idOf(c.publicKey),
      shortName: initials(c.name || '?'),
      kind: KIND[c.type] ?? 'chat',
      publicKey: hex(c.publicKey),
      lastHeard: c.lastMod ? Math.min(this.radioTime(c.lastMod), Date.now()) : undefined,
      hops: pathHops(c.outPathLen),
      path,
      position: c.lat || c.lon ? { lat: c.lat, lon: c.lon } : undefined,
      favorite: (c.flags & 1) !== 0,
    }
  }

  /** Resolves path hop hashes to node ids where a repeater's key starts with the hash. */
  private byKeyPrefix(prefixHex: string): { publicKey: Uint8Array } | undefined {
    if (this.self && hex(this.self.publicKey).startsWith(prefixHex)) return this.self
    for (const c of this.contacts.values()) if (hex(c.publicKey).startsWith(prefixHex)) return c
    return undefined
  }

  private resolveHops(hops: string[] | undefined): string[] {
    return (hops ?? []).map((h) => {
      let match: Contact | undefined
      for (const c of this.contacts.values())
        if (hex(c.publicKey).startsWith(h) && (!match || c.type === ContactType.REPEATER)) match = c
      return match ? idOf(match.publicKey) : h
    })
  }

  private describe(f: Uint8Array): string {
    try {
      switch (f[0]) {
        case Resp.DEVICE_INFO: {
          const d = decodeDeviceInfo(f)
          return `ver ${d.verCode} fw ${d.firmware} ${d.manufacturer} built ${d.buildDate} channels ${d.maxChannels}`
        }
        case Resp.SELF_INFO: {
          const s = decodeSelfInfo(f)
          return `${s.name} ${hex(s.publicKey, 6)} ${s.freqMHz} MHz BW ${s.bwKHz} SF${s.sf} CR${s.cr} ${s.txPower} dBm`
        }
        case Resp.CONTACT:
        case Push.NEW_ADVERT: {
          const c = decodeContact(f)
          return `${c.name} type ${c.type} path ${c.outPathLen === 0xff ? 'flood' : c.outPathLen & 63}`
        }
        case Resp.CHANNEL_INFO: {
          const c = decodeChannelInfo(f)
          return `#${c.index} ${c.name || '(empty)'}`
        }
        case Resp.CONTACT_MSG_RECV_V3:
        case Resp.CONTACT_MSG_RECV: {
          const m = decodeContactMsg(f)
          return `${hex(m.senderPrefix!)}: ${m.text}`
        }
        case Resp.CHANNEL_MSG_RECV_V3:
        case Resp.CHANNEL_MSG_RECV: {
          const m = decodeChannelMsg(f)
          return `ch${m.channel}: ${m.text}`
        }
        case Push.LOG_RX_DATA: {
          const r = decodeRxLog(f)
          return `${PAYLOAD_TYPES[r.payloadType] ?? r.payloadType} snr ${r.snr} rssi ${r.rssi} ${r.raw.length} B`
        }
        case Push.ADVERT:
        case Push.PATH_UPDATED:
          return this.contacts.get(hex(f.subarray(1, 7)))?.name ?? hex(f.subarray(1, 7))
        case Resp.ERR:
          return ERR_NAMES[f[1]] ?? `error ${f[1]}`
      }
    } catch {
      /* fall through to raw summary */
    }
    return `${f.length} B`
  }

  // Pushes

  private onPush(f: Uint8Array) {
    switch (f[0]) {
      case Push.MSG_WAITING:
        void this.syncMessages()
        return
      case Push.NEW_ADVERT: {
        const c = decodeContact(f)
        this.contacts.set(idOf(c.publicKey), c)
        this.sink.node({ ...this.toNode(c), lastHeard: Date.now() })
        this.sink.heard(idOf(c.publicKey), Date.now())
        return
      }
      case Push.ADVERT:
      case Push.PATH_UPDATED: {
        const id = hex(f.subarray(1, 7))
        this.sink.heard(id, Date.now())
        this.sink.node({ id, lastHeard: Date.now() })
        void this.refreshContact(f.subarray(1, 33))
        return
      }
      case Push.LOG_RX_DATA: {
        const r = decodeRxLog(f)
        if (r.payloadType !== PayloadType.GRP_TXT) return
        for (const e of this.echoes) {
          if (!endsWith(r.raw, e.ct)) continue
          e.count++
          this.sink.updateMessage(e.localId, { repeats: e.count })
        }
        return
      }
      case Push.LOGIN_SUCCESS:
      case Push.LOGIN_FAIL:
      case Push.STATUS_RESPONSE:
      case Push.TELEMETRY_RESPONSE:
      case Push.BINARY_RESPONSE:
      case Push.TRACE_DATA: {
        const w = this.remoteWait
        if (w && w.codes.includes(f[0]) && w.match(f)) w.done(f)
        return
      }
      case Push.SEND_CONFIRMED: {
        const r = new LeReader(f.subarray(1))
        const ack = r.u32()
        const rtt = r.u32()
        const pend = this.acks.get(ack)
        if (pend) {
          clearTimeout(pend.timer)
          this.acks.delete(ack)
          this.sink.updateMessage(pend.localId, { status: 'acked', settled: true })
          this.sink.log({ dir: 'info', kind: 'ack', summary: `delivered, round trip ${rtt} ms` })
        }
        return
      }
      case Push.PATH_DISCOVERY_RESPONSE: {
        const d = decodePathDiscovery(f)
        const id = hex(d.prefix)
        if (!this.discoveries.delete(id)) return
        const self = this.self ? idOf(this.self.publicKey) : ''
        this.sink.traceroute({
          nodeId: id,
          ts: Date.now(),
          towards: [self, ...this.resolveHops(d.out), id],
          snrTowards: [],
          back: d.in ? [id, ...this.resolveHops(d.in), self] : undefined,
        })
        return
      }
      case Push.CONTACT_DELETED:
        this.contacts.delete(hex(f.subarray(1, 7)))
        this.sink.removeNode(hex(f.subarray(1, 7)))
        return
    }
  }

  private async refreshContact(pk: Uint8Array) {
    try {
      const c = decodeContact(await this.expect(cmdGetContactByKey(pk), Resp.CONTACT))
      this.contacts.set(idOf(c.publicKey), c)
      this.sink.node({ ...this.toNode(c), lastHeard: Date.now() })
    } catch {
      /* contact not stored (e.g. manual add mode) */
    }
  }

  /** Drains the radio's offline message queue. */
  private async syncMessages() {
    if (this.syncing) return
    this.syncing = true
    try {
      // A reply is occasionally lost on the USB link; a lost "no more messages" is
      // harmless to retry, so retry a few times before giving up.
      for (let misses = 0; ; ) {
        let frame: Uint8Array | undefined
        try {
          await this.request(
            cmdSyncNext(),
            (f) => {
              frame = f
              return true
            },
            2000,
          )
        } catch (e) {
          if (e instanceof CommandError || ++misses > 2) throw e
          continue
        }
        misses = 0
        if (!frame || frame[0] === Resp.NO_MORE_MESSAGES) break
        this.onMessageFrame(frame)
      }
    } catch (e) {
      this.sink.log({ dir: 'error', kind: 'sync', summary: String(e) })
    } finally {
      this.syncing = false
    }
  }

  private onMessageFrame(f: Uint8Array) {
    const isChannel = f[0] === Resp.CHANNEL_MSG_RECV_V3 || f[0] === Resp.CHANNEL_MSG_RECV
    const isDm = f[0] === Resp.CONTACT_MSG_RECV_V3 || f[0] === Resp.CONTACT_MSG_RECV
    if (!isChannel && !isDm) return
    const m: RecvMessage = isChannel ? decodeChannelMsg(f) : decodeContactMsg(f)
    if (m.txtType === TxtType.CLI_DATA) {
      if (m.senderPrefix) this.sink.cliLine(hex(m.senderPrefix), 'in', m.text)
      return
    }
    const now = Date.now()
    // Sender clocks are unreliable; never place a message in the future.
    const ts = Math.min(m.senderTs * 1000, now)
    // 0xFF here means the message came by a direct route, so the hop count is not known.
    const hops = pathHops(m.pathLen)

    if (isChannel) {
      const sep = m.text.indexOf(': ')
      const name = sep > 0 ? m.text.slice(0, sep) : ''
      const text = sep > 0 ? m.text.slice(sep + 2) : m.text
      const contact = name ? [...this.contacts.values()].find((c) => c.name === name) : undefined
      const from = contact ? idOf(contact.publicKey) : `name:${name || '?'}`
      if (contact) this.sink.heard(from, now, m.channel)
      this.sink.message({
        id: `mc-ch${m.channel}-${m.senderTs}-${name}`,
        thread: `ch:${m.channel!}`,
        from,
        fromName: name || undefined,
        text,
        ts,
        status: 'received',
        hops,
        snr: m.snr,
      })
    } else {
      const from = hex(m.senderPrefix!)
      this.sink.heard(from, now)
      // A room server relays posts from its members: the thread is the room, the sender the author.
      const author = m.author ? this.byKeyPrefix(m.author) : undefined
      this.sink.message({
        id: `mc-dm-${from}-${m.senderTs}${m.author ? `-${m.author}` : ''}`,
        thread: `dm:${from}`,
        from: author ? idOf(author.publicKey) : (m.author ?? from),
        fromName: m.author && !author ? m.author : undefined,
        text: m.text,
        ts,
        status: 'received',
        hops,
        snr: m.snr,
      })
    }
  }

  // Outgoing

  async sendText(thread: ThreadKey, text: string, localId: string) {
    const ts = Math.floor((Date.now() + this.clockOffset) / 1000)
    if (thread.startsWith('ch:')) {
      const index = Number(thread.slice(3))
      const secret = this.secrets.get(index)
      const echo = secret && { ct: await groupTextCiphertext(secret, ts, this.self?.name ?? '', text), localId, count: 0 }
      if (echo) this.echoes.push(echo)
      await this.expect(cmdSendChannelText(index, text, ts), Resp.OK)
      this.sink.updateMessage(localId, { status: 'sent' })
      setTimeout(() => {
        if (echo) this.echoes = this.echoes.filter((e) => e !== echo)
        this.sink.updateMessage(localId, { settled: true })
      }, REPEAT_WINDOW_MS)
      return
    }
    const c = this.contacts.get(thread.slice(3))
    if (!c) throw new Error('unknown contact')
    const sent = decodeSent(await this.expect(cmdSendText(c.publicKey, text, ts), Resp.SENT))
    this.sink.updateMessage(localId, { status: 'sent' })
    const timer = setTimeout(
      () => {
        this.acks.delete(sent.tag)
        this.sink.updateMessage(localId, { status: 'failed', settled: true })
      },
      Math.max(sent.timeoutMs * 2, REPEAT_WINDOW_MS),
    )
    this.acks.set(sent.tag, { localId, timer })
  }

  async action(action: string, id: string) {
    const c = this.contacts.get(id)
    switch (action) {
      case 'advert-zero':
      case 'advert-flood':
        await this.expect(cmdAdvert(action === 'advert-flood'), Resp.OK)
        this.sink.log({ dir: 'info', kind: 'advert', summary: action === 'advert-flood' ? 'flood advert sent' : 'zero-hop advert sent' })
        return
    }
    if (!c) return
    switch (action) {
      case 'reset-path':
        await this.expect(cmdResetPath(c.publicKey), Resp.OK)
        c.outPathLen = 0xff
        this.sink.node({ id, path: undefined, hops: undefined })
        return
      case 'path-discovery':
        decodeSent(await this.expect(cmdPathDiscovery(c.publicKey), Resp.SENT))
        this.discoveries.add(id)
        return
      case 'req-status':
        return this.status(id, c)
      case 'req-telemetry':
        return this.telemetry(id, c)
      case 'req-neighbours':
        return this.neighbours(id, c)
      case 'req-owner':
        return this.owner(id, c)
      case 'trace':
        return this.trace(id, c)
      case 'share':
        await this.expect(cmdShareContact(c.publicKey), Resp.OK)
        return
      case 'remove':
        await this.expect(cmdRemoveContact(c.publicKey), Resp.OK)
        this.contacts.delete(id)
        this.sink.removeNode(id)
        return
      default:
        this.sink.log({ dir: 'info', kind: 'action', summary: `${action}: not implemented yet` })
    }
  }

  // Remote requests

  /**
   * Sends a request that the radio answers with RESP_SENT, then waits for a matching push.
   * Resolves null on timeout; a wrong password, for one, gets no answer at all.
   */
  private remote(
    cmd: Uint8Array,
    codes: number[],
    match: (f: Uint8Array, tag: number) => boolean,
  ): Promise<Uint8Array | null> {
    const run = async () => {
      const sent = decodeSent(await this.expect(cmd, Resp.SENT))
      const timeout = Math.min(Math.max(sent.timeoutMs + 5_000, 10_000), 60_000)
      return new Promise<Uint8Array | null>((resolve) => {
        const timer = setTimeout(() => {
          this.remoteWait = null
          resolve(null)
        }, timeout)
        this.remoteWait = {
          codes,
          match: (f) => match(f, sent.tag),
          done: (f) => {
            clearTimeout(timer)
            this.remoteWait = null
            resolve(f)
          },
        }
      })
    }
    const p = this.remoteChain.then(run)
    this.remoteChain = p.catch(() => {})
    return p
  }

  async login(id: string, password: string) {
    const c = this.contact(id)
    const f = await this.remote(cmdLogin(c.publicKey, password), [Push.LOGIN_SUCCESS, Push.LOGIN_FAIL], (f) => pushPrefix(f) === id)
    if (!f) return this.sink.actionResult(id, 'login', false, 'No answer: wrong password, or out of reach')
    if (f[0] === Push.LOGIN_FAIL) return this.sink.actionResult(id, 'login', false, 'Login rejected')
    const r = decodeLoginSuccess(f)
    this.sink.remote(id, { login: { role: r.role, ts: Date.now() } })
    this.sink.actionResult(id, 'login', true, `Logged in as ${r.role}`)
  }

  async cli(id: string, text: string) {
    const c = this.contact(id)
    await this.expect(cmdSendCli(c.publicKey, text), Resp.SENT)
    this.sink.cliLine(id, 'out', text)
  }

  private contact(id: string): Contact {
    const c = this.contacts.get(id)
    if (!c) throw new Error('unknown contact')
    return c
  }

  private async status(id: string, c: Contact) {
    const f = await this.remote(cmdStatusReq(c.publicKey), [Push.STATUS_RESPONSE], (f) => pushPrefix(f) === id)
    if (!f) return this.sink.actionResult(id, 'req-status', false, 'No answer (log in first?)')
    const fields = decodeStatus(f, c.type === ContactType.ROOM)
    this.sink.remote(id, { status: { ts: Date.now(), fields } })
    this.sink.actionResult(id, 'req-status', true, 'Status received')
  }

  private async telemetry(id: string, c: Contact) {
    const f = await this.remote(cmdTelemetryReq(c.publicKey), [Push.TELEMETRY_RESPONSE], (f) => pushPrefix(f) === id)
    if (!f) {
      const hint = c.type === ContactType.CHAT ? 'not shared, or out of reach' : 'log in first?'
      return this.sink.actionResult(id, 'req-telemetry', false, `No answer (${hint})`)
    }
    const readings = decodeLpp(f.subarray(8))
    this.sink.remote(id, { telemetry: { ts: Date.now(), readings } })
    const volts = readings.find((r) => r.channel === 1 && r.type === 116)
    if (volts) this.sink.node({ id, voltage: parseFloat(volts.value) })
    this.sink.actionResult(id, 'req-telemetry', true, `${readings.length} reading${readings.length === 1 ? '' : 's'}`)
  }

  private async binary(c: Contact, data: Uint8Array) {
    const f = await this.remote(cmdBinaryReq(c.publicKey, data), [Push.BINARY_RESPONSE], (f, tag) => decodeBinaryResponse(f).tag === tag)
    return f && decodeBinaryResponse(f).body
  }

  private async neighbours(id: string, c: Contact) {
    const list: { id: string; heardSecsAgo: number; snr: number }[] = []
    let total = 0
    do {
      const body = await this.binary(c, neighboursReq(list.length))
      if (!body) {
        if (!list.length) return this.sink.actionResult(id, 'req-neighbours', false, 'No answer (log in first?)')
        break
      }
      const page = decodeNeighbours(body)
      total = page.total
      for (const n of page.list) list.push({ id: this.resolveHops([n.prefix])[0], heardSecsAgo: n.heardSecsAgo, snr: n.snr })
      if (page.list.length < NEIGHBOURS_PER_PAGE) break
    } while (list.length < total && list.length < 100)
    this.sink.remote(id, { neighbours: { ts: Date.now(), total, list } })
    this.sink.actionResult(id, 'req-neighbours', true, `${total} neighbour${total === 1 ? '' : 's'}`)
  }

  private async owner(id: string, c: Contact) {
    const body = await this.binary(c, Uint8Array.of(ReqType.GET_OWNER_INFO))
    if (!body) return this.sink.actionResult(id, 'req-owner', false, 'No answer (log in first?)')
    const text = new TextDecoder().decode(body).replace(/\0+$/, '')
    this.sink.remote(id, { owner: { ts: Date.now(), text } })
    this.sink.actionResult(id, 'req-owner', true, 'Owner info received')
  }

  /** Trace out along the stored path to the node and back, recording SNR per hop. */
  private async trace(id: string, c: Contact) {
    if (c.outPathLen === OUT_PATH_FLOOD) throw new Error('No known path; use Find path first')
    const path = decodePath(c.outPathLen, c.outPath) ?? []
    // Trace hashes are 1 byte per hop here; path hashes may be longer.
    const first = path.map((h) => parseInt(h.slice(0, 2), 16))
    const hashes = Uint8Array.from([...first, c.publicKey[0], ...[...first].reverse()])
    const tag = crypto.getRandomValues(new Uint32Array(1))[0]
    const f = await this.remote(cmdTracePath(tag, hashes), [Push.TRACE_DATA], (f) => decodeTraceData(f).tag === tag)
    if (!f) return this.sink.actionResult(id, 'trace', false, 'No answer')
    const t = decodeTraceData(f)
    const self = this.self ? idOf(this.self.publicKey) : ''
    const via = this.resolveHops(path)
    const out = path.length + 1
    this.sink.traceroute({
      nodeId: id,
      ts: Date.now(),
      towards: [self, ...via, id],
      snrTowards: t.snrs.slice(0, out),
      back: [id, ...[...via].reverse(), self],
      snrBack: [...t.snrs.slice(out), t.finalSnr],
    })
  }

  get isReady() {
    return this.ready
  }
}
