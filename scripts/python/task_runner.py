#!/usr/bin/env python3
import argparse
import base64
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

TASK_PAYLOAD_FIELD_NAMES = (
    "id",
    "prompt",
    "mode",
    "timestamp",
    "startedAt",
    "system",
    "staticContext",
    "dynamicContext",
    "workDir",
    "sessionId",
    "stepName",
    "round",
    "schemaVersion",
    "knowledgeBase",
    "agentId",
    "parentHandoffId",
    "delegateArgv",
    "delegatePty",
    "delegateAcp",
    "finalizeStrategy",
    "sharedLockKey",
)

TASK_RESULT_FIELD_NAMES = (
    "id",
    "status",
    "content",
    "usage",
    "error",
    "model",
    "summary",
    "changes",
    "filesModified",
    "diffStat",
    "workspacePath",
    "workspaceRepoRoot",
    "workspaceBaseRef",
    "workspaceSharedLockKey",
    "schemaVersion",
    "insights",
    "nextSteps",
    "startedAt",
    "endedAt",
)

IPC_MODES = frozenset({"text", "agent-read", "agent-write"})
TASK_PAYLOAD_SCHEMA_VERSION = 6
TASK_RESULT_SCHEMA_VERSION = 6
GIT_DIFF_TIMEOUT_SEC = 120
DELEGATE_EXEC_TIMEOUT_SEC = int(os.environ.get("LLM_PIPELINE_DELEGATE_TIMEOUT_SEC", "900"))
SCRIPT_DIR = os.path.dirname(os.path.realpath(os.path.abspath(__file__)))
WORKSPACE_MANAGER_PATH = os.path.join(SCRIPT_DIR, "workspace_manager.py")


def normalize_path(path: str) -> str:
    return os.path.realpath(os.path.abspath(path))


@dataclass
class TaskPayload:
    id: str
    prompt: str
    mode: str
    timestamp: str
    startedAt: Optional[str] = None
    system: Optional[str] = None
    staticContext: Optional[str] = None
    dynamicContext: Optional[str] = None
    workDir: Optional[str] = None
    sessionId: Optional[str] = None
    stepName: Optional[str] = None
    round: int = 1
    knowledgeBase: Optional[Dict[str, str]] = None
    agentId: Optional[str] = None
    parentHandoffId: Optional[str] = None
    delegateArgv: Optional[List[str]] = None
    delegatePty: bool = False
    delegateAcp: bool = False
    finalizeStrategy: str = "auto"
    sharedLockKey: Optional[str] = None

    @staticmethod
    def _parse_delegate_argv(raw: Any) -> Optional[List[str]]:
        if raw is None:
            return None
        if not isinstance(raw, list) or not raw:
            raise ValueError("TaskPayload delegateArgv must be a non-empty JSON array of strings or omitted")
        out: List[str] = []
        for i, item in enumerate(raw):
            if not isinstance(item, str):
                raise ValueError(f"TaskPayload delegateArgv[{i}] must be a string")
            out.append(item)
        return out

    @staticmethod
    def _parse_knowledge_base(raw: Any) -> Optional[Dict[str, str]]:
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise ValueError("TaskPayload knowledgeBase must be an object (string keys, string values) or omitted")
        out: Dict[str, str] = {}
        for key, val in raw.items():
            if not isinstance(key, str):
                raise ValueError(f"TaskPayload knowledgeBase keys must be strings, got {type(key).__name__}")
            if not isinstance(val, str):
                raise ValueError(
                    f"TaskPayload knowledgeBase values must be strings, got {type(val).__name__} for key {key!r}"
                )
            out[key] = val
        return out

    @staticmethod
    def _parse_finalize_strategy(raw: Any) -> str:
        if raw is None:
            return "auto"
        if raw not in ("auto", "defer"):
            raise ValueError("TaskPayload finalizeStrategy must be 'auto', 'defer', or omitted")
        return str(raw)

    @staticmethod
    def _parse_optional_string(name: str, raw: Any) -> Optional[str]:
        if raw is None:
            return None
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"TaskPayload {name} must be a non-empty string when provided")
        return raw

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskPayload":
        required = ["id", "prompt", "mode", "timestamp"]
        missing = [f for f in required if f not in data]
        if missing:
            raise ValueError(f"TaskPayload missing required fields: {', '.join(missing)}")

        if data["mode"] not in IPC_MODES:
            raise ValueError(f"TaskPayload mode must be one of {sorted(IPC_MODES)}, got {data['mode']!r}")

        schema_version = data.get("schemaVersion")
        if schema_version is not None:
            if type(schema_version) is not int or schema_version < 1:
                raise ValueError("TaskPayload schemaVersion must be a positive integer")
            if schema_version > TASK_PAYLOAD_SCHEMA_VERSION:
                raise ValueError(
                    f"TaskPayload schema version {schema_version} is newer than supported {TASK_PAYLOAD_SCHEMA_VERSION}"
                )

        return cls(
            id=data["id"],
            prompt=data["prompt"],
            mode=data["mode"],
            timestamp=data["timestamp"],
            startedAt=data.get("startedAt"),
            system=data.get("system"),
            staticContext=data.get("staticContext"),
            dynamicContext=data.get("dynamicContext"),
            workDir=data.get("workDir"),
            sessionId=data.get("sessionId"),
            stepName=data.get("stepName"),
            round=data.get("round", 1),
            knowledgeBase=cls._parse_knowledge_base(data.get("knowledgeBase")),
            agentId=data.get("agentId"),
            parentHandoffId=data.get("parentHandoffId"),
            delegateArgv=cls._parse_delegate_argv(data.get("delegateArgv")),
            delegatePty=bool(data.get("delegatePty", False)),
            delegateAcp=bool(data.get("delegateAcp", False)),
            finalizeStrategy=cls._parse_finalize_strategy(data.get("finalizeStrategy")),
            sharedLockKey=cls._parse_optional_string("sharedLockKey", data.get("sharedLockKey")),
        )


