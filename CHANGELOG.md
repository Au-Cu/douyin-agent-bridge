# Changelog

## 0.5.0

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
