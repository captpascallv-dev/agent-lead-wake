import { loadConfig } from './lib/config.mjs';
import { AppMailboxEngine, MailboxDriver } from './lib/app-mailbox.mjs';
import { OfficialTools } from './lib/official-tools.mjs';
import { serveStdio } from './lib/mcp-service.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Usage: node server.mjs [--config <configuration.json>]');
  const config = loadConfig(process.env, args[1] ?? process.env.MAIL_WAKE_CONFIG);
  const engine = new AppMailboxEngine({ stateDir: config.stateDir, coordinatorThreadId: config.coordinatorThreadId,
    pollMs: config.pollIntervalMs, driver: new MailboxDriver({ root: config.mailboxRoot, pythonPath: config.pythonExecutable }),
    client: new OfficialTools({ appToolsEntry: config.appToolsEntry }) });
  serveStdio(engine);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { engine.close(); process.exit(0); });
} catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
