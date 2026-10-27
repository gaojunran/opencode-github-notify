export interface ActionDef {
  type: "prompt"
  prompt: string
}

/**
 * Built-in actions. Anything in `options.actions` overrides a key by name or
 * appends a new one, so the table below is a starting point, not a closed set.
 */
export const BUILTIN_ACTIONS: Record<string, ActionDef> = {
  "just-explain": {
    type: "prompt",
    prompt: [
      "Analyze only - do not touch GitHub, do not touch the codebase.",
      "1. Translate the update into the language the user has been using with you.",
      "2. Explain what the author wants and why, in concrete terms.",
      "3. Verify their claims against the current code and say plainly whether they are right, wrong, or unproven.",
      "Finish with a short verdict and what you would do about it, then wait for the user.",
      "Do not run any `gh` write command, do not edit files, do not commit, do not push.",
    ].join("\n"),
  },
  "explain-and-reply": {
    type: "prompt",
    prompt: [
      "Translate, explain and verify first, then answer in the thread.",
      "1. Translate the update into the user's language and explain what the author wants.",
      "2. Verify their claims against the current code; say whether they are right, wrong, or unproven.",
      "3. Post exactly one reply to {{url}} with `gh` that answers the author and states what happens next.",
      "Do not modify source files, do not commit, do not push.",
      "If a code change is required, ask the user and wait for approval before touching anything.",
    ].join("\n"),
  },
  "explain-and-act": {
    type: "prompt",
    prompt: [
      "Translate, explain and verify first, then act.",
      "1. Translate the update into the user's language and explain what the author wants.",
      "2. Verify their claims against the current code; say whether they are right, wrong, or unproven.",
      "3. Post exactly one reply to {{url}} with `gh` summarizing what you are about to do.",
      "4. Do the work: edit the code, run the checks, commit and push as appropriate, then keep the thread in sync with what actually changed.",
      "If the request is ambiguous or risky, ask the user before changing anything.",
    ].join("\n"),
  },
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** Replace `{{name}}` placeholders; unknown placeholders are left untouched. */
export const renderPrompt = (def: ActionDef, values: Record<string, string>): string =>
  def.prompt.replace(PLACEHOLDER, (match, key: string) => values[key] ?? match)
