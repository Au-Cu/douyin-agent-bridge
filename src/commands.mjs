const aliases=new Map(Object.entries({help:'help','帮助':'help','状态':'status',status:'status','设置':'settings','配置':'settings','密度':'density','模型':'model',model:'model','强度':'effort','快':'fast','快速':'fast',fast:'fast','分聊':'routing','预算':'budget','新建':'new','切换':'switch','找':'find','续看':'resume','继续视频':'resume','重连':'reconnect','重新连接':'reconnect',reconnect:'reconnect','派':'dispatch','派给':'dispatch',dispatch:'dispatch','同意':'approve','拒绝':'decline'}));
export function parseCommand(text){const m=String(text||'').trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);return m?{name:aliases.get(m[1].toLowerCase())||'unknown',arg:(m[2]||'').trim(),raw:String(text)}:null;}
export function onOff(arg){if(['开','on'].includes(arg.toLowerCase()))return true;if(['关','off'].includes(arg.toLowerCase()))return false;throw new Error('请明确填写 开 或 关；不填写时只查看当前设置。');}
export const commandHelp=`可用命令

/状态  查看进度和当前需求
/设置  查看默认配置
/模型 [完整ID]  查看或切换模型
/强度 [档位]  查看或更改推理强度
/快 开|关  快速模式
/密度 2|4|8  视频每秒读取帧数
/分聊 开|关  自动按需求分对话
/预算 数字  上下文 tokens 上限

/新建 [标题]  新需求并切换
/找 [关键词]  查找需求目录
/切换 需求ID  找回指定需求
/续看 [视频ID]  继续未完成的视频
/派 别名 任务  交给允许的目标聊天
/同意 编号  批准指定操作
/拒绝 编号  拒绝指定操作
/重连  读取当前 Codex 登录
/帮助  查看本说明

旧的 /派给、/继续视频、/重新连接 继续兼容。`;
