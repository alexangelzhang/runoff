import multiprocessing as mp
import os
import sys
import time

repo_root = os.environ["REPO_ROOT"]
repo = os.environ["TEST_REPO"]
os.environ["LLM_PIPELINE_HOME"] = os.environ["LOCK_HOME"]
sys.path.insert(0, os.path.join(repo_root, "scripts", "python"))

from workspace_manager import RepoLock  # noqa: E402


def exclusive_holder(path: str, q: mp.Queue) -> None:
    sys.path.insert(0, os.path.join(repo_root, "scripts", "python"))
    os.environ["LLM_PIPELINE_HOME"] = os.environ["LOCK_HOME"]
    r = RepoLock(path, None)
    r.acquire(os.getpid(), timeout=30)
    q.put("ready")
    time.sleep(8)
    r.release(os.getpid())


def shared_holder(path: str, key: str, q: mp.Queue) -> None:
    sys.path.insert(0, os.path.join(repo_root, "scripts", "python"))
    os.environ["LLM_PIPELINE_HOME"] = os.environ["LOCK_HOME"]
    r = RepoLock(path, key)
    r.acquire(os.getpid(), timeout=30)
    q.put("ready")
    time.sleep(8)
    r.release(os.getpid())


def main() -> None:
    ctx = mp.get_context("spawn")
    q: mp.Queue = ctx.Queue()
    p = ctx.Process(target=exclusive_holder, args=(repo, q))
    p.start()
    assert q.get(timeout=20) == "ready"
    parent = RepoLock(repo, None)
    try:
        parent.acquire(os.getpid(), timeout=5)
        print("EXCLUSIVE_FAIL_BOTH_ACQUIRED")
        sys.exit(1)
    except RuntimeError as e:
        if "REPO_LOCK_TIMEOUT" not in str(e) and "Repository is locked" not in str(e):
            raise
        print("EXCLUSIVE_OK")
    p.join(timeout=12)
    if p.exitcode not in (0, None):
        print("EXCLUSIVE_CHILD_BAD_EXIT", p.exitcode)
        sys.exit(1)

    shared_key = "agent-collab-123"
    q2: mp.Queue = ctx.Queue()
    p2 = ctx.Process(target=shared_holder, args=(repo, shared_key, q2))
    p2.start()
    assert q2.get(timeout=20) == "ready"
    r3 = RepoLock(repo, shared_key)
    r3.acquire(os.getpid(), timeout=30)
    print("SHARED_OK")
    r3.release(os.getpid())
    p2.join(timeout=12)
    if p2.exitcode not in (0, None):
        print("SHARED_CHILD_BAD_EXIT", p2.exitcode)
        sys.exit(1)


if __name__ == "__main__":
    main()
