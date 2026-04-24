import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PI_PACKAGE_ROOT = path.resolve(
  process.cwd(),
  'vendor/overlay/.local/lib/node_modules/@mariozechner/pi-coding-agent',
);

const PRUNE_DIRECTORY_BASENAMES = new Set([
  '.github',
  '.history',
  '__tests__',
  'docs',
  'example',
  'examples',
  'man',
  'spec',
  'test',
  'tests',
]);

const PRUNE_FILE_BASENAMES = new Set(['.yarnrc.yml', 'Cargo.toml', 'build.rs', 'package-lock.json', 'tsconfig.json']);

const PRUNE_NATIVE_PACKAGE_DIRS = [
  'node_modules/@mariozechner/clipboard-darwin-arm64',
  'node_modules/@mariozechner/clipboard-darwin-universal',
  'node_modules/koffi',
];

const PHASE_2_PACKAGE_DIRS = [
  'node_modules/@aws',
  'node_modules/@aws-crypto',
  'node_modules/@aws-sdk',
  'node_modules/@mistralai',
  'node_modules/@smithy',
];

const PHASE_2_FILE_PATHS = [
  'node_modules/@mariozechner/pi-ai/dist/providers/amazon-bedrock.js',
  'node_modules/@mariozechner/pi-ai/dist/providers/azure-openai-responses.js',
  'node_modules/@mariozechner/pi-ai/dist/providers/google-vertex.js',
  'node_modules/@mariozechner/pi-ai/dist/providers/mistral.js',
  'node_modules/@mariozechner/pi-ai/dist/utils/oauth/github-copilot.js',
  'node_modules/@mariozechner/pi-ai/dist/utils/oauth/google-antigravity.js',
];

const REWRITTEN_MODELS_JS = `import { MODELS } from "./models.generated.js";
const ALLOWED_PROVIDERS = new Set(["anthropic", "google", "google-gemini-cli", "openai", "openai-codex"]);
const modelRegistry = new Map();
// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
    if (!ALLOWED_PROVIDERS.has(provider))
        continue;
    const providerModels = new Map();
    for (const [id, model] of Object.entries(models)) {
        providerModels.set(id, model);
    }
    modelRegistry.set(provider, providerModels);
}
export function getModel(provider, modelId) {
    const providerModels = modelRegistry.get(provider);
    return providerModels?.get(modelId);
}
export function getProviders() {
    return Array.from(modelRegistry.keys());
}
export function getModels(provider) {
    const models = modelRegistry.get(provider);
    return models ? Array.from(models.values()) : [];
}
export function calculateCost(model, usage) {
    usage.cost.input = (model.cost.input / 1000000) * usage.input;
    usage.cost.output = (model.cost.output / 1000000) * usage.output;
    usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
    usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    return usage.cost;
}
/**
 * Check if a model supports xhigh thinking level.
 *
 * Supported today:
 * - GPT-5.2 / GPT-5.3 / GPT-5.4 model families
 * - Opus 4.6 models (xhigh maps to adaptive effort "max" on Anthropic-compatible providers)
 */
export function supportsXhigh(model) {
    if (model.id.includes("gpt-5.2") || model.id.includes("gpt-5.3") || model.id.includes("gpt-5.4")) {
        return true;
    }
    if (model.id.includes("opus-4-6") || model.id.includes("opus-4.6")) {
        return true;
    }
    return false;
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual(a, b) {
    if (!a || !b)
        return false;
    return a.id === b.id && a.provider === b.provider;
}
`;

