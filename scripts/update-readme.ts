/**
 * Regenerate the `cants --help` block in README.md from the actual CLI, so the documented options
 * can never drift from the binary. Run with `bun gen:readme`; the release workflow runs it before
 * publishing. Exits non-zero if the marker block is missing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildProgram } from "../src/cli";

const README = path.resolve(import.meta.dir, "..", "README.md");
const BEGIN = "<!-- BEGIN cants-help -->";
const END = "<!-- END cants-help -->";

const help = buildProgram().helpInformation().trimEnd();
const block = `${BEGIN}\n\n\`\`\`text\n${help}\n\`\`\`\n\n${END}`;

const md = fs.readFileSync(README, "utf8");
const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
if (!re.test(md)) {
  console.error(`update-readme: markers ${BEGIN} … ${END} not found in README.md`);
  process.exit(1);
}

const next = md.replace(re, block);
fs.writeFileSync(README, next);
console.log(md === next ? "README --help block already current" : "README --help block updated");
