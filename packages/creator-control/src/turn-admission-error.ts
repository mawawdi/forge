import {
  creatorWorkRequestHash,
  type CreatorTurnRequest,
} from "../../creator-conversation/src/index.js";

/** Issued only after a serialized ledger read proves this exact turn has no admitted job. */
export class CreatorTurnNotAdmittedError extends Error {
  readonly idempotencyKey: string;
  readonly requestHash: string;

  constructor(request: CreatorTurnRequest, message: string) {
    super(message);
    this.name = "CreatorTurnNotAdmittedError";
    this.idempotencyKey = request.idempotencyKey;
    this.requestHash = creatorWorkRequestHash(request);
  }
}
