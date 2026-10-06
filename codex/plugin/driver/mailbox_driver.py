"""Internal fixed-operation stdio driver for the bundled public ledger."""
import argparse
import json
from pathlib import Path
import sys
import ledger


def main():
    if sys.version_info < (3, 10):
        raise ValueError("Python 3.10+ is required")
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    leases = parser.add_mutually_exclusive_group()
    leases.add_argument("--lease", action="store_true")
    leases.add_argument("--authorization-lease", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.lease or args.authorization_lease:
        # Short grant/revoke controls serialize across MCP instances, separately
        # from the long receiver leader. OS releases both locks on process exit.
        name = ".codex-mail-wake.authorization.lock" if args.authorization_lease else ".codex-mail-wake.leader.lock"
        with (root / name).open("a+b") as lock:
            try:
                ledger.acquire(lock)
            except OSError:
                print(json.dumps({"busy": True, "operation": "lease"}), flush=True)
                return
            try:
                print(json.dumps({"busy": False, "operation": "lease"}), flush=True)
                while sys.stdin.buffer.read(1):
                    pass
            finally:
                ledger.release(lock)
        return
    request = json.load(sys.stdin)
    operation = request.get("operation")
    allowed = {"scan": {"operation"}, "claim": {"operation", "id"}, "ack": {"operation", "id", "receipt"}}
    if operation not in allowed or set(request) - allowed[operation]:
        raise ValueError("Only fixed scan/claim/ack fields are accepted")
    with ledger.operation_lock(root) as acquired:
        if not acquired:
            print(json.dumps({"busy": True, "operation": operation}))
            return
        ledger.initialize(root)
        if operation == "scan":
            result = ledger.scan(root)
        elif operation == "claim":
            result = ledger.claim(root, request["id"])
        else:
            result = ledger.ack(root, request["id"], request["receipt"])
        print(json.dumps({"busy": False, "operation": operation, "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
