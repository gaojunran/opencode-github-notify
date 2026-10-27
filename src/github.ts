import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { Target } from "./target"

const exec = promisify(execFile)

export interface GitHubClient {
  host: string
  token: string
  api: string
  graphql: string
}

export type NoteKind = "comment" | "review" | "review_comment" | "event" | "state" | "ci"

export interface Note {
  /** Stable across polls; this is what deduplicates deliveries. */
  id: string
  kind: NoteKind
  author: string
  body: string
  url: string
  createdAt: string
  summary: string
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "GitHubError"
  }
}

const MAX_PAGES = 5

export const resolveClient = async (options: { host: string; token?: string }): Promise<GitHubClient> => {
  const token =
    options.token ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    (await ghAuthToken(options.host))

  if (!token) {
    throw new Error(
      "[github-notify] no GitHub token found. Set `token` in plugin options, export GITHUB_TOKEN, or run `gh auth login`.",
    )
  }

  return {
    host: options.host,
    token,
    api: options.host === "github.com" ? "https://api.github.com" : `https://${options.host}/api/v3`,
    graphql: options.host === "github.com" ? "https://api.github.com/graphql" : `https://${options.host}/api/graphql`,
  }
}

const ghAuthToken = async (host: string): Promise<string | undefined> => {
  try {
    const { stdout } = await exec("gh", ["auth", "token", "--hostname", host])
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

const headers = (client: GitHubClient) => ({
  Authorization: `Bearer ${client.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
})

const nextLink = (header: string | null): string | undefined => {
  const match = header ? /<([^>]+)>;\s*rel="next"/.exec(header) : null
  return match?.[1]
}

const call = async (client: GitHubClient, url: string): Promise<{ data: unknown; next?: string }> => {
  const response = await fetch(url, { headers: headers(client) })
  if (!response.ok) {
    const body = await response.text()
    throw new GitHubError(response.status, `[github-notify] ${response.status} ${url}: ${body.slice(0, 300)}`)
  }
  return { data: await response.json(), next: nextLink(response.headers.get("link")) }
}

const list = async <T>(client: GitHubClient, path: string): Promise<T[]> => {
  const items: T[] = []
  let url: string | undefined = `${client.api}${path}`
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const result: { data: unknown; next?: string } = await call(client, url)
    if (Array.isArray(result.data)) items.push(...(result.data as T[]))
    url = result.next
  }
  return items
}

const get = async <T>(client: GitHubClient, path: string): Promise<T> => {
  const result = await call(client, `${client.api}${path}`)
  return result.data as T
}

const repoPath = (target: Target) => `/repos/${target.owner}/${target.repo}`

const AUTHOR_UNKNOWN = "ghost"

interface RawComment {
  id: number
  body?: string
  html_url?: string
  created_at?: string
  user?: { login?: string }
}

const fromComment = (kind: "comment" | "review_comment", raw: RawComment): Note => ({
  id: `${kind}:${raw.id}`,
  kind,
  author: raw.user?.login ?? AUTHOR_UNKNOWN,
  body: raw.body ?? "",
  url: raw.html_url ?? "",
  createdAt: raw.created_at ?? new Date(0).toISOString(),
  summary: "",
})

interface RawReview {
  id: number
  state?: string
  body?: string
  html_url?: string
  submitted_at?: string
  user?: { login?: string }
}

const fromReview = (raw: RawReview): Note => ({
  id: `review:${raw.id}`,
  kind: "review",
  author: raw.user?.login ?? AUTHOR_UNKNOWN,
  body: raw.body ?? "",
  url: raw.html_url ?? "",
  createdAt: raw.submitted_at ?? new Date(0).toISOString(),
  summary: raw.state ? `review ${raw.state.toLowerCase()}` : "review",
})

interface RawTimelineItem {
  id?: number
  body?: string
  html_url?: string
  created_at?: string
  submitted_at?: string
  state?: string
  user?: { login?: string }
  actor?: { login?: string }
  event?: string
  commit_id?: string
  label?: { name?: string }
  assignee?: { login?: string }
  rename?: { from?: string; to?: string }
  source?: { issue?: { html_url?: string; title?: string } }
}

const describeEvent = (item: RawTimelineItem): string => {
  switch (item.event) {
    case "labeled":
      return `labeled "${item.label?.name ?? "?"}"`
    case "unlabeled":
      return `removed label "${item.label?.name ?? "?"}"`
    case "assigned":
      return `assigned ${item.assignee?.login ?? "someone"}`
    case "unassigned":
      return `unassigned ${item.assignee?.login ?? "someone"}`
    case "closed":
      return "closed"
    case "reopened":
      return "reopened"
    case "merged":
      return "merged"
    case "review_requested":
      return "review requested"
    case "review_dismissed":
      return "review dismissed"
    case "head_ref_force_pushed":
      return "head branch force-pushed"
    case "referenced":
      return `referenced commit ${item.commit_id?.slice(0, 7) ?? ""}`
    case "committed":
      return `pushed commit ${item.commit_id?.slice(0, 7) ?? ""}`
    case "cross-referenced":
      return `cross-referenced from ${item.source?.issue?.html_url ?? "another thread"}`
    case "renamed":
      return `renamed "${item.rename?.from ?? ""}" -> "${item.rename?.to ?? ""}"`
    case "reviewed":
      return `review ${(item.state ?? "").toLowerCase()}`
    default:
      return item.event ?? "event"
  }
}

const fromTimelineItem = (item: RawTimelineItem): Note | undefined => {
  // The timeline mixes comment objects and event objects in one array.
  if (typeof item.body === "string" && item.id !== undefined) {
    return fromComment("comment", item as RawComment)
  }
  const event = item.event
  if (!event) return undefined
  const at = item.created_at ?? item.submitted_at ?? new Date(0).toISOString()
  const id = item.id !== undefined ? `event:${item.id}` : `event:${event}:${at}:${item.commit_id ?? ""}`
  return {
    id,
    kind: "event",
    author: item.actor?.login ?? item.user?.login ?? AUTHOR_UNKNOWN,
    body: item.body ?? "",
    url: item.html_url ?? "",
    createdAt: at,
    summary: describeEvent(item),
  }
}

interface RawCheckRun {
  name?: string
  status?: string
  conclusion?: string | null
  html_url?: string
}

/**
 * A check run aggregate is only interesting at its terminal state: emitting
 * while it is pending would deliver a note that says nothing.
 */
const summarizeChecks = (runs: RawCheckRun[]): { conclusion: string; failed: RawCheckRun[] } | undefined => {
  if (runs.length === 0) return undefined
  const pending = runs.some((run) => run.status !== "completed")
  if (pending) return undefined
  const failed = runs.filter((run) =>
    ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(run.conclusion ?? ""),
  )
  return { conclusion: failed.length > 0 ? "failure" : "success", failed }
}

const fetchChecks = async (client: GitHubClient, target: Target): Promise<Note[]> => {
  const pull = await get<{ head?: { sha?: string } }>(client, `${repoPath(target)}/pulls/${target.number}`)
  const sha = pull.head?.sha
  if (!sha) return []

  const result = await get<{ check_runs?: RawCheckRun[] }>(
    client,
    `${repoPath(target)}/commits/${sha}/check-runs?per_page=100`,
  )
  const summary = summarizeChecks(result.check_runs ?? [])
  if (!summary) return []

  return [
    {
      id: `ci:${sha}:${summary.conclusion}`,
      kind: "ci",
      author: "",
      body: summary.failed.map((run) => `${run.name ?? "check"}: ${run.conclusion} ${run.html_url ?? ""}`).join("\n"),
      url: `${target.url}/checks`,
      createdAt: new Date().toISOString(),
      summary: `CI ${summary.conclusion}`,
    },
  ]
}

interface RawDiscussionResponse {
  data?: {
    repository?: {
      discussion?: {
        closed?: boolean
        closedAt?: string
        answer?: { id?: string; createdAt?: string; url?: string } | null
        comments?: { nodes?: RawDiscussionComment[] }
      }
    }
  }
}

interface RawDiscussionComment {
  id?: string
  body?: string
  createdAt?: string
  url?: string
  author?: { login?: string }
  replies?: { nodes?: RawDiscussionComment[] }
}

const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      closed
      closedAt
      answer { id createdAt url }
      comments(last: 100) {
        nodes {
          id body createdAt url
          author { login }
          replies(last: 50) { nodes { id body createdAt url author { login } } }
        }
      }
    }
  }
}`

const fetchDiscussion = async (client: GitHubClient, target: Target, any: boolean): Promise<Note[]> => {
  const response = await fetch(client.graphql, {
    method: "POST",
    headers: { ...headers(client), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: DISCUSSION_QUERY,
      variables: { owner: target.owner, name: target.repo, number: target.number },
    }),
  })
  if (!response.ok) {
    throw new GitHubError(response.status, `[github-notify] ${response.status} graphql: ${(await response.text()).slice(0, 300)}`)
  }

  const payload = (await response.json()) as RawDiscussionResponse
  const discussion = payload.data?.repository?.discussion
  if (!discussion) throw new GitHubError(404, `[github-notify] discussion not found: ${target.url}`)

  const nodes = discussion.comments?.nodes ?? []
  const notes: Note[] = []
  for (const node of nodes) {
    notes.push(fromDiscussionComment(node))
    for (const reply of node.replies?.nodes ?? []) notes.push(fromDiscussionComment(reply))
  }

  if (any) {
    const stamp = discussion.closed ? (discussion.closedAt ?? "") : ""
    notes.push({
      id: `state:${discussion.closed ? "closed" : "open"}:${stamp}`,
      kind: "state",
      author: "",
      body: "",
      url: target.url,
      createdAt: stamp || new Date(0).toISOString(),
      summary: discussion.closed ? "discussion closed" : "discussion open",
    })
    if (discussion.answer?.id) {
      notes.push({
        id: `state:answer:${discussion.answer.id}`,
        kind: "state",
        author: "",
        body: "",
        url: discussion.answer.url ?? target.url,
        createdAt: discussion.answer.createdAt ?? new Date(0).toISOString(),
        summary: "answer marked",
      })
    }
  }

  return notes
}

const fromDiscussionComment = (node: RawDiscussionComment): Note => ({
  id: `comment:${node.id}`,
  kind: "comment",
  author: node.author?.login ?? AUTHOR_UNKNOWN,
  body: node.body ?? "",
  url: node.url ?? "",
  createdAt: node.createdAt ?? new Date(0).toISOString(),
  summary: "",
})

/** Pull the updates for one registration. */
export const fetchNotes = async (client: GitHubClient, target: Target, filter: "note" | "any"): Promise<Note[]> => {
  if (target.type === "discussion") return fetchDiscussion(client, target, filter === "any")

  if (filter === "note") {
    const comments = await list<RawComment>(client, `${repoPath(target)}/issues/${target.number}/comments?per_page=100`)
    const notes = comments.map((raw) => fromComment("comment", raw))
    if (target.type === "pr") {
      const reviewComments = await list<RawComment>(client, `${repoPath(target)}/pulls/${target.number}/comments?per_page=100`)
      const reviews = await list<RawReview>(client, `${repoPath(target)}/pulls/${target.number}/reviews?per_page=100`)
      notes.push(...reviewComments.map((raw) => fromComment("review_comment", raw)), ...reviews.map(fromReview))
    }
    return notes
  }

  const timeline = await list<RawTimelineItem>(client, `${repoPath(target)}/issues/${target.number}/timeline?per_page=100`)
  const notes = timeline.map(fromTimelineItem).filter((note): note is Note => note !== undefined)
  if (target.type === "pr") notes.push(...(await fetchChecks(client, target)))
  return notes
}
