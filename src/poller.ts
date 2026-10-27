import type { Plugin } from "@opencode/plugin"

import { renderPrompt } from "./actions"
import type { Filter, Options } from "./config"
import { fetchNotes, GitHubError, resolveClient, type GitHubClient, type Note } from "./github"
import {
  advance,
  deleteRegistration,
  newId,
  saveRegistration,
  type Registration,
} from "./registry"
import { formatTarget, type Target } from "./target"

const SCHEDULER_TICK = 5_000
const BATCH_SIZE = 5
const MAX_FAILURES = 10
const BODY_LIMIT = 1_500

export type Fetcher = (client: GitHubClient, target: Target, filter: Filter) => Promise<Note[]>
type PromptInput = Parameters<Plugin.Context["session"]["prompt"]>[0]

export interface CreateOptions {
  sessionID: string
  target: Target
  filter: Filter
  action: string
  interval: number
}

export interface Poller {
  add(input: CreateOptions): Promise<Registration>
  list(sessionID: string): Registration[]
  remove(id: string, sessionID: string): Promise<boolean>
  hydrate(registrations: Registration[]): void
  start(): void
  stop(): void
  /** Poll every due registration now. The scheduler calls this every 5s. */
  tick(): Promise<void>
}

export interface PollerDeps {
  ctx: Plugin.Context
  options: Options
  fetchNotes?: Fetcher
  resolveClient?: typeof resolveClient
}

