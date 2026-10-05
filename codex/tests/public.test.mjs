import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { loadConfig } from '../plugin/lib/config.mjs';
import { AppMailboxEngine, MailboxDriver } from '../plugin/lib/app-mailbox.mjs';
import { OfficialTools, resolveInstalledOfficialEntry } from '../plugin/lib/official-tools.mjs';
import { handleRequest, TOOLS } from '../plugin/lib/mcp-service.mjs';
import { readJson, createJsonOnce } from '../plugin/lib/store.mjs';
import { key } from '../plugin/lib/ids.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ledger = path.join(root, 'tools', 'mailbox.py');
const python = [process.env.MAIL_WAKE_TEST_PYTHON, 'python3', 'python'].filter(Boolean).find(command => {
  const result = spawnSync(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'], { windowsHide: true });
  return result.status === 0;
});
assert.ok(python, 'Python 3.10+ must be on PATH, or set MAIL_WAKE_TEST_PYTHON');
const owner = 'test-lead', coordinator = 'test-coordinator', actor = 'test-actor';
const write = (filename, value) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(value)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let count = 0; count < 250; count++) { if (check()) return; await pause(20); } throw new Error('Timed out waiting for test state'); }
function cli(f, args, success = true) {
  const result = spawnSync(python, ['-B', '-X', 'utf8', ledger, '--root', f.mailboxRoot, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
  if (success) assert.equal(result.status, 0, result.stdout); else assert.equal(result.status, 1);
  return JSON.parse(result.stdout);
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lead-wake-test-'));
  const canonicalBase = fs.realpathSync(base);
  const f = { base, mailboxRoot: path.join(base, 'ledger'), stateDir: path.join(base, 'state'), control: path.join(base, 'control.json'), log: path.join(base, 'host.jsonl'), engines: [] };
  const home = path.join(base, 'fake-codex-home'); const cache = path.join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '0.0.1');
  write(path.join(cache, '.codex-plugin', 'plugin.json'), { name: 'codex-app-tools', version: '0.0.1', author: { name: 'OpenAI' } });
  fs.copyFileSync(path.join(root, 'tests', 'fixtures', 'fake-host.mjs'), path.join(cache, 'server.mjs'));
  write(f.control, {});
  f.config = path.join(base, 'config.json'); write(f.config, { mailboxRoot: './ledger', stateDir: './state', coordinatorThreadId: coordinator, pythonExecutable: python });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MAIL_WAKE_')));
  f.env = { ...inherited, CODEX_HOME: home, CODEX_APP_TOOLS_PIPE_PATH: 'test-launch-pipe', CODEX_THREAD_ID: actor,
    HOME: base, USERPROFILE: base,
    MAIL_WAKE_CONFIG: f.config, TEST_CONTROL: f.control, TEST_LOG: f.log, TEST_STATE: f.stateDir };
  f.env.TEST_KEY_MODULE = pathToFileURL(path.join(root, 'plugin', 'lib', 'ids.mjs')).href;
  cli(f, ['route', '--project', 'demo', '--owner', owner]);
  t.after(async () => {
    for (const engine of f.engines) engine.close(); await pause(100);
    // Recursive cleanup is limited to the exact freshly created OS temp fixture.
    const resolved = fs.realpathSync(base); const temp = fs.realpathSync(os.tmpdir());
    assert.equal(resolved, canonicalBase); assert.equal(path.dirname(resolved), temp); assert.ok(path.basename(resolved).startsWith('agent-lead-wake-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return f;
}
function job(f, jobId = 'job', attempt = '1', source = 'cli', marker = {}) {
  const outbox = path.join(f.base, 'outboxes', `${jobId}-${attempt}`); fs.mkdirSync(outbox, { recursive: true });
  const registration = cli(f, ['register', '--project', 'demo', '--job', jobId, '--attempt', attempt, '--outbox', outbox, '--source', source]);
  fs.writeFileSync(path.join(outbox, 'REPORT.md'), `Original ${source} report ${jobId}/${attempt}.\n`);
  fs.writeFileSync(path.join(outbox, 'result.txt'), 'Example artifact');
  write(path.join(outbox, 'READY.json'), { status: 'completed', deliverables: ['result.txt'], notes: 'Example', ...marker });
  return { id: registration.key, outbox };
}
function engine(f, options = {}) {
  const instance = new AppMailboxEngine({ stateDir: f.stateDir, coordinatorThreadId: coordinator, env: f.env,
    driver: new MailboxDriver({ root: f.mailboxRoot, pythonPath: python }), client: new OfficialTools({ env: f.env, timeoutMs: 250 }), ...options });
  f.engines.push(instance); return instance;
}
const events = f => fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sends = f => events(f).filter(item => item.params?.name === 'send_message_to_thread');
const deliveries = f => sends(f).filter(item => item.params.arguments.prompt.startsWith('[app-mailbox:'));
const faults = f => sends(f).filter(item => item.params.arguments.prompt.startsWith('[app-mailbox-transport-fault:'));
const central = (f, id) => readJson(path.join(f.mailboxRoot, 'deliveries', `${id}.json`));

test('configuration and MCP identity fail closed; absent launch pipe or actor cannot scan', async t => {
  const f = fixture(t);
  const homes = { CODEX_HOME: path.join(f.base, 'default-home'), HOME: f.base, USERPROFILE: f.base };
  assert.throws(() => loadConfig(homes), /configuration is required/);
  assert.equal(TOOLS.length, 3); assert.ok(TOOLS.every(tool => !tool.name.includes('subscription')));
  const missing = spawnSync(process.execPath, [path.join(root, 'plugin', 'server.mjs')], { env: homes, encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1); assert.ok(missing.stderr.includes('configuration is required'));
  const standard = { mailboxRoot: '../ledger', stateDir: '../state', coordinatorThreadId: coordinator, pythonExecutable: python };
  write(path.join(homes.CODEX_HOME, 'mail-wake.config.json'), standard);
  assert.equal(loadConfig(homes).mailboxRoot, f.mailboxRoot);
  write(path.join(f.base, '.codex', 'mail-wake.config.json'), standard);
  assert.equal(loadConfig({ HOME: f.base, USERPROFILE: f.base }).stateDir, f.stateDir);
  assert.equal(loadConfig({ HOME: f.base }).coordinatorThreadId, coordinator);
  write(path.join(homes.CODEX_HOME, 'mail-wake.config.json'), { ...standard, coordinatorThreadId: null });
  assert.throws(() => loadConfig(homes), /coordinatorThreadId configuration is required/);
  assert.equal(loadConfig({ ...homes, MAIL_WAKE_CONFIG: f.config }).coordinatorThreadId, coordinator, 'explicit file wins over standard file');
  assert.throws(() => loadConfig({ ...homes, MAIL_WAKE_CONFIG: path.join(f.base, 'missing.json') }), /does not exist/);
  const item = job(f); const config = loadConfig({ MAIL_WAKE_CONFIG: f.config });
  assert.equal(config.mailboxRoot, f.mailboxRoot); assert.equal(config.stateDir, f.stateDir);
  const noPipe = engine(f, { client: new OfficialTools({ env: { ...f.env, CODEX_APP_TOOLS_PIPE_PATH: '' } }) });
  noPipe.startWatch(coordinator); await noPipe.tick(); assert.equal(central(f, item.id), null); assert.equal(noPipe.getStatus(coordinator).service.runtimeState, 'no_pipe'); noPipe.close();
  const noActor = engine(f, { env: {} }); await noActor.tick(); assert.equal(central(f, item.id), null);
  assert.equal(noActor.getStatus(coordinator).service.runtimeState, 'identity_unavailable');
  const call = (name, args, who) => handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
    _meta: { 'x-codex-turn-metadata': { thread_id: who } } } }, noActor, {});
  assert.equal((await call('start_app_mailbox_watch', { project: 'demo', target: 'other', model: 'override' }, owner)).isError, true);
  assert.equal((await call('start_app_mailbox_watch', {}, owner)).isError, true);
  assert.equal((await call('app_mailbox_status', { project: 'demo' }, owner)).isError, false);
  assert.equal(noActor.actorThreadId, owner); await noActor.tick(); assert.equal(central(f, item.id).state, 'sent');
  cli(f, ['route', '--project', 'Demo', '--owner', owner]);
  noActor.stopWatch(owner, { project: 'Demo' });
  const projects = noActor.getStatus(owner).projects;
  assert.equal(projects.find(item => item.project === 'demo').watchEnabled, true);
  assert.equal(projects.find(item => item.project === 'Demo').watchEnabled, false);
  assert.notEqual(key('demo').toLowerCase(), key('Demo').toLowerCase());
  assert.ok(key('X'.repeat(220)).length <= 80);
  const upperOutbox = path.join(f.base, 'upper-outbox'); fs.mkdirSync(upperOutbox);
  const upperJob = cli(f, ['register', '--project', 'Demo', '--job', 'job', '--attempt', '1', '--outbox', upperOutbox]);
  assert.notEqual(upperJob.key.toLowerCase(), item.id.toLowerCase());
  assert.equal(readJson(path.join(f.mailboxRoot, 'jobs', `${upperJob.key}.json`)).project, 'Demo');
  assert.equal(readJson(path.join(f.mailboxRoot, 'jobs', `${item.id}.json`)).project, 'demo');
});

test('portable CLI/Bot READY contract snapshots original reports and delivers exact claim prompt with actual source', async t => {
  const f = fixture(t); write(f.control, { ownerStatus: 'notLoaded' });
  const a = job(f, 'cli-job'); const b = job(f, 'bot-job', '1', 'bot', { status: 'blocked' }); const e = engine(f);
  e.startWatch(coordinator); await e.tick();
  for (const item of [a, b]) {
    const value = central(f, item.id); assert.equal(value.state, 'sent');
    const sent = deliveries(f).find(event => event.params.arguments.prompt.startsWith(`[app-mailbox:${item.id}]`));
    assert.equal(sent.params.arguments.prompt, value.prompt); assert.equal(sent.params.arguments.threadId, owner);
    assert.deepEqual(sent.params._meta, { 'x-codex-turn-metadata': { thread_id: actor } });
    assert.deepEqual(Object.keys(sent.params.arguments).sort(), ['prompt', 'threadId']);
    assert.equal(value.prompt.split('\n')[1], '此消息由收件系统自动投递。');
    assert.equal(fs.readFileSync(path.join(f.mailboxRoot, 'snapshots', item.id, 'REPORT.md'), 'utf8'), fs.readFileSync(path.join(item.outbox, 'REPORT.md'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(f.mailboxRoot, 'snapshots', item.id, 'result.txt'), 'utf8'), 'Example artifact');
  }
  // Later same-source events/READY changes do not replace a consumed attempt.
  write(path.join(a.outbox, 'READY.json'), { status: 'failed', deliverables: [] });
  await e.tick(); assert.equal(deliveries(f).length, 2); assert.equal(central(f, a.id).state, 'sent');
  const next = job(f, 'cli-job', '2'); await e.tick(); assert.equal(central(f, next.id).state, 'sent'); assert.equal(deliveries(f).length, 3);
  const intent = readJson(e.localPath(a.id, 'intent.json')); assert.equal(intent.permissionRegisteredBy, coordinator); assert.equal(intent.callerThreadId, actor);
  assert.equal(Object.hasOwn(intent, 'promptSha256'), false); assert.equal(Object.hasOwn(intent, 'pipeFingerprint'), false);
  e.stopWatch(owner, { project: 'demo' }); assert.equal(e.getStatus(owner).projects[0].watchEnabled, false);
});

test('ledger isolates escaping or damaged inputs, pins registrations and preserves atomic claims with idempotent exact ack', async t => {
  const f = fixture(t); const good = job(f, 'good'); const bad = job(f, 'bad', '1', 'cli', { deliverables: ['../outside.txt'] });
  assert.equal(cli(f, ['register', '--project', 'demo', '--job', 'good', '--attempt', '1', '--outbox', good.outbox]).key, good.id);
  assert.ok(cli(f, ['register', '--project', 'demo', '--job', 'good', '--attempt', '2', '--outbox', good.outbox], false).error.includes('already bound'));
  assert.ok(cli(f, ['register', '--project', 'demo', '--job', 'other-job', '--attempt', '1', '--outbox', good.outbox], false).error.includes('already bound'));
  fs.writeFileSync(path.join(f.base, 'outboxes', 'outside.txt'), 'Outside input'); fs.writeFileSync(path.join(f.mailboxRoot, 'jobs', 'broken.json'), '{bad');
  const scan = cli(f, ['scan']); assert.equal(scan.ready.length, 1); assert.equal(scan.ready[0].id, good.id); assert.equal(scan.errors.length, 2); assert.equal(central(f, bad.id), null);
  const claimed = cli(f, ['claim', good.id]); assert.equal(claimed.state, 'sending');
  assert.ok(cli(f, ['claim', good.id], false).error.includes('not claimable'));
  const receipt = path.join(f.base, 'receipt.json'); write(receipt, { structuredContent: { threadId: 'wrong-owner' } });
  assert.ok(cli(f, ['ack', good.id, receipt], false).error.includes('exact original-owner'));
  write(receipt, { structuredContent: { threadId: owner }, isError: false }); assert.equal(cli(f, ['ack', good.id, receipt]).state, 'sent');
  write(receipt, { isError: true }); assert.equal(cli(f, ['ack', good.id, receipt]).state, 'sent');
  assert.ok(fs.existsSync(path.join(f.mailboxRoot, 'claims', `${good.id}.lock`)));
  assert.ok(cli(f, ['route', '--project', 'demo', '--owner', 'replacement'], false).error.includes('--replace-owner'));
  cli(f, ['route', '--project', 'demo', '--owner', 'replacement', '--replace-owner']);
  assert.ok(cli(f, ['register', '--project', 'demo', '--job', 'good', '--attempt', '1', '--outbox', good.outbox], false).error.includes('immutable'));
  assert.equal(central(f, good.id).target_thread_id, owner);
  const e = engine(f); e.startWatch(coordinator); await e.tick(); await e.tick(); assert.equal(faults(f).length, 0);
  await e.tick(); await e.tick(); assert.equal(faults(f).length, 1, 'same registered collector error alerts once after three polls');
  assert.equal(deliveries(f).length, 0);
});

test('one OS leader scans; retained lock files and permanent claims survive lease exit and takeover', async t => {
  const f = fixture(t); let at = Date.now(); const a = engine(f, { now: () => at }); const b = engine(f, { now: () => at });
  const first = job(f); a.startWatch(coordinator); await a.tick(); await b.tick();
  assert.equal(a.getStatus(coordinator).service.runtimeState, 'leader'); assert.equal(b.getStatus(coordinator).service.runtimeState, 'standby');
  assert.equal(deliveries(f).length, 1); assert.equal(b.getStatus(coordinator).service.observedLeader.instanceId, a.instanceId);
  const lease = a.leader.child; lease.kill(); await once(lease, 'close'); at += 60001;
  const next = job(f, 'job', '2'); await b.tick(); assert.equal(central(f, next.id).state, 'sent'); assert.equal(deliveries(f).length, 2);
  const blocked = job(f, 'job', '3'); write(f.control, { ownerStatus: 'active' }); await b.tick(); assert.equal(central(f, blocked.id).state, 'pending');
  at += 2 * 60 * 60 * 1000; await b.tick(); await b.tick(); assert.equal(faults(f).length, 1);
  write(f.control, { ownerStatus: 'notLoaded' }); await b.tick(); assert.equal(central(f, blocked.id).state, 'sent');
  assert.ok(fs.existsSync(path.join(f.mailboxRoot, '.codex-mail-wake.leader.lock'))); assert.ok(fs.existsSync(path.join(f.mailboxRoot, 'claims', `${first.id}.lock`)));
});

test('uncertain intent and missing history stay single-attempt while same-pipe actor health recovery resumes independent delivery', async t => {
  const f = fixture(t); let at = Date.now(); const e = engine(f, { now: () => at }); const first = job(f);
  write(f.control, { sendMode: 'timeout' }); e.startWatch(coordinator); await e.tick();
  assert.equal(central(f, first.id).state, 'sending'); assert.equal(readJson(e.localPath(first.id, 'outcome.json')).status, 'uncertain');
  createJsonOnce(e.localPath('old-history', 'intent.json'), { deliveryId: 'old-history', project: 'demo', ownerThreadId: owner });
  const next = job(f, 'job', '2'); write(f.control, { readReject: true }); at += 60000; await e.tick(); assert.equal(central(f, next.id), null);
  const actorReads = () => events(f).filter(event => event.params?.name === 'read_thread' && event.params.arguments.threadId === actor).length;
  assert.equal(actorReads(), 1); at += 59999; await e.tick(); assert.equal(actorReads(), 1);
  write(f.control, {}); at += 1; await e.tick(); assert.equal(central(f, next.id).state, 'sent'); assert.equal(actorReads(), 2);
  assert.equal(deliveries(f).filter(event => event.params.arguments.prompt.startsWith(`[app-mailbox:${first.id}]`)).length, 1);
  assert.equal(readJson(e.localPath('old-history', 'outcome.json')).status, 'uncertain'); assert.equal(faults(f).length, 2);
  await e.tick(); assert.equal(faults(f).length, 2); assert.ok(e.getStatus(coordinator).ledgerProblems.some(item => item.deliveryId === 'old-history'));
  assert.ok(events(f).every(event => event.pipe === 'test-launch-pipe'));
});

function service(f, filename) {
  const child = spawn(process.execPath, [filename], { env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; const pending = new Map(); let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  readline.createInterface({ input: child.stdout }).on('line', line => { const result = JSON.parse(line); const operation = pending.get(result.id); if (operation) { pending.delete(result.id); operation.resolve(result.result); } });
  const call = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, { resolve }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, call, stderr: () => stderr };
}

test('standard stdio process restart recovers durable exact receipt with ack only; installed dependency lookup stays in current cache', async t => {
  const f = fixture(t); const item = job(f); const cache = path.join(f.env.CODEX_HOME, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  assert.equal(resolveInstalledOfficialEntry({ cacheRoot: cache }).version, '0.0.1');
  assert.throws(() => resolveInstalledOfficialEntry({ cacheRoot: cache, appToolsEntry: path.join(root, 'tests', 'fixtures', 'fake-host.mjs') }), /valid server.mjs/);
  const first = service(f, path.join(root, 'tests', 'fixtures', 'crash-service.mjs')); let second;
  try {
    assert.equal((await first.call('initialize')).serverInfo.version, '0.3.1');
    await first.call('tools/call', { name: 'start_app_mailbox_watch', arguments: { project: 'demo' }, _meta: { 'x-codex-turn-metadata': { thread_id: owner } } });
    await until(() => first.child.exitCode === 17); assert.equal(deliveries(f).length, 1); assert.equal(central(f, item.id).state, 'sending');
    second = service(f, path.join(root, 'plugin', 'server.mjs')); await second.call('initialize');
    await until(() => central(f, item.id).state === 'sent'); assert.equal(deliveries(f).length, 1);
    assert.equal((await second.call('tools/list')).tools.length, 3); assert.equal(second.stderr(), '');
  } finally {
    if (first.child.exitCode === null) { first.child.kill(); await once(first.child, 'close'); }
    if (second) { second.child.stdin.end(); await once(second.child, 'close'); }
  }
});

test('public prelaunch rejection contract binds identity and paths, delivers once and preserves existing or unknown work', async t => {
  const f = fixture(t);
  const prepare = (name, attempt = '1') => {
    const outbox = path.join(f.base, 'outboxes', `${name}-${attempt}`); fs.mkdirSync(outbox, { recursive: true });
    const record = cli(f, ['register', '--project', 'demo', '--job', name, '--attempt', attempt, '--outbox', outbox]);
    fs.writeFileSync(path.join(outbox, 'guard.log'), 'DUMMY_SECRET_NOT_FOR_MESSAGE');
    const proof = { schema_version: 1, kind: 'prelaunch_rejection', delivery_id: record.key,
      project: 'demo', job_id: name, attempt_id: attempt, target_thread_id: owner, stage: 'before_executor_spawn',
      executor_spawn_attempted: false, provider_invocation_attempted: false, execution_started: false,
      status: 'blocked', reason_code: 'write_scope_rejected', diagnostic_paths: ['guard.log'] };
    write(path.join(outbox, 'PRELAUNCH_REJECTION.json'), proof);
    return { id: record.key, outbox, proof };
  };
  const good = prepare('prelaunch-good');
  const wrong = prepare('prelaunch-wrong'); write(path.join(wrong.outbox, 'PRELAUNCH_REJECTION.json'), { ...wrong.proof, target_thread_id: 'not-original-owner' });
  const escaping = prepare('prelaunch-escape'); write(path.join(escaping.outbox, 'PRELAUNCH_REJECTION.json'), { ...escaping.proof, diagnostic_paths: ['../outside.log'] });
  const unknown = prepare('prelaunch-unknown'); write(path.join(unknown.outbox, 'PRELAUNCH_REJECTION.json'), { ...unknown.proof, executor_spawn_attempted: true });
  const existing = prepare('prelaunch-existing'); fs.writeFileSync(path.join(existing.outbox, 'REPORT.md'), 'Original executor report'); write(path.join(existing.outbox, 'READY.json'), { status: 'completed', deliverables: [] });
  const partial = prepare('prelaunch-partial'); fs.writeFileSync(path.join(partial.outbox, 'REPORT.md'), 'Preserved partial report');
  const claimed = prepare('prelaunch-claimed'); write(path.join(f.mailboxRoot, 'claims', `${claimed.id}.lock`), { previous: true });
  const retired = prepare('prelaunch-retired'); const retiredPath = path.join(f.mailboxRoot, 'jobs', `${retired.id}.json`); write(retiredPath, { ...readJson(retiredPath), state: 'retired' });
  const e = engine(f); e.startWatch(coordinator); await e.tick();
  assert.equal(central(f, good.id).state, 'sent'); assert.equal(central(f, existing.id).state, 'sent');
  const report = fs.readFileSync(path.join(good.outbox, 'REPORT.md'), 'utf8');
  assert.ok(report.includes('not an executor report')); assert.ok(report.includes('guard.log')); assert.equal(report.includes('DUMMY_SECRET'), false);
  const notification = deliveries(f).find(event => event.params.arguments.prompt.startsWith(`[app-mailbox:${good.id}]`));
  assert.equal(notification.params.arguments.threadId, owner); assert.ok(notification.params.arguments.prompt.includes('launch-failure receipt'));
  for (const item of [wrong, escaping, unknown, partial, claimed, retired]) assert.equal(fs.existsSync(path.join(item.outbox, 'READY.json')), false);
  assert.equal(fs.readFileSync(path.join(partial.outbox, 'REPORT.md'), 'utf8'), 'Preserved partial report');
  assert.equal(fs.readFileSync(path.join(existing.outbox, 'REPORT.md'), 'utf8'), 'Original executor report');
  const readyBytes = fs.readFileSync(path.join(good.outbox, 'READY.json')); const sentBytes = fs.readFileSync(path.join(f.mailboxRoot, 'deliveries', `${good.id}.json`));
  await e.tick(); assert.equal(deliveries(f).length, 2); assert.deepEqual(fs.readFileSync(path.join(good.outbox, 'READY.json')), readyBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.mailboxRoot, 'deliveries', `${good.id}.json`)), sentBytes);
  assert.equal(cli(f, ['prelaunch', good.id]).prelaunch_ready_created, false);
  const newer = prepare('prelaunch-good', '2'); await e.tick(); assert.equal(central(f, newer.id).state, 'sent');
});
