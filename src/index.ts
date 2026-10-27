import type { Plugin } from "@opencode/plugin"

import { resolveOptions } from "./config"
import { installHooks } from "./hooks"
import { createPoller } from "./poller"
import { loadRegistrations } from "./registry"
import { registerTools } from "./tools"

export default {
  id: "github-notify",
  async setup(ctx: Plugin.Context) {
    const options = resolveOptions(ctx.options)
    const poller = createPoller({ ctx, options })

    const restored = await loadRegistrations(ctx.storage)
    poller.hydrate(restored)
    if (restored.length > 0) {
      console.error(`[github-notify] resumed ${restored.length} registration(s) from the previous run`)
      poller.start()
    }

    const tools = await registerTools(ctx, { options, poller })
    const hooks = await installHooks(ctx, options)

    return async () => {
      poller.stop()
      await hooks.dispose()
      await tools.dispose()
    }
  },
} satisfies Plugin.Plugin
