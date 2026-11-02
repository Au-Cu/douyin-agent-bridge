# Changelog

## Unreleased

## 0.15.0

- 群聊可选轻量视频理解：复用本地口播转写和全时间轴低密度画面，限定时长与下载量，独立缓存，不进入个人资料库。
- 每群一个隔离会话，上下文预算交接、确认后空白重置、旧会话双层归档与恢复；面板查看真实 Codex 历史，并如实标注 DSH 原生能力差异。
- 可选归档保留期限，默认关闭；到期独立检查，只清理已核实、无保留引用的桥接记录与缓存。
- 增加全部／本组一键只读核实送达，保存实际核实进度；提示改为顶部居中浮窗并定时收起。

- Keep console notices visible at any scroll position in modern and classic layouts, with a dismiss button, bounded long-message scrolling and accessible announcements that retain focus and page position.
- Provide per-task/per-need delivery review, including exact uncertain reply segments and reactions, a read-only original-chat check, explicit manual receipt confirmation or abandonment, and guarded one-part text resend. Immediately synchronize resolved task state; never treat abandoned replies as delivered or repeat an uncertain reaction.
- Reconcile text receipts from normal observed history only when sender, full content, send-time bounds, native reference and uniqueness are verified. Persist future send-attempt bounds; older records without sufficient evidence remain available for manual review.

## 0.14.0

- Ship the accepted task-focused console: separate workbench, learning and settings views, readable task hierarchy, exact visual coverage, independent delivery/reaction states, light/dark appearance and incremental refresh that retains focus, scroll and expanded details. Keep a persistent classic UI selector and protect unsaved settings during layout changes.
- Let settings use the full content width and remove the new console's footer reminder. Both layouts share the same local state and backend controls.
- Add permanently deleting archived tasks and needs from either console layout, with a scope preview, explicit confirmation, transactional removal and restart-safe cache cleanup. Preserve native chats, projects, knowledge and backups. Fence active/uncertain execution and delivery, stale confirmations, old-message replay and number reuse.
- Keep authorized long-running Codex project tasks attached to their exact native turn beyond the old fixed deadline. Reconcile missed completion notifications or restarts without resubmitting execution or duplicating delivery. Keep DSH project calls waiting on their original ACP request; auxiliary memory failures cannot overwrite a confirmed result.
- Publish under the canonical `Au-Cu/douyin-agent-bridge` repository name while retaining existing entry points, private data paths and compatibility. Maintain paired Windows x64/ARM64 and macOS ARM64 source packages.

## 0.13.1

- Keep the desktop's one-shot startup policy/configuration probes out of the shared RPC broker. Preserve their direct JSON output and exit status even when stdin is closed or a shared desktop is already connected.
- Flush the Windows native wrapper's stdin/stdout/stderr after each chunk so short interactive RPC requests and replies arrive before EOF. Exercise this with a real compiled wrapper and an open stdin, rather than only finite CLI commands.
- Restrict broker interception to the recognized persistent desktop stdio command; pass help, schema generation, sign-out and other tooling to the original executable.
- Require verification of the actual reported startup/login path before publication; automated checks alone do not establish that the user's bug is resolved.

- Show the Windows desktop Codex window when launching the shared connection, and open or reuse the assistant console on both Windows and Mac ARM64.
- Repeated launches request the existing desktop window without stopping chats or claiming a live process has switched connections. Restore the launcher environment before starting the bridge's isolated clients.

## 0.13.0

- Integrate PR #1 by wd-ing: optional DeepSeek Harness ACP/MCP backend, Safari tab lookup by URL, and cross-platform browser test support.
- Preserve the shared Codex writer, isolated-chat account recovery, stable Windows storage and all existing task lifecycle safeguards.
- Rename the visible product to Douyin Agent Bridge while retaining existing data and entry-point compatibility.
- Wire both Agent and ordinary-chat backends into the server and console; isolate provider/model settings, retain each need's backend during rollover, and namespace approvals and DSH session IDs.
- Harden DSH submission journals, exact-session cancellation, account refresh, MCP callbacks, cross-project cwd restoration, reversible local archives and uncertainty fences. Restore bridge tools after restart without injecting Agent rules into project targets.
- Pin restricted DSH workers to 0.2.1-rc.5; verify actual native tool catalogs and forged execution refusal. Carry actual continuous and fine-detail image inputs, rejecting non-visual routes before inference instead of claiming file-path-only visual learning.
- Keep Safari tab indices accurate with empty/reordered tabs; restore only the unique owned tab marker and match complete video paths. Check both platform releases with the pinned native DSH wire tests.
- Recover the reproduced Chromium internal error-page navigation race with bounded retries, retaining the same browser profile and surfacing persistent failures. Update native macOS AppleScript compile fixtures for ownership preflight and indexed tab URLs.

## 0.12.1

