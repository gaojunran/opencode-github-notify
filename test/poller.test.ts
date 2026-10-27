import { describe, expect, test } from "bun:test"

import { resolveOptions } from "../src/config"
import type { Note } from "../src/github"
import { createPoller } from "../src/poller"
import { parseTarget } from "../src/target"
import { harness } from "./helpers"

const target = parseTarget("https://github.com/acme/app/pull/7")
const client = { host: "github.com", token: "t", api: "https://api.github.com", graphql: "https://api.github.com/graphql" }

const stubUser = (login: string) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ login }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

const note = (id: string, author: string, body: string, createdAt = "2026-01-01T00:00:00Z"): Note => ({
  id,
  kind: "comment",
  author,
  body,
  url: `https://github.com/acme/app/pull/7#${id}`,
  createdAt,
  summary: "",
})

const setup = (notes: Note[], raw: Record<string, unknown> = {}) => {
  stubUser("me")
  const h = harness(raw)
  const options = resolveOptions(raw)
  const poller = createPoller({
    ctx: h.ctx,
    options,
    fetchNotes: async () => notes,
    resolveClient: async () => client,
  })
  return { h, poller }
}

describe("poller", () => {
  test("records history on the first poll without delivering", async () => {
    const notes = [note("comment:1", "alice", "an old comment")]
    const { h, poller } = setup(notes)

    const registration = await poller.add({
      sessionID: "ses_1",
      target,
      filter: "note",
      action: "explain-and-reply",
      interval: 15_000,
    })

    expect(h.prompts).toHaveLength(0)
    expect(registration.baseline).toBe(false)
    expect(registration.seen).toEqual(["comment:1"])
    poller.stop()
  })

  test("delivers a new reply once, as a queued prompt", async () => {
    const notes = [note("comment:1", "alice", "old")]
    const { h, poller } = setup(notes)
    const registration = await poller.add({
      sessionID: "ses_1",
      target,
      filter: "note",
      action: "explain-and-reply",
      interval: 15_000,
    })

    notes.push(note("comment:2", "review-bot", "please fix the null check"))
    registration.lastPollAt = 0
    await poller.tick()

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.sessionID).toBe("ses_1")
    expect(h.prompts[0]?.delivery).toBe("queue")
    expect(h.prompts[0]?.text).toContain("please fix the null check")
    expect(h.prompts[0]?.text).toContain("--- action: explain-and-reply ---")

    registration.lastPollAt = 0
    await poller.tick()
    expect(h.prompts).toHaveLength(1)
    poller.stop()
  })

  test("ignores the authenticated login so replies do not loop", async () => {
    const notes = [note("comment:1", "alice", "old")]
    const { h, poller } = setup(notes)
    const registration = await poller.add({
      sessionID: "ses_1",
      target,
      filter: "note",
      action: "explain-and-reply",
      interval: 15_000,
    })

    notes.push(note("comment:2", "me", "my own reply"))
    registration.lastPollAt = 0
    await poller.tick()

    expect(h.prompts).toHaveLength(0)
    poller.stop()
  })

  test("never replays an event older than the cursor", async () => {
    const notes = [note("comment:1", "alice", "old")]
    const { h, poller } = setup(notes)
    const registration = await poller.add({
      sessionID: "ses_1",
      target,
      filter: "note",
      action: "just-explain",
      interval: 15_000,
    })

    notes.push(note("comment:0", "alice", "ancient", "2025-12-31T00:00:00Z"))
    registration.lastPollAt = 0
    await poller.tick()

    expect(h.prompts).toHaveLength(0)
    poller.stop()
  })

  test("remove stops watching and is scoped to the owning session", async () => {
    const { h, poller } = setup([])
    const registration = await poller.add({
      sessionID: "ses_1",
      target,
      filter: "note",
      action: "just-explain",
      interval: 15_000,
    })

    expect(await poller.remove(registration.id, "ses_2")).toBe(false)
    expect(await poller.remove(registration.id, "ses_1")).toBe(true)
    expect(poller.list("ses_1")).toHaveLength(0)
    expect(h.store.size).toBe(0)
    poller.stop()
  })
})
