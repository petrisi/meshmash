import { initials } from '../../format'
import { REPEAT_WINDOW_MS } from '../../model/capabilities'
import { sameBytes } from '../../model/channels'
import type { Channel, ChannelConfig, ContactSettings, FoundRoute, MeshNode, NodeKind, RadioInfo, ThreadKey } from '../../model/types'
import type { Transport } from '../../transport/types'
import { endsWith, hex, LeReader, utf8Encode } from '../bytes'
import type { ActionContext, RadioClient, RadioSink } from '../types'
import { type ClockFix, clockFixes, correctRadioSecs, recordClockFix } from './clockFix'
import { parseContactLink } from './links'
import {
  cmdBinaryReq,
  cmdLogin,
  cmdSendCli,
  cmdStatusReq,
  cmdTelemetryReq,
  cmdDiscover,
  cmdTracePath,
  decodeBinaryResponse,
  decodeDiscoverReply,
  type DiscoverReply,
  decodeLoginSuccess,
  decodeLpp,
  decodeNeighbours,
  decodeStatus,
  decodeTraceData,
  traceHashes,
  NEIGHBOURS_PER_PAGE,
  neighboursReq,
  pushPrefix,
  ReqType,
} from './remote'
import {
  Cmd,
  cmdAdvert,
  cmdAppStart,
  cmdDeviceQuery,
  cmdGetBattery,
  cmdGetChannel,
  cmdSetChannel,
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
  type ChannelInfo,
  decodeChannelInfo,
  isHashtagChannel,
  decodeChannelMsg,
  decodeContact,
  decodeContactMsg,
  decodeDeviceInfo,
  decodePath,
  encodePath,
  decodePathDiscovery,
  decodeRxLog,
  decodeSelfInfo,
  decodeSent,
  cmdUpdateContact,
  cmdGetAutoAdd,
  cmdSetAutoAdd,
  cmdSetOtherParams,
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

/** Repeaters reply after a random delay of a few seconds. */
const DISCOVER_LISTEN_MS = 20_000

/**
 * Login passwords and CLI traffic (which can carry passwords) stay out of the protocol log,
 * which users copy into bug reports. Returns the frame header to log instead, or null.
 */
export function txSecret(p: Uint8Array): Uint8Array | null {
  if (p[0] === Cmd.SEND_LOGIN) return p.subarray(0, 33)
  if (p[0] === Cmd.SEND_TXT_MSG && p[1] === TxtType.CLI_DATA) return p.subarray(0, 13)
  return null
}

export function rxSecret(f: Uint8Array): Uint8Array | null {
  const type = f[0] === Resp.CONTACT_MSG_RECV_V3 ? 11 : f[0] === Resp.CONTACT_MSG_RECV ? 8 : -1
  return type >= 0 && f[type] === TxtType.CLI_DATA ? f.subarray(0, type + 5) : null
}

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
  private clockFixes: ClockFix[] = []
  private syncing = false
  private ready = false
  private acks = new Map<number, { localId: string; timer: ReturnType<typeof setTimeout> }>()
  private unsaved = new Map<string, Contact>()
  private discovering: { tag: number; found: Map<string, DiscoverReply> } | null = null
  private secrets = new Map<number, Uint8Array>()
  /** Used channel slots by index. */
  private channelInfos = new Map<number, ChannelInfo>()
  /**
   * The radio matches only one outstanding remote request (login, status, telemetry, binary,
   * path discovery); a new one replaces the old. Requests therefore run one at a time.
   */
  private remoteChain: Promise<unknown> = Promise.resolve()
  private remoteWait: { codes: number[]; match: (f: Uint8Array) => boolean; done: (f: Uint8Array) => void } | null = null
  /** Our recent channel messages, matched against overheard repeats. */
  private echoes: { ct: Uint8Array; localId: string; count: number }[] = []

  constructor(
    private t: Transport,
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
      const hidden = rxSecret(f)
      this.sink.log({ dir: 'rx', kind: codeName(f[0]), summary: hidden ? 'CLI reply, contents not logged' : this.describe(f), bytes: hidden ?? f })
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
        const hidden = txSecret(payload)
        this.sink.log({ dir: 'tx', kind: name, summary: hidden ? 'contents not logged' : '', bytes: hidden ?? payload })
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
    this.clockFixes = clockFixes(idOf(this.self.publicKey))

    const t = await this.expect(cmdGetTime(), Resp.CURR_TIME)
    this.clockOffset = new LeReader(t.subarray(1)).u32() * 1000 - Date.now()
    if (Math.abs(this.clockOffset) > 60_000)
      this.sink.log({ dir: 'info', kind: 'clock', summary: `radio clock off by ${Math.round(this.clockOffset / 1000)} s` })
    // Firmware only accepts forward adjustments.
    if (this.clockOffset < -5_000) {
      try {
        const now = Math.floor(Date.now() / 1000)
        await this.expect(cmdSetTime(now), Resp.OK)
        recordClockFix(idOf(this.self.publicKey), { at: now, skew: Math.round(-this.clockOffset / 1000) })
        this.clockFixes = clockFixes(idOf(this.self.publicKey))
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
    const max = this.device?.maxChannels ?? 8
    for (let i = 0; i < max; i++) {
      try {
        this.keepChannel(decodeChannelInfo(await this.expect(cmdGetChannel(i), Resp.CHANNEL_INFO)))
      } catch (e) {
        if (e instanceof CommandError) break
        throw e
      }
    }
    return this.channelList()
  }

  private keepChannel(c: ChannelInfo) {
    if (c.name) {
      this.channelInfos.set(c.index, c)
      this.secrets.set(c.index, c.secret)
    } else {
      this.channelInfos.delete(c.index)
      this.secrets.delete(c.index)
    }
  }

  private async channelList(): Promise<Channel[]> {
    const out: Channel[] = []
    for (const c of [...this.channelInfos.values()].sort((a, b) => a.index - b.index)) {
      const hashtag = await isHashtagChannel(c.name, c.secret)
      out.push({
        index: c.index,
        name: c.name,
        kind: c.index === 0 && c.name === 'Public' ? 'public' : hashtag ? 'hashtag' : 'private',
        encryption: hashtag ? 'hashtag key' : c.index === 0 ? 'public key' : 'AES-128',
      })
    }
    return out
  }

  channelConfig(index: number): ChannelConfig | undefined {
    const c = this.channelInfos.get(index)
    return c && { index, name: c.name, key: c.secret }
  }

  /** An empty name marks a free slot; the firmware skips those when matching channel traffic. */
  async deleteChannel(index: number) {
    await this.expect(cmdSetChannel(index, '', new Uint8Array(16)), Resp.OK)
    const got = decodeChannelInfo(await this.expect(cmdGetChannel(index), Resp.CHANNEL_INFO))
    this.keepChannel(got)
    this.sink.channels(await this.channelList())
    if (got.name) throw new Error('The radio did not delete the channel')
  }

  async setChannel(c: ChannelConfig, _isNew: boolean) {
    await this.expect(cmdSetChannel(c.index, c.name, c.key), Resp.OK)
    const got = decodeChannelInfo(await this.expect(cmdGetChannel(c.index), Resp.CHANNEL_INFO))
    this.keepChannel(got)
    this.sink.channels(await this.channelList())
    if (got.name !== c.name || !sameBytes(got.secret, c.key)) throw new Error('The radio did not keep the change')
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
      lastHeard: this.lastHeard(c),
      hops: pathHops(c.outPathLen),
      path,
      position: c.lat || c.lon ? { lat: c.lat, lon: c.lon } : undefined,
      favorite: (c.flags & 1) !== 0,
    }
  }

  /**
   * lastMod is stamped by our radio's clock, which may have been wrong when it was stored
   * (no RTC). The advert's own timestamp comes from the sender's clock; take the later of the
   * two, never in the future.
   */
  private lastHeard(c: Contact): number | undefined {
    const mod = c.lastMod ? this.radioTime(correctRadioSecs(c.lastMod, this.clockFixes)) : 0
    const advert = c.lastAdvert * 1000
    const t = Math.max(mod, advert <= Date.now() + 60_000 ? advert : 0)
    return t ? Math.min(t, Date.now()) : undefined
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
        // Heard but not added to the radio's contacts; kept so it can be added.
        const c = decodeContact(f)
        const id = idOf(c.publicKey)
        if (this.contacts.has(id)) return
        this.unsaved.set(id, c)
        this.sink.node({ ...this.toNode(c), lastHeard: Date.now(), unsaved: true })
        this.sink.heard(id, Date.now())
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
      case Push.PATH_DISCOVERY_RESPONSE:
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
      case Push.CONTROL_DATA: {
        const d = decodeDiscoverReply(f)
        if (d && this.discovering?.tag === d.tag) {
          this.discovering.found.set(hex(d.publicKey.subarray(0, 6)), d)
          this.publishDiscovery()
        }
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

  async action(action: string, id: string, ctx?: ActionContext) {
    const c = this.contacts.get(id)
    switch (action) {
      case 'discover':
        return this.discoverNearby(id)
      case 'add-contact': {
        const c = this.unsaved.get(id)
        if (!c) throw new Error('Not an unsaved node')
        await this.saveContact(c)
        this.sink.actionResult(id, action, true, 'Added to contacts')
        return
      }
      case 'advert-zero':
      case 'advert-flood':
        await this.expect(cmdAdvert(action === 'advert-flood'), Resp.OK)
        this.sink.actionResult(id, action, true, action === 'advert-flood' ? 'Flood advert sent' : 'Zero-hop advert sent')
        return
    }
    if (!c) return
    switch (action) {
      case 'reset-path':
        await this.expect(cmdResetPath(c.publicKey), Resp.OK)
        c.outPathLen = 0xff
        this.sink.node({ id, path: undefined, hops: undefined })
        this.sink.actionResult(id, action, true, 'Path cleared; the next message floods')
        return
      case 'path-discovery':
        return this.discoverPath(id, c)
      case 'use-path': {
        if (!ctx?.route) throw new Error('No discovered path')
        const { outLen, outBytes } = encodePath(ctx.route.out)
        const updated = { ...c, outPathLen: outLen, outPath: outBytes }
        await this.expect(cmdUpdateContact(updated), Resp.OK)
        this.contacts.set(id, updated)
        this.sink.node({ id, path: decodePath(outLen, outBytes), hops: pathHops(outLen) })
        this.sink.actionResult(id, action, true, 'Path saved')
        return
      }
      case 'req-status':
        return this.status(id, c)
      case 'req-telemetry':
        return this.telemetry(id, c)
      case 'req-neighbours':
        return this.neighbours(id, c)
      case 'req-owner':
        return this.owner(id, c)
      case 'trace':
        return this.trace(id, c, ctx?.route)
      case 'share':
        try {
          await this.expect(cmdShareContact(c.publicKey), Resp.OK)
        } catch (e) {
          // The radio re-sends the advert it stored; it has none for contacts added from a
          // link, and reports that (or no free packet buffer) as "table full".
          if (e instanceof CommandError) throw new Error('No advert from this node stored on the radio yet, or the radio is busy')
          throw e
        }
        this.sink.actionResult(id, action, true, 'Advert re-sent to radios in direct range')
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

  private async saveContact(c: Contact) {
    const id = idOf(c.publicKey)
    await this.expect(cmdUpdateContact({ ...c, lastMod: c.lastMod || Math.floor((Date.now() + this.clockOffset) / 1000) }), Resp.OK)
    this.unsaved.delete(id)
    this.contacts.set(id, c)
    this.sink.node({ ...this.toNode(c), unsaved: false })
  }

  async importContact(link: string): Promise<string> {
    const l = parseContactLink(link)
    if (!l) throw new Error('Not a meshcore://contact/add link')
    const pk = Uint8Array.from(l.publicKey.match(/../g)!.map((h) => parseInt(h, 16)))
    const id = idOf(pk)
    const existing = this.contacts.get(id)
    if (existing) return id
    await this.saveContact({
      publicKey: pk,
      type: l.type,
      flags: 0,
      outPathLen: OUT_PATH_FLOOD,
      outPath: new Uint8Array(),
      name: l.name,
      lastAdvert: 0,
      lat: 0,
      lon: 0,
      lastMod: 0,
    })
    return id
  }

  async getContactSettings(): Promise<ContactSettings> {
    const f = await this.expect(cmdGetAutoAdd(), Resp.AUTOADD_CONFIG)
    const mask = f[1] ?? 0
    return {
      manual: (this.self?.manualAddContacts ?? 0) & 1 ? true : false,
      overwriteOldest: !!(mask & 0x01),
      chat: !!(mask & 0x02),
      repeater: !!(mask & 0x04),
      room: !!(mask & 0x08),
      sensor: !!(mask & 0x10),
      maxHops: f[2] ?? 0,
    }
  }

  async setContactSettings(s: ContactSettings) {
    const self = this.self
    if (!self) throw new Error('not connected')
    const mask = (s.overwriteOldest ? 1 : 0) | (s.chat ? 2 : 0) | (s.repeater ? 4 : 0) | (s.room ? 8 : 0) | (s.sensor ? 0x10 : 0)
    await this.expect(cmdSetAutoAdd(mask, Math.max(0, Math.min(64, s.maxHops))), Resp.OK)
    const manual = s.manual ? 1 : 0
    if (manual !== (self.manualAddContacts & 1)) {
      await this.expect(cmdSetOtherParams(manual, self.telemetryModes, self.advertLocPolicy, self.multiAcks), Resp.OK)
      self.manualAddContacts = manual
    }
  }

  /** Asks nodes in direct range to identify themselves; repeaters answer after a random delay. */
  private async discoverNearby(selfId: string) {
    const tag = crypto.getRandomValues(new Uint32Array(1))[0]
    this.discovering = { tag, found: new Map() }
    await this.expect(cmdDiscover(tag), Resp.OK)
    this.publishDiscovery()
    await new Promise((r) => setTimeout(r, DISCOVER_LISTEN_MS))
    const n = this.discovering.found.size
    this.discovering = null
    this.sink.actionResult(selfId, 'discover', true, `${n} node${n === 1 ? '' : 's'} in direct range`)
  }

  /** Shows replies as they arrive; repeaters answer at random times. */
  private publishDiscovery() {
    if (!this.discovering || !this.self) return
    const list = [...this.discovering.found.entries()]
      .map(([id, d]) => ({ id, heardSecsAgo: 0, snr: d.snr, snrThere: d.snrThere }))
      .sort((a, b) => b.snr - a.snr)
    this.sink.remote(idOf(this.self.publicKey), { neighbours: { ts: Date.now(), total: list.length, list } })
  }

  /**
   * Floods a request whose answer carries the route both ways. The radio does not store the
   * route it finds; "Use this path" writes it to the contact.
   */
  private async discoverPath(id: string, c: Contact) {
    const f = await this.remote(cmdPathDiscovery(c.publicKey), [Push.PATH_DISCOVERY_RESPONSE], (f) => pushPrefix(f) === id)
    if (!f) {
      const hint = c.type === ContactType.CHAT ? 'telemetry not shared, or out of reach' : 'log in first?'
      return this.sink.actionResult(id, 'path-discovery', false, `No answer (${hint})`)
    }
    const d = decodePathDiscovery(f)
    const self = this.self ? idOf(this.self.publicKey) : ''
    this.sink.traceroute({
      nodeId: id,
      ts: Date.now(),
      towards: [self, ...this.resolveHops(d.out), id],
      snrTowards: [],
      back: d.in ? [id, ...this.resolveHops(d.in), self] : undefined,
      discovered: true,
      found: { out: d.out ?? [], back: d.in },
    })
  }

  /**
   * Trace out to the node and back, recording SNR per hop. Follows the latest path discovery
   * result; without one, the stored path out and its reverse back.
   */
  private async trace(id: string, c: Contact, found?: FoundRoute) {
    const stored = decodePath(c.outPathLen, c.outPath)
    const via = found ? 'found' : stored ? 'stored' : 'direct'
    // Without any path, try it as a direct neighbour; a trace needs no login.
    const out = found?.out ?? stored ?? []
    const back = found?.back ?? [...out].reverse()
    const { hashes, pathSz, size } = traceHashes(out, c.publicKey, back)
    const tag = crypto.getRandomValues(new Uint32Array(1))[0]
    const f = await this.remote(cmdTracePath(tag, hashes, pathSz), [Push.TRACE_DATA], (f) => decodeTraceData(f).tag === tag)
    if (!f) {
      const text =
        via === 'direct' ? 'No answer as a direct neighbour (no stored or found path)' : `No answer along the ${via} path`
      const room = c.type === ContactType.ROOM ? '; rooms pass a trace on only with repeat on' : ''
      return this.sink.actionResult(id, 'trace', false, text + room)
    }
    const t = decodeTraceData(f)
    const self = this.self ? idOf(this.self.publicKey) : ''
    this.sink.traceroute({
      nodeId: id,
      ts: Date.now(),
      towards: [self, ...this.resolveHops(out), id],
      snrTowards: t.snrs.slice(0, out.length + 1),
      back: [id, ...this.resolveHops(back), self],
      snrBack: [...t.snrs.slice(out.length + 1), t.finalSnr],
      traced: { via, foundTs: found?.ts, hashBytes: size },
    })
  }

  get isReady() {
    return this.ready
  }
}