@dataclass
class TaskResult:
    id: str
    status: str
    content: str = ""
    usage: Dict[str, int] = field(default_factory=lambda: {"promptTokens": 0, "completionTokens": 0})
    error: Optional[str] = None
    model: str = "unknown"
    summary: Optional[str] = None
    changes: Optional[str] = None
    filesModified: List[str] = field(default_factory=list)
    diffStat: Optional[str] = None
    workspacePath: Optional[str] = None
    workspaceRepoRoot: Optional[str] = None
    workspaceBaseRef: Optional[str] = None
    workspaceSharedLockKey: Optional[str] = None
    schemaVersion: int = TASK_RESULT_SCHEMA_VERSION
    insights: Optional[Dict[str, str]] = None
    nextSteps: Optional[List[Dict[str, Any]]] = None
    startedAt: Optional[str] = None
    endedAt: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "id": self.id,
            "status": self.status,
            "content": self.content,
            "usage": self.usage,
            "model": self.model,
            "filesModified": self.filesModified,
            "schemaVersion": self.schemaVersion,
        }
        if self.error is not None:
            data["error"] = self.error
        if self.summary is not None:
            data["summary"] = self.summary
        if self.changes is not None:
            data["changes"] = self.changes
        if self.diffStat is not None:
            data["diffStat"] = self.diffStat
        if self.workspacePath is not None:
            data["workspacePath"] = self.workspacePath
        if self.workspaceRepoRoot is not None:
            data["workspaceRepoRoot"] = self.workspaceRepoRoot
        if self.workspaceBaseRef is not None:
            data["workspaceBaseRef"] = self.workspaceBaseRef
        if self.workspaceSharedLockKey is not None:
            data["workspaceSharedLockKey"] = self.workspaceSharedLockKey
        if self.insights is not None:
            data["insights"] = self.insights
        if self.nextSteps is not None:
            data["nextSteps"] = self.nextSteps
        if self.startedAt is not None:
            data["startedAt"] = self.startedAt
        if self.endedAt is not None:
            data["endedAt"] = self.endedAt
        return data


def _task_started_at(task: TaskPayload) -> str:
    return task.startedAt or task.timestamp


def _attach_ipc_timing(result: TaskResult, task: TaskPayload) -> TaskResult:
    result.startedAt = _task_started_at(task)
    result.endedAt = datetime.now(timezone.utc).isoformat()
    return result


