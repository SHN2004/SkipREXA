import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenClawIndex } from "./openclaw-paper-search-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultInputPath = path.join(repoRoot, "data", "question-papers.json");
const defaultOutputPath = path.join(repoRoot, "data", "openclaw-paper-index.json");

function parseArgs(argv) {
  const args = {
    input: defaultInputPath,
    output: defaultOutputPath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      args.input = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === "--output") {
      args.output = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/build-openclaw-index.mjs [--input <file>] [--output <file>]");
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawSource = await readFile(args.input, "utf8");
  const sourceIndex = JSON.parse(rawSource);
  const outputIndex = buildOpenClawIndex(sourceIndex);

  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(outputIndex, null, 2)}\n`, "utf8");

  console.log(`Wrote ${outputIndex.metadata.paper_count} records to ${args.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
