import { describe, expect, test } from "bun:test"

import plugin from "../src/index"
import { harness } from "./helpers"

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })

const stubGitHub = () => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.endsWith("/user")) return json({ login: "me" })
    return json([])
  }) as unknown as typeof fetch
}

describe("plugin", () => {
  test("registers the notify tools and round-trips a registration", async () => {
    stubGitHub()
    const h = harness({ token: "test-token" })
    const cleanup = await plugin.setup(h.ctx)

    expect([...h.tools.keys()]).toEqual(["register", "list", "cancel"])

    const register = h.tools.get("register")
    const listed = h.tools.get("list")
    const cancel = h.tools.get("cancel")
    if (!register || !listed || !cancel) throw new Error("tools missing")

    const created = await register.execute(
      { target: "https://github.com/acme/app/pull/7", action: "just-explain" },
      { sessionID: "ses_1" },
    )
    expect(created.content).toContain("Watching pr acme/app#7")

    expect((await listed.execute({}, { sessionID: "ses_1" })).content).toContain("acme/app#7")
    expect((await listed.execute({}, { sessionID: "ses_2" })).content).toContain("No GitHub threads")

    const id = /id (\w+)/.exec(created.content)?.[1]
    expect(id).toBeDefined()
    expect((await cancel.execute({ id: id ?? "" }, { sessionID: "ses_1" })).content).toContain("Stopped watching")
    expect([...h.store.keys()]).toHaveLength(0)

    await cleanup?.()
  })

  test("uses the configured preference when action is omitted", async () => {
    stubGitHub()
    const h = harness({ token: "test-token", defaultAction: "explain-and-act" })
    const cleanup = await plugin.setup(h.ctx)
    const register = h.tools.get("register")
    if (!register) throw new Error("tools missing")

    expect(register.description).toContain("The user's preferred action is `explain-and-act`")
    expect(register.input.properties.action.default).toBe("explain-and-act")
    expect(register.input.properties.action.description).toContain("omit this field")

    const created = await register.execute({ target: "https://github.com/acme/app/pull/7" }, { sessionID: "ses_1" })
    expect(created.content).toContain("action=explain-and-act")

    await cleanup?.()
  })

  test("rejects an unknown action", async () => {
    stubGitHub()
    const h = harness({ token: "test-token" })
    const cleanup = await plugin.setup(h.ctx)
    const register = h.tools.get("register")
    if (!register) throw new Error("tools missing")

    await expect(
      register.execute({ target: "https://github.com/acme/app/pull/7", action: "nope" }, { sessionID: "ses_1" }),
    ).rejects.toThrow(/unknown action/)

    await cleanup?.()
  })
})
