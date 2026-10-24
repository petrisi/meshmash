import type {
  Capabilities,
  Channel,
  MeshNode,
  Message,
  Protocol,
  RadioInfo,
  ThreadKey,
  TracerouteResult,
} from '../model/types'

export type LogDir = 'rx' | 'tx' | 'text' | 'info' | 'error'

export interface LogEntry {
  ts: number
  dir: LogDir
  /** Short type name, e.g. "FromRadio.node_info" or "RESP_CODE_CONTACT". */
  kind: string
  summary: string
  bytes?: Uint8Array
}

/** Callbacks a protocol client uses to publish what it learns. */
export interface RadioSink {
  info(info: RadioInfo, caps?: Partial<Capabilities>): void
  progress(text: string): void
  /** Insert or merge by id. */
  node(patch: Partial<MeshNode> & { id: string }): void
  removeNode(id: string): void
  channels(list: Channel[]): void
  message(m: Message): void
  updateMessage(id: string, patch: Partial<Message>): void
  /** A packet from nodeId was heard, optionally on a channel index. */
  heard(nodeId: string, ts: number, channel?: number): void
  traceroute(r: TracerouteResult): void
  log(e: Omit<LogEntry, 'ts'>): void
  /** Initial download complete; UI can show the radio. */
  ready(): void
  closed(reason?: string): void
}

export interface Probe {
  /** Meshtastic want_config nonce sent during detection. */
  nonce: number
  /** Raw bytes received since the first probe. */
  received: Uint8Array[]
}

export interface RadioClient {
  readonly protocol: Protocol
  /**
   * Runs the connect handshake and initial download. `probe` is what detection already
   * requested and received, so a slow radio is not asked twice.
   */
  start(probe?: Probe): Promise<void>
  close(): Promise<void>
  /** localId is the id the UI already gave the pending message. */
  sendText(thread: ThreadKey, text: string, localId: string): Promise<void>
  action(action: string, nodeId: string): Promise<void>
}
