#!/usr/bin/env tsx
// Deploys the web bucket and invalidates the CloudFront distribution:
//   - Bulwark Lite at the root, from the release pinned in scripts/bulwark-lite.json,
//     uploaded only when the bucket holds a different build
//   - config.json pointing Bulwark at this deployment's JMAP server
//   - the SvelteKit admin app from web/build/, whose routes all live under /admin
// Run: pnpm deploy:web
//
// Generate deploy.json with: terraform output -raw deploy_config > deploy.json

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

interface DeployConfig {
  region: string;
  functions: Record<string, string>;
  web_bucket: string;
  web_origin: string;
  cloudfront_distribution: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(resolve(repoRoot, "scripts/bulwark-lite.json"), "utf8")) as { version: string; sha256: string };

// Host config for platforms Bulwark ships alongside the bundle, which CloudFront replaces,
// and the files this deploy writes with Dork Mail's name and icons instead.
const BULWARK_SKIP = new Set([
  "config.json", "lite-build.json", "_redirects", "_headers", "Caddyfile.example", "nginx.conf.example", "LITE-README.md",
  "manifest.webmanifest", "apple-touch-icon.png", "branding/Bulwark_Favicon.svg",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

function cacheControl(key: string): string {
  // Content-hashed assets from Next.js and SvelteKit, safe to cache forever
  if (key.startsWith("_next/static/") || key.startsWith("_app/immutable/")) return "public, max-age=31536000, immutable";
  if (/\.(html|txt|json|webmanifest)$/.test(key) || key === "service-worker.js") return "no-cache";
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

/** Downloads and unpacks the pinned release once, into .bulwark/<version>/. */
async function bulwarkDir(): Promise<string> {
  const dir = resolve(repoRoot, `.bulwark/${pin.version}`);
  if (existsSync(resolve(dir, "lite-build.json"))) return dir;

  const url = `https://github.com/bulwarkmail/webmail/releases/download/${pin.version}/bulwark-lite-${pin.version}.zip`;
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== pin.sha256) throw new Error(`Checksum mismatch: expected ${pin.sha256}, got ${digest}`);

  mkdirSync(dir, { recursive: true });
  const zipPath = resolve(dir, "..", `bulwark-lite-${pin.version}.zip`);
  writeFileSync(zipPath, zip);
  const unzip = spawnSync("unzip", ["-q", "-o", zipPath, "-d", dir], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error("unzip failed; it must be on PATH");
  return dir;
}

async function deployedBuildId(s3: S3Client, bucket: string): Promise<string | undefined> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "lite-build.json" }));
    return JSON.parse(await obj.Body!.transformToString()).buildId;
  } catch {
    return undefined;
  }
}

async function uploadAll(s3: S3Client, bucket: string, files: { key: string; body: Buffer }[]) {
  const BATCH_SIZE = 20;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    await Promise.all(files.slice(i, i + BATCH_SIZE).map(({ key, body }) => s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: MIME_TYPES[extname(key).toLowerCase()] ?? "application/octet-stream",
      CacheControl: cacheControl(key),
    }))));
    process.stdout.write(`\r  ${Math.min(i + BATCH_SIZE, files.length)}/${files.length}`);
  }
  process.stdout.write("\n");
}

const filesUnder = (dir: string, prefix = "") =>
  [...walkDir(dir)].map(file => ({ key: prefix + relative(dir, file).replace(/\\/g, "/"), body: readFileSync(file) }));

async function main() {
  const config = loadConfig();
  const s3 = new S3Client({ region: config.region });
  const cf = new CloudFrontClient({ region: config.region });

  const liteDir = await bulwarkDir();
  const liteBuild = readFileSync(resolve(liteDir, "lite-build.json"));
  const buildId = JSON.parse(liteBuild.toString()).buildId as string;
  if (await deployedBuildId(s3, config.web_bucket) === buildId) {
    console.log(`Bulwark Lite ${buildId} already deployed.`);
  } else {
    const files = filesUnder(liteDir).filter(f => !BULWARK_SKIP.has(f.key));
    console.log(`Uploading Bulwark Lite ${buildId} (${files.length} files) to s3://${config.web_bucket}...`);
    await uploadAll(s3, config.web_bucket, files);
    // Written last, so an interrupted upload is retried on the next deploy.
    await uploadAll(s3, config.web_bucket, [{ key: "lite-build.json", body: liteBuild }]);
  }

  const liteConfig = {
    ...JSON.parse(readFileSync(resolve(liteDir, "config.json"), "utf8")),
    appName: "Dork Mail",
    jmapServerUrl: config.web_origin,
    rememberMeEnabled: true,
    loginShowTotp: false,
    // Bulwark links here from Settings > Account; Lite can't host the password and admin pages itself.
    accountManagementUrl: "/admin/account",
    accountManagementLabel: "Password and admin",
    loginUsernamePlaceholder: "Username",
    // The admin build puts Dork Mail's icons at the root.
    faviconUrl: "/icon.svg",
    appLogoLightUrl: "/icon.svg",
    appLogoDarkUrl: "/icon.svg",
    loginLogoLightUrl: "/icon.svg",
    loginLogoDarkUrl: "/icon.svg",
  };
  delete liteConfig._comment;

  // Bulwark's manifest names the installed app "Bulwark Webmail" and config.json can't change it.
  const manifest = {
    ...JSON.parse(readFileSync(resolve(liteDir, "manifest.webmanifest"), "utf8")),
    name: "Dork Mail",
    short_name: "Dork Mail",
    description: "Dork Mail",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };

  const admin = filesUnder(resolve(repoRoot, "web/build"));
  console.log(`Uploading config and admin app (${admin.length} files)...`);
  await uploadAll(s3, config.web_bucket, [
    { key: "config.json", body: Buffer.from(JSON.stringify(liteConfig, null, 2)) },
    { key: "manifest.webmanifest", body: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { key: "apple-touch-icon.png", body: readFileSync(resolve(repoRoot, "web/static/icon-192.png")) },
    // Linked from Bulwark's prerendered HTML before config.json's faviconUrl applies.
    { key: "branding/Bulwark_Favicon.svg", body: readFileSync(resolve(repoRoot, "web/static/icon.svg")) },
    { key: "service-worker.js", body: readFileSync(resolve(repoRoot, "scripts/retired-service-worker.js")) },
    ...admin,
  ]);

  console.log("Creating CloudFront invalidation...");
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
