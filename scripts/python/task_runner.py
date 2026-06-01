#!/usr/bin/env python3
import argparse
import base64
import fcntl
import json
import os
import pty
import re
import select
import subprocess
import sys
import tempfile
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

    Uses pty.openpty() to create a master/slave pair. The child's stdin/stdout/stderr
    are all connected to the slave fd. We write the prompt to the master, then read
    all output until the process exits or the timeout fires.
    """
    master_fd, slave_fd = pty.openpty()

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
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    output_chunks: List[bytes] = []
    deadline = time.time() + timeout
    prompt_sent = False
    quit_sent = False
    # Accumulated output for ready-signal detection.
    accumulated = b""
    # Sentinel that indicates the CLI is ready to accept input.
    # Gemini CLI prints "YOLO mode is enabled." before its prompt.
    READY_SENTINEL = b"mode is enabled"

    def _write_bytes(fd: int, data: bytes) -> None:
        written = 0
        while written < len(data):
            try:
                n = os.write(fd, data[written:])
                written += n
            except BlockingIOError:
                time.sleep(0.02)

    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            proc.kill()
            proc.wait()
            os.close(master_fd)
            raise subprocess.TimeoutExpired(argv, timeout)

        ready, _, _ = select.select([master_fd], [], [], min(remaining, 0.5))
        if ready:
            try:
                chunk = os.read(master_fd, 4096)
                if chunk:
                    output_chunks.append(chunk)
                    accumulated += chunk
                    # Send prompt once CLI signals readiness.
                    if not prompt_sent and READY_SENTINEL in accumulated:
                        time.sleep(0.3)  # Let any further startup output flush.
                        _write_bytes(master_fd, (stdin_text.rstrip("\n") + "\n").encode())
                        prompt_sent = True
                else:
                    break  # EOF
            except OSError:
                break  # slave closed

        if proc.poll() is not None:
            # Process exited — drain remaining output.
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

        # After prompt is sent, watch for a completion indicator, then send /quit.
        if prompt_sent and not quit_sent:
            recent = b"".join(output_chunks[-10:])
            # Gemini prints something like "has been updated" or file content when done.
            # We use a 3-second silence window: if no new output for 3s after prompt, assume done.
            # Simpler: just send /quit after a fixed wait post-prompt.
            if b"\n" in recent and len(recent) > 100:
                time.sleep(2.0)  # Wait for Gemini to finish writing the file.
                _write_bytes(master_fd, b"/quit\n")
                quit_sent = True

    os.close(master_fd)
    returncode = proc.wait(timeout=5) if proc.poll() is None else proc.returncode
    raw_output = b"".join(output_chunks).decode(errors="replace")
    # Strip terminal control sequences (basic ANSI escape codes).
    clean_output = re.sub(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\r", "", raw_output)
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


def _execute_delegate_or_stub(task: TaskPayload, work_dir: str, final_prompt: str) -> str:
    if task.delegateArgv:
        try:
            if task.delegatePty:
                proc = _run_delegate_pty(task.delegateArgv, work_dir, final_prompt)
            else:
                proc = _run_delegate(task.delegateArgv, work_dir, final_prompt)
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
