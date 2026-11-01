export const chatReplyInstructions='抖音私信不能渲染 Markdown、LaTeX 或 HTML。给用户看的回复必须是纯文本：标题独占一行，用空行分段，每段只说一件事；步骤用编号，一行一项，编号与正文之间留一个空格。尽量用短句，避免大段文字；不用井号标题、加粗星号、反引号、代码围栏、Markdown 表格或数学定界符。公式用易读文字或普通数学符号表达，链接直接写完整网址。';

function plainMath(value){
  let s=value.trim().replace(/\\(?:begin|end)\{[^}]+\}/g,'').replace(/\\(?:left|right)\b/g,'');
  for(let i=0;i<12;i++){
    const before=s;
    s=s.replace(/\\(?:d?frac)\{([^{}]*)\}\{([^{}]*)\}/g,'($1)/($2)').replace(/\\sqrt\{([^{}]*)\}/g,'√($1)')
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g,'$1');
    if(s===before)break;
  }
  const symbols={times:'×',cdot:'·',leq:'≤',le:'≤',geq:'≥',ge:'≥',neq:'≠',ne:'≠',approx:'≈',infty:'∞',pm:'±',mp:'∓',to:'→',rightarrow:'→',leftarrow:'←',sum:'Σ',prod:'Π',int:'∫',alpha:'α',beta:'β',gamma:'γ',delta:'δ',theta:'θ',lambda:'λ',mu:'μ',pi:'π',sigma:'σ',omega:'ω',quad:' ',qquad:' ',ldots:'…',cdots:'…'};
  return s.replace(/\\([a-zA-Z]+)/g,(_,name)=>symbols[name]??name).replace(/\\\\/g,'\n').replace(/\\[,;:! ]/g,' ')
    .replace(/\^\{2\}/g,'²').replace(/\^\{3\}/g,'³').replace(/\^\{([^{}]*)\}/g,'^($1)').replace(/_\{([^{}]*)\}/g,'_($1)')
    .replace(/[{}]/g,c=>c==='{'?'(':')').replace(/&/g,' ').trim();
}

const cells=line=>line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'｜'));
const tableRule=line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

export function toPlainChatText(value){
  let s=String(value??'').replace(/\r\n?/g,'\n');const literal=[];
  const protect=text=>{const token='\uE000'+literal.length+'\uE001';literal.push(text);return token;};
  s=s.replace(/(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/g,(_,code)=>protect(code.trimEnd()));
  s=s.replace(/`([^`\n]+)`/g,(_,code)=>protect(code));
  s=s.replace(/\$\$([\s\S]*?)\$\$/g,(_,math)=>plainMath(math)).replace(/\\\[([\s\S]*?)\\\]/g,(_,math)=>plainMath(math))
    .replace(/\\\(([\s\S]*?)\\\)/g,(_,math)=>plainMath(math)).replace(/(?<![\\\w])\$([^$\n]+)\$/g,(_,math)=>plainMath(math));
  s=s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,(_,alt,url)=>(alt||'图片')+'（'+url+'）')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,url)=>label===url?url:label+'（'+url+'）')
    .replace(/(?<![A-Za-z0-9])\*\*(?=\S)([^\n]*?\S)\*\*/g,'$1').replace(/__([^]*?)__/g,'$1').replace(/~~([^]*?)~~/g,'$1')
    .replace(/(^|[\s（(])\*([^*\n]+)\*(?=$|[\s，。！？、）)])/gm,'$1$2')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,'$1').replace(/^[ \t]*>[ \t]?/gm,'').replace(/^[ \t]*[-*+][ \t]+/gm,'• ')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm,'').replace(/^[ \t]*(?:```|~~~).*$/gm,'')
    .replace(/<br\s*\/?>/gi,'\n').replace(/<\/?(?:p|h[1-6]|div)\b[^>]*>/gi,'\n').replace(/<\/?(?:strong|em|b|i)\b[^>]*>/gi,'')
    .replace(/cite[^]*/g,'');
  const lines=s.split('\n'),out=[];
  for(let i=0;i<lines.length;i++){
    if(i+1<lines.length&&tableRule(lines[i+1])){
      const headers=cells(lines[i]);i++;
      while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim()){
        const row=cells(lines[++i]);out.push(row.map((v,j)=>headers[j]?headers[j]+'：'+v:v).filter(Boolean).join('；'));
      }
      out.push('');
    }else out.push(lines[i]);
  }
  const readable=out.flatMap(line=>{
    if(Array.from(line).length<=120||!/\p{Script=Han}/u.test(line)||/\uE000|https?:\/\//.test(line))return [line];
    const sentences=line.match(/[^。！？；，]+[。！？；，]?/g)||[line],paragraphs=[];let paragraph='';
    for(const sentence of sentences){if(paragraph&&Array.from(paragraph+sentence).length>100){paragraphs.push(paragraph,'');paragraph='';}paragraph+=sentence;}
    if(paragraph)paragraphs.push(paragraph);return paragraphs;
  });
  return readable.join('\n').replace(/\uE000(\d+)\uE001/g,(_,i)=>literal[Number(i)]).split('\n').map(l=>l.trimEnd()).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}

export const comparableChatText=value=>String(value??'').replace(/\s+/g,' ').trim();

export function matchesOutgoingText(message,body,{replyToMessageId='',replyToSender=''}={}){
  if(comparableChatText(message.text)===comparableChatText(body))return true;
  return !!replyToMessageId&&message.replyTo?.messageId===replyToMessageId&&!!replyToSender&&message.nativeReplyBody?.uid===replyToSender&&comparableChatText(message.nativeReplyBody.text)===comparableChatText(body);
}
