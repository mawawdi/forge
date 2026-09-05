// Offline subprocess fixture. It replays recorded bytes; it performs no inference.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-dir") + 1];
const prompt = args[args.indexOf("--prompt") + 1];
if (prompt === "hang") setInterval(() => {}, 1000);
else if (prompt === "overflow") process.stdout.write("x".repeat(65536));
else {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, "output.obj"),
    fs.readFileSync(path.join(process.cwd(), "recorded.obj")),
  );
}
