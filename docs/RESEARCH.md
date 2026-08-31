# Forge Research Index

This index separates research rationale and evidence from normative documentation. [FORGE.md](FORGE.md), [EVALS.md](EVALS.md), and [ROADMAP.md](ROADMAP.md) define the current system. The smaller research set below retains only material that still explains a current architectural boundary or preserves unique runtime evidence.

| Document | Classification | Current relevance |
| --- | --- | --- |
| [Deep research report](deep-research-report.md) | Foundational transformation rationale | Source of truth for the move from mechanic compilation toward an observable Roblox agent harness and evaluation system. |
| [Agent runtime report](agent-runtime-report.md) | Current architectural rationale | Explains why Forge owns the native agent loop and keeps model providers behind a one-turn boundary. The implementation has applied this recommendation; version-specific comparisons remain dated research. |
| [Semantic-authority audit](research/semantic-authority-audit.md) | Current research rationale | Captures the failure patterns and authority rules behind the implemented provenance, visibility, enforcement, and leakage boundary. |
| [Studio capability evidence](research/studio-capability-evidence.md) | Runtime evidence ledger | Preserves the protocol-v11 P0/P0.1/P0.2 observations and explains why they do not establish protocol-v12 readiness. |

## Retention rules

- Keep research focused on a current boundary or unique evidence; remove reports whose useful conclusions are fully represented elsewhere.
- Preserve exact run identities, hashes, and failure classifications when consolidating evidence. Raw pre-canonicalization records remain recoverable from the external snapshot.
- Update rationale reports when implementation decisions become current, and label predecessor evidence explicitly rather than presenting it as active behavior.
- Never use research as authority for a current schema, CLI command, protocol union, package dependency, or candidate verdict.
- Keep secrets, pairing grants, credentials, raw private traces, and hidden evaluator bodies outside the repository.
