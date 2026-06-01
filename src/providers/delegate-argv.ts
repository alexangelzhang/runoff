/**
 * Normalize CLI delegate argv for headless smoke / subprocess runners.
 *
 * History: Gemini CLI v0.35-0.43 required `-p` to read stdin in headless mode.
 * Gemini CLI v0.44+ reads stdin directly without a TTY; `-p` without a value
 * causes "Not enough arguments following: p". No normalization is needed for
 * modern Gemini — configure `--yolo` in the provider args instead.
 */
export function normalizeDelegateArgv(argv: string[]): string[] {
  return argv;
}
