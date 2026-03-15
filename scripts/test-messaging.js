import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/messaging.test.js");
  const distDir = resolve(__dirname, "../dist");

  // Bundle messaging for node testing
  await build({
    entryPoints: [resolve(__dirname, "../src/messaging.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    sourcemap: false,
    target: "es2020",
  });

  // Minimal mock chrome.runtime for our small test
  const listeners = [];
  global.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      sendMessage(message, cb) {
        // immediately call all listeners to simulate broadcast
        for (const l of listeners) {
          l(message, { id: "mock" }, cb);
        }
      },
    },
  };

  const { subscribeToCurrentImageUpdates, requestCurrentImageId } =
    await import(`file://${outFile}`);

  let received = null;
  const unsubscribe = subscribeToCurrentImageUpdates((id) => {
    received = id;
  });

  // Should return null before we broadcast anything
  const initial = await requestCurrentImageId();
  if (initial !== null) {
    throw new Error(`Expected null initial image id, got ${initial}`);
  }

  // Simulate a broadcast
  global.chrome.runtime.sendMessage({
    action: "currentImageUpdated",
    imageId: "abc123",
  });

  if (received !== "abc123") {
    throw new Error(`Expected received to be abc123, got ${received}`);
  }

  unsubscribe();

  rmSync(outFile, { force: true });

  console.log("✅ messaging tests passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ messaging test failed:", err);
  process.exit(1);
});
