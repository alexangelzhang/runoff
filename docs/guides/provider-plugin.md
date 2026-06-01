# Provider Plugin Guide

runoff supports third-party provider plugins — npm packages that add new provider types without forking runoff.

## Quick start

**1. Install the plugin:**

```bash
npm install runoff-provider-ollama
```

**2. Use it in `pipeline.config.json`:**

```json
{
  "providers": {
    "ollama": {
      "type": "plugin",
      "package": "runoff-provider-ollama",
      "model": "llama3",
      "mode": "text"
    }
  },
  "pipeline": {
    "implement": ["ollama"],
    "review": ["ollama", "implement"]
  }
}
```

That's it. The plugin is loaded at runtime from your project's `node_modules`.

---

## Writing a plugin

A provider plugin is an npm package that exports a single function:

```typescript
import type { LLMProvider, LLMRequest, LLMResponse } from "runoff/providers";

export function createProvider(name: string, config: PluginProviderConfig): LLMProvider {
  return {
    name,
    mode: config.mode ?? "text",
    async execute(req: LLMRequest): Promise<LLMResponse> {
      // call your backend here
      const text = await callMyBackend(req.prompt, config);
      return {
        kind: "text",
        content: text,
        code: text,
        explanation: "",
        model: config.model ?? "unknown",
      };
    },
  };
}
```

### The `LLMProvider` interface

```typescript
interface LLMProvider {
  name: string;
  mode: "text" | "agent-read" | "agent-write";
  execute(req: LLMRequest): Promise<LLMResponse>;
}
```

### Provider modes

| Mode | What it means | Use when |
|------|--------------|----------|
| `text` | Returns generated text. runoff extracts code blocks. | API-based LLMs (OpenAI-compatible, Ollama, etc.) |
| `agent-read` | Reads the repo, returns a diff as text. No workspace isolation. | Lightweight agents that don't write files |
| `agent-write` | Writes files directly into a git worktree. runoff collects the diff. | CLI agents (Codex, Claude Code, Gemini, OpenCode) |

Most plugins should use `mode: "text"`.

### Request shape

```typescript
interface LLMRequest {
  prompt: string;         // the task prompt
  language?: string;      // target language hint
  context?: string;       // existing code for style matching
  workDir?: string;       // absolute path to the repo (agent modes)
  sessionId?: string;
  stepName?: string;
  round?: number;
  signal?: AbortSignal;   // honour this for cancellation
}
```

### Response shapes

**Text response** (`mode: "text"`):

```typescript
{
  kind: "text";
  content: string;       // full raw response
  code: string;          // extracted code block(s)
  explanation: string;   // text outside code blocks
  model: string;         // model name for traces
  usage?: { promptTokens: number; completionTokens: number };
  failed?: boolean;
  error?: string;
}
```

**Agent response** (`mode: "agent-write"` / `"agent-read"`):

```typescript
{
  kind: "agent";
  summary: string;
  changes: string;          // git diff output
  filesModified: string[];
  diffStat: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
  failed?: boolean;
  error?: string;
}
```

---

## Full example: Ollama plugin

```typescript
// runoff-provider-ollama/index.ts
import type { LLMProvider, LLMRequest, LLMResponse } from "runoff";

interface OllamaConfig {
  package: string;
  model?: string;
  baseUrl?: string;
  mode?: "text";
}

export function createProvider(name: string, config: OllamaConfig): LLMProvider {
  const baseUrl = config.baseUrl ?? "http://localhost:11434";
  const model = config.model ?? "llama3";

  return {
    name,
    mode: "text",
    async execute(req: LLMRequest): Promise<LLMResponse> {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: req.prompt, stream: false }),
        signal: req.signal,
      });

      if (!res.ok) {
        return { kind: "text", content: "", code: "", explanation: "",
                 model, failed: true, error: `Ollama ${res.status}` };
      }

      const data = (await res.json()) as { response: string };
      const content = data.response;
      // Extract code blocks (runoff also does this, but being explicit is fine)
      const code = content.match(/```[\w]*\n([\s\S]*?)```/)?.[1]?.trim() ?? content;

      return { kind: "text", content, code, explanation: content, model };
    },
  };
}
```

**`package.json`:**

```json
{
  "name": "runoff-provider-ollama",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "peerDependencies": {
    "runoff": ">=3.0.0"
  }
}
```

**Use in `pipeline.config.json`:**

```json
{
  "providers": {
    "ollama-llama3": {
      "type": "plugin",
      "package": "runoff-provider-ollama",
      "model": "llama3",
      "baseUrl": "http://localhost:11434"
    }
  }
}
```

---

## Publishing your plugin

Name your package with the `runoff-provider-` prefix so it's discoverable:

```
runoff-provider-ollama
runoff-provider-lmstudio
runoff-provider-groq
runoff-provider-together
```

Then publish to npm:

```bash
npm publish
```

And open a PR to add it to the [community plugins list](../../PLUGINS.md).

---

## Config fields passed to `createProvider`

All fields from the provider's config block are passed as-is. Standard fields:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"plugin"` | Always `"plugin"` |
| `package` | `string` | Your npm package name |
| `model` | `string?` | Model identifier |
| `mode` | `ProviderMode?` | `text` / `agent-read` / `agent-write` |
| `timeoutMs` | `number?` | Timeout in ms |
| `tier` | `"lite" \| "full"?` | Cost tier hint for router |
| `costPerToken` | `number?` | USD per 1M tokens |
| `avgLatencyMs` | `number?` | Latency hint for tie-breaking |

Any additional fields you add to the config block are passed through untouched.
