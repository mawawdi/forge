import { resolve } from "node:path";
import { setupOfficialSourceAnalysisToolchain } from "../packages/source-intelligence/src/index.js";

const toolchain = await setupOfficialSourceAnalysisToolchain(resolve(process.cwd()));
process.stdout.write(
  `Installed verified source-analysis toolchain ${toolchain.id} (${toolchain.platform})\n`,
);
