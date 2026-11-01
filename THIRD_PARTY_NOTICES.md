# Third-party notices

Original bridge source uses the MIT license. Dependencies, downloaded tools and model weights retain their own licenses and are not relicensed by this repository. The source archive does not bundle these binaries or weights.

- OpenAI Codex CLI: https://github.com/openai/codex — Apache-2.0; installed from the official @openai/codex npm package.
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness — optional, separately installed native ACP runtime; retains its upstream license and third-party notices. Integration and Safari contributions from wd-ing in PR #1 are retained in Git history.
- Playwright: https://github.com/microsoft/playwright — Apache-2.0; the Windows adapter uses the user's Microsoft Edge installation. macOS uses the user's native Safari through Apple Events.
- sherpa-onnx engine: https://github.com/k2-fsa/sherpa-onnx — Apache-2.0. SenseVoice model terms and releases: https://github.com/FunAudioLLM/SenseVoice and https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models .
- FFmpeg: https://ffmpeg.org/legal.html . Pinned builds are downloaded separately through https://www.npmjs.com/package/@ffmpeg-installer/win32-x64 and https://www.npmjs.com/package/@ffmpeg-installer/darwin-arm64 . Their GPL/LGPL terms and source references remain applicable; the package README is retained under data/runtime/package/.

Implementation references, independently adapted:

- https://github.com/Aaron-gx/douyin-fire-desktop — public React share-card message shapes.
- https://github.com/codenoah/codex-telegram-bridge — persistent local bridge design.
- https://github.com/QwenLM/Qwen-MM-Plugins — local metadata/frame/crop tool boundaries. This bridge uses FFmpeg directly and does not call Qwen services.
- https://learn.chatgpt.com/docs/app-server — official Codex integration protocol.

This independent community integration is not an official Douyin or OpenAI connector. Each external service is operated by its own provider.
