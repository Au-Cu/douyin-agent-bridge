import { parentPort,workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join } from 'node:path';
try {
  const sherpa=createRequire(import.meta.url)('sherpa-onnx-node');
  const recognizer=new sherpa.OfflineRecognizer({featConfig:{sampleRate:16000,featureDim:80},modelConfig:{senseVoice:{model:join(workerData.model,'model.int8.onnx'),language:'auto',useInverseTextNormalization:1},tokens:join(workerData.model,'tokens.txt'),numThreads:2,provider:'cpu',debug:0}});
  const wav=sherpa.readWave(workerData.wav);const results=[];const chunk=16000*30;
  for(let at=0;at<wav.samples.length;at+=chunk){
    const stream=recognizer.createStream();stream.acceptWaveform({samples:wav.samples.subarray(at,at+chunk),sampleRate:wav.sampleRate});recognizer.decode(stream);
    const text=recognizer.getResult(stream).text.replace(/<\|[^>]+\|>/g,'').trim();
    if(text)results.push({seconds:Math.round(at/16000),text});
    stream.free?.();parentPort.postMessage({type:'progress',progress:Math.min(1,(at+chunk)/wav.samples.length)});
  }
  parentPort.postMessage({type:'result',segments:results});recognizer.free?.();
} catch(e){parentPort.postMessage({type:'error',error:e.message});}
