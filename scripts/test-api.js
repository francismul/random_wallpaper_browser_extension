import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/api.test.js");

  // Bundle the API module for Node testing
  await build({
    entryPoints: [resolve(__dirname, "../src/api/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    sourcemap: false,
    target: "es2020",
  });

  // Simple mocked fetch implementation
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });

    // On first call, return 500 to force retry
    if (calls.length === 1) {
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        blob: async () => new Blob(),
      };
    }

    // On second call, succeed
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      blob: async () => new Blob(["ok"], { type: "text/plain" }),
    };
  };

  const { downloadFile, isRetryableStatus } = await import(`file://${outFile}`);

  // Test isRetryableStatus
  if (isRetryableStatus(401)) {
    throw new Error("Expected 401 to be non-retryable");
  }
  if (isRetryableStatus(500)) {
    throw new Error("Expected 500 to be non-retryable");
  }

  // Test downloadFile retry logic
  const blob = await downloadFile("https://example.com/test");
  const text = await blob.text();
  if (text !== "ok") {
    throw new Error(`Unexpected blob content: ${text}`);
  }

  // Ensure we attempted at least 2 calls (retry)
  if (calls.length < 2) {
    throw new Error(`Expected retries, got ${calls.length} attempts`);
  }

  rmSync(outFile, { force: true });

  console.log("✅ api tests passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ api test failed:", err);
  process.exit(1);
});
