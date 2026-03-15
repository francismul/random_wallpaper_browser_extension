import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/optionsLogic.test.js");

  // Ensure dist exists
  const distDir = resolve(__dirname, "../dist");
  if (!existsSync(distDir)) {
    await build({
      entryPoints: [resolve(__dirname, "../src/optionsLogic.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: outFile,
      sourcemap: false,
      target: "es2020",
    });
  } else {
    await build({
      entryPoints: [resolve(__dirname, "../src/optionsLogic.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: outFile,
      sourcemap: false,
      target: "es2020",
    });
  }

  const { maskApiKey, isApiKeyValidFormat } = await import(`file://${outFile}`);

  const maskTests = [
    { in: "abcdef1234567890", out: "abcdef12••••7890" },
    { in: "short", out: "s••••" },
  ];

  for (const { in: input, out: expected } of maskTests) {
    const got = maskApiKey(input);
    if (got !== expected) {
      throw new Error(
        `maskApiKey failed for ${input}: got ${got}, expected ${expected}`,
      );
    }
  }

  const validKeys = ["abc123DEF0", "key_123-456"];
  for (const key of validKeys) {
    if (!isApiKeyValidFormat(key)) {
      throw new Error(`isApiKeyValidFormat should return true for ${key}`);
    }
  }

  const invalidKeys = ["abc", "contains space", "bad!char"];
  for (const key of invalidKeys) {
    if (isApiKeyValidFormat(key)) {
      throw new Error(`isApiKeyValidFormat should return false for ${key}`);
    }
  }

  rmSync(outFile, { force: true });

  console.log("✅ optionsLogic tests passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ optionsLogic test failed:", err);
  process.exit(1);
});