const REWRITTEN_REGISTER_BUILTINS_JS = `import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
let anthropicProviderModulePromise;
let googleProviderModulePromise;
let googleGeminiCliProviderModulePromise;
let openAICodexResponsesProviderModulePromise;
let openAICompletionsProviderModulePromise;
let openAIResponsesProviderModulePromise;
export function setBedrockProviderModule(_module) { }
function forwardStream(target, source) {
    (async () => {
        for await (const event of source) {
            target.push(event);
        }
        target.end();
    })();
}
function createLazyLoadErrorMessage(model, error) {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    };
}
function createLazyStream(loadModule) {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();
        loadModule()
            .then((module) => {
            const inner = module.stream(model, context, options);
            forwardStream(outer, inner);
        })
            .catch((error) => {
            const message = createLazyLoadErrorMessage(model, error);
            outer.push({ type: "error", reason: "error", error: message });
            outer.end(message);
        });
        return outer;
    };
}
function createLazySimpleStream(loadModule) {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();
        loadModule()
            .then((module) => {
            const inner = module.streamSimple(model, context, options);
            forwardStream(outer, inner);
        })
            .catch((error) => {
            const message = createLazyLoadErrorMessage(model, error);
            outer.push({ type: "error", reason: "error", error: message });
            outer.end(message);
        });
        return outer;
    };
}
function loadAnthropicProviderModule() {
    anthropicProviderModulePromise ||= import("./anthropic.js").then((module) => {
        const provider = module;
        return {
            stream: provider.streamAnthropic,
            streamSimple: provider.streamSimpleAnthropic,
        };
    });
    return anthropicProviderModulePromise;
}
function loadGoogleProviderModule() {
    googleProviderModulePromise ||= import("./google.js").then((module) => {
        const provider = module;
        return {
            stream: provider.streamGoogle,
            streamSimple: provider.streamSimpleGoogle,
        };
    });
    return googleProviderModulePromise;
}
function loadGoogleGeminiCliProviderModule() {
    googleGeminiCliProviderModulePromise ||= import("./google-gemini-cli.js").then((module) => {
        const provider = module;
        return {
            stream: provider.streamGoogleGeminiCli,
            streamSimple: provider.streamSimpleGoogleGeminiCli,
        };
    });
    return googleGeminiCliProviderModulePromise;
}
function loadOpenAICodexResponsesProviderModule() {
    openAICodexResponsesProviderModulePromise ||= import("./openai-codex-responses.js").then((module) => {
        const provider = module;
        return {
            stream: provider.streamOpenAICodexResponses,
            streamSimple: provider.streamSimpleOpenAICodexResponses,
        };
    });
    return openAICodexResponsesProviderModulePromise;
}
function loadOpenAICompletionsProviderModule() {
    openAICompletionsProviderModulePromise ||= import("./openai-completions.js").then((module) => {
        const provider = module;
        return {
            stream: provider.streamOpenAICompletions,
            streamSimple: provider.streamSimpleOpenAICompletions,
        };
    });
    return openAICompletionsProviderModulePromise;
}
function loadOpenAIResponsesProviderModule() {
    openAIResponsesProviderModulePromise ||= import("./openai-responses.js").then((module) => {
        const provider = module;
        return {
            stream: provider.streamOpenAIResponses,
            streamSimple: provider.streamSimpleOpenAIResponses,
        };
    });
    return openAIResponsesProviderModulePromise;
}
export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamSimpleAnthropic = createLazySimpleStream(loadAnthropicProviderModule);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamSimpleGoogle = createLazySimpleStream(loadGoogleProviderModule);
export const streamGoogleGeminiCli = createLazyStream(loadGoogleGeminiCliProviderModule);
export const streamSimpleGoogleGeminiCli = createLazySimpleStream(loadGoogleGeminiCliProviderModule);
export const streamOpenAICodexResponses = createLazyStream(loadOpenAICodexResponsesProviderModule);
export const streamSimpleOpenAICodexResponses = createLazySimpleStream(loadOpenAICodexResponsesProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
export const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
export const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
export const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);
export function registerBuiltInApiProviders() {
    registerApiProvider({
        api: "anthropic-messages",
        stream: streamAnthropic,
        streamSimple: streamSimpleAnthropic,
    });
    registerApiProvider({
        api: "openai-completions",
        stream: streamOpenAICompletions,
        streamSimple: streamSimpleOpenAICompletions,
    });
    registerApiProvider({
        api: "openai-responses",
        stream: streamOpenAIResponses,
        streamSimple: streamSimpleOpenAIResponses,
    });
    registerApiProvider({
        api: "openai-codex-responses",
        stream: streamOpenAICodexResponses,
        streamSimple: streamSimpleOpenAICodexResponses,
    });
    registerApiProvider({
        api: "google-generative-ai",
        stream: streamGoogle,
        streamSimple: streamSimpleGoogle,
    });
    registerApiProvider({
        api: "google-gemini-cli",
        stream: streamGoogleGeminiCli,
        streamSimple: streamSimpleGoogleGeminiCli,
    });
}
export function resetApiProviders() {
    clearApiProviders();
    registerBuiltInApiProviders();
}
registerBuiltInApiProviders();
`;

