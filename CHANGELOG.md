# Changelog

## 0.10.0

- Add opt-in single/group reply-only chats alongside the existing bound-user personal Agent. Configure each observed chat in the local console; groups require an exact native mention of the verified assistant UID.
- Keep separate persisted model, reasoning and Fast defaults for personal Agent and ordinary chat; preserve the previous shared combination once during migration and apply future changes only to the next turn of the selected mode.
- Restore groups using exact SDK conversation identities, including when header and sidebar titles differ. Retain a witnessed assistant identity within the verified browser account session as outgoing rows scroll away; invalidate it on logout or account changes.
- Isolate ordinary chat in a separate Codex process/profile, with ephemeral turns, bounded per-chat history, no personal memory, zero registered tools, and explicit denial of approvals/client tools. Keep the installed ChatGPT login without an API key or persisted external tokens.
- Test the actual pinned CLI's model request tools and refusal of a forged shell call. Preserve owner binding, existing knowledge, task queues, reaction progress and uncertain delivery across upgrades.
- Serialize multi-chat UI selection and sending, fence late replies after mode changes, and show ordinary chat delivery state without creating personal task/need numbers. Maintain paired Windows and macOS ARM64 releases, with native Safari on Mac.

## 0.9.2

- Allow more time for the reaction menu to expand on slower Windows machines without retrying an uncertain reaction click.

## 0.9.1

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
