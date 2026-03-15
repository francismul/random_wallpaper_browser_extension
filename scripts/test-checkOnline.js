import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/checkOnline.test.js");

  await build({
    entryPoints: [resolve(__dirname, "../src/api/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    sourcemap: false,
    target: "es2020",
  });

  const { checkOnline } = await import(`file://${outFile}`);

  // Node may have a read-only navigator; define it if missing or override if possible
  if (typeof global.navigator === "undefined") {
    Object.defineProperty(global, "navigator", {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
  } else {
    try {
      global.navigator.onLine = true;
    } catch {
      Object.defineProperty(global, "navigator", {
        value: { onLine: true },
        configurable: true,
        writable: true,
      });
    }
  }

  // Mock fetch for success
  global.fetch = async () => ({ ok: true });
  let ok = await checkOnline(10);
  if (!ok) throw new Error("Expected checkOnline to be true when fetch succeeds");

  // Mock fetch for failure
  global.fetch = async () => {
    throw new Error("network fail");
  };
  ok = await checkOnline(10);
  if (ok) throw new Error("Expected checkOnline to be false when fetch fails");

  rmSync(outFile, { force: true });

  console.log("✅ checkOnline tests passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ checkOnline test failed:", err);
  process.exit(1);
});
