// Per-radio MeshCore flood scope chosen for a channel, kept until changed.
import { scopeName } from '../model/scope'
import type { ThreadKey } from '../model/types'

const key = (radio: string) => `meshmash.floodScopes.${radio}`

/** A region name, or null for unscoped. */
export type ScopeChoice = string | null

function load(radio: string): Record<string, ScopeChoice> {
  try {
    const v = JSON.parse(localStorage.getItem(key(radio)) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** The thread's choice; undefined for the radio default. */
export function loadScope(radio: string, thread: ThreadKey): ScopeChoice | undefined {
  const v = load(radio)[thread]
  if (v === null) return null
  return typeof v === 'string' ? (scopeName(v) ?? undefined) : undefined
}

/** Region names chosen for any of the radio's channels. */
export function scopeNames(radio: string): string[] {
  return [...new Set(Object.values(load(radio)).filter((v): v is string => typeof v === 'string' && scopeName(v) === v))]
}

/** undefined clears the thread's choice (back to the radio default). */
export function saveScope(radio: string, thread: ThreadKey, scope: ScopeChoice | undefined) {
  const all = load(radio)
  if (scope === undefined) delete all[thread]
  else all[thread] = scope
  try {
    localStorage.setItem(key(radio), JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}
