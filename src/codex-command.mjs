import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Invoke the official npm entry point directly: Windows .cmd shims cannot be
// safely spawned without a shell. No shell or user message enters this command.
export function resolveCodexCommand(requested='codex'){
  let command=requested;
  if(command==='codex'){
    const local=fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js',import.meta.url));
    if(existsSync(local))command=local;
  }
  return /\.(?:mjs|cjs|js)$/i.test(command)?{executable:process.execPath,prefix:[resolve(command)]}:{executable:command,prefix:[]};
}
