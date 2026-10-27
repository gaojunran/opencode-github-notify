import { describe, expect, test } from "bun:test"

import { resolveOptions } from "../src/config"
import { installHooks } from "../src/hooks"
import { harness } from "./helpers"

const event = (command: string, result: string) => ({
  before: { id: "call-1", tool: "bash", sessionID: "s", agent: "a", messageID: "m", input: { command } },
  after: {
    id: "call-1",
    tool: "bash",
    sessionID: "s",
    agent: "a",
    messageID: "m",
    input: { command },
    status: "completed" as const,
    result: { content: result },
  },
})

describe("installHooks", () => {
  test("suggests notify_register after gh pr create", async () => {
    const h = harness()
    await installHooks(h.ctx, resolveOptions({}))

    const { before, after } = event("gh pr create --title x --body y", "https://github.com/acme/app/pull/42\n")
    await h.fire("execute.before", before)
    await h.fire("execute.after", after)

    expect(String(after.result.content)).toContain("notify_register")
    expect(String(after.result.content)).toContain("https://github.com/acme/app/pull/42")
    expect(String(after.result.content)).toContain("github-notify")
  })

  test("supports the gh --repo form", async () => {
    const h = harness()
    await installHooks(h.ctx, resolveOptions({}))

    const { before, after } = event("gh --repo acme/app issue create", "https://github.com/acme/app/issues/5")
    await h.fire("execute.before", before)
    await h.fire("execute.after", after)

    expect(String(after.result.content)).toContain("notify_register")
  })

  test("leaves unrelated commands alone", async () => {
    const h = harness()
    await installHooks(h.ctx, resolveOptions({}))

    const { before, after } = event("gh pr view 42", "https://github.com/acme/app/pull/42")
    await h.fire("execute.before", before)
    await h.fire("execute.after", after)

    expect(after.result.content).toBe("https://github.com/acme/app/pull/42")
  })

  test("does nothing when hint is disabled", async () => {
    const h = harness()
    await installHooks(h.ctx, resolveOptions({ hint: false }))
    expect(h.hooks.size).toBe(0)
  })
})
