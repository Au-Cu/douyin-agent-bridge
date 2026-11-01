import {randomInt} from 'node:crypto';
// Windows can allocate a browser-blocked ephemeral port (for example 6697).
// Use a bounded high range and retry only a genuine address collision.
export async function listenBrowserFixture(server){for(let i=0;i<12;i++){try{await new Promise((resolve,reject)=>{const failed=e=>{server.off('listening',ready);reject(e);},ready=()=>{server.off('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen(randomInt(20000,55000),'127.0.0.1');});return;}catch(e){if(e.code!=='EADDRINUSE')throw e;}}throw new Error('No free browser fixture port');}
