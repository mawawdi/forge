import {
  createHashVerifiedChunkSourceResolver,
  type SourceDocumentInput,
  type VerifiedSourceResolver,
} from "../../packages/source-intelligence/src/index.js";

/** Exercise the production chunk/hash/range boundary with in-memory test bodies. */
export function createTestFixtureSourceResolver(
  inputs: readonly SourceDocumentInput[],
): VerifiedSourceResolver {
  const documents = inputs.map(({ source, ...document }) => ({
    ...document,
    utf8Bytes: Buffer.byteLength(source, "utf8"),
  }));
  const sources = new Map(inputs.map((document) => [document.sourceHash, document.source]));
  return createHashVerifiedChunkSourceResolver({
    documents,
    chunks: [...sources].map(([sourceHash, utf8]) => ({
      sourceHash,
      ordinal: 0,
      startByte: 0,
      endByte: Buffer.byteLength(utf8, "utf8"),
      utf8,
    })),
  });
}
