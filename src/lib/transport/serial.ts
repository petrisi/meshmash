/** Byte transport over Web Serial. One reader loop delivers chunks to `onData`. */
export class SerialTransport {
  onData: (chunk: Uint8Array) => void = () => {}
  onClose: (reason?: string) => void = () => {}

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private closing = false
  private loop: Promise<void> | null = null

  constructor(readonly port: SerialPort) {}

  get label(): string {
    const i = this.port.getInfo()
    const h = (n?: number) => (n ?? 0).toString(16).padStart(4, '0')
    return i.usbVendorId !== undefined ? `USB ${h(i.usbVendorId)}:${h(i.usbProductId)}` : 'Serial'
  }

  async open(baudRate = 115200) {
    await this.port.open({ baudRate, bufferSize: 64 * 1024 })
    if (this.closing) {
      // close() was called while opening.
      await this.port.close().catch(() => {})
      throw new Error('closed while opening')
    }
    // RTS asserted with DTR released resets ESP32 boards via their auto-reset circuit;
    // DTR asserted is needed by some native-USB (nRF52) boards to send at all.
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: false }).catch(() => {})
    this.writer = this.port.writable!.getWriter()
    this.loop = this.readLoop()
  }

  private async readLoop() {
    let reason: string | undefined
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader()
        try {
          for (;;) {
            const { value, done } = await this.reader.read()
            if (done) break
            if (value?.length) this.onData(value)
          }
        } finally {
          this.reader.releaseLock()
          this.reader = null
        }
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    if (!this.closing) {
      this.closing = true
      await this.release()
      this.onClose(reason ?? 'port closed')
    }
  }

  async write(bytes: Uint8Array) {
    if (!this.writer) throw new Error('port not open')
    await this.writer.write(bytes)
  }

  async close() {
    if (this.closing) return
    this.closing = true
    await this.reader?.cancel().catch(() => {})
    await this.loop // the loop releases its reader lock before the port can close
    await this.release()
    this.onClose()
  }

  private async release() {
    try {
      this.writer?.releaseLock()
    } catch {
      /* already released */
    }
    this.writer = null
    await this.port.close().catch(() => {})
  }
}
