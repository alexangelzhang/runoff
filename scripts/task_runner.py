#!/usr/bin/env python3
import argparse
import base64
import errno
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

# Wave 5: Strict IPC & Pure Executor Implementation

def normalize_path(path):
    return os.path.realpath(os.path.abspath(path))

def random_id():
    return uuid.uuid4().hex[:8]

TASK_PAYLOAD_SCHEMA_VERSION = 6


@dataclass
class TaskPayload:
    id: str
    prompt: str
    mode: str
    timestamp: str
    system: Optional[str] = None
    staticContext: Optional[str] = None
    dynamicContext: Optional[str] = None
    workDir: Optional[str] = None
    sessionId: Optional[str] = None
    stepName: Optional[str] = None
    round: int = 1
    agentId: Optional[str] = None
    parentHandoffId: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'TaskPayload':
        # P1: Strict validation of the IPC contract
        required = ["id", "prompt", "mode", "timestamp"]
        missing = [f for f in required if f not in data]
        if missing:
            raise ValueError(f"TaskPayload missing required fields: {', '.join(missing)}")

        sv = data.get("schemaVersion")
        if sv is not None:
            if type(sv) is not int or sv < 1:
                raise ValueError("TaskPayload schemaVersion must be a positive integer")
            if sv > TASK_PAYLOAD_SCHEMA_VERSION:
                raise ValueError(
                    f"TaskPayload schema version {sv} is newer than supported {TASK_PAYLOAD_SCHEMA_VERSION}"
                )

        return cls(
            id=data["id"],
            prompt=data["prompt"],
            mode=data["mode"],
            timestamp=data["timestamp"],
            system=data.get("system"),
            staticContext=data.get("staticContext"),
            dynamicContext=data.get("dynamicContext"),
            workDir=data.get("workDir"),
            sessionId=data.get("sessionId"),
            stepName=data.get("stepName"),
            round=data.get("round", 1),
            agentId=data.get("agentId"),
            parentHandoffId=data.get("parentHandoffId"),
        )

TASK_RESULT_SCHEMA_VERSION = 5

@dataclass
class TaskResult:
    id: str
    status: str
    content: str = ""
    usage: Dict[str, int] = field(default_factory=lambda: {"promptTokens": 0, "completionTokens": 0})
    error: Optional[str] = None
    model: str = "unknown"
    # Agent session traits
    summary: Optional[str] = None
    changes: Optional[str] = None
    filesModified: List[str] = field(default_factory=list)
    diffStat: Optional[str] = None
    schemaVersion: int = TASK_RESULT_SCHEMA_VERSION

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "content": self.content,
            "usage": self.usage,
            "error": self.error,
            "model": self.model,
            "summary": self.summary,
            "changes": self.changes,
            "filesModified": self.filesModified,
            "diffStat": self.diffStat,
            "schemaVersion": self.schemaVersion,
        }

def run_git_diff(cwd):
    try:
        diff = subprocess.check_output(["git", "diff", "HEAD"], cwd=cwd).decode("utf-8")
        files = subprocess.check_output(["git", "diff", "--name-only", "HEAD"], cwd=cwd).decode("utf-8").splitlines()
        stat = subprocess.check_output(["git", "diff", "--stat", "HEAD"], cwd=cwd).decode("utf-8")
        return diff, files, stat
    except Exception as e:
        return None, [], str(e)

def _atomic_write_json(filepath: str, data: dict):
    """Write JSON atomically via temp file + rename."""
    tmp = filepath + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, filepath)


def execute_oneshot(task_file: str, result_file: str):
    """Wave 5: Pure one-shot executor logic."""
    try:
        with open(task_file, "r") as f:
            data = json.load(f)
        task = TaskPayload.from_dict(data)
    except Exception as e:
        res = TaskResult(id="unknown", status="error", error=f"IPC Payload Error: {str(e)}")
        _atomic_write_json(result_file, res.to_dict())
        return

    work_dir = os.path.realpath(task.workDir) if task.workDir else os.getcwd()
    if not os.path.isdir(work_dir):
        res = TaskResult(id=task.id, status="error", error=f"work_dir does not exist or is not a directory: {work_dir}")
        _atomic_write_json(result_file, res.to_dict())
        return
    
    # Simple execution engine implementation
    # In a real system, this would invoke actual tools or subprocesses.
    # Here we simulate the runner behavior for the pipeline integration.
    
    # Reconstruct prompt (From Wave 4)
    final_prompt = task.prompt
    if task.system or task.staticContext:
        parts = []
        if task.system: parts.append(task.system)
        if task.staticContext: parts.append(task.staticContext)
        if task.dynamicContext: parts.append(task.dynamicContext)
        else: parts.append(task.prompt)
        final_prompt = "\n\n".join(parts)

    try:
        # P1: This executor currently handles text and agent-write modes
        if task.mode == "agent-write":
            # Simulate agent work if needed, or just capture diffs
            diff, files, stat = run_git_diff(work_dir)
            result = TaskResult(
                id=task.id, status="success",
                summary=f"Successfully processed task in {work_dir}",
                changes=diff, filesModified=files, diffStat=stat
            )
        else:
            result = TaskResult(
                id=task.id, status="success",
                content=f"Executed prompt (Simulated): {final_prompt[:100]}..."
            )
            
        _atomic_write_json(result_file, result.to_dict())

    except Exception as e:
        result = TaskResult(id=task.id, status="error", error=str(e))
        _atomic_write_json(result_file, result.to_dict())

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LLM Pipeline Task Runner (Wave 5: One-shot)")
    parser.print_help = lambda: None # Silent help if needed
    parser.add_argument("task_file", help="Path to the JSON task file")
    parser.add_argument("result_file", help="Path where to write the JSON result")
    
    args = parser.parse_args()
    execute_oneshot(args.task_file, args.result_file)
