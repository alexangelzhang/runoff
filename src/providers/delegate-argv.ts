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

function isOpencodeCommand(cmd: string): boolean {
  const base = cmd.split(/[/\\]/).pop() ?? cmd;
  return base === "opencode" || base.startsWith("opencode.");
}

/**
 * Inject `--dir <workDir>` into opencode argv so it resolves the project root
 * from the worktree directory rather than tracing back through `.git` to the
 * source repo.  Without this, opencode running inside a linked worktree
 * identifies the wrong project (the pipeline repo instead of the target repo).
 *
 * Only injects when:
 *  - argv[0] is `opencode`
 *  - `--dir` is not already present
 *  - workDir is a non-empty string
 */
export function injectDirFlag(argv: string[], workDir?: string): string[] {
  if (!workDir || argv.length === 0) return argv;
  const cmd = argv[0]!;
  if (!isOpencodeCommand(cmd)) return argv;
  if (argv.includes("--dir")) return argv;
  return [...argv, "--dir", workDir];
}
