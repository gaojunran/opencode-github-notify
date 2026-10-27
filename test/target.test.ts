import { describe, expect, test } from "bun:test"

import { parseTarget } from "../src/target"

describe("parseTarget", () => {
  test("parses a pull request URL", () => {
    expect(parseTarget("https://github.com/acme/app/pull/12")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "app",
      number: 12,
      type: "pr",
      url: "https://github.com/acme/app/pull/12",
    })
  })

  test("parses issue and discussion URLs", () => {
    expect(parseTarget("https://github.com/acme/app/issues/3").type).toBe("issue")
    expect(parseTarget("https://github.com/acme/app/discussions/9").type).toBe("discussion")
  })

  test("parses an enterprise host", () => {
    const target = parseTarget("https://ghe.acme.dev/acme/app/pull/4")
    expect(target.host).toBe("ghe.acme.dev")
    expect(target.url).toBe("https://ghe.acme.dev/acme/app/pull/4")
  })

  test("parses the short form when the type is given", () => {
    const target = parseTarget("acme/app#7", "issue")
    expect(target.url).toBe("https://github.com/acme/app/issues/7")
  })

  test("refuses the ambiguous short form", () => {
    expect(() => parseTarget("acme/app#7")).toThrow(/ambiguous/)
  })

  test("refuses garbage", () => {
    expect(() => parseTarget("not a target")).toThrow(/cannot parse/)
  })
})