def _atomic_write_json(filepath: str, data: dict) -> None:
    tmp = filepath + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, filepath)


def _compose_prompt_text(task: TaskPayload) -> str:
    if task.system or task.staticContext:
        parts = []
        if task.system:
            parts.append(task.system)
        if task.staticContext:
            parts.append(task.staticContext)
        if task.dynamicContext:
            parts.append(task.dynamicContext)
        else:
            parts.append(task.prompt)
        return "\n\n".join(parts)
    return task.prompt


# Minimum Gemini CLI version required for ACP (Agent Client Protocol) support.
_ACP_MIN_VERSION = (0, 45, 0)


def _parse_version(version_str: str) -> tuple:
    """Parse a semver string like '0.45.0-preview.1' into a comparable tuple."""
    import re as _re
    m = _re.match(r"(\d+)\.(\d+)\.(\d+)", version_str.strip())
    if not m:
        return (0, 0, 0)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _check_gemini_acp_version(argv: List[str]) -> None:
    """Raise RuntimeError when the installed Gemini CLI is too old to support ACP."""
    cmd = argv[0] if argv else "gemini"
    try:
        result = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=10)
        version_str = (result.stdout or result.stderr or "").strip()
        version = _parse_version(version_str)
        if version < _ACP_MIN_VERSION:
            min_str = ".".join(str(v) for v in _ACP_MIN_VERSION)
            raise RuntimeError(
                f"Gemini CLI {version_str or 'unknown'} does not support ACP. "
                f"Upgrade to v{min_str}+ (currently in preview: "
                f"`npm install -g @google/gemini-cli@0.45.0-preview.1`). "
                f"Alternatively, remove `\"acp\": true` from the provider config to use "
                f"gemini in text mode instead."
            )
    except FileNotFoundError:
        raise RuntimeError(f"Gemini CLI not found at '{cmd}'. Install with: npm install -g @google/gemini-cli")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Timed out checking Gemini CLI version ({cmd} --version).")


def _run_delegate_acp(argv: List[str], cwd: str, prompt_text: str, timeout: int = DELEGATE_EXEC_TIMEOUT_SEC) -> subprocess.CompletedProcess[str]:
    """Run Gemini CLI via ACP (Agent Client Protocol) JSON-RPC over stdio.

    Flow: initialize → authenticate → session/new → session/prompt → wait for response.

    Requires Gemini CLI v0.45.0+. Call _check_gemini_acp_version() before this function.
    """
    _check_gemini_acp_version(argv)

    acp_argv = list(argv)
    if "--acp" not in acp_argv:
        acp_argv.append("--acp")
    # --yolo auto-approves all tool calls (file edits, etc.)
    if "--yolo" not in acp_argv and "--approval-mode" not in " ".join(acp_argv):
        acp_argv.extend(["--approval-mode", "yolo"])

    proc = subprocess.Popen(
        acp_argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        bufsize=1,
    )

    req_id = 0

    def send(method: str, params: Dict[str, Any]) -> int:
        nonlocal req_id
        req_id += 1
        msg = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
        proc.stdin.write(msg)  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]
        return req_id

    def recv(wait_id: int, timeout_secs: float = 10.0) -> Dict[str, Any]:
        deadline = time.time() + timeout_secs
        while time.time() < deadline:
            ready, _, _ = select.select([proc.stdout, proc.stderr], [], [], 0.3)  # type: ignore[arg-type]
            for fd in ready:
                line = fd.readline()  # type: ignore[attr-defined]
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    if obj.get("id") == wait_id:
                        return obj
                except (json.JSONDecodeError, ValueError):
                    pass
        raise RuntimeError(f"ACP: timed out waiting for response to request {wait_id}")

    output_lines: List[str] = []

    try:
        # 1. initialize
        iid = send("initialize", {
            "protocolVersion": 1,
            "capabilities": {},
            "clientInfo": {"name": "llm-pipeline", "version": "1.0"},
        })
        recv(iid, timeout_secs=10)

        # 2. authenticate (skip credential prompts — use cached OAuth)
        aid = send("authenticate", {"methodId": "oauth-personal"})
        recv(aid, timeout_secs=10)

        # 3. session/new
        sid_req = send("session/new", {"cwd": cwd, "mcpServers": []})
        s_resp = recv(sid_req, timeout_secs=15)
        if "error" in s_resp:
            raise RuntimeError(f"ACP session/new failed: {s_resp['error']}")
        session_id = s_resp["result"]["sessionId"]

        # 4. session/prompt — send the task and collect streaming updates
        pid_req = send("session/prompt", {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": prompt_text}],
        })

        # Drain until we get the final response for the prompt request.
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([proc.stdout, proc.stderr], [], [], 0.5)  # type: ignore[arg-type]
            for fd in ready:
                line = fd.readline()  # type: ignore[attr-defined]
                if not line.strip():
                    continue
                output_lines.append(line)
                try:
                    obj = json.loads(line)
                    # Collect agent text chunks for the summary.
                    if obj.get("method") == "session/update":
                        upd = obj.get("params", {}).get("update", {})
                        if upd.get("sessionUpdate") == "agent_message_chunk":
                            text = upd.get("content", {}).get("text", "")
                            if text:
                                output_lines.append(text)
                    # Final response: id matches the prompt request.
                    if obj.get("id") == pid_req:
                        if "error" in obj:
                            raise RuntimeError(f"ACP session/prompt failed: {obj['error']}")
                        # Done — return collected output as stdout.
                        summary = "".join(
                            l for l in output_lines if not l.startswith("{")
                        ).strip()
                        return subprocess.CompletedProcess(
                            acp_argv, 0, stdout=summary or "ACP task completed.", stderr=""
                        )
                except (json.JSONDecodeError, ValueError):
                    pass

        raise RuntimeError(f"ACP: timed out waiting for session/prompt response (>{timeout}s)")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def _run_delegate(argv: List[str], cwd: str, stdin_text: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        input=stdin_text,
        text=True,
        capture_output=True,
        timeout=DELEGATE_EXEC_TIMEOUT_SEC,
    )


