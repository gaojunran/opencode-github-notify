/**
 * Minimal GitHub API stand-in for the end-to-end check.
 *
 *   bun e2e/mock-github.ts            # starts on :8787
 *   curl -X POST localhost:8787/__comment -d '{"body":"please fix","author":"review-bot"}'
 *   curl localhost:8787/__state
 */
const comments: Record<string, unknown>[] = []
let sequence = 0

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })

const server = Bun.serve({
  port: 8787,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/user") return json({ login: "me" })

    if (url.pathname === "/__comment" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { body?: string; author?: string }
      sequence += 1
      const comment = {
        id: sequence,
        body: body.body ?? "a new reply",
        user: { login: body.author ?? "review-bot" },
        html_url: `https://github.com/acme/app/pull/7#issuecomment-${sequence}`,
        created_at: new Date().toISOString(),
      }
      comments.push(comment)
      console.log(`[mock] comment ${comment.id} from ${comment.user.login}`)
      return json({ ok: true, id: comment.id })
    }

    if (url.pathname === "/__state") return json({ comments })

    if (url.pathname.startsWith("/repos/acme/app/issues/7/comments")) return json(comments)
    if (url.pathname.startsWith("/repos/acme/app/pulls/7/comments")) return json([])
    if (url.pathname.startsWith("/repos/acme/app/pulls/7/reviews")) return json([])

    return json([])
  },
})

console.log(`[mock] listening on http://127.0.0.1:${server.port}`)
