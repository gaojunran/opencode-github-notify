import type { Plugin } from "@opencode/plugin"

import { MIN_INTERVAL, type Options } from "./config"
import type { Poller } from "./poller"
import { parseTarget } from "./target"

interface RegisterInput {
  target: string
  type?: "pr" | "issue" | "discussion"
  filter?: "note" | "any"
  action?: string
  interval?: number
}

interface CancelInput {
  id: string
}

const registerInput = (options: Options) => ({
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: {
    target: {
      type: "string",
      description: "GitHub URL (https://github.com/owner/repo/pull/123) or owner/repo#123.",
    },
    type: {
      type: "string",
      enum: ["pr", "issue", "discussion"],
      description: "Required only for the owner/repo#123 form, which is ambiguous.",
    },
    filter: {
      type: "string",
      enum: ["note", "any"],
      default: "note",
      description: "note = comments and reviews. any = every timeline event on the thread.",
    },
    action: {
      type: "string",
      default: options.defaultAction,
      description: [
        `The user's preferred action is \`${options.defaultAction}\`, so omit this field unless the user explicitly asked for a different behaviour.`,
        `Available: ${Object.keys(options.actions).join(", ")}.`,
      ].join(" "),
    },
    interval: {
      type: "number",
      minimum: MIN_INTERVAL,
      description: "Polling interval in milliseconds. Defaults to the plugin option.",
    },
  },
})

const CANCEL_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", description: "Registration id returned by notify_register." },
  },
}

const describe = (list: Awaited<ReturnType<Poller["list"]>>): string =>
  list.length === 0
    ? "No GitHub threads are being watched in this session."
    : list
        .map(
          (item) =>
            `- ${item.id}: ${item.type} ${item.owner}/${item.repo}#${item.number} [${item.filter}] action=${item.action} every ${Math.round(item.interval / 1000)}s${item.disabled ? " (disabled)" : ""}\n  ${item.url}`,
        )
        .join("\n")

export const registerTools = async (
  ctx: Plugin.Context,
  deps: { options: Options; poller: Poller },
): Promise<{ dispose: () => Promise<void> }> => {
  const { options, poller } = deps

  const registration = await ctx.tool.transform((editor) => {
    const add = (tool: unknown) => editor.add(tool as Parameters<typeof editor.add>[0])

    editor.namespace({
      name: "notify",
      description: "Watch GitHub threads and have their updates pushed back into this session",
    })

    add({
      name: "register",
      description: [
        "Start watching a GitHub pull request, issue or discussion.",
        "New comments/reviews (filter=note) or any timeline event (filter=any) are pushed into this session as a queued prompt,",
        "and the chosen action tells you how to respond.",
        `The user's preferred action is \`${options.defaultAction}\` - omit action to use it, and only pass a different one when the user explicitly asks for different behaviour.`,
        "Call this only when the user wants follow-ups here - typically right after you created the thread with `gh pr create`.",
      ].join(" "),
      input: registerInput(options),
      execute: async (input: unknown, context: { sessionID: string }) => {
        const values = input as RegisterInput
        const target = parseTarget(String(values.target ?? ""), values.type, options.host)
        const filter = values.filter === "any" ? "any" : "note"
        const action = typeof values.action === "string" && values.action !== "" ? values.action : options.defaultAction

        if (!options.actions[action]) {
          throw new Error(
            `[github-notify] unknown action "${action}". Available: ${Object.keys(options.actions).join(", ")}`,
          )
        }

        const interval = Math.max(MIN_INTERVAL, Number(values.interval ?? options.interval))
        const saved = await poller.add({ sessionID: context.sessionID, target, filter, action, interval })

        return {
          content: [
            `Watching ${target.type} ${target.owner}/${target.repo}#${target.number} (id ${saved.id}).`,
            `filter=${filter}, action=${action}, every ${Math.round(interval / 1000)}s.`,
            "Existing history was recorded as a baseline and will not be replayed.",
            `Updates are delivered to this session as queued prompts. Call notify_list to review, notify_cancel to stop.`,
          ].join("\n"),
        }
      },
    })

    add({
      name: "list",
      description: "List the GitHub threads this session is watching, with their registration ids.",
      input: { type: "object", additionalProperties: false, properties: {} },
      execute: async (_input: unknown, context: { sessionID: string }) => ({
        content: describe(poller.list(context.sessionID)),
      }),
    })

    add({
      name: "cancel",
      description: "Stop watching a GitHub thread registered by this session.",
      input: CANCEL_INPUT,
      execute: async (input: unknown, context: { sessionID: string }) => {
        const { id } = input as CancelInput
        const removed = await poller.remove(id, context.sessionID)
        return { content: removed ? `Stopped watching ${id}.` : `No registration ${id} belongs to this session.` }
      },
    })
  })

  return {
    dispose: async () => {
      await registration.dispose()
    },
  }
}
