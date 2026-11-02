// Only the desktop's persistent stdio host belongs to the broker. Startup
// policy probes, sign-out, CLI tools and helper servers must reach the original
// executable directly, with their stdout/stderr and exit status intact.
const globalValues=new Set(['-c','--config','--enable','--disable','-p','--profile','-C','--cd']);
const serverValues=new Set(['-c','--config','--enable','--disable','--startup-client-info','--cloud-skills-snapshot','--code-mode-host','--listen','--ws-auth','--ws-token-file','--ws-token-sha256','--ws-shared-secret-file','--ws-issuer','--ws-audience','--ws-max-clock-skew-seconds']);
export function isSharedDesktopServer(args){
  let i=0;
  while(i<args.length&&args[i].startsWith('-')){
    const [key,...value]=args[i].split('=');
    if(!globalValues.has(key))return false;
    if(!value.length){if(i+1>=args.length)return false;i++;}i++;
  }
  if(args[i++]!=='app-server')return false;
  let analytics=false,listen='stdio://';
  for(;i<args.length;i++){
    const [key,...value]=args[i].split('=');
    if(serverValues.has(key)){
      const argument=value.length?value.join('='):args[++i];if(argument===undefined)return false;
      if(key==='--listen')listen=argument;
    }else if(key==='--analytics-default-enabled'&&!value.length)analytics=true;
    else if(key==='--stdio'&&!value.length)listen='stdio://';
    else if(key!=='--strict-config'||value.length)return false;
  }
  return analytics&&listen==='stdio://';
}
