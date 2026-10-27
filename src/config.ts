import type { PluginOptions } from "@opencode/plugin"

import { BUILTIN_ACTIONS, type ActionDef } from "./actions"

export type Filter = "note" | "any"
export type TargetType = "pr" | "issue" | "discussion"

export interface Options {
  /** How often the scheduler checks each registration. */
  interval: number
  host: string
  /**
   * Overrides the derived REST base URL, for proxies and local test servers.
   * `graphql` is served from `${baseUrl}/graphql`.
   */
  baseUrl?: string
  token?: string
  /**
   * Comment authors that must never wake the session. `"self"` resolves to the
   * authenticated login and is what stops the agent's own reply from looping.
   */
  ignoreAuthors: string[]
  /** Append a `notify_register` suggestion after `gh pr create` / `gh issue create`. */
  hint: boolean
  actions: Record<string, ActionDef>
  /** What the user wants by default. The agent sends it unless told otherwise. */
  defaultAction: string
}

export const MIN_INTERVAL = 15_000
const DEFAULT_INTERVAL = 60_000

const parseAction = (name: string, raw: unknown): ActionDef => {
  if (!raw || typeof raw !== "object") {
    throw new Error(`[github-notify] action "${name}" must be an object like { "type": "prompt", "prompt": "..." }`)
  }
  const { type, prompt } = raw as Record<string, unknown>
  if (type !== "prompt") {
    throw new Error(`[github-notify] action "${name}": only type "prompt" is supported`)
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error(`[github-notify] action "${name}": prompt must be a non-empty string`)
  }
  return { type: "prompt", prompt }
}

export const resolveOptions = (raw: PluginOptions): Options => {
  const interval = Number(raw.interval ?? DEFAULT_INTERVAL)
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL) {
    throw new Error(`[github-notify] options.interval must be a number >= ${MIN_INTERVAL}`)
  }

  const actions: Record<string, ActionDef> = { ...BUILTIN_ACTIONS }
  for (const [name, def] of Object.entries((raw.actions ?? {}) as Record<string, unknown>)) {
    actions[name] = parseAction(name, def)
  }

  // Explaining only is the safe default: a watching agent that also replies turns
  // every notification into a GitHub comment, and several registrations quickly
  // drown the thread in AI-written noise. Replying has to be asked for.
  const defaultAction = typeof raw.defaultAction === "string" && raw.defaultAction !== "" ? raw.defaultAction : "just-explain"
  if (!actions[defaultAction]) {
    throw new Error(
      `[github-notify] options.defaultAction "${defaultAction}" is not a configured action. Available: ${Object.keys(actions).join(", ")}`,
    )
  }

  return {
    interval,
    host: typeof raw.host === "string" && raw.host !== "" ? raw.host : "github.com",
    baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl !== "" ? raw.baseUrl : undefined,
    token: typeof raw.token === "string" && raw.token !== "" ? raw.token : undefined,
    ignoreAuthors: Array.isArray(raw.ignoreAuthors)
      ? (raw.ignoreAuthors as unknown[]).filter((value): value is string => typeof value === "string")
      : ["self"],
    hint: raw.hint !== false,
    actions,
    defaultAction,
  }
}
