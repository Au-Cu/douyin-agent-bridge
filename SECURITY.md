# Private state and vulnerability reports

Report vulnerabilities through GitHub private vulnerability reporting when available. Otherwise describe the affected component in an issue without credentials or private account data.

Never attach data/, browser profiles, cookies, Codex auth.json, signed media URLs, chat databases, private videos or complete diagnostic bundles to issues or pull requests. Use synthetic messages for reproductions.

The console listens on 127.0.0.1 only. It is designed for a personal computer and a dedicated Douyin assistant account. Only the bound owner can authorize work; target chats require an explicit allowlist. Do not expose it through a public tunnel or shared host.

Reply-only conversations are explicitly selected in the local console using observed platform identities. Group messages require a native structured mention matching the verified assistant UID. Unknown group type, account identity or mention metadata fails closed. Names and plain text mentions do not grant access. Personal Agent retains the existing bound-user single-chat boundary.

Native restoration prefers exact SDK conversation IDs and always verifies the selected chat before sending. An assistant UID witnessed in outgoing platform messages can be carried within the same authenticated browser session when virtualized history hides those messages. Account-cookie change markers stay local and are never returned in diagnostics; logout, a changed marker or conflicting outgoing identities invalidate the witness. If no account marker is available, reuse is restricted to the same live document. The ordinary-chat model cannot access or change any of these bindings or its own model defaults.

Reply-only inference runs in a separate Codex process and CODEX_HOME, with an empty working directory, fresh ephemeral threads, bounded per-chat context and a sanitized model catalog. Shell and apply_patch are independently disabled; MCP, apps, plugins, hooks, skills instructions, memory, web, computer tools and delegation are unavailable. The model receives no registered tools, including dynamic dispatch tools. Approval/tool requests are denied in the client as an additional boundary. A read-only sandbox alone is not considered sufficient isolation.

The pinned CLI is exercised by an offline local backend test on Windows and Mac: it inspects the actual tools array and sends a forged exec_command call to verify that no executor is registered. External ChatGPT access tokens travel through local stdio only and are not persisted in the isolated profile. The normal login, refresh token and personal project state are not copied there. No API key is required. File-backed local ChatGPT auth is currently required for this opt-in feature; unsupported keyring-only auth is rejected.

Changes to a conversation's mode/revision fence queued or late reply-only results. Submitted uncertain inference or delivery is retained rather than silently replayed. Native UI selection, verification and send/reaction actions are serialized to prevent replies from being written into a different chat. This does not guarantee factual answers or prevent social manipulation in generated text; it removes project and computer execution authority from the ordinary chatbot.
