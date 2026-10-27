/**
 * Test-only wrapper: the v2.1.3 loader only auto-discovers
 * `<location>/.opencode/plugin/*.ts`, and configured `plugins` entries are
 * resolved as npm packages. This shim loads the real plugin with the options
 * that `e2e/opencode.json` would have supplied.
 */
import real from "../../../src/index"

export default {
  id: "github-notify",
  setup: (ctx: Parameters<typeof real.setup>[0]) =>
    real.setup({
      ...ctx,
      options: { baseUrl: "http://127.0.0.1:8787", token: "test-token", interval: 15000 },
    }),
}
