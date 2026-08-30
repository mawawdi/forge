# RFC: Verified Mechanic Capsules

Status: archived M2/M3 domain decision; not a post-M3.5 production architecture
Date: 2026-08-29

## Decision

`VerifiedMechanicCapsule` is a preserved historical domain shape backed by a `MechanicContract`, invariants, adaptation rules, executable assertion IDs, and provenance. It is not a post-M3.5 generalization mechanism, source snippet, template, RAG result, or genre-specific code copy.

The schema supports a `candidate` state now. A capsule may enter `verified` only when it carries non-empty ProofBundle IDs, assertion IDs, Studio runtime versions, and a verification timestamp. This prevents a successful static repair from becoming universal truth.

Capsule adaptation always creates a new candidate implementation and must re-run the complete applicable verification suite. Reuse never bypasses static, semantic, preflight, or Studio checks. The originating ProofBundle and BuildTrace remain immutable references.

## M2/M3 boundary

M2 defines the domain shape but creates no verified capsule: its ProofBundle is explicitly incomplete because Studio has not run. M3's first authoritative `CollectFruit` ProofBundle is the earliest eligible input for a capsule review. Retrieval, ranking, adaptation agents, and capsule-vs-fresh-generation experiments remain later work.

## Provenance minimum

A promoted capsule must retain contract version, originating ProofBundle/build IDs, toolchain versions, Studio runtime versions, test-suite version, compatibility assumptions, and known limitations. Missing provenance is a candidate or invalid artifact, never a verified capability.
