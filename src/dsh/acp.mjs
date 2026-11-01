import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export const ACP_PROTOCOL_VERSION = 1;

// Minimal Agent Client Protocol v1 client over newline-delimited JSON-RPC.
// The DeepSeek Harness ACP server keeps stdout free of anything but protocol
// frames, so a plain line reader is enough. Server-initiated requests (the
// permission prompt) are forwarded to the caller instead of being answered
// here: the bridge owns the approval decision.
export class AcpConnection extends EventEmitter {
  constructor({ command, args = [], cwd, env = {}, log = () => {}, clientInfo = { name: 'douyin_codex_bridge', version: '0.9.2' } } = {}) {
    super();
    Object.assign(this, { command, args, cwd, env, log, clientInfo });
    this.seq = 0;
    this.pending = new Map();
    this.proc = null;
    this.lines = null;
    this.ready = false;
    this.capabilities = {};
    this.stderrTail = '';
  }

  async start() {
    if (this.proc) return this;
    const { executable, prefix, env } = this.command;
    const proc = this.proc = spawn(executable, [...prefix, ...this.args], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proc.on('error', e => this.#disconnect(e));
    proc.on('exit', (code, signal) => this.#disconnect(Object.assign(new Error('DeepSeek Harness 连接已关闭'), { code: 'DSH_CLIENT_CLOSED', uncertain: true, exitCode: code, signal })));
    // Keep a bounded tail for diagnosis only. Credentials never reach the app log.
    proc.stderr.on('data', chunk => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    this.lines = createInterface({ input: proc.stdout });
    this.lines.on('line', line => this.#receive(line));
    const result = await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
      clientInfo: this.clientInfo
    }, 30000);
    await this.request('authenticate', { methodId: 'douyin-codex-bridge' }, 15000).catch(() => {});
    this.capabilities = result?.agentCapabilities || {};
    this.ready = true;
    return result;
  }

  send(message) {
    if (!this.proc?.stdin?.writable) throw new Error('DeepSeek Harness 未连接');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} 超时`), { code: 'DSH_REQUEST_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params = {}) {
    try { this.send({ jsonrpc: '2.0', method, params }); } catch { /* the connection is already gone */ }
  }

  respond(id, result) {
    try { this.send({ jsonrpc: '2.0', id, result }); } catch { /* the connection is already gone */ }
  }

  respondError(id, code, message) {
    try { this.send({ jsonrpc: '2.0', id, error: { code, message } }); } catch { /* the connection is already gone */ }
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.log('DeepSeek Harness 消息无法解析', 'error'); return; }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = Object.assign(new Error(message.error.message || JSON.stringify(message.error)), {
          remote: true,
          code: message.error.code,
          rpcMethod: pending.method
        });
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      // A server-initiated request. The bridge answers permission prompts.
      this.emit('request', message);
      return;
    }
    if (message.method !== undefined) {
      this.emit('notification', message);
    }
  }

  #disconnect(error) {
    if (!this.proc) return;
    this.ready = false;
    this.lines?.close();
    this.lines = null;
    const tail = this.stderrTail.trim().slice(-400);
    const failure = tail ? Object.assign(error, { detail: tail }) : error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    this.proc = null;
    this.emit('disconnected', failure);
  }

  close() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.lines?.close();
    this.lines = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('DeepSeek Harness 连接已关闭'), { code: 'DSH_CLIENT_CLOSED' }));
    }
    this.pending.clear();
    proc.kill();
  }
}