def _run_delegate_pty(argv: List[str], cwd: str, stdin_text: str, timeout: int = DELEGATE_EXEC_TIMEOUT_SEC) -> subprocess.CompletedProcess[str]:
    """Run delegate with a pseudo-TTY so the child process sees isatty()==True.

    Strategy:
    1. Open a pty pair and set a sensible terminal size.
    2. Spawn the CLI attached to the slave end.
    3. Read output until we see the input-prompt sentinel ("Type your message").
    4. Write the task prompt followed by a newline.
    5. Use a silence-based completion detector: once output stops for
       PTY_SILENCE_SEC seconds after the last byte, assume the task is done.
    6. Send /quit to exit the CLI cleanly.
    """
    PTY_SILENCE_SEC = 4.0   # seconds of silence → task considered complete
    PTY_ROWS, PTY_COLS = 50, 220

    master_fd, slave_fd = pty.openpty()

    # Set terminal dimensions — TUI apps need this to render correctly.
    winsize = struct.pack('HHHH', PTY_ROWS, PTY_COLS, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    proc = subprocess.Popen(
        argv,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=cwd,
        close_fds=True,
    )
    os.close(slave_fd)

    # Set master non-blocking so select() works cleanly.
    fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    def _write_bytes(data: bytes) -> None:
        written = 0
        while written < len(data):
            try:
                n = os.write(master_fd, data[written:])
                written += n
            except BlockingIOError:
                time.sleep(0.02)

    # Sentinel text that appears once Gemini has rendered its input prompt.
    READY_SENTINEL = b"Type your message"

    output_chunks: List[bytes] = []
    accumulated = b""
    deadline = time.time() + timeout
    prompt_sent = False
    quit_sent = False
    last_output_time = time.time()

    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            proc.kill()
            proc.wait()
            os.close(master_fd)
            raise subprocess.TimeoutExpired(argv, timeout)

        ready, _, _ = select.select([master_fd], [], [], min(remaining, 0.3))
        if ready:
            try:
                chunk = os.read(master_fd, 4096)
                if chunk:
                    output_chunks.append(chunk)
                    accumulated += chunk
                    last_output_time = time.time()
                    if not prompt_sent and READY_SENTINEL in accumulated:
                        # CLI is ready — brief pause then send the task prompt.
                        time.sleep(0.5)
                        _write_bytes((stdin_text.rstrip("\n") + "\n").encode())
                        prompt_sent = True
                        last_output_time = time.time()
                else:
                    break  # EOF on master
            except OSError:
                break  # slave fd closed

        if proc.poll() is not None:
            # Process already exited — drain remaining output.
            time.sleep(0.1)
            try:
                while True:
                    chunk = os.read(master_fd, 4096)
                    if not chunk:
                        break
                    output_chunks.append(chunk)
            except OSError:
                pass
            break

        # After prompt is sent, use silence detection to know when Gemini is done.
        if prompt_sent and not quit_sent:
            silence = time.time() - last_output_time
            if silence >= PTY_SILENCE_SEC:
                _write_bytes(b"/quit\n")
                quit_sent = True
                # Give the CLI a moment to process /quit and exit.
                time.sleep(1.0)

    os.close(master_fd)
    if proc.poll() is None:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    returncode = proc.returncode or 0

    raw_output = b"".join(output_chunks).decode(errors="replace")
    # Strip ANSI escape sequences and carriage returns.
    clean_output = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r", "", raw_output)
    return subprocess.CompletedProcess(argv, returncode, stdout=clean_output, stderr="")


def _git_output(args: List[str], cwd: str, timeout: int = GIT_DIFF_TIMEOUT_SEC) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, timeout=timeout)


