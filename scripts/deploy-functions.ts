#!/usr/bin/env tsx
// Deploys Lambda function code from functions/dist-zip/ using deploy.json config.
// Run: pnpm deploy:functions
//
// Terraform manages Lambda configuration; this script only updates function code.
// Generate deploy.json with: terraform output -raw deploy_config > deploy.json

import { LambdaClient, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface DeployConfig {
  region: string;
  functions: Record<string, string>;
  web_bucket: string;
  cloudfront_distribution: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadConfig(): DeployConfig {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, "deploy.json"), "utf8"));
  } catch {
    console.error("deploy.json not found. Generate it with:");
    console.error("  terraform output -raw deploy_config > deploy.json");
    process.exit(1);
  }
}

async function main() {
  const config = loadConfig();
  const client = new LambdaClient({ region: config.region });

  console.log(`Deploying to region ${config.region}...`);

  for (const [name, functionName] of Object.entries(config.functions)) {
    const zipPath = resolve(repoRoot, `functions/dist-zip/${name}.zip`);
    const zipFile = readFileSync(zipPath);

    process.stdout.write(`  updating ${functionName}...`);
    const result = await client.send(
      new UpdateFunctionCodeCommand({ FunctionName: functionName, ZipFile: zipFile })
    );
    console.log(` ${result.CodeSize} bytes, ${result.LastModified}`);
  }

  console.log("\nAll functions updated.");
}

main().catch(err => { console.error(err); process.exit(1); });
