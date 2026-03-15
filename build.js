import * as esbuild from "esbuild";
import path from "path";
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import JavaScriptObfuscator from "javascript-obfuscator";

const isWatch = process.argv.includes("--watch");
const shouldObfuscate = process.argv.includes("--obfuscate");
const obfuscationLevel =
  process.argv
    .find((arg) => arg.startsWith("--obfuscate-level="))
    ?.split("=")[1] || "medium";

/**
 * Obfuscation configurations for different levels
 */
const obfuscationConfigs = {
  light: {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    log: false,
    numbersToExpressions: false,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: false,
    stringArray: true,
    stringArrayCallsTransform: false,
    stringArrayEncoding: [],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersCount: 2,
    stringArrayWrappersType: "variable",
    stringArrayThreshold: 0.75,
    unicodeEscapeSequence: false,
  },
  medium: {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4, // Reduced for safety
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.15, // Reduced
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    log: false,
    numbersToExpressions: true,
    numbersToExpressionsThreshold: 0.4,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: false, // DISABLED - breaks API URLs
    splitStringsChunkLength: 5,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.5,
    stringArrayEncoding: ["base64"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersCount: 4,
    stringArrayWrappersType: "function",
    stringArrayThreshold: 0.7, // Reduced from 0.8
    transformObjectKeys: false, // DISABLED - breaks message action names
    unicodeEscapeSequence: false,
    // Protect critical strings
    reservedStrings: [
      "chrome\\.runtime",
      "chrome\\.storage",
      "chrome\\.alarms",
      "action",
      "https://api",
    ],
  },
  heavy: {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5, // Reduced from 0.75 to avoid breaking async
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3, // Reduced from 0.4
    debugProtection: false, // DISABLED - breaks Chrome extension APIs
    debugProtectionInterval: 0, // DISABLED
    disableConsoleOutput: false, // KEEP ENABLED for extension logging
    domainLock: [],
    identifierNamesGenerator: "hexadecimal", // Changed from "mangled" - safer for extensions
    log: false,
    numbersToExpressions: true,
    numbersToExpressionsThreshold: 0.6, // Reduced from 0.8
    renameGlobals: false,
    selfDefending: false, // DISABLED - can break in extension context
    simplify: true,
    splitStrings: false, // DISABLED - breaks API URLs and action strings
    splitStringsChunkLength: 3,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.6, // Reduced from 0.8
    stringArrayEncoding: ["base64"], // Changed from "rc4" - rc4 is too aggressive
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 3, // Reduced from 5
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersCount: 3, // Reduced from 5
    stringArrayWrappersType: "function",
    stringArrayThreshold: 0.75, // Reduced from 0.9
    transformObjectKeys: false, // DISABLED - breaks chrome.runtime.sendMessage action names
    unicodeEscapeSequence: false,
    // Add reserved strings to protect critical identifiers
    reservedStrings: [
      "chrome\\.runtime",
      "chrome\\.storage",
      "chrome\\.alarms",
      "sendMessage",
      "sendResponse",
      "action",
      "forceRefreshCache",
      "forceRefresh",
      "checkRefreshStatus",
      "checkRefreshNeeded",
      "apiKeysUpdated",
      "settingsUpdated",
      "https://api\\.unsplash\\.com",
      "https://api\\.pexels\\.com",
    ],
  },
  fun: {
    compact: false, // keep chaos visible

    // Chaos in execution flow
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,

    // Inject tons of garbage code
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 1,

    // Random numeric expression madness
    numbersToExpressions: true,
    numbersToExpressionsThreshold: 1,

    // Identifier insanity
    identifierNamesGenerator: "mangled-shuffled",

    renameGlobals: false,

    // Keep structure weird
    simplify: false,

    // Break every string into confetti
    splitStrings: true,
    splitStringsChunkLength: 1,

    // Hide everything in a string array
    stringArray: true,
    stringArrayThreshold: 1,

    stringArrayEncoding: ["base64", "rc4"],

    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,

    // Wrapper madness
    stringArrayWrappersCount: 50,
    stringArrayWrappersType: "function",
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersCount: 10,

    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 1,

    // Turn object keys into chaos
    transformObjectKeys: true,

    // Unicode soup
    unicodeEscapeSequence: true,

    // Randomization
    seed: 42,

    // Cosmetic insanity
    debugProtection: false,
    disableConsoleOutput: false,

    log: false,
  },
};

/**
 * Obfuscates JavaScript files in the dist directory
 */
async function obfuscateFiles() {
  try {
    const config =
      obfuscationConfigs[obfuscationLevel] || obfuscationConfigs.medium;
    const jsFiles = await glob("dist/**/*.js");

    console.log(
      `🔮 Obfuscating ${jsFiles.length} files with "${obfuscationLevel}" level...`,
    );

    for (const filePath of jsFiles) {
      const sourceCode = readFileSync(filePath, "utf8");
      const obfuscated = JavaScriptObfuscator.obfuscate(sourceCode, config);
      writeFileSync(filePath, obfuscated.getObfuscatedCode());
      console.log(`✨ Obfuscated: ${filePath}`);
    }

    console.log(
      "🎭 Obfuscation complete! Your code is now wonderfully mysterious!",
    );
  } catch (error) {
    console.error("💥 Obfuscation failed:", error);
  }
}

const buildOptions = {
  entryPoints: {
    background: "src/background.ts",
    backgroundLogic: "src/backgroundLogic.ts",
    newTab: "src/newTab.ts",
    options: "src/options.ts",
    popup: "src/popup.ts",
  },
  bundle: true,
  outdir: "dist",
  format: "esm",
  platform: "browser",
  target: "es2020",
  sourcemap: false, // No sourcemaps when obfuscating for maximum mystery
  minify: false, //!isWatch && !shouldObfuscate, // Let obfuscator handle minification
  splitting: false,
};

function validateManifestPaths(distDir) {
  const manifestPath = path.join(distDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const errors = [];

  const checkPath = (relativePath) => {
    if (!relativePath) return;
    const full = path.join(distDir, relativePath);
    if (!existsSync(full)) {
      errors.push(relativePath);
    }
  };

  // Background worker
  checkPath(manifest.background?.service_worker);

  // Pages
  checkPath(manifest.chrome_url_overrides?.newtab);
  checkPath(manifest.options_page);
  checkPath(manifest.action?.default_popup);

  // Icons
  if (manifest.icons) {
    for (const icon of Object.values(manifest.icons)) {
      const iconPath = String(icon);
      checkPath(iconPath);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Manifest references missing output files:\n  ${errors.join("\n  ")}`,
    );
  }
}

async function build() {
  try {
    // Create dist directory
    mkdirSync("dist", { recursive: true });

    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log("👀 Watching for changes...");
    } else {
      await esbuild.build(buildOptions);

      if (shouldObfuscate) {
        console.log(
          `🎪 Fun mode activated! Preparing to obfuscate with "${obfuscationLevel}" level...`,
        );
        await obfuscateFiles();
      } else {
        console.log("✅ Build complete!");
      }
    }

    // Copy static files
    cpSync("src/manifest.json", "dist/manifest.json");
    cpSync("src/newTab.html", "dist/newTab.html", { force: true });
    cpSync("src/options.html", "dist/options.html", { force: true });
    cpSync("src/popup.html", "dist/popup.html", { force: true });

    // Copy icons if they exist
    if (existsSync("src/icons")) {
      cpSync("src/icons", "dist/icons", { recursive: true, force: true });
      console.log("📋 Static files and icons copied");
    } else {
      console.log(
        "📋 Static files copied (⚠️  icons folder not found - extension will need icons to load)",
      );
    }

    // Sanity check: ensure dist/manifest.json references existing files
    validateManifestPaths("dist");

    // Add obfuscation summary
    if (shouldObfuscate && !isWatch) {
      console.log("");
      console.log("🎭 === OBFUSCATION SUMMARY ===");
      console.log(`🔮 Level: ${obfuscationLevel}`);
      console.log("✨ Your code is now beautifully mysterious!");
      console.log("🕵️ Good luck reverse engineering this masterpiece!");
      console.log(
        "🎪 Remember: With great obfuscation comes great debugging difficulty!",
      );
    }
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();
