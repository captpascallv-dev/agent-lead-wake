"""MIT, Python 3.10+. File-only registered delivery ledger; no executor launch."""
import argparse
import hashlib
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 25 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,220}", value):
        raise ValueError("Invalid delivery ID")
    return value


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}", value):
        raise ValueError("project/job/attempt must be 1..40 safe ASCII characters")
    return value


def read(path):
    with Path(path).open("r", encoding="utf-8") as stream:
        return json.load(stream)


def publish(path, content, exclusive=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".publish-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            try:
                os.link(temporary, path)
            except FileExistsError:
                return False
        else:
            os.replace(temporary, path)
        return True
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write(path, value, exclusive=False):
    return publish(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), exclusive)


def initialize(root):
    for directory in ("jobs", "deliveries", "claims", "snapshots"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    if not (root / "routes.json").exists():
        write(root / "routes.json", {"projects": {}}, exclusive=True)


def acquire(lock):
    lock.seek(0, os.SEEK_END)
    if lock.tell() == 0:
        lock.write(b"\0")
        lock.flush()
    lock.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def release(lock):
    lock.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


@contextmanager
def operation_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".codex-mail-wake.driver.lock").open("a+b") as lock:
        try:
            acquire(lock)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            release(lock)


def route(root, project, owner, status, replace_owner=False):
    name(project)
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError("An explicit actual owner thread ID is required")
    routes = read(root / "routes.json")
    previous = routes["projects"].get(project)
    if previous and previous["thread_id"] != owner and not replace_owner:
        raise ValueError("Owner replacement requires explicit --replace-owner; old jobs keep their original owner")
    routes["projects"][project] = {"thread_id": owner, "status": status}
    write(root / "routes.json", routes)
    return routes["projects"][project]


def register(root, project, job_id, attempt_id, outbox, source="cli"):
    for item in (project, job_id, attempt_id):
        name(item)
    route_value = read(root / "routes.json")["projects"][project]
    if route_value["status"] != "active":
        raise ValueError("Only an active route can register a new attempt")
    box = Path(outbox).resolve(strict=True)
    if not box.is_dir():
        raise ValueError("outbox must be an existing directory")
    if box == root or box.is_relative_to(root):
        raise ValueError("outbox must be outside the ledger directory")
    # One compact, lowercase file identity at registration, with an immutable
    # full-registration equality check. Not a per-poll report/content digest.
    token = hashlib.sha256(json.dumps([project, job_id, attempt_id], separators=(",", ":")).encode()).hexdigest()
    ident = safe_id("delivery-" + token)
    job = {"key": ident, "project": project, "job_id": job_id, "attempt_id": attempt_id,
           "outbox": str(box), "target_thread_id": route_value["thread_id"], "source": source}
    filename = root / "jobs" / (ident + ".json")
    if filename.exists():
        if read(filename) != job:
            raise ValueError("Existing registration is immutable; use an explicit new job/attempt after route configuration")
        return job
    # READY has no embedded attempt identity. Bind a canonical outbox to exactly
    # one registration, even after sent, rather than reusing old READY as new work.
    canonical_box = os.path.normcase(str(box))
    for existing_path in (root / "jobs").glob("*.json"):
        existing = read(existing_path)
        if not isinstance(existing, dict) or not existing.get("outbox"):
            raise ValueError("Existing outbox binding is unreadable; registration requires manual repair")
        if os.path.normcase(str(Path(existing["outbox"]).resolve())) == canonical_box:
            raise ValueError("Outbox is already bound to another job/attempt; use a fresh independent outbox")
    if not write(filename, job, exclusive=True) and read(filename) != job:
        raise ValueError("Existing registration is immutable; use an explicit new job/attempt after route configuration")
    return job


