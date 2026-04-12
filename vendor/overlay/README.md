# Keto-Friendly Pi

This overlay contains a vendored `@mariozechner/pi-coding-agent` tree
with three local modifications to reduce overlay size.

## 1. Recursive import fix

Originally added in commit `c3045492` (`fix: patch @mariozechner/pi-coding-agent to avoid recursive import error`).

Cut point:
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js`

What changed:
- Replaced `export * from "./agent-session-runtime.js"` with explicit re-exports:
  - `AgentSessionRuntime`
  - `createAgentSessionRuntime`
  - `createAgentSessionFromServices`
  - `createAgentSessionServices`

Why:
- The wildcard re-export pulled in a recursive import path that breaks in WebContainers. The fix was to narrow that export surface instead of changing downstream callsites.

## 2. Size trim

Applied by:
- `scripts/prune_pi_overlay.mjs`

This phase did **not** rewrite imports in other files. It only removes files and optional package directories that are not required by the runtime path we use in this app.

## 3. Provider trim

Applied by:
- `scripts/prune_pi_overlay.mjs`

Keeps provider families:
- `anthropic`
- `openai`
- `openai-codex`
- `google`
- `google-gemini-cli`

Primary cut points:
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/models.js`
  - filtered the built-in provider/model registry to the allowed providers
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/register-builtins.js`
  - rewritten to lazy-register only the allowed API providers
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.js`
  - rewritten to register only the remaining OAuth providers
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/model-resolver.js`
  - trimmed default provider fallbacks to the remaining set
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli/args.js`
  - trimmed static help text so removed providers are not advertised
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/bedrock-provider.js`
  - replaced with a stub so the Bun registration path does not try to load removed Bedrock code

This phase **did** rewrite a small number of registry / entrypoint files so the deleted provider SDKs became unreachable.

It did **not** rewrite general callsites across the rest of the codebase; most code still imports from `@mariozechner/pi-ai`, but those imports now resolve through the trimmed registries above.

## Reapplying

Run:

```sh
node scripts/prune_pi_overlay.mjs
```