const REWRITTEN_OAUTH_INDEX_JS = `/**
 * OAuth credential management for AI providers.
 */
export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
export { geminiCliOAuthProvider, loginGeminiCli, refreshGoogleCloudToken } from "./google-gemini-cli.js";
export { loginOpenAICodex, openaiCodexOAuthProvider, refreshOpenAICodexToken } from "./openai-codex.js";
export * from "./types.js";
import { anthropicOAuthProvider } from "./anthropic.js";
import { geminiCliOAuthProvider } from "./google-gemini-cli.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
const BUILT_IN_OAUTH_PROVIDERS = [
    anthropicOAuthProvider,
    geminiCliOAuthProvider,
    openaiCodexOAuthProvider,
];
const oauthProviderRegistry = new Map(BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]));
export function getOAuthProvider(id) {
    return oauthProviderRegistry.get(id);
}
export function registerOAuthProvider(provider) {
    oauthProviderRegistry.set(provider.id, provider);
}
export function unregisterOAuthProvider(id) {
    const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
    if (builtInProvider) {
        oauthProviderRegistry.set(id, builtInProvider);
        return;
    }
    oauthProviderRegistry.delete(id);
}
export function resetOAuthProviders() {
    oauthProviderRegistry.clear();
    for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
        oauthProviderRegistry.set(provider.id, provider);
    }
}
export function getOAuthProviders() {
    return Array.from(oauthProviderRegistry.values());
}
export function getOAuthProviderInfoList() {
    return getOAuthProviders().map((p) => ({
        id: p.id,
        name: p.name,
        available: true,
    }));
}
export async function refreshOAuthToken(providerId, credentials) {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
        throw new Error(\`Unknown OAuth provider: \${providerId}\`);
    }
    return provider.refreshToken(credentials);
}
export async function getOAuthApiKey(providerId, credentials) {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
        throw new Error(\`Unknown OAuth provider: \${providerId}\`);
    }
    let creds = credentials[providerId];
    if (!creds) {
        return null;
    }
    if (Date.now() >= creds.expires) {
        try {
            creds = await provider.refreshToken(creds);
        }
        catch (_error) {
            throw new Error(\`Failed to refresh OAuth token for \${providerId}\`);
        }
    }
    const apiKey = provider.getApiKey(creds);
    return { newCredentials: creds, apiKey };
}
`;

const REWRITTEN_BEDROCK_PROVIDER_JS = `function removedBedrockProvider() {
    throw new Error("Amazon Bedrock was removed from this trimmed pi overlay.");
}
export const bedrockProviderModule = {
    streamBedrock: removedBedrockProvider,
    streamSimpleBedrock: removedBedrockProvider,
};
`;

const TRIMMED_CLI_ENV_BLOCK = `  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  OPENAI_API_KEY                   - OpenAI GPT API key
  GEMINI_API_KEY                   - Google Gemini API key
  \${ENV_AGENT_DIR.padEnd(32)} - Session storage directory (default: ~/\${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)`;

function shouldDeleteFile(name) {
  if (PRUNE_FILE_BASENAMES.has(name)) return true;
  if (name.endsWith('.map')) return true;
  if (name.endsWith('.d.ts') || name.endsWith('.d.ts.map')) return true;
  if (name.endsWith('.d.mts') || name.endsWith('.d.mts.map')) return true;
  if (name.endsWith('.d.cts') || name.endsWith('.d.cts.map')) return true;
  if (name.endsWith('.md') && !/^license(?:\.[^.]+)?$/i.test(name)) return true;
  return false;
}

function shouldDeleteSourceDirectory(parentPath, name) {
  if (name !== 'src') return false;
  const lowerParent = parentPath.replace(/\\/g, '/').toLowerCase();
  return (
    lowerParent.endsWith('/node_modules/openai') ||
    lowerParent.endsWith('/node_modules/@anthropic-ai/sdk') ||
    lowerParent.endsWith('/node_modules/@mistralai/mistralai')
  );
}

