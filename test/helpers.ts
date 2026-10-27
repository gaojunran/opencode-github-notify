import type { Plugin } from "@opencode/plugin"

export type HookHandler = (event: any) => void | Promise<void>

export interface Harness {
  ctx: Plugin.Context
  store: Map<string, unknown>
  prompts: { sessionID?: unknown; text: string; delivery?: string }[]
  tools: Map<
    string,
    {
      name: string
      description: string
      input: any
      execute: (input: unknown, context: any) => Promise<{ content: string }>
    }
  >
  hooks: Map<string, HookHandler[]>
  fire(name: string, event: any): Promise<void>
}

export const harness = (options: Record<string, unknown> = {}): Harness => {
  const store = new Map<string, unknown>()
  const prompts: Harness["prompts"] = []
  const tools: Harness["tools"] = new Map()
  const hooks = new Map<string, HookHandler[]>()
  const dispose = async () => {}

  const ctx = {
    options,
    app: { version: "2.1.4" },
    location: { directory: process.cwd(), project: { id: "p", directory: process.cwd(), canonical: process.cwd() } },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      prompt: async (input: Harness["prompts"][number]) => {
        prompts.push(input)
        return input
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ namespace: () => {}, add: (tool: unknown) => tools.set((tool as { name: string }).name, tool as Parameters<typeof tools.set>[1]) })
        return { dispose }
      },
      hook: async (name: string, callback: HookHandler) => {
        hooks.set(name, [...(hooks.get(name) ?? []), callback])
        return { dispose }
      },
    },
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    store,
    prompts,
    tools,
    hooks,
    fire: async (name, event) => {
      for (const hook of hooks.get(name) ?? []) await hook(event)
    },
  }
}