def input_file(outbox, relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or "\\" in relative:
        raise ValueError("deliverables must use relative forward-slash paths under outbox")
    lexical = Path(relative)
    if any(part in ("..", ".") for part in lexical.parts):
        raise ValueError("Input path cannot escape or alias outbox")
    candidate = (outbox / lexical).resolve(strict=True)
    if not candidate.is_relative_to(outbox) or not candidate.is_file():
        raise ValueError("Input path escapes the registered outbox or is not a regular file")
    stat = candidate.stat()
    if stat.st_size > MAX_FILE_BYTES:
        raise ValueError("Input file exceeds 10 MiB")
    content = candidate.read_bytes()
    after = candidate.stat()
    if (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Input changed during snapshot; write READY last")
    return content


def commit_prelaunch(root, job):
    """File-only trusted-wrapper assertion; never infer failure from PID/absence."""
    ident = safe_id(job['key'])
    box = Path(job['outbox']).resolve(strict=True)
    if (job.get('state') == 'retired' or (root / 'deliveries' / (ident + '.json')).exists()
            or (root / 'claims' / (ident + '.lock')).exists() or (box / 'READY.json').exists()):
        return False
    candidate = box / 'PRELAUNCH_REJECTION.json'
    if not candidate.exists():
        return False
    proof = json.loads(input_file(box, 'PRELAUNCH_REJECTION.json').decode('utf-8'))
    allowed = {'schema_version', 'kind', 'delivery_id', 'project', 'job_id', 'attempt_id', 'target_thread_id',
               'stage', 'executor_spawn_attempted', 'provider_invocation_attempted', 'execution_started',
               'status', 'reason_code', 'diagnostic_paths'}
    if not isinstance(proof, dict) or set(proof) - allowed:
        raise ValueError('Unsupported prelaunch proof fields; no synthetic READY')
    identity = {'delivery_id': ident, 'project': job['project'], 'job_id': job['job_id'],
                'attempt_id': job['attempt_id'], 'target_thread_id': job['target_thread_id']}
    if any(proof.get(field) != value for field, value in identity.items()):
        raise ValueError('Prelaunch proof differs from immutable registered identity')
    reasons = {'write_scope_rejected', 'input_validation_rejected', 'dependency_unavailable', 'adapter_preflight_rejected'}
    if (proof.get('schema_version') != 1 or proof.get('kind') != 'prelaunch_rejection'
            or proof.get('stage') != 'before_executor_spawn'
            or any(proof.get(field) is not False for field in ('executor_spawn_attempted', 'provider_invocation_attempted', 'execution_started'))
            or proof.get('status') not in ('failed', 'blocked') or proof.get('reason_code') not in reasons):
        raise ValueError('Affirmative before-spawn rejection is required; unknown or possibly-running state is not failure')
    diagnostics = proof.get('diagnostic_paths', [])
    if not isinstance(diagnostics, list) or len(diagnostics) > 16:
        raise ValueError('diagnostic_paths must be at most 16 relative outbox files')
    for relative in diagnostics:
        input_file(box, relative)  # Validate scope/existence; do not copy raw content into the report.
    report = ('# Launch failure receipt (not an executor report or task acceptance)\n\n'
              f"project: {job['project']}\njob: {job['job_id']}\nattempt: {job['attempt_id']}\n"
              f"reason_code: {proof['reason_code']}\nstage: before_executor_spawn\n"
              'The trusted wrapper explicitly rejected before any executor/provider invocation.\n'
              'No executor result is claimed. Original Lead decides continuation; no retry or acceptance.\n'
              'Original diagnostic references (under registered outbox):\n' + ''.join(f'- {item}\n' for item in diagnostics))
    report_bytes = report.encode('utf-8')
    # A helper-owned partial publication may finish READY after process rebuild;
    # any different original report wins and is never replaced/relabelled.
    if (box / 'REPORT.md').exists() and (box / 'REPORT.md').read_bytes() != report_bytes:
        raise ValueError('Existing REPORT.md is preserved; wrapper must commit its own appropriate READY')
    if not publish(box / 'REPORT.md', report_bytes, exclusive=True) and (box / 'REPORT.md').read_bytes() != report_bytes:
        raise ValueError('Another report was published concurrently; no synthetic READY')
    marker = {'status': proof['status'], 'deliverables': [], 'source': 'prelaunch_rejection',
              'notes': 'System launch-failure receipt, not executor output or task acceptance'}
    write(box / 'READY.json', marker, exclusive=True)
    return True


def harvest(root, job):
    ident = safe_id(job["key"])
    filename = root / "deliveries" / (ident + ".json")
    if filename.exists():
        delivery = read(filename)
        if (delivery.get("id"), delivery.get("project"), delivery.get("target_thread_id")) != (ident, job["project"], job["target_thread_id"]):
            raise ValueError("Existing delivery identity differs from immutable registration")
        return delivery
    if (root / "claims" / (ident + ".lock")).exists():
        raise ValueError("Existing claim without delivery; manual review, never recreate or resend")
    box = Path(job["outbox"]).resolve(strict=True)
    if not (box / "READY.json").exists():
        if not commit_prelaunch(root, job):
            return None
    marker = json.loads(input_file(box, "READY.json").decode("utf-8"))
    if marker.get("status") not in ("completed", "blocked", "failed"):
        raise ValueError("READY status must be completed, blocked or failed")
    deliverables = marker.get("deliverables", [])
    if not isinstance(deliverables, list) or len(deliverables) > 64:
        raise ValueError("READY deliverables must be a list with at most 64 entries")
    entries = []
    total = 0
    report = None
    for relative in dict.fromkeys(["REPORT.md", *deliverables]):
        content = input_file(box, relative)
        total += len(content)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("Snapshot exceeds 25 MiB")
        target = root / "snapshots" / ident / relative
        if not target.resolve().is_relative_to(root):
            raise ValueError("Snapshot path escapes the configured ledger")
        if not publish(target, content, exclusive=True) and target.read_bytes() != content:
            raise ValueError("Existing immutable snapshot differs from input; manual review")
        entries.append({"sourceRelativePath": relative, "snapshotRelativePath": str(target.relative_to(root)), "bytes": len(content)})
        if relative == "REPORT.md":
            report = content.decode("utf-8")
    manifest = {"job": job, "marker": marker, "files": entries}
    write(root / "snapshots" / ident / "manifest.json", manifest, exclusive=True)
    status_label = 'launch-failure receipt (not executor report)' if marker.get('source') == 'prelaunch_rejection' else 'executor'
    prompt = (f"[app-mailbox:{ident}]\n此消息由收件系统自动投递。\n"
              f"project: {job['project']}\njob: {job['job_id']}\nattempt: {job['attempt_id']}\n"
              f"{status_label} status: {marker['status']}\nsnapshot: {root / 'snapshots' / ident / 'manifest.json'}\n"
              "Transport acceptance is not task acceptance. Read the original report and decide continuation.\n\n" + report)
    delivery = {"id": ident, "project": job["project"], "target_thread_id": job["target_thread_id"],
                "prompt": prompt, "state": "pending", "created_at": now()}
    if not write(filename, delivery, exclusive=True):
        raise ValueError("Concurrent delivery publication; inspect existing identity")
    return delivery


def scan(root):
    routes = read(root / "routes.json")["projects"]
    result = {"ready": [], "held": [], "uncertain": [], "errors": []}
    for filename in sorted((root / "jobs").glob("*.json")):
        job = None
        try:
            job = read(filename)
            if job.get('state') == 'retired':
                continue
            delivery = harvest(root, job)
            if not delivery or delivery["state"] == "sent":
                continue
            route_value = routes[job["project"]]
            if delivery["target_thread_id"] != route_value["thread_id"]:
                raise ValueError("Destination changed; explicit handoff required; no owner reassignment")
            if route_value["status"] != "active":
                result["held"].append({"id": delivery["id"], "project": delivery["project"], "reason": route_value["status"]})
            elif delivery["state"] in ("sending", "uncertain") or (root / "claims" / (delivery["id"] + ".lock")).exists():
                result["uncertain"].append(delivery)
            elif delivery["state"] == "pending":
                result["ready"].append({"id": delivery["id"], "project": delivery["project"]})
            else:
                raise ValueError("Unknown central delivery state; no send")
        except Exception as error:
            result["errors"].append({"job_file": str(filename), "id": job.get("key") if isinstance(job, dict) else None,
                                     "project": job.get("project") if isinstance(job, dict) else None, "error": str(error)})
    return result


def claim(root, ident):
    ident = safe_id(ident)
    filename = root / "deliveries" / (ident + ".json")
    delivery = read(filename)
    route_value = read(root / "routes.json")["projects"][delivery["project"]]
    if delivery["id"] != ident or delivery["state"] != "pending" or route_value["status"] != "active" or route_value["thread_id"] != delivery["target_thread_id"]:
        raise ValueError("Delivery not claimable for its exact original active owner")
    if not write(root / "claims" / (ident + ".lock"), {"id": ident, "claimedAt": now()}, exclusive=True):
        raise ValueError("Existing permanent claim; no automatic retry")
    # If anything after the exclusive claim fails, retain it. Never delete a
    # possibly consumed claim to turn an uncertain operation into a duplicate.
    delivery.update(state="sending", claimed_at=now())
    write(filename, delivery)
    return delivery


def exact_receipt(receipt, owner):
    if not isinstance(receipt, dict) or receipt.get("isError"):
        return False
    evidence = receipt.get("structuredContent")
    for item in receipt.get("content", []):
        if item.get("type") == "text":
            try:
                candidate = json.loads(item["text"])
                if isinstance(candidate, dict) and candidate.get("threadId"):
                    evidence = candidate
            except (ValueError, KeyError):
                pass
    return isinstance(evidence, dict) and evidence.get("threadId") == owner


def ack(root, ident, receipt):
    ident = safe_id(ident)
    filename = root / "deliveries" / (ident + ".json")
    delivery = read(filename)
    if delivery.get("id") != ident:
        raise ValueError("Central delivery identity mismatch")
    if delivery["state"] == "sent":
        return {"id": ident, "state": "sent"}
    if delivery["state"] not in ("sending", "uncertain") or not exact_receipt(receipt, delivery["target_thread_id"]):
        raise ValueError("Prior claim and exact original-owner receipt are required")
    delivery.update(state="sent", sent_at=now(), receipt=receipt)
    write(filename, delivery)
    return {"id": ident, "state": "sent"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    sub = parser.add_subparsers(dest="operation", required=True)
    p = sub.add_parser("route")
    p.add_argument("--project", required=True)
    p.add_argument("--owner", required=True)
    p.add_argument("--status", choices=("active", "held", "closed"), default="active")
    p.add_argument("--replace-owner", action="store_true")
    p = sub.add_parser("register")
    for field in ("project", "job", "attempt", "outbox"):
        p.add_argument("--" + field, required=True)
    p.add_argument("--source", choices=("cli", "bot"), default="cli")
    sub.add_parser("scan")
    p = sub.add_parser('prelaunch')
    p.add_argument('id')
    p = sub.add_parser("claim")
    p.add_argument("id")
    p = sub.add_parser("ack")
    p.add_argument("id")
    p.add_argument("receipt_file")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    with operation_lock(root) as acquired:
        if not acquired:
            return {"busy": True}
        initialize(root)
        if args.operation == "route":
            return route(root, args.project, args.owner, args.status, args.replace_owner)
        if args.operation == "register":
            return register(root, args.project, args.job, args.attempt, args.outbox, args.source)
        if args.operation == "scan":
            return scan(root)
        if args.operation == 'prelaunch':
            ident = safe_id(args.id)
            committed = commit_prelaunch(root, read(root / 'jobs' / (ident + '.json')))
            return {'id': ident, 'prelaunch_ready_created': committed, 'acceptance': False, 'automatic_retry': False}
        if args.operation == "claim":
            return claim(root, args.id)
        return ack(root, args.id, read(args.receipt_file))


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
