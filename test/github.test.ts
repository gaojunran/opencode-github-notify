import { describe, expect, test } from "bun:test"

import { fetchNotes, type GitHubClient } from "../src/github"
import { parseTarget } from "../src/target"

const client: GitHubClient = {
  host: "github.com",
  token: "t",
  api: "https://api.github.com",
  graphql: "https://api.github.com/graphql",
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })

const stub = (routes: Record<string, unknown>) => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) return json(body)
    }
    return json([])
  }) as unknown as typeof fetch
}

describe("fetchNotes", () => {
  test("collects issue comments, review comments and reviews for a pull request", async () => {
    stub({
      "/pulls/7/comments": [
        { id: 12, body: "inline nit", user: { login: "bob" }, html_url: "u12", created_at: "2026-01-02T00:00:00Z" },
      ],
      "/pulls/7/reviews": [
        { id: 13, state: "APPROVED", body: "lgtm", user: { login: "carol" }, submitted_at: "2026-01-03T00:00:00Z" },
      ],
      "/issues/7/comments": [
        { id: 11, body: "hello", user: { login: "alice" }, html_url: "u11", created_at: "2026-01-01T00:00:00Z" },
      ],
    })

    const notes = await fetchNotes(client, parseTarget("https://github.com/acme/app/pull/7"), "note")
    expect(notes.map((note) => note.id)).toEqual(["comment:11", "review_comment:12", "review:13"])
    expect(notes[2]?.summary).toBe("review approved")
  })

  test("maps mixed timeline items, including comments embedded in the timeline", async () => {
    stub({
      "/issues/7/timeline": [
        { id: 1, body: "hey", user: { login: "alice" }, html_url: "u1", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, event: "labeled", actor: { login: "bob" }, created_at: "2026-01-02T00:00:00Z", label: { name: "bug" } },
      ],
    })

    const notes = await fetchNotes(client, parseTarget("https://github.com/acme/app/issues/7"), "any")
    expect(notes.map((note) => note.id)).toEqual(["comment:1", "event:2"])
    expect(notes[1]?.summary).toBe('labeled "bug"')
  })

  test("raises a GitHubError on a failed request", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch

    const error = await fetchNotes(client, parseTarget("https://github.com/acme/app/issues/7"), "note").catch(
      (cause) => cause,
    )
    expect(error).toMatchObject({ name: "GitHubError", status: 404 })
  })
})
