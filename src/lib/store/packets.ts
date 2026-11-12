// Collects Analytics packet records for the connected radio: buffered writes, retention, and
// the span of time the radio has been connected.
import { type CoverageSpan, type PacketRecord, PACKETS_CAP, RETENTION_MS } from '../model/analytics'
import { addPackets, pruneCoverage, prunePackets, saveCoverage } from './db'

export interface PacketBackend {
  add(radio: string, recs: PacketRecord[]): Promise<void>
  coverage(radio: string, span: CoverageSpan): Promise<void>
  prune(radio: string, before: number, cap: number): Promise<void>
}

export const idbBackend: PacketBackend = {
  add: addPackets,
  coverage: saveCoverage,
  prune: async (radio, before, cap) => {
    await prunePackets(radio, before, cap)
    await pruneCoverage(radio, before)
  },
}

export const FLUSH_MS = 5_000
const PRUNE_MS = 86_400_000

export class PacketRecorder {
  private radio: string | null = null
  private buffer: PacketRecord[] = []
  private span: CoverageSpan | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private backend: PacketBackend = idbBackend,
    private clock: () => number = Date.now,
  ) {}

  /** The span of the current connection, up to now. */
  get current(): CoverageSpan | null {
    return this.span && { start: this.span.start, end: this.clock() }
  }

  /** Records arriving before start (during the initial download) are kept for that radio. */
  add(r: PacketRecord) {
    this.buffer.push(r)
  }

  start(radio: string) {
    this.stopTimers()
    this.radio = radio
    const now = this.clock()
    this.span = { start: now, end: now }
    void this.prune()
    void this.flush()
    this.timers.push(
      setInterval(() => void this.flush(), FLUSH_MS),
      setInterval(() => void this.prune(), PRUNE_MS),
    )
  }

  /** Writes what is buffered and ends the coverage span. The recorder is free at once. */
  stop(): Promise<void> {
    this.stopTimers()
    const written = this.flush()
    this.radio = null
    this.span = null
    this.buffer = []
    return written
  }

  flush(): Promise<void> {
    const radio = this.radio
    if (!radio) return this.writing
    const recs = this.buffer
    this.buffer = []
    if (this.span) this.span.end = this.clock()
    const span = this.span && { ...this.span }
    this.writing = this.writing
      .then(async () => {
        if (recs.length) await this.backend.add(radio, recs)
        if (span) await this.backend.coverage(radio, span)
      })
      .catch(() => {})
    return this.writing
  }

  private prune() {
    const radio = this.radio
    if (!radio) return
    this.writing = this.writing.then(() => this.backend.prune(radio, this.clock() - RETENTION_MS, PACKETS_CAP)).catch(() => {})
  }

  private stopTimers() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }
}
