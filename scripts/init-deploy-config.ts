#!/usr/bin/env tsx
// Reads terraform output and writes deploy.json.
// Run: pnpm deploy:init --tf-dir <path-to-terraform-root>
//
// Alternatively, generate deploy.json manually:
//   terraform output -raw deploy_config > deploy.json
//
// If your Terraform root uses dork-mail as a module, re-export the output:
//   output "deploy_config" { value = module.dork_mail.deploy_config }

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const tfDirIdx = args.indexOf("--tf-dir");
if (tfDirIdx === -1 || !args[tfDirIdx + 1]) {
  console.error("Usage: pnpm deploy:init --tf-dir <path-to-terraform-root>");
  process.exit(1);
}

const tfDir = resolve(args[tfDirIdx + 1]);
console.log(`Reading terraform outputs from ${tfDir}...`);

let raw: string;
try {
  raw = execSync("terraform output -raw deploy_config", { cwd: tfDir, encoding: "utf8" });
} catch {
  console.error("terraform output failed. Make sure:");
  console.error("  1. terraform is installed and in PATH");
  console.error("  2. the workspace has been initialized and applied");
  console.error("  3. deploy_config is exported (output \"deploy_config\" { value = module.dork_mail.deploy_config })");
  process.exit(1);
}

const parsed = JSON.parse(raw);
const configPath = resolve(repoRoot, "deploy.json");
writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
console.log(`deploy.json written to ${configPath}`);
