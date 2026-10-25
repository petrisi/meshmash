/** A byte stream to a radio: Web Serial, or a WebSocket through meshmash-bridge. */
export interface Transport {
  /** Shown in the status bar, e.g. "USB 2886:0059" or "WiFi Vuores". */
  readonly label: string
  onData: (chunk: Uint8Array) => void
  onClose: (reason?: string) => void
  /** Set when the link ended for a reason reconnecting cannot fix (e.g. taken over). */
  readonly final?: boolean
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}
