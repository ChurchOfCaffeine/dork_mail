// Bundles each Lambda handler into a zip-ready directory using esbuild,
// then zips each bundle into functions/dist-zip/<name>.zip.
//
// Zip names must match the keys expected in terraform/lambda.tf:
//   email-ingest.zip, authorizer.zip, api-auth.zip, api-mail.zip, api-dns.zip
//
// Run via: npm run build --workspace=functions
// Or via:  scripts/publish-lambdas.sh <bucket> [prefix]

import { build } from "esbuild";
import { mkdirSync, createWriteStream } from "fs";
import { ZipArchive } from "archiver";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const handlers = [
  { entry: "src/email-ingest/handler.ts", outdir: "bundle/email-ingest", zip: "email-ingest.zip", handler: "handler" },
  { entry: "src/authorizer/handler.ts",   outdir: "bundle/authorizer",   zip: "authorizer.zip",   handler: "handler" },
  { entry: "src/api/auth.ts",             outdir: "bundle/api-auth",     zip: "api-auth.zip",     handler: "auth"    },
  { entry: "src/api/mail.ts",             outdir: "bundle/api-mail",     zip: "api-mail.zip",     handler: "mail"    },
  { entry: "src/api/dns.ts",              outdir: "bundle/api-dns",      zip: "api-dns.zip",      handler: "dns"     },
];

mkdirSync(`${root}/dist-zip`, { recursive: true });

await Promise.all(
  handlers.map(async ({ entry, outdir, zip, handler }) => {
    const absOut = `${root}/${outdir}`;
    mkdirSync(absOut, { recursive: true });

    await build({
      entryPoints: [`${root}/${entry}`],
      bundle: true,
      platform: "node",
      target: "node25",
      outfile: `${absOut}/${handler}.js`,
      external: [],        // bundle everything — no node_modules in Lambda zip
      minify: false,
      sourcemap: true,
      format: "cjs",
    });

    // Zip the bundle directory
    await zipDir(absOut, `${root}/dist-zip/${zip}`);
    console.log(`  bundled → dist-zip/${zip}`);
  })
);

console.log("\nAll handlers bundled into functions/dist-zip/");

function zipDir(srcDir, destZip) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destZip);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}
