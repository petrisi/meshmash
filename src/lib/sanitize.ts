// Text from the radio, much of it set by other nodes, before it reaches the UI and storage.
import type { Message, RemoteData } from './model/types'
import type { RadioSink } from './protocol/types'

/**
 * C0/C1 controls and bidi embedding, override, isolate and mark characters. Bidi controls
 * can reorder or hide text, so a name could imitate another one or spill into nearby text.
 * Tab and newline are handled separately; zero-width joiners stay for emoji sequences.
 */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g

export function cleanText(s: string, multiline = false): string {
  const t = s.replace(CONTROLS, '')
  return multiline ? t : t.replace(/[\t\n]/g, ' ')
}

const clean = <T extends object, K extends keyof T>(o: T, keys: K[], multiline = false): T => {
  const out = { ...o }
  for (const k of keys) if (typeof out[k] === 'string') out[k] = cleanText(out[k] as string, multiline) as T[K]
  return out
}

function cleanRemote(p: Omit<RemoteData, 'cli'>): Omit<RemoteData, 'cli'> {
  return {
    ...p,
    ...(p.owner && { owner: { ...p.owner, text: cleanText(p.owner.text, true) } }),
    ...(p.status && { status: { ...p.status, fields: p.status.fields.map((f) => clean(f, ['label', 'value'])) } }),
  }
}

/** Wraps a sink so every string from the radio is cleaned on the way in. */
export function sanitizeSink(s: RadioSink): RadioSink {
  return {
    ...s,
    info: (i, caps) => s.info(clean(i, ['longName', 'shortName', 'firmware', 'hwModel']), caps),
    node: (p) => s.node(clean(p, ['longName', 'shortName', 'hwModel'])),
    channels: (l) => s.channels(l.map((c) => clean(c, ['name']))),
    message: (m) => s.message(cleanMessage(m)),
    updateMessage: (id, p) => s.updateMessage(id, cleanMessage(p)),
    remote: (id, p) => s.remote(id, cleanRemote(p)),
    cliLine: (id, dir, text) => s.cliLine(id, dir, cleanText(text, true)),
  }
}

function cleanMessage<M extends Partial<Message>>(m: M): M {
  const out = clean(m, ['text'], true)
  return clean(out, ['fromName'])
}

const HIDDEN = '••••'

/**
 * CLI history as stored: values after "password" in commands, "password now: …" replies,
 * and the reply to any command that mentions a password are hidden.
 */
export function redactCli(lines: RemoteData['cli'] = []): NonNullable<RemoteData['cli']> {
  let afterPasswordCmd = false
  return lines.map((l) => {
    let text = l.text
    if (l.dir === 'out') {
      afterPasswordCmd = /password/i.test(text)
      text = text.replace(/(password)\s+\S.*$/i, `$1 ${HIDDEN}`)
    } else {
      if (afterPasswordCmd) text = HIDDEN
      else text = text.replace(/(password[^:]*:\s*).+$/i, `$1${HIDDEN}`)
      afterPasswordCmd = false
    }
    return text === l.text ? l : { ...l, text }
  })
}
