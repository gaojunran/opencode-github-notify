import type { Plugin } from "@opencode/plugin"

import type { Filter, TargetType } from "./config"

export interface Registration {
  id: string
  sessionID: string
  type: TargetType
  owner: string
  repo: string
  number: number
  url: string
  filter: Filter
  action: string
  interval: number
  createdAt: number
  lastPollAt?: number
  /** Newest real event timestamp already accounted for. Keeps a long thread from replaying. */
  cursor?: string
  /** Signature of the last emitted CI aggregate, if any. */
  lastCi?: string
  /** The first poll records history instead of delivering it. */
  baseline: boolean
  seen: string[]
  failures: number
  disabled?: boolean
}

const PREFIX = "registration/"
const SEEN_LIMIT = 100

export const newId = (): string => `ntf_${Math.random().toString(36).slice(2, 10)}`

export const loadRegistrations = async (storage: Plugin.Context["storage"]): Promise<Registration[]> => {
  const registrations: Registration[] = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix: PREFIX, limit: 100, after })
    for (const entry of page.entries) {
      const value = entry.value as unknown as Registration | undefined
      if (value && typeof value.id === "string") registrations.push(value)
    }
    after = page.next
  } while (after)
  return registrations
}

export const saveRegistration = async (
  storage: Plugin.Context["storage"],
  registration: Registration,
): Promise<void> => {
  await storage.set(`${PREFIX}${registration.id}`, registration as never)
}

export const deleteRegistration = async (
  storage: Plugin.Context["storage"],
  registration: Registration,
): Promise<void> => {
  await storage.remove(`${PREFIX}${registration.id}`)
}

/**
 * Moves the cursor to the newest event stamp and remembers only the ids that
 * share it. That is enough to dedupe same-second siblings, and it means an
 * event older than the cursor can never be replayed, however long the thread is.
 */
export const advance = (
  registration: Registration,
  notes: { id: string; createdAt: string }[],
): void => {
  const newest = notes.map((note) => note.createdAt).sort().at(-1)
  if (!newest) return
  const atCursor = notes.filter((note) => note.createdAt === newest).map((note) => note.id)
  if (!registration.cursor || newest > registration.cursor) {
    registration.cursor = newest
    registration.seen = atCursor.slice(-SEEN_LIMIT)
    return
  }
  if (newest === registration.cursor) {
    registration.seen = [...new Set([...registration.seen, ...atCursor])].slice(-SEEN_LIMIT)
  }
}
