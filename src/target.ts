import type { TargetType } from "./config"

export interface Target {
  host: string
  owner: string
  repo: string
  number: number
  type: TargetType
  url: string
}

const URL_PATTERN = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(pull|issues|discussions)\/(\d+)\/?$/
const SHORT_PATTERN = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/

const PATHS: Record<TargetType, string> = {
  pr: "pull",
  issue: "issues",
  discussion: "discussions",
}

const TYPES: Record<string, TargetType> = {
  pull: "pr",
  issues: "issue",
  discussions: "discussion",
}

/**
 * Accepts a full GitHub URL or `owner/repo#123`. A short form needs `type`
 * because `owner/repo#123` is ambiguous between pull requests and issues.
 */
export const parseTarget = (raw: string, type?: TargetType, host = "github.com"): Target => {
  const value = raw.trim()

  const url = URL_PATTERN.exec(value)
  if (url) {
    const [, urlHost = host, owner = "", repo = "", path = "issues", number = "0"] = url
    const targetType = TYPES[path]
    if (!targetType) throw new Error(`[github-notify] unsupported URL: ${raw}`)
    return {
      host: urlHost,
      owner,
      repo,
      number: Number(number),
      type: targetType,
      url: `https://${urlHost}/${owner}/${repo}/${path}/${number}`,
    }
  }

  const short = SHORT_PATTERN.exec(value)
  if (short) {
    if (!type) throw new Error(`[github-notify] "${raw}" is ambiguous, pass type: "pr" | "issue" | "discussion"`)
    const [, owner = "", repo = "", number = "0"] = short
    return {
      host,
      owner,
      repo,
      number: Number(number),
      type,
      url: `https://${host}/${owner}/${repo}/${PATHS[type]}/${number}`,
    }
  }

  throw new Error(`[github-notify] cannot parse "${raw}", expected a GitHub URL or owner/repo#123`)
}

export const formatTarget = (target: Pick<Target, "owner" | "repo" | "number">): string =>
  `${target.owner}/${target.repo}#${target.number}`
