const aliases=new Map(Object.entries({help:'help','帮助':'help','状态':'status',status:'status','设置':'settings','配置':'settings','密度':'density','模型':'model',model:'model','强度':'effort','快':'fast','快速':'fast',fast:'fast','分聊':'routing','预算':'budget','新建':'new','切换':'switch','找':'find','续看':'resume','继续视频':'resume','重连':'reconnect','重新连接':'reconnect',reconnect:'reconnect','派':'dispatch','派给':'dispatch',dispatch:'dispatch','同意':'approve','拒绝':'decline','重试':'retry','归档需求':'archive_need','归档任务':'archive_task','恢复需求':'restore_need','恢复任务':'restore_task'}));
aliases.set('中断','interrupt');
aliases.set('助手','harness');aliases.set('harness','harness');
aliases.set('忽略','ignore_start');aliases.set('结束忽略','ignore_end');
export function parseCommand(text){const m=String(text||'').trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);return m?{name:aliases.get(m[1].toLowerCase())||'unknown',arg:(m[2]||'').trim(),raw:String(text)}:null;}
export function onOff(arg){if(['开','on'].includes(arg.toLowerCase()))return true;if(['关','off'].includes(arg.toLowerCase()))return false;throw new Error('请明确填写 开 或 关；不填写时只查看当前设置。');}
export const commandHelp=`可用命令

/状态  查看进度和当前需求
/中断 任务编号  立即强制中断，例如 /中断 5 或 /中断 5-1
/忽略  静默忽略后续所有消息和命令
/结束忽略  静默恢复正常接收
/设置  查看默认配置
/模型 [完整ID]  查看或切换模型
/强度 [档位]  查看或更改推理强度
/快 开|关  快速模式
/密度 2|4|8  视频每秒读取帧数
/分聊 开|关  自动按需求分对话
/预算 数字  上下文 tokens 上限
/助手 [codex|dsh]  查看或切换本机助手，重启后生效

/新建 [标题]  新需求并切换
/找 [关键词]  查找需求目录
/切换 需求编号  找回指定需求，例如 /切换 2
/归档需求 编号  收起需求并归档对应 Codex 对话
/恢复需求 编号  恢复需求及对应 Codex 对话
/归档任务 编号  收起任务，未提交的工作暂停
/恢复任务 编号  恢复显示；暂停工作需另用 /重试
/续看 [视频ID]  继续未完成的视频
/派 别名 任务  交给允许的目标聊天
/同意 操作号  批准待确认操作（使用确认请求给出的操作号）
/拒绝 操作号  拒绝待确认操作
/重连  读取当前 Codex 登录
/重试 任务编号  恢复尚未提交的受阻任务，例如 /重试 5-1
/帮助  查看本说明`;
