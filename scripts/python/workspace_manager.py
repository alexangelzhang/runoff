#!/usr/bin/env python3
"""
Centralized workspace manager for runoff.
Orchestrates isolated git worktrees, collects patches, applies changes natively,
and manages OS-level directory locks for concurrent safety across TS pipelines and Python Watcher agents.

Lock contract (issue 6.12)
--------------------------
- Default (shared_lock_key omitted / None): **exclusive** lock per repo. Each acquirer gets a unique
  effective key so two ordinary pipeline sessions never share the same lock directory entry.
- Opt-in sharing: pass the **same** non-empty `shared_lock_key` (e.g. trace/session id for races)
  so multiple processes may hold the lock concurrently when keys match.
- TS callers: `SessionWorkspace.create({ sharedLockKey: "..." })` only when intentional; omit for isolation.
"""

import argparse
import errno
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
import base64
import random

def random_id():
    return uuid.uuid4().hex[:8]

def normalize_path(path):
    return os.path.realpath(os.path.abspath(path))


def pipeline_home_dir():
    return normalize_path(
        os.environ.get(
            "RUNOFF_HOME", os.path.join(os.path.expanduser("~"), ".runoff")
        )
    )


def managed_workspaces_dir():
    return normalize_path(os.path.join(pipeline_home_dir(), "workspaces"))


def is_subpath(path, root):
    path = normalize_path(path)
    root = normalize_path(root)
    return path == root or path.startswith(root + os.sep)


def is_registered_worktree(repo_root, worktree_path):
    try:
        output = git(["worktree", "list", "--porcelain"], repo_root)
    except Exception:
        return False
    target = normalize_path(worktree_path)
    for line in output.splitlines():
        if not line.startswith("worktree "):
            continue
        candidate = normalize_path(line[len("worktree "):])
        if candidate == target:
            return True
    return False

