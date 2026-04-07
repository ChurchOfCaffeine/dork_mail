#!/usr/bin/env tsx
// Syncs web/build/ to S3 and invalidates the CloudFront distribution.
// Run: pnpm deploy:web
//
// Generate deploy.json with: terraform output -raw deploy_config > deploy.json

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

interface DeployConfig {
  region: string;
  functions: Record<string, string>;
  web_bucket: string;
  cloudfront_distribution: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

function cacheControl(key: string): string {
  // SvelteKit puts content-hashed assets here — safe to cache forever
  if (key.startsWith("_app/immutable/")) return "public, max-age=31536000, immutable";
  // Entry points must always revalidate
  if (key.endsWith(".html") || key === "service-worker.js") return "no-cache";
  return "public, max-age=3600";
}

function* walkDir(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) yield* walkDir(full);
    else yield full;
  }
}

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
  const s3 = new S3Client({ region: config.region });
  const cf = new CloudFrontClient({ region: config.region });
  const buildDir = resolve(repoRoot, "web/build");

  const files = [...walkDir(buildDir)];
  console.log(`Uploading ${files.length} files to s3://${config.web_bucket}...`);

  // Upload in parallel batches
  const BATCH_SIZE = 20;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    await Promise.all(
      files.slice(i, i + BATCH_SIZE).map(async (file) => {
        const key = relative(buildDir, file).replace(/\\/g, "/");
        await s3.send(
          new PutObjectCommand({
            Bucket: config.web_bucket,
            Key: key,
            Body: readFileSync(file),
            ContentType: MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
            CacheControl: cacheControl(key),
          })
        );
        console.log(`  ${key}`);
      })
    );
  }

  console.log("\nCreating CloudFront invalidation...");
  const inv = await cf.send(
    new CreateInvalidationCommand({
      DistributionId: config.cloudfront_distribution,
      InvalidationBatch: {
        CallerReference: Date.now().toString(),
        Paths: { Quantity: 1, Items: ["/*"] },
      },
    })
  );
  console.log(`  invalidation ${inv.Invalidation?.Id} (${inv.Invalidation?.Status})`);
  console.log("\nWeb deploy complete.");
}

main().catch(err => { console.error(err); process.exit(1); });
