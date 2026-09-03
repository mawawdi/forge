import { contentHash, stableJson } from "../../contracts/src/index.js";

export const EVALUATOR_ISOLATION_POLICY = {
  id: "forge-evaluator-isolation",
  statement:
    "Production candidate source and builder-visible context must not depend on evaluator instrumentation, hidden assertions, benchmark oracles, or expected observations.",
} as const;

export const EVALUATOR_ISOLATION_POLICY_HASH = contentHash(stableJson(EVALUATOR_ISOLATION_POLICY));
