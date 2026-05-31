import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root from `tests/helpers/` (two levels up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
