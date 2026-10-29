// Node list filters.
import { describe, expect, it } from 'vitest'
import { nodeFilters } from '../src/lib/model/filters'
import type { MeshNode } from '../src/lib/model/types'

describe('Ignored filter', () => {
  it('Meshtastic only, when asked for', () => {
    expect(nodeFilters('meshtastic').some((f) => f.id === 'ignored')).toBe(false)
    expect(nodeFilters('meshcore', true).some((f) => f.id === 'ignored')).toBe(false)
    const f = nodeFilters('meshtastic', true).find((x) => x.id === 'ignored')!
    expect(f.label).toBe('Ignored')
    expect(f.test({ ignored: true } as MeshNode)).toBe(true)
    expect(f.test({} as MeshNode)).toBe(false)
  })
})
