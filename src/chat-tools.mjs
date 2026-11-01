// No eval, Function, child process, filesystem, network, account or project API.
// These are the ONLY bridge callbacks an ordinary model can invoke.
export function calculate(source){
  if(typeof source!=='string'||source.length>500)throw new Error('算式须为 500 字符以内的纯数学表达式');
  const tokens=source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[^\s]/gi)||[];let pos=0,steps=0,depth=0;
  const finite=x=>{if(!Number.isFinite(x)||Math.abs(x)>1e308)throw new Error('计算超出有限数值范围');return x;};
  const functions={sqrt:Math.sqrt,abs:Math.abs,log:Math.log,sin:Math.sin,cos:Math.cos,round:Math.round};
  const atom=()=>{if(++steps>1000||++depth>32)throw new Error('算式过于复杂');let value,t=tokens[pos++];
    if(t==='('){value=expression();if(tokens[pos++]!==')')throw new Error('括号不匹配');}
    else if(/^\d|^\.\d/.test(t||''))value=Number(t);
    else if(t==='pi')value=Math.PI;
    else if(Object.hasOwn(functions,t||'')){if(tokens[pos++]!=='(')throw new Error('数学函数需要括号');value=functions[t](expression());if(tokens[pos++]!==')')throw new Error('括号不匹配');}
    else throw new Error('仅允许数字、算术和指定数学函数');depth--;return finite(value);
  };
  const unary=()=>{if(tokens[pos]==='+'||tokens[pos]==='-'){if(++steps>1000||depth++>32)throw new Error('算式过于复杂');const sign=tokens[pos++]==='-'?-1:1,n=sign*unary();depth--;return n;}return power();};
  const power=()=>{let n=atom();if(tokens[pos]==='^'){pos++;if(++steps>1000||depth++>32)throw new Error('算式过于复杂');n=finite(n**unary());depth--;}return n;};
  const product=()=>{let n=unary();while(['*','/','%'].includes(tokens[pos])){const op=tokens[pos++],b=unary();n=finite(op==='*'?n*b:op==='/'?n/b:n%b);}return n;};
  const expression=()=>{let n=product();while(tokens[pos]==='+'||tokens[pos]==='-'){const op=tokens[pos++],b=product();n=finite(op==='+'?n+b:n-b);}return n;};
  const value=expression();if(pos!==tokens.length)throw new Error('含不支持的表达式');return {expression:source,result:value};
}
export const publicChatTools=[{name:'public_calculate',description:'纯数学计算器，仅接受数学表达式；不运行代码，不读取文件。支持 + - * / % ^、括号、pi、sqrt、abs、log、sin、cos、round。',inputSchema:{type:'object',properties:{expression:{type:'string'}},required:['expression'],additionalProperties:false}},{name:'current_time',description:'查询当前时间。只返回公开时间，不读取用户的系统设置或账户。',inputSchema:{type:'object',properties:{timezone:{type:'string',enum:['Asia/Shanghai','Asia/Hong_Kong','UTC']}},required:['timezone'],additionalProperties:false}}];
export function publicChatTool(call){
  const args=call.arguments;if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('无效的工具参数');
  if(call.tool==='public_calculate'&&Object.keys(args).every(k=>k==='expression'))return calculate(args.expression);
  if(call.tool==='current_time'&&Object.keys(args).every(k=>k==='timezone')&&['Asia/Shanghai','Asia/Hong_Kong','UTC'].includes(args.timezone)){const now=new Date();return {timezone:args.timezone,time:new Intl.DateTimeFormat('zh-CN',{timeZone:args.timezone,dateStyle:'full',timeStyle:'long',hour12:false}).format(now),utc:now.toISOString()};}
  throw new Error('普通聊天没有这个工具或参数权限');
}
