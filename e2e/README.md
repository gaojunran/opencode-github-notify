# End-to-end check

Runs the real plugin inside a real OpenCode server against a mock GitHub API. It
verifies the parts unit tests cannot: that the plugin loads, that the tools are
visible to the model, that a delivered prompt reaches the session, and that the
`gh pr create` hint survives into the model's context.

## Run it

```bash
# 1. mock GitHub on :8787
bun e2e/mock-github.ts &

# 2. a server dedicated to this test, so the poller keeps running between turns
cd e2e && opencode serve --port 4599 &

# 3. let the agent register a watch, then have it run a `gh pr create`-shaped command
cd e2e && opencode run --server http://127.0.0.1:4599 -s ses_e2e --agent build \
  "Call notify_register with target=https://github.com/acme/app/pull/7, filter=note, action=just-explain.
   Then run: echo 'gh pr create --title demo' && echo 'https://github.com/acme/app/pull/7'"

# 4. pretend a reviewer replied
curl -X POST localhost:8787/__comment -d '{"body":"please handle the empty list","author":"review-bot"}'

# 5. wait one interval, then read the transcript
sleep 20
opencode api --server http://127.0.0.1:4599 get /api/session/ses_e2e/context
```

## Expected

- the `register` tool returns `Watching pr acme/app#7 (id ntf_…)` — no history replay
- the shell tool result ends with the `[github-notify] GitHub thread created.` hint
- one new `user` message starting with `[github-notify] pr acme/app#7 - 1 new update(s)`,
  followed by the comment body and the `just-explain` action block
- an assistant message after it: the agent loop resumed on its own

Also worth repeating:

| Check | How | Expected |
|---|---|---|
| Dedupe | wait two more intervals | still one notification |
| Batching | `POST /__comment` twice within one interval | one notification, `2 new update(s)` |
| Self-loop guard | `POST /__comment` with `"author":"me"` | no notification |
| Resume | restart `opencode serve` | `notify_list` still shows `ntf_…`, polling continues |

## Why the shim exists

`.opencode/plugin/github-notify.ts` is a shim, not the published entrypoint. On
opencode 2.1.3 a `plugins` entry that points at a filesystem path is ignored: a
file path logs `configured plugin path must be a directory`, while a directory
path or `file://` path is skipped silently. Only npm package specifiers and the
`<location>/.opencode/plugin/*.ts` glob loader work. The shim injects the options
that config would have supplied (`baseUrl`, `token`, `interval`).
