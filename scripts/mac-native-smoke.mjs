import assert from 'node:assert/strict';import {join} from 'node:path';
import {resolveDataRoot} from '../src/data-root.mjs';import {runFfmpeg,transcribe} from '../src/media.mjs';import {modelName} from './setup-asr.mjs';
assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
await runFfmpeg(['-version']);const model=join(resolveDataRoot(),'models',modelName),segments=await transcribe(join(model,'test_wavs','zh.wav'),model);assert.ok(segments.some(s=>s.text.length>5),'native local speech recognition did not return text');
console.log(JSON.stringify({platform:'darwin-arm64',nativeFfmpeg:true,nativeAsr:true,thirdPartyInference:false}));
