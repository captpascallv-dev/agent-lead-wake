// Fake MCP host used only by the portable tests. It is not official server code.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const { key } = await import(process.env.TEST_KEY_MODULE);
const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (!Object.hasOwn(request, 'id')) return;
  fs.appendFileSync(process.env.TEST_LOG, `${JSON.stringify({ method: request.method, params: request.params, pipe: process.env.CODEX_APP_TOOLS_PIPE_PATH })}\n`);
  if (request.method === 'initialize') return respond(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test-host', version: '0.0.0' } });
  if (request.method === 'tools/list') return respond(request.id, { tools: [{ name: 'read_thread' }, { name: 'send_message_to_thread' }] });
  const control = JSON.parse(fs.readFileSync(process.env.TEST_CONTROL, 'utf8')); const params = request.params;
  if (params.name === 'read_thread') {
    if (control.readReject) return respond(request.id, { isError: true, content: [{ type: 'text', text: 'Test read refusal' }] });
    return respond(request.id, { isError: false, content: [{ type: 'text', text: JSON.stringify({ thread: {
      id: control.wrongActor ?? params.arguments.threadId, status: { type: control.ownerStatus ?? 'idle' },
    } }) }] });
  }
  if (params.name === 'send_message_to_thread') {
    const id = params.arguments.prompt.match(/^\[app-mailbox:([^\]]+)\]/)?.[1];
    const fault = params.arguments.prompt.match(/^\[app-mailbox-transport-fault:([^\]]+)\]/)?.[1];
    const intentPath = id ? path.join(process.env.TEST_STATE, 'app-mailbox', 'deliveries', key(id), 'intent.json')
      : path.join(process.env.TEST_STATE, 'app-mailbox', 'faults', fault, 'intent.json');
    if (!fs.existsSync(intentPath)) throw new Error('Send happened before durable intent publication');
    if (control.sendMode === 'timeout') return;
    return respond(request.id, { isError: control.sendMode === 'reject', content: [{ type: 'text', text: JSON.stringify({ threadId: params.arguments.threadId }) }] });
  }
});
