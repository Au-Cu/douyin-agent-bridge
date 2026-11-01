import {readFile} from 'node:fs/promises';
import {SharedCodexBroker} from '../src/shared-codex-broker.mjs';
import {lockStorage} from '../src/durable.mjs';
import {dirname} from 'node:path';
import {clearStaleSharedSocket} from '../src/shared-codex-transport.mjs';

const [file,launchFile]=process.argv.slice(2),config=JSON.parse(await readFile(file,'utf8')),launch=JSON.parse(await readFile(launchFile,'utf8'));
let unlock,broker;
try{
  unlock=lockStorage(dirname(file),'broker.lock');
  await clearStaleSharedSocket(config.endpoint);
  broker=await new SharedCodexBroker({endpoint:config.endpoint,token:config.token,command:config.original,args:launch.args,cwd:launch.cwd,env:process.env}).listen();
  const close=broker.close.bind(broker);broker.close=async()=>{await close();unlock?.();process.exit(0);};
  process.once('SIGINT',()=>broker.close());process.once('SIGTERM',()=>broker.close());
}catch{unlock?.();process.exitCode=1;}
