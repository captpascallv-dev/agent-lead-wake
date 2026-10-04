import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function loadConfig(env = process.env, filename = env.MAIL_WAKE_CONFIG) {
  const explicit = typeof filename === 'string' && filename.trim();
  const codexHome = env.CODEX_HOME?.trim() || path.join(env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir(), '.codex');
  const configPath = explicit ? path.resolve(filename) : path.resolve(codexHome, 'mail-wake.config.json');
  const exists = fs.existsSync(configPath);
  if (explicit && !exists) throw new Error('The explicitly selected MAIL_WAKE_CONFIG file does not exist.');
  // This fixed location holds USER-PROVIDED configuration. It supplies no
  // implicit root/owner/permission; missing required fields still fail closed.
  const base = exists ? path.dirname(configPath) : process.cwd();
  const file = exists ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const allowed = new Set(['mailboxRoot', 'stateDir', 'coordinatorThreadId', 'pythonExecutable', 'appToolsEntry', 'pollIntervalMs']);
  for (const name of Object.keys(file)) if (!allowed.has(name)) throw new Error(`Unknown configuration field: ${name}.`);
  const config = { mailboxRoot: env.MAIL_WAKE_MAILBOX_ROOT ?? file.mailboxRoot,
    stateDir: env.MAIL_WAKE_STATE_DIR ?? file.stateDir,
    coordinatorThreadId: env.MAIL_WAKE_COORDINATOR ?? file.coordinatorThreadId,
    pythonExecutable: env.MAIL_WAKE_PYTHON ?? file.pythonExecutable,
    appToolsEntry: file.appToolsEntry ?? null, pollIntervalMs: file.pollIntervalMs ?? 15000 };
  for (const name of ['mailboxRoot', 'stateDir', 'coordinatorThreadId', 'pythonExecutable']) {
    if (typeof config[name] !== 'string' || !config[name].trim() || /REPLACE|<[^>]+>/.test(config[name])) throw new Error(`Explicit ${name} configuration is required.`);
  }
  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 1000 || config.pollIntervalMs > 60000) throw new Error('pollIntervalMs must be 1000..60000.');
  for (const name of ['mailboxRoot', 'stateDir', 'appToolsEntry']) if (config[name]) config[name] = path.resolve(base, config[name]);
  // A bare Python command explicitly chooses the current PATH; path values are
  // resolved beside the configuration file. Never guess another user's runtime.
  if (/[\\/]/.test(config.pythonExecutable)) config.pythonExecutable = path.resolve(base, config.pythonExecutable);
  if (config.mailboxRoot === config.stateDir) throw new Error('mailboxRoot and stateDir must be separate directories.');
  return config;
}
