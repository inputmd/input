# Sugar-free Pi

This overlay contains a vendored `@mariozechner/pi-coding-agent` tree
with four local modifications to reduce overlay size and keep its cwd in
sync with the terminal shell.

## 1. Recursive import fix

Originally added in commit `c3045492` (`fix: patch @mariozechner/pi-coding-agent to avoid recursive import error`).

Applied by:
- `scripts/patch_pi_compat.mjs`

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
- `scripts/prune_pi_overlay_providers.mjs`

This phase did **not** rewrite imports in other files. It only removes files and optional package directories that are not required by the runtime path we use in this app.

## 3. Provider trim

Applied by:
- `scripts/prune_pi_overlay_providers.mjs`

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

## 4. Shell cwd sync

Applied by:
- `scripts/patch_pi_compat.mjs`

Cut point:
- `vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js`

What changed:
- on startup, `pi` now prefers `$PWD` over Node's inherited `process.cwd()`
  when they diverge and `$PWD` points at a real directory

Why:
- inside the WebContainer terminal, external Node processes can inherit a
  cwd that differs from the shell's visible working directory
- `pi` binds its built-in `ls`/`bash`/`read` tools to `process.cwd()` at
  startup, so that mismatch made tool calls inspect an empty directory even
  while direct shell commands were in the correct repo