def _resolve_repo_root(path: str) -> str:
    return normalize_path(_git_output(["rev-parse", "--show-toplevel"], path).strip())


def _resolve_source_repo_root(path: str) -> str:
    # git rev-parse --git-common-dir may return an absolute path like /repo/.git (main worktree)
    # or /repo/.git/worktrees/<name> (linked worktree). In both cases the source repo is the
    # directory containing the .git component.
    common_dir_raw = _git_output(["rev-parse", "--git-common-dir"], path).strip()
    common_dir = normalize_path(common_dir_raw)
    parts = common_dir.replace("\\", "/").split("/")
    try:
        git_idx = next(i for i in range(len(parts) - 1, -1, -1) if parts[i] == ".git")
        return normalize_path("/".join(parts[:git_idx]))
    except StopIteration:
        return normalize_path(path)


def _is_inside_linked_worktree(path: str) -> bool:
    git_dir = _git_output(["rev-parse", "--git-dir"], path).strip().replace("\\", "/")
    return "/worktrees/" in git_dir or ".git/worktrees" in git_dir


def _run_workspace_manager(cmd: str, **kwargs: Any) -> Dict[str, Any]:
    argv = ["python3", WORKSPACE_MANAGER_PATH, cmd]
    for key, value in kwargs.items():
        if value is None or value is False or value == "":
            continue
        flag = f"--{key.replace('_', '-')}"
        if value is True:
            argv.append(flag)
            continue
        argv.extend([flag, str(value)])

    proc = subprocess.run(argv, capture_output=True, text=True)
    output = (proc.stdout or "").strip()

    if proc.returncode != 0 and not output:
        raise RuntimeError((proc.stderr or "").strip() or f"workspace_manager {cmd} failed")

    for line in reversed(output.splitlines() if output else []):
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            if data.get("error"):
                raise RuntimeError(str(data["error"]))
            return data

    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or output).strip() or f"workspace_manager {cmd} failed")
    raise RuntimeError(f"workspace_manager {cmd} returned no JSON payload")


def _map_workdir_to_worktree(original_work_dir: str, repo_root: str, worktree_root: str) -> str:
    abs_work_dir = normalize_path(original_work_dir)
    abs_repo_root = normalize_path(repo_root)
    rel = os.path.relpath(abs_work_dir, abs_repo_root)
    if rel == ".":
        return worktree_root
    mapped = normalize_path(os.path.join(worktree_root, rel))
    os.makedirs(mapped, exist_ok=True)
    return mapped


