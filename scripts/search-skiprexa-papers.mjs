import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchOpenClawIndex } from "./openclaw-paper-search-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultIndexPath = path.join(repoRoot, "data", "openclaw-paper-index.json");

function parseArgs(argv) {
  const args = {
    indexPath: defaultIndexPath,
    limit: null,
    queryParts: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--index") {
      args.indexPath = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === "--limit") {
      args.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (argument === "--query") {
      args.queryParts.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/search-skiprexa-papers.mjs --query <text> [--limit <n>] [--index <file>]");
      process.exit(0);
    }

    args.queryParts.push(argument);
  }

  if (args.queryParts.length === 0) {
    throw new Error("Missing query. Pass --query \"<text>\".");
  }

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error("Limit must be a positive integer.");
  }

  return {
    indexPath: args.indexPath,
    limit: args.limit,
    query: args.queryParts.join(" ").trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawIndex = await readFile(args.indexPath, "utf8");
  const index = JSON.parse(rawIndex);
  const result = searchOpenClawIndex(index, args.query, { limit: args.limit });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
