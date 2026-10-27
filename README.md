# opencode-github-notify

OpenCode plugin that watches a GitHub pull request, issue or discussion and pushes new activity back into the session that registered it.

The flow is deliberately agent-driven:

1. The agent (or you) calls `notify_register` on a thread.
2. A single scheduler starts polling — nothing runs before the first registration.
3. When something new appears, the plugin sends a **queued prompt** to that same session.
4. The prompt ends with an **action** block that tells the agent how far it may go: explain only, reply, or reply and act.

It also hooks `gh pr create` / `gh issue create` and appends a one-line hint to the command output, so the agent knows it can offer to follow the thread.

## Install

```jsonc
{
  "plugins": [
    {
      "package": "opencode-github-notify",
      "options": {
        "interval": 60000,
        "defaultAction": "just-explain",
        "actions": {
          "just-explain": { "type": "prompt", "prompt": "Only translate and verify. Touch nothing." }
        }
      }
    }
  ]
}
```

A `plugins` entry must name an npm package. On opencode 2.1.3 a filesystem path is
ignored — a file path warns `configured plugin path must be a directory`, while a
directory path or `file://` path is skipped without a word. To run this from a
checkout, drop a shim into `<project>/.opencode/plugin/` (see
[`e2e/.opencode/plugin/github-notify.ts`](e2e/.opencode/plugin/github-notify.ts)).

### Options

| Option | Default | Meaning |
|---|---|---|
| `interval` | `60000` | Scheduler granularity in ms. Minimum `15000`. A registration may override it. |
| `host` | `github.com` | GitHub host. Enterprise hosts get `https://<host>/api/v3` and `/api/graphql`. |
| `baseUrl` | — | Overrides the derived REST base URL (proxies, local test servers). GraphQL is served from `<baseUrl>/graphql`. |
| `token` | — | GitHub token. Falls back to `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token --hostname <host>`. |
| `ignoreAuthors` | `["self"]` | Authors that never wake the session. `"self"` resolves to the authenticated login. |
| `hint` | `true` | Append the `notify_register` suggestion after `gh pr create` / `gh issue create`. |
| `actions` | built-ins | Merge over the built-in action table: same key overrides, new key appends. |
| `defaultAction` | `just-explain` | The user's preferred action. It is injected into the tool description and the `gh pr create` hint, and used whenever the agent omits `action`. Must name a configured action. |

## Tools

### `notify_register`

```jsonc
{
  "target": "https://github.com/acme/app/pull/42",
  "filter": "note",
  "action": "just-explain"
}
```

| Field | Values |
|---|---|
| `target` | A GitHub URL, or `owner/repo#123` (needs `type` because the number is ambiguous) |
| `type` | `pr` \| `issue` \| `discussion` — inferred from a URL |
| `filter` | `note` (comments and reviews) \| `any` (every timeline event) |
| `action` | Omit to use `defaultAction`. Pass a value only when the user explicitly asks for different behaviour |
| `interval` | Per-registration polling interval, in ms |

The first poll is a **baseline**: existing history is recorded as seen and is not replayed into the session. If that first poll fails (bad URL, bad token), the registration is dropped and the tool call throws, so the agent sees the real error.

### `notify_list`

Lists the threads this session is watching.

### `notify_cancel`

Takes `{ "id": "ntf_..." }`. A session can only cancel its own registrations.

## Actions

An action is a prompt fragment appended to every notification for that registration. Three are built in:

The plugin tells the agent which one is preferred: `options.defaultAction` is spelled out in the tool
description and is the schema default, with the instruction to use it unless the user explicitly asks
for something else. So a user-level preference lands in `opencode.jsonc` once, and the agent stops
re-deciding per call.

The default is `just-explain`, and that is deliberate. A watching agent that also replies turns every
notification into a GitHub comment; with a few registrations open, threads fill up with AI-written
acknowledgements that the reviewer never asked for. Silence is the safe default — replying is opt-in
(`explain-and-reply`) or explicit per call.

| Action | What the agent is told to do |
|---|---|
| `just-explain` | Translate, explain, and verify the claim against the code. No `gh` writes, no edits, no commits, no push. |
| `explain-and-reply` | The above, then post exactly one reply in the thread with `gh`. Still no source edits, commits, or pushes — a code change must be approved by the user first. |
| `explain-and-act` | The above, then actually do the work: edit, commit, push, and keep the thread in sync. |

Custom actions are `{ "type": "prompt", "prompt": "..." }` entries under `options.actions`. Using a built-in name overrides it; a new name appends.

Placeholders available in the prompt:

| Placeholder | Value |
|---|---|
| `{{url}}` | Canonical URL of the watched thread |
| `{{target}}` | `owner/repo#123` |
| `{{type}}` | `pr` \| `issue` \| `discussion` |
| `{{author}}` | Author of the first update in the batch |
| `{{kind}}` | `comment` \| `review` \| `event` \| `state` \| `ci` |

Only `type: "prompt"` exists today. The field is part of the schema so other shapes can be added without breaking existing configs.

## What counts as an update

`filter: "note"`

- pull request: conversation comments, inline review comments, reviews
- issue: conversation comments
- discussion: top-level comments and their replies

`filter: "any"` — everything above plus the thread timeline:

- labels, assignees, milestones, rename, close/reopen/merge, review requests
- commits pushed to the head branch, force-pushes, cross-references
- for pull requests only: a CI aggregate note when all check runs on the head commit finish

Updates are deduplicated by a stable event id before delivery. Up to five updates are batched into one message; the rest arrive on the next poll.

## Auth

The plugin needs a token with read access to the repository. Resolution order:

1. `options.token`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `gh auth token --hostname <host>`

If you already use the GitHub CLI, nothing needs configuring.

## Loop protection

An agent that replies through `explain-and-reply` or `explain-and-act` writes to the very thread it is watching. Without a guard, every reply would trigger the next notification forever.

`ignoreAuthors` defaults to `["self"]`, which resolves the authenticated login once per plugin load and drops anything that account writes. Add more entries for bots you never want to hear from:

```jsonc
{ "ignoreAuthors": ["self", "dependabot[bot]", "github-actions[bot]"] }
```

Do **not** add the bot you actually want to follow, and do not set this to `[]` unless you accept self-triggered loops.

## Behaviour notes

- Registrations persist in plugin storage and resume on the next load. The cursor is kept, so activity that happened while OpenCode was offline is delivered on the first poll.
- One `setInterval` drives every registration; each registration keeps its own interval and cursor.
- Ten consecutive failures disable a registration. `404`/`410` drops it immediately.
- A failed baseline poll throws back into the tool call and rolls the registration back, so a bad URL or token surfaces immediately instead of silently watching nothing.
- A deleted session causes delivery to fail; the registration is retried until it is disabled. Call `notify_cancel` if a session will not come back.
- Discussions are read through GraphQL. `filter: "any"` for discussions covers comments, replies, open/closed, and marked answers — GitHub exposes no further timeline surface over one request.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```

An end-to-end check against a mock GitHub runs the real plugin inside a real
server: see [`e2e/README.md`](e2e/README.md).

Layout:

```
src/index.ts     plugin entry: options, poller, tools, hooks
src/config.ts    option normalisation and action merging
src/actions.ts   built-in action prompts and placeholder rendering
src/target.ts    URL / owner-repo-number parsing
src/github.ts    auth resolution, REST + GraphQL event fetching
src/registry.ts  persisted registrations and cursors
src/poller.ts    scheduler, dedupe, delivery
src/hooks.ts     gh pr create / gh issue create hint
```

## License

MIT
