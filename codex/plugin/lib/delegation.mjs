import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic, createJsonOnce } from './store.mjs';

const schema = 'codex-mail-wake/background-delegation';
export const identitySources = Object.freeze({ turn_metadata: 'instance_tool_metadata', executor_environment: 'tool_executor_environment' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const validWatchEpoch = uuid;
const sameRoot = (stored, expected) => {
  if (typeof stored !== 'string' || !path.isAbsolute(stored)) return false;
  const resolved = path.resolve(stored);
  return process.platform === 'win32' ? resolved.toLowerCase() === expected.toLowerCase() : resolved === expected;
};

// Background authority is separate from a tools/call identity. This record
// contains no pipe and is usable only with the current process's launch pipe.
export class BackgroundDelegation {
  constructor({ stateDir, mailboxRoot, coordinator, allWatch, iso, instanceId }) {
    Object.assign(this, { stateDir, mailboxRoot, coordinator, allWatch, iso, instanceId });
    this.filename = path.join(stateDir, 'delegation.json');
  }
  inspect() {
    const record = readJson(this.filename);
    const result = (state, reason, valid = false) => ({ state, reason, valid, record });
    if (record === null && !fs.existsSync(this.filename)) return result('none', 'No explicit background grant.');
    if (!object(record) || record._unreadable) return result('invalid', 'Unreadable delegation record.');
    if (record.schema !== schema || record.schemaVersion !== 1) return result('invalid', 'Unsupported delegation schema.');
    if (record.status === 'revoked') return result('revoked', 'Explicitly revoked; a new grant is required.');
    if (record.status !== 'active' || !uuid(record.grantId) || typeof record.createdAtUtc !== 'string'
      || !Number.isFinite(Date.parse(record.createdAtUtc))) return result('invalid', 'Malformed active grant.');
    if (record.grantedBy !== this.coordinator || record.delegateThreadId !== this.coordinator
      || !Object.values(identitySources).includes(record.grantedBySource)) return result('invalid', 'Grant identity does not match the configured coordinator.');
    if (!object(record.scope) || !sameRoot(record.scope.stateRoot, this.stateDir)
      || !sameRoot(record.scope.mailboxRoot, this.mailboxRoot)) return result('invalid', 'Grant roots do not match this receiver.');
    let watch;
    try { watch = this.allWatch(); } catch { return result('invalid', 'Unreadable all-watch permission.'); }
    if (watch.enabled !== true || watch.registeredBy !== this.coordinator) return result('inactive_permit', 'Coordinator all-watch is disabled.');
    if (!validWatchEpoch(watch.epoch) || record.scope.allWatchEpoch !== watch.epoch) return result('stale_epoch', 'A new grant is required for this all-watch epoch.');
    return result('active', null, true);
  }
  requireCoordinator(owner, source) {
    if (owner !== this.coordinator || !Object.hasOwn(identitySources, source)) throw new Error('Only the configured coordinator identified by this call metadata/executor environment may grant or revoke delegation.');
  }
  grant(owner, source) {
    this.requireCoordinator(owner, source);
    const watch = this.allWatch();
    if (watch.enabled !== true || watch.registeredBy !== this.coordinator || !validWatchEpoch(watch.epoch)) throw new Error('An already enabled coordinator all-watch with a valid epoch is required. Grant never enables watch.');
    const checked = this.inspect();
    if (checked.valid) return 'already_active_same_scope';
    if (checked.state === 'invalid') throw new Error('Invalid existing delegation; explicitly revoke it before granting again.');
    const record = { schema, schemaVersion: 1, status: 'active', grantId: randomUUID(),
      grantedBy: owner, grantedBySource: identitySources[source], delegateThreadId: this.coordinator,
      scope: { stateRoot: this.stateDir, mailboxRoot: this.mailboxRoot, allWatchEpoch: watch.epoch },
      createdAtUtc: this.iso(), grantedByInstanceId: this.instanceId,
      replacesGrantId: uuid(checked.record?.grantId) ? checked.record.grantId : null };
    createJsonOnce(path.join(this.stateDir, 'delegation-history', `${record.grantId}-granted.json`), record);
    writeJsonAtomic(this.filename, record);
    return 'granted';
  }
  revoke(owner, source) {
    this.requireCoordinator(owner, source);
    const prior = readJson(this.filename);
    if (prior === null && !fs.existsSync(this.filename)) return 'no_grant';
    if (object(prior) && prior.schema === schema && prior.schemaVersion === 1 && prior.status === 'revoked') return 'already_revoked';
    const record = { schema, schemaVersion: 1, status: 'revoked', grantId: uuid(prior?.grantId) ? prior.grantId : null,
      revokedAtUtc: this.iso(), revokedBy: owner, revokedBySource: identitySources[source],
      priorRecordInvalid: this.inspect().state === 'invalid' };
    createJsonOnce(path.join(this.stateDir, 'delegation-history', `${record.grantId ?? 'invalid'}-revoked-${randomUUID()}.json`), record);
    writeJsonAtomic(this.filename, record);
    return 'revoked';
  }
}