- Fix the reproduced MSIX AppData virtualization mismatch: desktop Codex and an external CMD could resolve the same logical connection path to different physical files. Store new Windows state under the user's home directory and canonicalize shared setup and executable paths.
- Discover and conservatively migrate existing AppData/package state, preserving source data, models, browser profiles, knowledge, needs, chat settings and shared setup. Distinct legacy databases require an explicit choice; never silently merge them or overwrite an established profile.
- Add a read-only Windows shared-launcher check with explicit missing-path diagnostics and UTF-8 output. Keep the Mac ARM64 source release paired; its default data path is unchanged.

## 0.12.0

- Share the desktop app's actual app-server writer for authorized project dispatch through a local authenticated RPC broker. Translate request and callback IDs, route desktop tools to the desktop, preserve native approvals, reconcile exact turn results and restrict interruption to bridge-owned turns. Keep ordinary chat isolated.
- Add Windows x64/ARM64 and Mac ARM64 setup/launch entry points. Desktop cutover requires an explicit user restart; never force-close another chat, delete writer locks or replay uncertain work. Recover only proven unsubmitted, non-archived, non-interrupted blocked tasks.
- Repair stale isolated-chat authentication after account switches or prior quota errors. Import external tokens into memory on every reconnect, preserve account boundaries for running turns, distinguish login and quota failures, and never replay old failed replies automatically.
- Retry the reproduced Windows first-navigation failure when reopening the Douyin window, preserving the existing profile and surfacing the window. Keep the shared Windows source package for x64/ARM64; no unsupported architecture diagnosis.
- Verify broker ownership, callback translation, one-time approvals, disconnection fences, platform launcher stdio/Unicode/exit handling, and actual authenticated shared-writer/interrupt behavior in disposable self-check chats.

## 0.11.0

- Avoid routine chat switching when the exact native sidebar unread count is zero. Keep a one-minute reconciliation, stable message collection after navigation, coalesced polling and complete leases through sending/reaction verification. Independent video tabs no longer block the inbox.
- Quote the triggering native group message in every reply segment, verify both the composer reference and the confirmed outgoing pointer, and never silently send an unanchored or duplicate uncertain reply.
- Preserve isolated chat privileges while allowing public web search, a bounded arithmetic parser and clock. Add optional disposable Python containers with no host mounts, network, credentials, Docker socket or desktop; enforce image verification and resource/time limits without host fallback.
- Allow each group to choose native-mention-only or all-new-message replies, defaulting to mentions. Trigger changes persist without cancelling current answers or weakening isolation.
- Reconcile uncertain quoted deliveries through exact native references, full bodies, structured mention ranges and sender identity, without resending. Resume a verified native @ draft without overwriting user text; distinguish the quoted message from any older reference nested inside it.
- Keep personal Agent and chat model choices independent. Improve the chat prompt's completeness and factual tool use; limited capabilities do not change the selected model or reasoning effort.
- Add actual CLI allowlist/injection tests, delayed-DOM and inbox scheduling tests, native quote fixtures for both adapters, and actual Linux container isolation checks alongside paired Windows/macOS ARM64 releases.

## 0.10.0

- Add opt-in single/group reply-only chats alongside the existing bound-user personal Agent. Configure each observed chat in the local console; groups require an exact native mention of the verified assistant UID.
- Keep separate persisted model, reasoning and Fast defaults for personal Agent and ordinary chat; preserve the previous shared combination once during migration and apply future changes only to the next turn of the selected mode.
- Restore groups using exact SDK conversation identities, including when header and sidebar titles differ. Retain a witnessed assistant identity within the verified browser account session as outgoing rows scroll away; invalidate it on logout or account changes.
- Isolate ordinary chat in a separate Codex process/profile, with ephemeral turns, bounded per-chat history, no personal memory, zero registered tools, and explicit denial of approvals/client tools. Keep the installed ChatGPT login without an API key or persisted external tokens.
- Test the actual pinned CLI's model request tools and refusal of a forged shell call. Preserve owner binding, existing knowledge, task queues, reaction progress and uncertain delivery across upgrades.
- Serialize multi-chat UI selection and sending, fence late replies after mode changes, and show ordinary chat delivery state without creating personal task/need numbers. Maintain paired Windows and macOS ARM64 releases, with native Safari on Mac.

## 0.9.1

- Allow more time for the reaction menu to expand on slower Windows machines without retrying an uncertain reaction click.

- Bound browser-heavy regression concurrency to reduce timeouts on busy Windows CI runners; continue building and verifying both platform packages together.

## 0.9.0

- Add an Apple Silicon macOS installation, launcher, native FFmpeg and local speech runtime. Keep Mac and Windows release artifacts paired and verified on their respective CI machines.
- Add a native Safari adapter using a bridge-owned, validated window and the user's Safari profile; require explicit Apple Events permission and preserve uncertain delivery or reaction results.
- Use platform-native fonts for timestamped continuous video sheets. Existing Windows account data and browser profiles remain unchanged.

## 0.8.0

- Resolve native Douyin reply pointers to verified outgoing messages, the complete reply group, original need and original video evidence. Persist exact platform IDs and use a unique exact-text fallback for older deliveries.
- Feed the full cited response and video references to new Codex turns and authorized target chats without treating quoted content as new instructions. Ambiguous citations wait for user clarification.
- Assign new supplements durable root-based labels such as 1-1 and 1-2 without consuming root task numbers; existing labels stay unchanged and all task commands accept the new labels.

