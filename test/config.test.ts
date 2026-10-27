import { describe, expect, test } from "bun:test"

import { resolveOptions } from "../src/config"

describe("resolveOptions", () => {
  test("applies defaults", () => {
    const options = resolveOptions({})
    expect(options.interval).toBe(60_000)
    expect(options.host).toBe("github.com")
    expect(options.ignoreAuthors).toEqual(["self"])
    expect(options.hint).toBe(true)
    expect(Object.keys(options.actions)).toContain("explain-and-act")
  })

  test("overrides a built-in action by name", () => {
    const options = resolveOptions({ actions: { "just-explain": { type: "prompt", prompt: "only translate" } } })
    expect(options.actions["just-explain"]?.prompt).toBe("only translate")
    expect(options.actions["explain-and-act"]?.prompt).toContain("Translate")
  })

  test("appends a custom action", () => {
    const options = resolveOptions({ actions: { "translate-only": { type: "prompt", prompt: "translate {{url}}" } } })
    expect(options.actions["translate-only"]?.prompt).toBe("translate {{url}}")
  })

  test("keeps the default action and accepts an override", () => {
    expect(resolveOptions({}).defaultAction).toBe("explain-and-reply")
    expect(resolveOptions({ defaultAction: "just-explain" }).defaultAction).toBe("just-explain")
    expect(
      resolveOptions({
        defaultAction: "translate-only",
        actions: { "translate-only": { type: "prompt", prompt: "translate" } },
      }).defaultAction,
    ).toBe("translate-only")
  })

  test("rejects a default action that does not exist", () => {
    expect(() => resolveOptions({ defaultAction: "nope" })).toThrow(/not a configured action/)
  })

  test("rejects an unknown action type", () => {
    expect(() => resolveOptions({ actions: { custom: { type: "command", prompt: "x" } } })).toThrow(/only type "prompt"/)
  })

  test("rejects a too-small interval", () => {
    expect(() => resolveOptions({ interval: 1_000 })).toThrow(/interval/)
  })
})
