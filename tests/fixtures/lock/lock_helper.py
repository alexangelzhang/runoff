
import sys
import os
import time
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "python"))
from workspace_manager import RepoLock

repo = sys.argv[1]
key = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "None" else None
lock = RepoLock(repo, shared_lock_key=key)

try:
    if lock.acquire(os.getpid(), timeout=30):
        print("LOCKED", flush=True)
        time.sleep(5) 
        lock.release(os.getpid())
    else:
        print("FAILED", flush=True)
except Exception as e:
    print(f"ERROR: {str(e)}", flush=True)
    sys.exit(1)
