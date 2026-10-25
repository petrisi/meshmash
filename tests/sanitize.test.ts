import { describe, expect, it } from 'vitest'
import { LeReader, utf8Encode } from '../src/lib/protocol/bytes'
import { MeshCoreClient, rxSecret, txSecret } from '../src/lib/protocol/meshcore/client'
import { Resp, TxtType } from '../src/lib/protocol/meshcore/codec'
import { cmdLogin, cmdSendCli } from '../src/lib/protocol/meshcore/remote'
import { fields } from '../src/lib/protocol/protobuf'
import { cleanText, redactCli } from '../src/lib/sanitize'
import type { Transport } from '../src/lib/transport/types'
import { bytes, mcIn, recordingSink } from './helpers'

describe('cleanText', () => {
  it('removes bidi overrides, isolates and controls', () => {
    expect(cleanText('ab‮cd⁦e\u0007f‏')).toBe('abcdef')
  })
  it('turns tabs and newlines into spaces unless multiline', () => {
    expect(cleanText('a\nb\tc')).toBe('a b c')
    expect(cleanText('a\nb\tc', true)).toBe('a\nb\tc')
  })
  it('keeps emoji sequences', () => {
    expect(cleanText('👩‍💻 ok')).toBe('👩‍💻 ok')
  })
})

describe('redactCli', () => {
  const line = (dir: 'out' | 'in', text: string) => ({ ts: 0, dir, text })
  it('hides password values, replies and the reply to a password query', () => {
    const out = redactCli([
      line('out', 'password hunter2'),
      line('in', 'password now: hunter2'),
      line('out', 'get guest.password'),
      line('in', '> s3cret'),
      line('out', 'set guest.password abc def'),
      line('out', 'ver'),
      line('in', 'v1.17.1'),
    ]).map((l) => l.text)
    expect(out).toEqual([
      'password ••••',
      '••••',
      'get guest.password',
      '••••',
      'set guest.password ••••',
      'ver',
      'v1.17.1',
    ])
    expect(out.join()).not.toMatch(/hunter2|s3cret|abc/)
  })
})

describe('length checks', () => {
  it('rejects a negative protobuf length instead of rewinding', () => {
    // Field 2, length -11: would point back at its own key forever.
    const b = Uint8Array.of(0x12, 0xf5, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01)
    expect(() => [...fields(b)]).toThrow(RangeError)
  })
  it('rejects negative byte counts', () => {
    expect(() => new LeReader(bytes(4)).bytes(-1)).toThrow(RangeError)
  })
})

describe('MeshCore log redaction', () => {
  const pk = bytes(32, 7)
  it('keeps login passwords and CLI text out of logged tx bytes', () => {
    expect(txSecret(cmdLogin(pk, 'hunter2'))).toHaveLength(33)
    expect(txSecret(cmdSendCli(pk, 'password hunter2'))).toHaveLength(13)
  })

  it('logs CLI replies without their text', () => {
    const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write: async () => {} }
    const rec = recordingSink()
    new MeshCoreClient(t as unknown as Transport, rec.sink)
    const reply = Uint8Array.of(Resp.CONTACT_MSG_RECV_V3, 40, 0, 0, ...pk.subarray(0, 6), 0, TxtType.CLI_DATA, 1, 2, 3, 4, ...utf8Encode('password now: hunter2'))
    expect(rxSecret(reply)).toHaveLength(16)
    t.onData(mcIn(reply))
    const logged = rec.logs.find((l) => l.dir === 'rx')!
    expect(logged.summary).not.toMatch(/hunter2/)
    expect(new TextDecoder().decode(logged.bytes)).not.toMatch(/hunter2/)
  })
})
