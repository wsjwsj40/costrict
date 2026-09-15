---
"zgsm": minor
"@roo-code/types": patch
---

Add an opt-in command sandbox with project-scoped writes, sensitive-path protection,
filtered environments and an explicit network domain allowlist. Commands run through
a bundled native sandbox runtime; ordinary sandboxed commands can be auto-approved
without broad executable allow rules. Outside-sandbox requests show their working
directory and justification and always require a one-time approval. Missing sandbox
dependencies or execution failures never silently retry without isolation.

Add availability diagnostics and an explicit Windows setup action. Windows support
is experimental and requires administrator authorization. Preserve existing command
allowlist behavior when sandboxing is disabled.