## 0.7.0

- Add immediate per-operation interruption through task cards and /中断. Persist stop intent, interrupt owned Codex turns, terminate local decoding/transcription, fence late results and stop unsent reply segments without blocking unrelated chats.
- Handle the startup cancellation race with bounded retries only after definitive rejection; retain unknown stop/delivery results for reconciliation.
- Exclude archived/interrupted parents from classification and revalidate asynchronous decisions; detach pending supplements from archived parents.
- Add persistent silent /忽略 and /结束忽略 gates, discarding ignored content before inference, dispatch, reactions and model history.
- Preserve receipt/detail expansion across dashboard refreshes, fold data/recovery by default and remove the legacy-alias footer from command help.

## 0.6.0

- Archive and restore needs, learning materials and task cards without deleting memory, media or delivery records. Need archiving synchronizes the assistant's Codex continuation chats through a persisted, reconciled archive journal; shared dispatch targets are preserved.
- Automatically archive completed operations only after all tasks and text replies finish. Restoring an operation never silently replays submitted or uncertain execution.
- Add archive scopes, task status filters, explicit archive/restore slash commands and validated links to the operation's actual Codex chats.
- Collapse setup when connected and configuration cards after first customization; persist manual open/closed choices across restarts.
- Restrict active progress to Douyin's exact native [奋斗] reaction and migrate only pending unsubmitted receipts to the corrected selection.

## 0.5.0

- Use persistent numeric task/need labels and short titles; announce new task identities once and group execution, reply delivery and reactions by their actual operation association.
- Allow different Codex chats to run concurrently, serialize only the same target chat and reuse loaded chats without repeated resume calls.
- Handle foreground chat layers and unlabeled native reaction expansion; click individual emoji leaves rather than rows or grids, and bound retries to proven unsubmitted clicks.
- Store account state and memory in a fixed per-user data directory, independent of source folders and launcher copies; support explicit isolated profiles.
- Migrate legacy data without deleting the original or overwriting an existing account, and rebase video/evidence paths.
- Commit settings to SQLite with FULL durability, atomic configuration mirrors and consistent automatic/manual snapshots.
- Restore saved browser sessions, owner conversation and listening intent on restart; keep uncertain work isolated.
- Prevent concurrent processes from rewriting one data profile, and save target-list changes immediately.
- Add a data/recovery panel and regression checks for forced termination, torn configuration files and safe migration.

## 0.4.0

- Track execution and multi-part reply delivery as one persisted operation; mark done only after all work and replies are confirmed.
- Link duplicate requests to ongoing operations; preserve amendments and explicit redo requests.
- Add received/active/done reactions to every new message with verified, non-toggling emoji clicks.
- Keep progress quiet: no periodic or phase text announcements; status is available on request and in the console.
- Bound active-writer retries, persist blocking reasons and add /重试 for known unsubmitted work only.
- Run an independent status checker without replaying uncertain execution or delivery.
- Standardize Chinese interface, rules, docs and outgoing replies to use 用户.

## 0.3.0

- Route each new message through an isolated lightweight classifier: continue, new need, recall, or ask for clarification.
- Classify video references using their observed visual content instead of opening a chat per video.
- Persist per-need memory, exact exchanges, video references and task results; rotate chats with a handoff when their context budget is reached.
- Migrate the legacy long chat without deleting its original history, owner binding or target list.
- Discover real Codex models, supported reasoning efforts and Fast service tiers; configure them in the console or concise Douyin commands.
- Add /帮助, /设置, /模型, /强度, /快, /密度, /分聊, /预算, /新建, /找, /切换, /派, /续看 and /重连, preserving old aliases.
- Validate source-fact recovery after handoff and keep complete owner instructions when inputs exceed the budget.

## 0.2.1

- Move target-chat video reading instructions into prompts/task-reference.md.
- Keep original video indexes and image attachments while replacing repeated full transcripts and visual notes with short summaries and file references.

## 0.2.0

- Reload local Codex authentication after account changes without replacing owner binding, target IDs or video progress.
- Defer reconnection during active work; never replay uncertain execution tasks.
- Resume videos paused by authentication or quota errors and expose reconnect controls in the console and Douyin.
- Retry authentication failures once only for isolated read-only visual analysis.
- Load fixed assistant and visual rules from prompts/*.md at the session level; shorten per-message inputs.
- Preserve existing target-project instructions when updating the assistant's rules.

## 0.1.0

- Douyin private video shares and bound-owner instructions.
- Native reaction receipts and readable plain-text fallback.
- Local narration transcription and resumable, timestamped full-duration visual analysis through Codex.
- Original frames, crops and dense interval inspection.
- Allowlisted Codex task dispatch with original video references and image attachments.
- Windows setup, pinned official Codex CLI, isolated instances and clean source releases.
- Width-bounded, left-aligned chat selection with full-title hints and stable target IDs.
