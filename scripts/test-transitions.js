import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, rmSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const outFile = resolve(__dirname, "../dist/transitions.test.js");

  // Bundle the transitions module for Node execution
  await build({
    entryPoints: [resolve(__dirname, "../src/transitions/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    sourcemap: false,
    target: "es2020",
  });

  // Provide a minimal window shim for the transitions module.
  global.window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: () => {},
  }; 

  const { Easing, CanvasTransitionManager } = await import(`file://${outFile}`);

  // Easing tests
  if (Easing.easeInOutQuint(0) !== 0 || Easing.easeInOutQuint(1) !== 1) {
    throw new Error("easeInOutQuint must return 0 at t=0 and 1 at t=1");
  }
  if (Easing.spring(0) !== 0 || Easing.spring(1) !== 1) {
    throw new Error("spring easing must return 0 at t=0 and 1 at t=1");
  }

  // Canvas/transition tests
  const drawCalls = [];
  const ctx = {
    _globalAlpha: 1,
    get globalAlpha() {
      return this._globalAlpha;
    },
    set globalAlpha(value) {
      this._globalAlpha = value;
    },
    fillStyle: "",
    filter: "",
    globalCompositeOperation: "source-over",
    save: () => {},
    restore: () => {},
    translate: () => {},
    beginPath: () => {},
    clip: () => {},
    rect: () => {},
    fillRect: () => {},
    clearRect: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    drawImage: (...args) => {
      drawCalls.push({ args, alpha: ctx.globalAlpha });
    },
  };

  const canvas = {
    width: 800,
    height: 600,
    getContext: () => ctx,
  };

  const manager = new CanvasTransitionManager(canvas);

  const fakeImage = { naturalWidth: 800, naturalHeight: 600 };
  manager.currentImage = fakeImage;
  manager.nextImage = fakeImage;

  drawCalls.length = 0;
  manager.renderFade(0);
  const fade0 = drawCalls.find((c) => c.alpha === 0);
  if (!fade0) throw new Error("renderFade did not draw with alpha 0 at progress 0");

  drawCalls.length = 0;
  manager.renderFade(1);
  const fade1 = drawCalls.find((c) => c.alpha === 1);
  if (!fade1) throw new Error("renderFade did not draw with alpha 1 at progress 1");

  drawCalls.length = 0;
  manager.renderPixelate(0);
  if (drawCalls.length === 0) {
    throw new Error("renderPixelate did not draw any frames at progress=0");
  }

  drawCalls.length = 0;
  manager.renderPixelate(1);
  if (drawCalls.length === 0) {
    throw new Error("renderPixelate did not draw any frames at progress=1");
  }

  rmSync(outFile, { force: true });
  console.log("✅ transitions tests passed");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ transitions test failed:", err);
  process.exit(1);
});