def git(cmd_args, cwd, timeout=120):
    result = subprocess.run(
        ["git"] + cmd_args, capture_output=True, text=True, cwd=cwd, timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(f"Git {' '.join(cmd_args)} failed:\n{result.stderr.strip()}")
    return result.stdout.strip()

def git_bytes(cmd_args, cwd):
    result = subprocess.run(
        ["git"] + cmd_args, capture_output=True, cwd=cwd
    )
    if result.returncode != 0:
        raise RuntimeError(f"Git {' '.join(cmd_args)} failed:\n{result.stderr.decode('utf-8', 'ignore').strip()}")
    return result.stdout

class RepoLock:
    """Read/Write-like cross-process directory lock.
    Multiple processes sharing the same shared_lock_key can access concurrently.
    The lock persists until all owner_pids die or manually release it.
    """
    def __init__(self, repo_root, shared_lock_key=None):
        self.repo_root = normalize_path(repo_root)
        # P0 Fix: Do NOT default to "default". Keep it as None to represent exclusive mode.
        self.shared_lock_key = shared_lock_key
        
        self.locks_dir = os.path.join(pipeline_home_dir(), "locks")
        os.makedirs(self.locks_dir, exist_ok=True)
        
        repo_id = hashlib.sha256(self.repo_root.encode("utf-8")).hexdigest()[:16]
        self.lock_dir = os.path.join(self.locks_dir, f"{repo_id}.lockdir")

    def acquire(self, pid, timeout=30):
        start_time = time.time()
        attempt = 0
        base_sleep = 0.1
        max_sleep = 2.0
        # Exclusive mode: single sentinel in `owner` so all holders agree this repo is taken.
        # (Random per-pid strings are only for debugging; mutual exclusion is ref_pid + this sentinel.)
        effective_key = (
            self.shared_lock_key
            if self.shared_lock_key
            else "__exclusive__"
        )

        while True:
            try:
                os.mkdir(self.lock_dir)
                # Write ref_* before owner so _clean_stale_lock never sees an "empty" lockdir
                # while another process is between mkdir and first ref (TOCTOU steal).
                with open(os.path.join(self.lock_dir, f"ref_{pid}"), "w") as f:
                    f.write(str(pid))
                with open(os.path.join(self.lock_dir, "owner"), "w") as f:
                    f.write(effective_key)
                return True
            except OSError as e:
                if e.errno == errno.EEXIST:
                    try:
                        with open(os.path.join(self.lock_dir, "owner"), "r") as f:
                            owner = f.read().strip()
                    except OSError:
                        owner = None

                    if self.shared_lock_key and owner == self.shared_lock_key:
                        with open(os.path.join(self.lock_dir, f"ref_{pid}"), "w") as f:
                            f.write(str(pid))
                        return True

                    if self._clean_stale_lock():
                        continue
                        
                    if timeout > 0 and (time.time() - start_time) < timeout:
                        attempt += 1
                        # Exponential backoff with jitter
                        sleep_time = min(max_sleep, base_sleep * (2 ** attempt) + random.uniform(0, 0.1))
                        time.sleep(sleep_time)
                        continue
                        
                    waited_ms = int((time.time() - start_time) * 1000)
                    raise RuntimeError(
                        "REPO_LOCK_TIMEOUT "
                        f"repo={self.repo_root} waited_ms={waited_ms} lock_dir={self.lock_dir}"
                    )
                raise

    def release(self, pid):
        ref_file = os.path.join(self.lock_dir, f"ref_{pid}")
        try:
            os.remove(ref_file)
        except OSError:
            pass
            
        self._clean_stale_lock()

    def is_held_by(self, pid):
        ref_file = os.path.join(self.lock_dir, f"ref_{pid}")
        if not os.path.exists(ref_file):
            return False
        try:
            with open(os.path.join(self.lock_dir, "owner"), "r") as f:
                owner = f.read().strip()
        except OSError:
            return False
        effective_key = self.shared_lock_key if self.shared_lock_key else "__exclusive__"
        return owner == effective_key

    def _clean_stale_lock(self):
        try:
            owner_path = os.path.join(self.lock_dir, "owner")
            ref_files = [f for f in os.listdir(self.lock_dir) if f.startswith("ref_")]

            # No refs yet: either in-flight acquire (mkdir → ref → owner) or orphan mkdir.
            if not ref_files:
                if not os.path.isfile(owner_path):
                    try:
                        st = os.stat(self.lock_dir)
                        if time.time() - st.st_mtime < 3.0:
                            return False
                    except OSError:
                        return False
                shutil.rmtree(self.lock_dir, ignore_errors=True)
                return True

            alive = 0
            for f in ref_files:
                pid_str = f[4:]
                try:
                    p = int(pid_str)
                    os.kill(p, 0)
                    alive += 1
                except ValueError:
                    try:
                        os.remove(os.path.join(self.lock_dir, f))
                    except OSError:
                        pass
                except ProcessLookupError:
                    try:
                        os.remove(os.path.join(self.lock_dir, f))
                    except OSError:
                        pass
                except OSError as e:
                    # Only treat as dead when the PID does not exist. EPERM / other errors
                    # mean we cannot probe cross-process; assume the holder is still live
                    # (otherwise we rmtree a valid lock and a second client gets LOCKED).
                    if e.errno == errno.ESRCH:
                        try:
                            os.remove(os.path.join(self.lock_dir, f))
                        except OSError:
                            pass
                    else:
                        alive += 1

            if alive == 0:
                shutil.rmtree(self.lock_dir, ignore_errors=True)
                return True
        except OSError:
            pass
        return False

def do_create(args):
    repo_root = args.repo
    session_id = args.session
    base_ref = args.base_ref
    
    lock = RepoLock(repo_root, args.shared_lock_key)
    try:
        lock.acquire(args.owner_pid, timeout=30)
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)
    
    try:
        # --allow-dirty is only valid when the source repo is itself a linked worktree.
        # Reject the flag for ordinary (main) repos to prevent accidental dirty-state escapes.
        if args.allow_dirty:
            git_dir = subprocess.check_output(
                ["git", "rev-parse", "--git-dir"], cwd=repo_root, text=True
            ).strip().replace("\\", "/")
            if "/worktrees/" not in git_dir and ".git/worktrees" not in git_dir:
                lock.release(args.owner_pid)
                sys.stdout.write(json.dumps({"error": "--allow-dirty is only permitted when --repo is a linked worktree"}))
                sys.exit(1)

        status = git(["status", "--porcelain"], repo_root)
        if status and not args.allow_dirty:
            lock.release(args.owner_pid)
            sys.stdout.write(json.dumps({"error": f"workDir has uncommitted changes.\n{status[:500]}"}))
            sys.exit(1)
    except Exception as e:
        lock.release(args.owner_pid)
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)

    try:
        if not base_ref:
            base_ref = git(["rev-parse", "HEAD"], repo_root)

        workspaces_dir = managed_workspaces_dir()
        os.makedirs(workspaces_dir, exist_ok=True)
        worktree_path = normalize_path(os.path.join(workspaces_dir, f"session-{session_id}"))

        if os.path.exists(worktree_path):
            try:
                git(["worktree", "remove", "--force", worktree_path], repo_root)
            except Exception:
                shutil.rmtree(worktree_path, ignore_errors=True)
                try:
                    git(["worktree", "prune"], repo_root)
                except Exception: pass
            
            if os.path.exists(worktree_path):
                raise RuntimeError(f"Failed to cleanly remove existing worktree directory: {worktree_path}")

        git(["worktree", "add", "--detach", "--force", worktree_path, base_ref], repo_root)
    except Exception as e:
        lock.release(args.owner_pid)
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)

    sys.stdout.write(json.dumps({"worktreePath": worktree_path, "baseRef": base_ref}))

def _validate_worktree_path(worktree_path, repo_root):
    """Allow repo-local worktrees, registered git worktrees, and managed external workspaces."""
    real_worktree = normalize_path(worktree_path)
    allowed_roots = [normalize_path(repo_root), managed_workspaces_dir()]
    if any(is_subpath(real_worktree, root) for root in allowed_roots):
        return
    if is_registered_worktree(repo_root, real_worktree):
        return
    raise ValueError(
        f"Worktree path {worktree_path} is outside allowed roots and is not a registered worktree"
    )

