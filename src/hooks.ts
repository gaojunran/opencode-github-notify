import type { Plugin } from "@opencode/plugin"

import type { Options } from "./config"
import { parseTarget } from "./target"

/** `gh pr create`, `gh issue create`, and the `gh --repo o/r pr create` form. */
const CREATE_COMMAND = /\bgh\b[^\n]*?\b(?:pr|issue)\s+create\b/
const THREAD_URL = /(https?:\/\/[^\s"'<>]+\/[^\s"'<>]+\/[^\s"'<>]+\/(?:pull|issues)\/\d+)/

const flatten = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { type: string; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

const suggestion = (url: string, action: string): string => {
  let target = url
  try {
    target = parseTarget(url).url
  } catch {
    // keep the raw URL when the host or path is unusual
  }
  return [
    "[github-notify] GitHub thread created.",
    "If the user wants to keep following this thread, call:",
    `  notify_register({ target: "${target}", filter: "note", action: "${action}" })`,
    "Ask the user first - do not register without their intent.",
  ].join("\n")
}

export interface HookRegistration {
  dispose: () => Promise<void>
}

export const installHooks = async (ctx: Plugin.Context, options: Options): Promise<HookRegistration> => {
  if (!options.hint) return { dispose: async () => {} }

  const pending = new Set<string>()

  const before = await ctx.tool.hook("execute.before", (event) => {
    const input = event.input as { command?: unknown } | undefined
    const command = typeof input?.command === "string" ? input.command : ""
    if (CREATE_COMMAND.test(command)) pending.add(String(event.id))
  })

  const after = await ctx.tool.hook("execute.after", (event) => {
    const key = String(event.id)
    if (!pending.has(key)) return
    pending.delete(key)
    if (event.status !== "completed") return

    const match = THREAD_URL.exec(flatten(event.result.content))
    if (!match?.[1]) return

    const hint = suggestion(match[1], options.defaultAction)
    const content = event.result.content
    const next =
      content === undefined
        ? hint
        : typeof content === "string"
          ? `${content}\n\n${hint}`
          : [...content, { type: "text" as const, text: hint }]

    event.result = { ...event.result, content: next }
  })

  return {
    dispose: async () => {
      pending.clear()
      await before.dispose()
      await after.dispose()
    },
  }
}