async function pruneTree(rootPath) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE_DIRECTORY_BASENAMES.has(entry.name) || shouldDeleteSourceDirectory(rootPath, entry.name)) {
        await rm(entryPath, { force: true, recursive: true });
        continue;
      }
      await pruneTree(entryPath);
      continue;
    }
    if (shouldDeleteFile(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
}

async function writeFileIfChanged(relativePath, nextSource) {
  const filePath = path.join(PI_PACKAGE_ROOT, relativePath);
  const currentSource = await readFile(filePath, 'utf8');
  if (currentSource === nextSource) return;
  await writeFile(filePath, nextSource);
}

async function applyPhase2Trims() {
  await writeFileIfChanged('node_modules/@mariozechner/pi-ai/dist/models.js', REWRITTEN_MODELS_JS);
  await writeFileIfChanged(
    'node_modules/@mariozechner/pi-ai/dist/providers/register-builtins.js',
    REWRITTEN_REGISTER_BUILTINS_JS,
  );
  await writeFileIfChanged('node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.js', REWRITTEN_OAUTH_INDEX_JS);
  await writeFileIfChanged('node_modules/@mariozechner/pi-ai/dist/bedrock-provider.js', REWRITTEN_BEDROCK_PROVIDER_JS);

  const modelResolverPath = path.join(PI_PACKAGE_ROOT, 'dist/core/model-resolver.js');
  const modelResolverSource = await readFile(modelResolverPath, 'utf8');
  const trimmedDefaultProviders = `export const defaultModelPerProvider = {
    anthropic: "claude-opus-4-6",
    openai: "gpt-5.4",
    "openai-codex": "gpt-5.4",
    google: "gemini-2.5-pro",
    "google-gemini-cli": "gemini-2.5-pro",
};`;
  const rewrittenModelResolverSource = modelResolverSource.replace(
    /export const defaultModelPerProvider = \{[\s\S]*?\};/,
    trimmedDefaultProviders,
  );
  if (rewrittenModelResolverSource !== modelResolverSource) {
    await writeFile(modelResolverPath, rewrittenModelResolverSource);
  }

  const cliArgsPath = path.join(PI_PACKAGE_ROOT, 'dist/cli/args.js');
  const cliArgsSource = await readFile(cliArgsPath, 'utf8');
  const rewrittenCliArgsSource = cliArgsSource
    .replace(
      '  # Limit to a specific provider with glob pattern\n  ${APP_NAME} --models "github-copilot/*"',
      '  # Limit to a specific provider with glob pattern\n  ${APP_NAME} --models "google/*"',
    )
    .replace(
      /  ANTHROPIC_API_KEY[\s\S]*?  PI_AI_ANTIGRAVITY_VERSION        - Override Antigravity User-Agent version \(e\.g\., 1\.23\.0\)/,
      TRIMMED_CLI_ENV_BLOCK,
    );
  if (rewrittenCliArgsSource !== cliArgsSource) {
    await writeFile(cliArgsPath, rewrittenCliArgsSource);
  }

  for (const relativePath of PHASE_2_FILE_PATHS) {
    await rm(path.join(PI_PACKAGE_ROOT, relativePath), { force: true });
  }
  for (const relativePath of PHASE_2_PACKAGE_DIRS) {
    await rm(path.join(PI_PACKAGE_ROOT, relativePath), { force: true, recursive: true });
  }
}

async function sizeInBytes(rootPath) {
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) return rootStat.size;
  let total = 0;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    total += await sizeInBytes(path.join(rootPath, entry.name));
  }
  return total;
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function main() {
  const beforeBytes = await sizeInBytes(PI_PACKAGE_ROOT);
  await pruneTree(PI_PACKAGE_ROOT);
  await applyPhase2Trims();
  for (const relativePath of PRUNE_NATIVE_PACKAGE_DIRS) {
    await rm(path.join(PI_PACKAGE_ROOT, relativePath), { force: true, recursive: true });
  }
  const afterBytes = await sizeInBytes(PI_PACKAGE_ROOT);
  const removedBytes = Math.max(0, beforeBytes - afterBytes);
  console.info('[prune-pi-overlay] completed', {
    before: formatMiB(beforeBytes),
    after: formatMiB(afterBytes),
    removed: formatMiB(removedBytes),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
