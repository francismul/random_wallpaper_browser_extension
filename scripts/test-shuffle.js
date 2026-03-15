import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/shuffle.test.js");

  await build({
    entryPoints: [resolve(__dirname, "../src/newTabLogic.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    sourcemap: false,
    target: "es2020",
  });

  const { buildShuffleOrder, pickNextFromShuffle } = await import(
    `file://${outFile}`,
  );

  // Validate shuffle order contains same elements, is a permutation
  const ids = ["a", "b", "c", "d"];
  const order1 = buildShuffleOrder(ids);
  const order2 = buildShuffleOrder(ids);

  // Check same length and same membership
  if (order1.length !== ids.length) throw new Error("Shuffle order length mismatch");
  ids.forEach((id) => {
    if (!order1.includes(id)) throw new Error(`Missing id in shuffle order: ${id}`);
  });

  // Check that at least one shuffle differs (not deterministic)
  if (order1.join(",") === order2.join(",")) {
    console.warn("Warning: shuffle order matched twice in a row (low probability)");
  }

  // Validate pickNextFromShuffle respects recent IDs
  const shuffleOrder = ["a", "b", "c"];
  const recent = new Set(["a"]);
  const { nextId, nextIndex } = pickNextFromShuffle(shuffleOrder, 0, recent);
  if (!nextId) throw new Error("pickNextFromShuffle returned no ID");
  if (nextId === "a") throw new Error("pickNextFromShuffle returned a recent ID");
  if (nextIndex === 0) throw new Error("pickNextFromShuffle index did not advance");

  rmSync(outFile, { force: true });
  console.log("✅ shuffle logic tests passed");
}

run().catch((err) => {
  console.error("❌ shuffle test failed:", err);
  process.exit(1);
});