def do_collect(args):
    worktree_path = args.worktree
    base_ref = args.base_ref
    
    try:
        git(["add", "-N", "."], worktree_path)
    except Exception:
        pass

    try:
        patch_bytes = git_bytes(["diff", "--binary", base_ref], worktree_path)
        diff_stat = git(["diff", base_ref, "--stat"], worktree_path)
        files_raw = git(["diff", base_ref, "--name-only"], worktree_path)
        files_modified = [f for f in files_raw.split("\n") if f.strip()]
        
        sys.stdout.write(json.dumps({
            "patch": base64.b64encode(patch_bytes).decode('utf-8') if patch_bytes else "",
            "diffStat": diff_stat,
            "filesModified": files_modified
        }))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)

def do_apply(args):
    repo_root = args.repo
    lock = RepoLock(repo_root, args.shared_lock_key)
    acquired_here = False
    try:
        if not lock.is_held_by(args.owner_pid):
            lock.acquire(args.owner_pid, timeout=30)
            acquired_here = True
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)

    try:
        with open(args.patch_file, "rb") as f:
            patch_bytes = f.read()

        if patch_bytes:
            # --3way handles conflicts gracefully for modified files but fails for
            # brand-new files that have no base in the index.  Fall back to plain
            # apply so that patches adding new files also succeed.
            try:
                subprocess.run(
                    ["git", "apply", "--binary", "--3way", args.patch_file],
                    cwd=repo_root,
                    check=True,
                    capture_output=True
                )
            except subprocess.CalledProcessError:
                subprocess.run(
                    ["git", "apply", "--binary", args.patch_file],
                    cwd=repo_root,
                    check=True,
                    capture_output=True
                )
        sys.stdout.write(json.dumps({"status": "ok"}))
    except subprocess.CalledProcessError as e:
        sys.stdout.write(json.dumps({"error": e.stderr.decode('utf-8', 'ignore')}))
        sys.exit(1)
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)
    finally:
        if acquired_here:
            lock.release(args.owner_pid)

def do_destroy(args):
    repo_root = args.repo
    worktree_path = args.worktree

    try:
        _validate_worktree_path(worktree_path, repo_root)
        if os.path.exists(worktree_path):
            try:
                git(["worktree", "remove", "--force", worktree_path], repo_root)
            except Exception:
                shutil.rmtree(worktree_path, ignore_errors=True)
                try:
                    git(["worktree", "prune"], repo_root)
                except Exception: pass
            
        lock = RepoLock(repo_root, args.shared_lock_key)
        lock.release(args.owner_pid)
        sys.stdout.write(json.dumps({"status": "ok"}))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)

def do_release(args):
    repo_root = args.repo
    lock = RepoLock(repo_root, args.shared_lock_key)
    lock.release(args.owner_pid)
    sys.stdout.write(json.dumps({"status": "ok"}))

def do_lock(args):
    repo_root = args.repo
    lock = RepoLock(repo_root, args.shared_lock_key)
    try:
        lock.acquire(args.owner_pid, timeout=30)
        sys.stdout.write(json.dumps({"status": "ok"}))
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="LLM Pipeline Workspace Manager")
    subparsers = parser.add_subparsers(dest="cmd", required=True)
    
    p_create = subparsers.add_parser("create")
    p_create.add_argument("--repo", required=True)
    p_create.add_argument("--session", required=True)
    p_create.add_argument("--owner-pid", type=int, required=True)
    p_create.add_argument("--shared-lock-key", default="")
    p_create.add_argument("--base-ref", default="")
    p_create.add_argument("--allow-dirty", action="store_true")
    p_create.set_defaults(func=do_create)
    
    p_collect = subparsers.add_parser("collect")
    p_collect.add_argument("--worktree", required=True)
    p_collect.add_argument("--base-ref", required=True)
    p_collect.set_defaults(func=do_collect)
    
    p_apply = subparsers.add_parser("apply")
    p_apply.add_argument("--repo", required=True)
    p_apply.add_argument("--patch-file", required=True)
    p_apply.add_argument("--owner-pid", type=int, required=True)
    p_apply.add_argument("--shared-lock-key", default="")
    p_apply.set_defaults(func=do_apply)
    
    p_destroy = subparsers.add_parser("destroy")
    p_destroy.add_argument("--repo", required=True)
    p_destroy.add_argument("--worktree", required=True)
    p_destroy.add_argument("--owner-pid", type=int, required=True)
    p_destroy.add_argument("--shared-lock-key", default="")
    p_destroy.set_defaults(func=do_destroy)
    
    p_release = subparsers.add_parser("release")
    p_release.add_argument("--repo", required=True)
    p_release.add_argument("--owner-pid", type=int, required=True)
    p_release.add_argument("--shared-lock-key", default="")
    p_release.set_defaults(func=do_release)

    p_lock = subparsers.add_parser("lock")
    p_lock.add_argument("--repo", required=True)
    p_lock.add_argument("--owner-pid", type=int, required=True)
    p_lock.add_argument("--shared-lock-key", default="")
    p_lock.set_defaults(func=do_lock)

    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
