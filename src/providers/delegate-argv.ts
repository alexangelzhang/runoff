/**
 * Normalize CLI delegate argv for headless smoke / subprocess runners.
 */

const GEMINI_HEADLESS_FLAGS = ["-p", "--prompt"] as const;

function isGeminiCommand(cmd: string): boolean {
  const base = cmd.split(/[/\\]/).pop() ?? cmd;
  return base === "gemini" || base.startsWith("gemini.");
}

/** Gemini 0.35+ needs `-p` (and usually `-y`) when prompt is sent via stdin. */
export function normalizeDelegateArgv(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const cmd = argv[0]!;
  if (!isGeminiCommand(cmd)) return argv;
  const hasPromptFlag = argv.some(
    (a, i) =>
      i > 0 &&
      (GEMINI_HEADLESS_FLAGS.includes(a as (typeof GEMINI_HEADLESS_FLAGS)[number]) ||
        a.startsWith("--prompt=")),
  );
  if (hasPromptFlag) return argv;
  const out = [...argv];
  if (!out.includes("-y")) out.push("-y");
  out.push("-p");
  return out;
}
