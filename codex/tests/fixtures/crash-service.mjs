// Test-only process: crash after exact receipt persistence, before ledger ack.
import { loadConfig } from '../../plugin/lib/config.mjs';
import { AppMailboxEngine, MailboxDriver } from '../../plugin/lib/app-mailbox.mjs';
import { OfficialTools } from '../../plugin/lib/official-tools.mjs';
import { serveStdio } from '../../plugin/lib/mcp-service.mjs';
const config = loadConfig();
class CrashDriver extends MailboxDriver {
  run(operation, args) { if (operation === 'ack') process.exit(17); return super.run(operation, args); }
}
const engine = new AppMailboxEngine({ stateDir: config.stateDir, coordinatorThreadId: config.coordinatorThreadId, pollMs: 25,
  driver: new CrashDriver({ root: config.mailboxRoot, pythonPath: config.pythonExecutable }), client: new OfficialTools({ timeoutMs: 1000 }) });
serveStdio(engine);
