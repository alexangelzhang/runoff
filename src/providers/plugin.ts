/**
 * Plugin provider loader.
 *
 * Allows third-party npm packages to add new provider types without forking runoff.
 *
 * A plugin package must export:
 *   createProvider(name: string, config: ProviderConfig): LLMProvider
 *
 * Example pipeline.config.json:
 *   "providers": {
 *     "my-ollama": {
 *       "type": "plugin",
 *       "package": "runoff-provider-ollama",
 *       "model": "llama3",
 *       "mode": "text"
 *     }
 *   }
 */

import type { LLMProvider } from "./types.js";
import type { ProviderConfig } from "../core/config.js";

export interface RunoffProviderPlugin {
  createProvider(name: string, config: ProviderConfig): LLMProvider;
}

export function loadPluginProvider(name: string, config: ProviderConfig): LLMProvider {
  const pkg = config.package;
  if (!pkg) {
    throw new Error(
      `Provider "${name}" has type "plugin" but no "package" field. ` +
        `Set "package": "your-npm-package-name" in the provider config.`,
    );
  }

  let plugin: RunoffProviderPlugin;
  try {
    // Dynamic import — the package must be installed in the project's node_modules
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    plugin = require(pkg) as RunoffProviderPlugin;
  } catch (err) {
    throw new Error(
      `Failed to load provider plugin "${pkg}" for provider "${name}". ` +
        `Make sure it is installed: npm install ${pkg}\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof plugin.createProvider !== "function") {
    throw new Error(
      `Provider plugin "${pkg}" does not export a "createProvider" function. ` +
        `See docs/guides/provider-plugin.md for the expected interface.`,
    );
  }

  return plugin.createProvider(name, config);
}
