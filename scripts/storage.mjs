import {fileURLToPath} from 'node:url';import {parseArgs} from 'node:util';
import {resolveDataRoot,prepareDataRoot,migrateData,inspectData} from '../src/data-root.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
const {values}=parseArgs({options:{prepare:{type:'boolean'},port:{type:'boolean'},encoded:{type:'boolean'},'migrate-from':{type:'string'}}});
try{const root=resolveDataRoot();if(values['migrate-from'])await migrateData(values['migrate-from'],root);else if(values.prepare)await prepareDataRoot(project);console.log(values.port?(inspectData(root).config.port||39361):values.encoded?Buffer.from(root,'utf8').toString('base64'):root);}
catch(e){console.error('数据目录未修改完成：'+e.message);process.exitCode=1;}
