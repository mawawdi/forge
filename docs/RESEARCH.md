# Forge Research Index

Research preserves design rationale and exact observations from recorded builds.
It does not define the current system. Use [Architecture](ARCHITECTURE.md) for
contracts, [Evaluation policy](EVALS.md) for claims, and [Roadmap](ROADMAP.md) for
future work.

| Record                                                                       | Purpose                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Validation evidence](research/validation-evidence.md)                       | Unique run identities and classifications consolidated from former root-document ledgers |
| [Conversation evidence](research/durable-creator-conversation.md)            | Conversation, identity, recovery, and UI observations from recorded builds               |
| [Planning and Build measurements](research/compact-planning-acceptance.md)   | Exact model runs, usage, archived artifacts, and live acceptance limits                  |
| [Mutation reconciliation](research/mutation-reconciliation.md)               | Why writes require independent readback and complete state comparison                    |
| [Transaction protocol integrity](research/transaction-protocol-integrity.md) | Delivery, execution, and durable recording boundaries                                    |
| [Capability completeness](research/studio-capability-completeness.md)        | Catalog accounting, codec closure, and reflection rationale                              |
| [Execution isolation](research/execution-isolation-boundaries.md)            | Separation of agent execution from authoritative Studio observation                      |

Historical workflow descriptions, old commands, counts, and pending actions apply
only to their recorded builds. They are not alternate supported interfaces or
current tasks. A written identifier does not guarantee its raw artifacts remain
available after a store reset; external archives are evidence locations, not
portable repository fixtures.

Keep only unique evidence or rationale not already explained by the primary docs.
When consolidating records, preserve exact run identities, hashes, failure
classifications, and claim limits. Keep credentials, pairing grants, private
traces, and hidden evaluator material outside the repository.
