#!/usr/bin/env python3
"""
Centralized workspace manager for llm-pipeline.
Orchestrates isolated git worktrees, collects patches, applies changes natively,
and manages OS-level directory locks for concurrent safety across TS pipelines and Python Watcher agents.
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

def git(cmd_args, cwd):
    result = subprocess.run(
        ["git"] + cmd_args, capture_output=True, text=True, cwd=cwd
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
        
        pipeline_home = os.environ.get(
            "LLM_PIPELINE_HOME", os.path.join(os.path.expanduser("~"), ".llm-pipeline")
        )
        self.locks_dir = os.path.join(pipeline_home, "locks")
        os.makedirs(self.locks_dir, exist_ok=True)
        
        repo_id = hashlib.sha256(self.repo_root.encode("utf-8")).hexdigest()[:16]
        self.lock_dir = os.path.join(self.locks_dir, f"{repo_id}.lockdir")

    def acquire(self, pid, timeout=30):
        start_time = time.time()
        attempt = 0
        base_sleep = 0.1
        max_sleep = 2.0
        # If no shared key provided, we are in exclusive mode. 
        # We use a unique marker to prevent accidental "None == None" sharing.
        effective_key = self.shared_lock_key if self.shared_lock_key else f"exclusive_{pid}_{random_id()}"

        while True:
            try:
                os.mkdir(self.lock_dir)
                with open(os.path.join(self.lock_dir, "owner"), "w") as f:
                    f.write(effective_key)
                with open(os.path.join(self.lock_dir, f"ref_{pid}"), "w") as f:
                    f.write(str(pid))
                return True
            except OSError as e:
                if e.errno == errno.EEXIST:
                    try:
                        with open(os.path.join(self.lock_dir, "owner"), "r") as f:
                            owner = f.read().strip()
                    except OSError:
                        owner = None

                    # Only allow sharing if key matches AND it's not our auto-generated exclusive key
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
                        
                    raise RuntimeError(f"Repository is locked by another session (lock: {self.lock_dir})")
                raise

    def release(self, pid):
        ref_file = os.path.join(self.lock_dir, f"ref_{pid}")
        try:
            os.remove(ref_file)
        except OSError:
            pass
            
        self._clean_stale_lock()

    def _clean_stale_lock(self):
        try:
            ref_files = [f for f in os.listdir(self.lock_dir) if f.startswith("ref_")]
            alive = 0
            for f in ref_files:
                pid_str = f[4:]
                try:
                    p = int(pid_str)
                    os.kill(p, 0)
                    alive += 1
                except (OSError, ValueError):
                    try:
                        os.remove(os.path.join(self.lock_dir, f))
                    except OSError:
                        pass
            
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
        status = git(["status", "--porcelain"], repo_root)
        if status:
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

        pipeline_home = os.environ.get(
            "LLM_PIPELINE_HOME", os.path.join(os.path.expanduser("~"), ".llm-pipeline")
        )
        workspaces_dir = os.path.join(pipeline_home, "workspaces")
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
    try:
        lock.acquire(args.owner_pid, timeout=30)
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)
    
    try:
        with open(args.patch_file, "rb") as f:
            patch_bytes = f.read()

        if patch_bytes:
            subprocess.run(
                ["git", "apply", "--binary", "--3way", args.patch_file],
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

def do_destroy(args):
    repo_root = args.repo
    worktree_path = args.worktree
    
    try:
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
