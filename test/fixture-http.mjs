import {randomInt} from 'node:crypto';
// Windows can allocate a browser-blocked ephemeral port (for example 6697).
// Windows/Hyper-V can also reserve a port in this range (listen returns EACCES).
// Retry a bounded number of fixture ports; do not change the OS reservations.
export async function listenBrowserFixture(server){let last;for(let i=0;i<12;i++){try{await new Promise((resolve,reject)=>{const failed=e=>{server.off('listening',ready);reject(e);},ready=()=>{server.off('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen(randomInt(20000,55000),'127.0.0.1');});return;}catch(e){last=e;if(e.code!=='EADDRINUSE'&&!(process.platform==='win32'&&e.code==='EACCES'))throw e;}}throw new Error('No free browser fixture port',{cause:last});}
