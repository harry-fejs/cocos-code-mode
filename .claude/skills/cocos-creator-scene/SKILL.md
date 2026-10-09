---
name: cocos-creator-scene
description: Routes Cocos Creator tasks to cc_docs MCP knowledge by topic and English intent. Use for scene, UI, camera, prefab, asset, input, animation, Spine, physics, shader, localization, XR, native, build, or editor questions; then use CCP only when editor inspection or mutation is needed.
---

# Cocos Creator MCP Knowledge Router

Use this skill as a retrieval router, not as a replacement for `cc_docs`.

## Required workflow

1. Identify the target project's engine version and task category; use 3.7 only when it matches.
2. Discover the connected docs tools; call `list_corpora` once per session and confirm `cc_docs` access. Read live tool schemas; never invent a server URL or credentials.
3. Read `references/creator-cookbook.md` for topic/intent keywords and `references/creator-recipes.md` for retrieval procedures. These files are references bundled with this skill. Read a matching known page directly; otherwise search with the matching domain (`cocos-v3.7` for 3.7).
4. Read the selected result, not just its search snippet. Reuse matching-version context already read during this task.
5. For questions, answer with corpus path and relevant heading. No editor mutation is needed.
6. For editor tasks, use `ccp3x` to connect to the intended editor and inspect live state; documentation access and editor access are separate.
7. Apply the requested change only after obtaining required knowledge and target references; read back and verify.

## Bundled references

- [`references/creator-cookbook.md`](references/creator-cookbook.md) — keyword → corpus path map.
- [`references/creator-recipes.md`](references/creator-recipes.md) — retrieval procedures and failure handling.
- [`references/README.md`](references/README.md) — reference index and routing table.

## Hard routing boundaries

- Do not answer Cocos engine questions from this skill’s memory when a matching `cc_docs` page exists.
- Do not copy upstream engine rules into local docs; add keywords, source paths, and retrieval guidance instead.
- Read `references/creator-recipes.md` Recipe 0 for connection, retrieval, failure handling, and handoff.
- Never treat another version's documentation as proof of API support in the target editor.
- Live state describes the current scene; corpus docs describe engine behavior. Report conflicts rather than treating either as permission to ignore engine constraints.
- For editor mutations, follow `ccp3x` and `cc-scene-graph`: bounded read, narrow write, post-write read.