def run_git_diff(cwd: str):
    try:
        try:
            subprocess.run(["git", "add", "-N", "."], cwd=cwd, check=False, capture_output=True, text=True)
        except Exception:
            pass
        diff = _git_output(["diff", "HEAD"], cwd)
        files_out = _git_output(["diff", "--name-only", "HEAD"], cwd)
        stat = _git_output(["diff", "--stat", "HEAD"], cwd)
        files = [line for line in files_out.splitlines() if line.strip()]
        return diff, files, stat
    except subprocess.TimeoutExpired:
        return None, [], "git diff timed out"
    except Exception as err:
        return None, [], str(err)


def _decode_patch_bytes(encoded: Optional[str]) -> bytes:
    if not encoded:
        return b""
    return base64.b64decode(encoded.encode("utf-8"))


def _apply_patch_to_repo(repo_root: str, patch_bytes: bytes) -> None:
    if not patch_bytes:
        return
    with tempfile.NamedTemporaryFile(prefix="llm-task-runner-", suffix=".patch", delete=False) as tmp:
        tmp.write(patch_bytes)
        tmp_path = tmp.name
    try:
        _run_workspace_manager("apply", repo=repo_root, patch_file=tmp_path, owner_pid=os.getpid())
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _inject_dir_flag(argv: List[str], work_dir: str) -> List[str]:
    """Inject --dir <work_dir> for opencode so it resolves the project root from the
    worktree directory rather than tracing back through .git to the source repo."""
    if not argv or not work_dir:
        return argv
    cmd_base = os.path.basename(argv[0]).lower()
    if not (cmd_base == "opencode" or cmd_base.startswith("opencode.")):
        return argv
    if "--dir" in argv:
        return argv
    return list(argv) + ["--dir", work_dir]


def _execute_delegate_or_stub(task: TaskPayload, work_dir: str, final_prompt: str) -> str:
    if task.delegateArgv:
        effective_argv = _inject_dir_flag(task.delegateArgv, work_dir)
        try:
            if task.delegateAcp:
                proc = _run_delegate_acp(effective_argv, work_dir, final_prompt)
            elif task.delegatePty:
                proc = _run_delegate_pty(effective_argv, work_dir, final_prompt)
            else:
                proc = _run_delegate(effective_argv, work_dir, final_prompt)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"delegateArgv subprocess timed out after {DELEGATE_EXEC_TIMEOUT_SEC}s")
        if proc.returncode != 0:
            err_tail = (proc.stderr or proc.stdout or "").strip()[:8000]
            raise RuntimeError(f"delegateArgv exited {proc.returncode}: {err_tail}")
        return (proc.stdout or "").strip()
    return f"Executed prompt (stub runner, no delegateArgv): {final_prompt[:100]}..."


def _build_summary(delegate_out: str, work_dir: str) -> str:
    return delegate_out if delegate_out else f"delegate completed in {work_dir}"