const clip = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more characters)` : value

const toTarget = (registration: Registration): Target => ({
  host: new URL(registration.url).host,
  owner: registration.owner,
  repo: registration.repo,
  number: registration.number,
  type: registration.type,
  url: registration.url,
})

export const createPoller = (deps: PollerDeps): Poller => {
  const { ctx, options } = deps
  const fetcher = deps.fetchNotes ?? fetchNotes
  const resolver = deps.resolveClient ?? resolveClient
  const registrations = new Map<string, Registration>()

  let timer: ReturnType<typeof setInterval> | undefined
  let client: GitHubClient | undefined
  let self: string | undefined
  let ticking = false

  const getClient = async (): Promise<GitHubClient> => (client ??= await resolver(options))

  const getSelf = async (): Promise<string | undefined> => {
    if (self !== undefined) return self || undefined
    try {
      const github = await getClient()
      const response = await fetch(`${github.api}/user`, {
        headers: {
          Authorization: `Bearer ${github.token}`,
          Accept: "application/vnd.github+json",
        },
      })
      if (!response.ok) throw new Error(String(response.status))
      const payload = (await response.json()) as { login?: string }
      self = payload.login ?? ""
    } catch (error) {
      console.error("[github-notify] cannot resolve the authenticated login:", error)
      self = ""
    }
    return self || undefined
  }

  const ignoredAuthors = async (): Promise<Set<string>> => {
    const names = new Set<string>()
    for (const value of options.ignoreAuthors) {
      if (value === "self") {
        const login = await getSelf()
        if (login) names.add(login.toLowerCase())
      } else {
        names.add(value.toLowerCase())
      }
    }
    return names
  }

  const render = (registration: Registration, notes: Note[]): string => {
    const def = options.actions[registration.action]
    if (!def) console.error(`[github-notify] action "${registration.action}" is not configured, using a bare summary`)
    const header = `[github-notify] ${registration.type} ${formatTarget(registration)} - ${notes.length} new update(s)`
    const sections = notes.map((note) => {
      const meta = [note.author || "github", note.kind, note.summary].filter(Boolean).join(" · ")
      return [`### ${meta}`, note.url, "", clip(note.body.trim(), BODY_LIMIT)].filter(Boolean).join("\n")
    })
    const instruction = def
      ? renderPrompt(def, {
          url: registration.url,
          target: formatTarget(registration),
          type: registration.type,
          author: notes[0]?.author ?? "",
          kind: notes[0]?.kind ?? "",
        })
      : "Summarize this update for the user and ask what to do."
    return [header, registration.url, "", ...sections, "", `--- action: ${registration.action} ---`, instruction].join("\n")
  }

  const persist = (registration: Registration) => saveRegistration(ctx.storage, registration)

  const pollOne = async (registration: Registration): Promise<void> => {
    const fetched = await fetcher(await getClient(), toTarget(registration), registration.filter)

    // CI is a derived aggregate rather than a timeline event, so it is deduped
    // by signature instead of by timestamp: a finished run is reported once.
    const signals = fetched.filter((note) => note.kind === "ci")
    const signature = signals.map((note) => note.id).sort().join("|")
    const emitSignals = signals.length > 0 && registration.lastCi !== signature
    if (emitSignals) registration.lastCi = signature
    const notes = [...fetched.filter((note) => note.kind !== "ci"), ...(emitSignals ? signals : [])]

    if (registration.baseline) {
      advance(registration, notes.filter((note) => note.kind !== "ci"))
      registration.baseline = false
      registration.failures = 0
      await persist(registration)
      return
    }

    const ignored = await ignoredAuthors()
    const fresh = notes
      .filter(
        (note) =>
          note.kind === "ci" ||
          !registration.cursor ||
          note.createdAt > registration.cursor ||
          (note.createdAt === registration.cursor && !registration.seen.includes(note.id)),
      )
      .filter((note) => !(note.author && ignored.has(note.author.toLowerCase())))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

    if (fresh.length === 0) {
      registration.failures = 0
      await persist(registration)
      return
    }

    const batch = fresh.slice(0, BATCH_SIZE)
    const text = render(registration, batch)
    await ctx.session.prompt({ sessionID: registration.sessionID, text, delivery: "queue" } as unknown as PromptInput)

    advance(
      registration,
      batch.filter((note) => note.kind !== "ci"),
    )
    registration.failures = 0
    await persist(registration)
  }

  const onError = async (registration: Registration, error: unknown): Promise<void> => {
    if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) {
      console.error(`[github-notify] ${registration.url} is gone, dropping the registration`)
      registrations.delete(registration.id)
      await deleteRegistration(ctx.storage, registration)
      return
    }

    registration.failures += 1
    console.error(`[github-notify] poll failed for ${registration.url} (${registration.failures}/${MAX_FAILURES}):`, error)
    if (registration.failures >= MAX_FAILURES) {
      registration.disabled = true
      console.error(`[github-notify] disabling ${registration.url} after ${MAX_FAILURES} consecutive failures`)
    }
    await persist(registration)
  }

  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      for (const registration of [...registrations.values()]) {
        if (registration.disabled) continue
        const now = Date.now()
        if (now - (registration.lastPollAt ?? 0) < registration.interval) continue
        registration.lastPollAt = now
        try {
          await pollOne(registration)
        } catch (error) {
          await onError(registration, error)
        }
      }
    } finally {
      ticking = false
    }
  }

  const add = async (input: CreateOptions): Promise<Registration> => {
    const existing = [...registrations.values()].find(
      (item) =>
        item.sessionID === input.sessionID && item.url === input.target.url && item.filter === input.filter,
    )
    if (existing) {
      existing.action = input.action
      existing.interval = input.interval
      await persist(existing)
      return existing
    }

    const registration: Registration = {
      id: newId(),
      sessionID: input.sessionID,
      type: input.target.type,
      owner: input.target.owner,
      repo: input.target.repo,
      number: input.target.number,
      url: input.target.url,
      filter: input.filter,
      action: input.action,
      interval: input.interval,
      createdAt: Date.now(),
      baseline: true,
      seen: [],
      failures: 0,
    }
    registrations.set(registration.id, registration)
    registration.lastPollAt = Date.now()
    try {
      // The first poll is a baseline. Failing here means the target or the token
      // is wrong, so surface it to the tool call instead of failing silently.
      await pollOne(registration)
    } catch (error) {
      registrations.delete(registration.id)
      await deleteRegistration(ctx.storage, registration)
      throw error
    }
    await persist(registration)
    start()
    return registration
  }

  const start = (): void => {
    if (timer || registrations.size === 0) return
    timer = setInterval(() => void tick().catch((error) => console.error("[github-notify] scheduler:", error)), SCHEDULER_TICK)
  }

  const stop = (): void => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    add,
    list: (sessionID) => [...registrations.values()].filter((item) => item.sessionID === sessionID),
    remove: async (id, sessionID) => {
      const registration = registrations.get(id)
      if (!registration || registration.sessionID !== sessionID) return false
      registrations.delete(id)
      await deleteRegistration(ctx.storage, registration)
      if (registrations.size === 0) stop()
      return true
    },
    hydrate: (restored) => {
      for (const registration of restored) registrations.set(registration.id, registration)
    },
    start,
    stop,
    tick,
  }
}
