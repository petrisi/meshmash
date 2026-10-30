// Delivery state of an outgoing message, and when it may be sent again.
import { REPEAT_OK } from './capabilities'
import type { Message, Protocol } from './types'

export type DeliveryState = 'queued' | 'unknown' | 'waiting' | 'counting' | 'ok' | 'weak' | 'none' | 'delivered' | 'failed' | 'direct'

/** One state per message; DM recipient ACK outranks repeat counting. */
export function deliveryState(m: Message, protocol: Protocol | null | undefined): DeliveryState {
  const repeats = m.repeats ?? 0
  // Meshtastic reports only that someone relayed (implicit ACK), not how many.
  const counts = protocol !== 'meshtastic'
  if (m.status === 'failed') return 'failed'
  if (m.status === 'pending') return m.settled ? 'unknown' : 'queued'
  if (m.thread.startsWith('dm:') && m.status === 'acked') return 'delivered'
  // Hop limit 0: no relay and no ACK to wait for.
  if (m.hopLimit === 0) return 'direct'
  if (repeats >= REPEAT_OK && (m.settled || !counts)) return 'ok'
  if (!m.settled) return repeats ? 'counting' : 'waiting'
  return repeats ? 'weak' : 'none'
}

/**
 * A DM can be sent again once its outcome is in and the recipient has not acknowledged it:
 * failed, unknown, or only an implicit ACK (a rebroadcast) heard. Hop limit 0 asks for no ACK.
 */
export function canResend(m: Message, selfId: string): boolean {
  return m.from === selfId && m.thread.startsWith('dm:') && !!m.settled && m.status !== 'acked' && m.hopLimit !== 0
}
