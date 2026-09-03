import { resolve } from "node:path";
import { assertOfficialSourceAnalysisToolchain } from "../packages/source-intelligence/src/index.js";

const toolchain = await assertOfficialSourceAnalysisToolchain(resolve(process.cwd()));
process.stdout.write(
  `Verified source-analysis toolchain ${toolchain.id} (${toolchain.platform})\n`,
);
