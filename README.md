# 抖音 × Codex 本机助手

[![CI](https://github.com/Au-Cu/douyin-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Au-Cu/douyin-codex-bridge/actions/workflows/ci.yml)
[源码发行包](https://github.com/Au-Cu/douyin-codex-bridge/releases/latest) · [故障排查](docs/TROUBLESHOOTING.md) · [MIT](LICENSE)

在手机抖音里，把视频私信转发给自己的助手账号。电脑上的桥接读取原视频，让你自己的 Codex 理解画面和口播，并在原私信里回复。你明确发出指示后，它可以把原片、视觉资料和任务交给你允许的其他 Codex 聊天。

你不需要先截图、摘字幕或手动概括视频。把视频当作图片参考一样转发，随后直接说“按这个做”“比较刚才两个视频”或“把这个交给网站项目”。

这是运行在个人电脑上的社区项目，依赖抖音网页版结构。当前安装入口支持 Windows x64 / ARM64；ARM64 已做真实账号验收，x64 由 Windows CI 检查。macOS/Linux 暂未提供安装适配。不是抖音或 OpenAI 官方连接器。

## 需要准备

- Node.js 24.5.0 或以上：[官方下载](https://nodejs.org/)。安装后重新打开终端。
- Microsoft Edge、正常联网的 Windows 电脑，使用期间保持开机。
- 自己已开通 Codex 使用权限的 ChatGPT 账号。项目会安装固定版本的官方 Codex CLI，复用本机 Codex 登录与聊天数据，无需单独配置模型 API Key。
- 一个用来接收视频的抖音助手账号；主号和助手账号互关。手机可以是 iPhone 或安卓。

视觉理解和任务执行由 Codex 完成；口播使用本机 SenseVoice 转写。没有第三方云模型调用。文字稿与连续画面会提交给你登录的 Codex，使用你的 Codex 额度。耗时和额度消耗取决于视频长度与采样密度。

## 下载与首次安装

```powershell
git clone https://github.com/Au-Cu/douyin-codex-bridge.git
cd douyin-codex-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

也可以下载 [Release ZIP](https://github.com/Au-Cu/douyin-codex-bridge/releases/latest)，解压后双击 `install.cmd`。这是源码安装包，首次安装需要联网；不包含 Node、账号信息、浏览器登录资料或模型权重。

安装器执行 npm ci，准备视频工具和本地转写模型。模型压缩包约 163 MB，解压后约 239 MB。下载会校验完整性，完成后直接复用。

首次使用 Codex、或检查提示未登录时，打开项目目录下的终端执行：

```powershell
npm run codex:login
```

选择用自己的 ChatGPT 账号登录，完成官方浏览器流程。已有可用登录通常会直接复用。登录后运行 `start.cmd`；如果助手已运行，先执行 `stop.cmd` 再启动。官方登录说明：[Codex Authentication](https://learn.chatgpt.com/docs/auth)。

## 连接自己的抖音

1. 双击 `start.cmd`（也保留了 `启动助手.cmd`），打开 http://127.0.0.1:39361。
2. 点“打开抖音登录窗口”，在项目专用 Edge 窗口登录自己的助手账号。它与日常浏览器使用独立资料目录。
3. 从手机主号给助手发一条消息。在项目窗口打开主号私信，点控制台“绑定当前会话”。绑定核验账号 ID，不靠昵称。
4. 点“创建调度聊天”，建立自己的固定 Codex 助手会话。
5. 若需要派任务，点“读取本机聊天”，选择允许接收任务的聊天，填别名、加入名单并保存。可先留空，只使用视频学习。
6. 点“开始监听”，再从手机转发一条新视频。启动前的历史消息不会被当成新指令。

之后在手机私信里使用即可。收到视频时优先给原消息贴“👌”；无法核验表情时用短文字确认。排队与开始分析会分别告知，结果回到原会话。回复使用纯文本、短段落、换行和编号。

## 在抖音里怎么用

| 发送内容 | 行为 |
| --- | --- |
| 私信转发视频卡片 | 获取原视频，转写口播并分析全时段连续画面，保存学习资料 |
| “按刚才的视频，解释页面切换的具体做法” | 引用已保存的画面、口播和视觉观察回答 |
| `/派给 网站项目 根据刚才视频修改首页并验证` | 交给允许名单中的“网站项目”，带原片索引与图片附件 |
| `/状态` | 查看视频分析和任务进度 |
| `/继续视频` | 从最近未完成视频的已保存进度续做 |
| `/继续视频 视频ID` | 继续指定视频 |
| `/重新连接` | 重新读取本机当前 Codex 登录，保留绑定、目标名单与进度 |
| `/同意 编号` 或 `/拒绝 编号` | 处理 Codex 对应的操作确认；具体内容可在控制台核对 |

只有绑定主号的直接指示可以派任务。视频里的口播、字幕和其他素材不会被当成你的命令。没有配置目标聊天时，不会擅自把任务发给其他项目。

## 本机切换 Codex 账号

额度不足或登录失效时，可以在同一台电脑的 Codex 中完成其他自有账号的登录，保留同一个 CODEX_HOME。默认文件型登录每 3 秒检查一次；检测到变化后重建桥接连接，无需重绑抖音、重新选择目标聊天或重新转发视频。

正在执行的任务会先结束，再切换连接。因登录或额度暂停的视频会复用已保存的原片和已完成视觉片段，连接恢复后续做。执行结果不明的派发任务保留“需要核实”，不会自动重复执行。

也可以在抖音发送 `/重新连接`，或在控制台点“重新连接 Codex”；`/继续视频` 会先重新读取登录再续做。使用系统凭据库、未触发文件变化检测，或同一账号额度恢复时，可用这些入口手动触发。桥接不会保存多个账号的密码或替你自动切换账号；新登录本身必须有效且有可用额度。

这是本机 app-server 连接的恢复，不会更改 Codex 的登录文件或复制令牌。官方协议见 [Codex App Server](https://learn.chatgpt.com/docs/app-server#auth-endpoints)。

## 固定提示词在哪里

固定规则放在 `prompts/assistant.md` 和 `prompts/visual.md`。程序在建立助手会话时加载为会话级规则；已有调度聊天首次恢复时更新一次，不会每条消息都追加整段相同的用户 prompt。目标项目聊天原有的规则不会被覆盖。

每轮只传主人新指示、是否允许派发，以及必要的视频资料。普通追问只带简短索引；需要细节时再查询笔记或原片。视觉观察和口播等实际视频证据仍会提交给 Codex。修改固定规则后重启助手即可生效；无需重建抖音绑定或聊天名单。会话级规则仍属于模型上下文，这项优化不表示固定规则完全不消耗额度。

## 视频如何理解

- 默认每秒 4 帧，按完整时间轴逐段观察；可选每秒 2 或 8 帧。
- Codex 可取原始清晰帧、裁剪放大局部，或用每秒 8/12/16 帧细看短片段。
- 每段完成即保存，断线或额度不足时可续做。全片观察完成前不会冒称已经完整学习。
- 保留原视频、逐段视觉证据和本地回看命令。下游 Codex 任务获得初始视觉附件，也能按时间回看原片。
- 当前 Codex 接口接收有时间顺序的图片序列，不是原生 MP4 视频输入；极短暂的帧间变化仍可能遗漏。

本地工具参考 Qwen-MM-Plugins core 的职责边界，使用 FFmpeg 独立实现，不需要 Qwen API 或 WSL2 插件。

## 启停、端口与数据

```powershell
.\Start.ps1 -Port 39362        # 需要换端口时使用，配置会保存
.\Start.ps1 -NoOpen            # 后台启动，不打开控制台
.\Stop.ps1                     # 任务结束后执行，停止当前副本
```

停止脚本会核验项目目录，拒绝停止同一端口上的另一个副本。`-Force` 仅用于确实需要中断的情况；结果不明的任务和发送操作不会自动重放。

`data/` 在首次运行时创建，保存你自己的配置、数据库、浏览器资料、模型、视频与笔记，默认被 Git 忽略。更新代码时保留自己的 data/；不要拿别人的 data/ 替换。停止后才备份整个 data/。恢复后重新开启监听。

| 位置 | 用途 |
| --- | --- |
| `data/config.json` | 自己的主人绑定、目标名单与偏好 |
| `data/browser-profile/` | 自己的抖音登录资料 |
| `data/bridge.sqlite` | 消息、发件箱、任务和知识索引 |
| `data/knowledge/` | 原视频、文字稿、连续画面、视觉记录和笔记 |
| `data/models/`、`data/runtime/` | 首次安装下载的模型和视频工具 |

只监听本机 127.0.0.1。请勿把 data/、Codex auth.json、Cookie、私人视频或完整日志上传到 GitHub；公开问题请用脱敏或合成样本。

## 开发与验证

```powershell
npm ci
npm run setup:runtime
npm test
npm run test:portable
npm run release:check
npm run release:build
```

`test:portable` 使用合成 Codex 服务和全新的临时数据目录，不读取个人登录。真实组件检查需自行选择运行：

```powershell
npm run doctor -- --live-codex --live-asr
npm run test:live
npm run test:visual
```

这些真实模型检查会使用自己的 Codex 额度；组件测试通过不等于每个抖音账号的真实收发都已验收。跨聊天正在被桌面端占用时，桥接不会强抢；不明执行结果不会自动重做。

仓库源码采用 MIT；依赖、模型和视频工具保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
