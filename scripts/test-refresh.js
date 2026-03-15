import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/backgroundLogic.test.js");

  // Ensure dist exists (build helps with caching shared deps)
  const distDir = resolve(__dirname, "../dist");
  if (!existsSync(distDir)) {
    console.log("dist directory not found; running build first...");
    await build({
      entryPoints: [resolve(__dirname, "../src/background.ts")],
      bundle: true,
      outdir: distDir,
      format: "esm",
      platform: "browser",
      target: "es2020",
      sourcemap: false,
      minify: false,
    });
  }

  // Bundle a standalone copy of the background logic for Node testing.
  await build({
    entryPoints: [resolve(__dirname, "../src/backgroundLogic.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    sourcemap: false,
    target: "es2020",
  });

  const { refreshImages, backgroundState } = await import(`file://${outFile}`);

  const deps = {
    getSettings: async () => ({
      cache: { permanentMode: false },
      apiKeys: { unsplash: ["key"], pexels: [] },
      searchPreferences: { unsplashKeywords: "cars", pexelsKeywords: "cars" },
    }),
    getStorageInfo: async () => ({
      available: 1024 * 1024 * 1024,
      total: 1024 * 1024 * 1024,
      used: 0,
      percentUsed: 0,
      hasEnoughSpace: true,
    }),
    cleanExpiredImages: async () => 0,
    areApiKeysConfigured: async () => true,
    fetchAllImages: async () => [],
    getLastFetchTime: async () => null,
    setLastFetchTime: async () => {},
    storeImages: async () => {},
    getValidImageCount: async () => 0,
    getFallbackImages: async () => [],
    clearFallbackImages: async () => 0,
    state: backgroundState,
  };

  let threw = false;
  try {
    await refreshImages(deps);
  } catch (error) {
    threw = true;
    console.log("✅ refreshImages threw as expected:", error.message);
  }

  if (!threw) {
    throw new Error(
      "Expected refreshImages to throw when fetchAllImages returns []",
    );
  }

  // Clean up test bundle file
  rmSync(outFile, { force: true });

  console.log("✅ Test passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