def _execute_agent_task(task: TaskPayload, work_dir: str, final_prompt: str) -> TaskResult:
    repo_root = _resolve_repo_root(work_dir)
    defer_finalize = task.finalizeStrategy == "defer"
    inside_linked_worktree = _is_inside_linked_worktree(work_dir)

    if inside_linked_worktree and not defer_finalize:
        worktree_root = _resolve_repo_root(work_dir)
        print(f"Session workspace (reusing): {worktree_root}", flush=True)
        delegate_out = _execute_delegate_or_stub(task, work_dir, final_prompt)
        diff, files, stat = run_git_diff(worktree_root)
        return TaskResult(
            id=task.id,
            status="success",
            summary=_build_summary(delegate_out, work_dir),
            changes=diff if diff is not None else "",
            filesModified=files,
            diffStat=stat if isinstance(stat, str) else str(stat or ""),
        )

    session_id = task.id if defer_finalize else (task.sessionId or task.id)
    create_repo_root = repo_root
    result_repo_root = repo_root
    base_ref_override: Optional[str] = None
    parent_patch_bytes = b""

    if defer_finalize and inside_linked_worktree:
        create_repo_root = _resolve_repo_root(work_dir)
        result_repo_root = _resolve_source_repo_root(create_repo_root)
        base_ref_override = _git_output(["rev-parse", "HEAD"], create_repo_root).strip()
        parent_collect = _run_workspace_manager(
            "collect",
            worktree=create_repo_root,
            base_ref=base_ref_override,
        )
        parent_patch_bytes = _decode_patch_bytes(parent_collect.get("patch"))

    create_result = _run_workspace_manager(
        "create",
        repo=create_repo_root,
        session=session_id,
        owner_pid=os.getpid(),
        shared_lock_key=task.sharedLockKey,
        base_ref=base_ref_override,
        allow_dirty=True if (defer_finalize and inside_linked_worktree) else None,
    )
    worktree_root = normalize_path(str(create_result["worktreePath"]))
    # Use create_result["baseRef"] as canonical; when base_ref_override was supplied
    # (defer+linked path) workspace_manager echoes it back unchanged, so both are consistent.
    base_ref = str(create_result["baseRef"])
    # Sanity-check: override and result must agree when both are set.
    if base_ref_override and base_ref_override != base_ref:
        raise RuntimeError(
            f"base_ref mismatch: requested {base_ref_override!r} but workspace returned {base_ref!r}"
        )
    exec_dir = _map_workdir_to_worktree(work_dir, create_repo_root, worktree_root)
    print(f"Isolated worktree: {worktree_root}", flush=True)

    should_destroy = True
    try:
        if parent_patch_bytes:
            _apply_patch_to_repo(worktree_root, parent_patch_bytes)
        delegate_out = _execute_delegate_or_stub(task, exec_dir, final_prompt)
        diff, files, stat = run_git_diff(worktree_root)
        collect_result = _run_workspace_manager("collect", worktree=worktree_root, base_ref=base_ref)
        result = TaskResult(
            id=task.id,
            status="success",
            summary=_build_summary(delegate_out, exec_dir),
            changes=diff if diff is not None else "",
            filesModified=files,
            diffStat=stat if isinstance(stat, str) else str(stat or ""),
        )
        if defer_finalize:
            result.workspacePath = worktree_root
            # Source repo for apply/lock; create_repo_root may be a linked parent worktree.
            result.workspaceRepoRoot = result_repo_root
            result.workspaceBaseRef = base_ref
            result.workspaceSharedLockKey = task.sharedLockKey
            should_destroy = False  # set last — any exception above still triggers destroy
            return result
        if task.mode == "agent-write":
            _apply_patch_to_repo(repo_root, _decode_patch_bytes(collect_result.get("patch")))
        return result
    finally:
        if should_destroy:
            try:
                _run_workspace_manager(
                    "destroy",
                    repo=create_repo_root,
                    worktree=worktree_root,
                    owner_pid=os.getpid(),
                    shared_lock_key=task.sharedLockKey,
                )
            except Exception as err:
                print(f"workspace destroy warning: {err}", file=sys.stderr, flush=True)


def execute_oneshot(task_file: str, result_file: str) -> None:
    try:
        with open(task_file, "r") as f:
            task = TaskPayload.from_dict(json.load(f))
    except Exception as err:
        _atomic_write_json(result_file, TaskResult(id="unknown", status="error", error=f"IPC Payload Error: {err}").to_dict())
        return

    work_dir = normalize_path(task.workDir) if task.workDir else os.getcwd()
    if not os.path.isdir(work_dir):
        _atomic_write_json(
            result_file,
            TaskResult(id=task.id, status="error", error=f"work_dir does not exist or is not a directory: {work_dir}").to_dict(),
        )
        return

    final_prompt = _compose_prompt_text(task)

    try:
        if task.mode in ("agent-write", "agent-read"):
            result = _execute_agent_task(task, work_dir, final_prompt)
        else:
            content = _execute_delegate_or_stub(task, work_dir, final_prompt)
            result = TaskResult(id=task.id, status="success", content=content)
        _atomic_write_json(result_file, _attach_ipc_timing(result, task).to_dict())
    except Exception as err:
        err_result = TaskResult(id=task.id, status="error", error=str(err))
        _atomic_write_json(result_file, _attach_ipc_timing(err_result, task).to_dict())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LLM Pipeline Task Runner (Wave 5: One-shot)")
    parser.print_help = lambda: None
    parser.add_argument("task_file", help="Path to the JSON task file")
    parser.add_argument("result_file", help="Path where to write the JSON result")
    args = parser.parse_args()
    execute_oneshot(args.task_file, args.result_file)
