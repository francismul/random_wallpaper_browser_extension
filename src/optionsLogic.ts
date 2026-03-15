/**
 * Pure logic helpers for the Options page.
 *
 * This module is intentionally DOM-independent so it can be unit tested in
 * a Node-like environment and used to drive rendering code in the UI.
 */

import { Settings } from "./config";

/**
 * Returns a masked version of an API key for display.
 * Shows only the first `visibleStart` and last `visibleEnd` characters.
 */
export function maskApiKey(
  key: string,
  visibleStart = 8,
  visibleEnd = 4,
  maskChar = "•",
): string {
  if (!key) return "";
  if (key.length <= visibleStart + visibleEnd) {
    // Short keys are partially masked but keep at least the first/last chars
    const visible = Math.max(0, key.length - 4);
    return key.slice(0, visible) + maskChar.repeat(key.length - visible);
  }

  return (
    key.slice(0, visibleStart) +
    maskChar.repeat(Math.max(0, key.length - visibleStart - visibleEnd)) +
    key.slice(-visibleEnd)
  );
}

/**
 * Validates an API key string for allowed characters and minimum length.
 */
export function isApiKeyValidFormat(
  key: string,
  minLength = 10,
  pattern = /^[a-zA-Z0-9_-]+$/,
): boolean {
  if (!key || typeof key !== "string") return false;
  if (key.length < minLength) return false;
  return pattern.test(key);
}

/**
 * Returns the effective list of API keys (unsplash + pexels) with their source.
 */
export function getAllApiKeys(settings: Settings): Array<{
  source: "unsplash" | "pexels";
  key: string;
}> {
  return [
    ...((settings.apiKeys?.unsplash ?? []).map((key) => ({
      source: "unsplash" as const,
      key,
    })) ?? []),
    ...((settings.apiKeys?.pexels ?? []).map((key) => ({
      source: "pexels" as const,
      key,
    })) ?? []),
  ];
}

/**
 * Computes the display status metadata for an API key based on stored status.
 */
export function getApiKeyStatus(
  settings: Settings,
  source: "unsplash" | "pexels",
  key: string,
): {
  tested: boolean;
  valid: boolean;
  testedAt: number | null;
  isStale: boolean;
} {
  const status = settings.apiKeyStatus?.[`${source}_${key}`];
  const testedAt = status?.testedAt ?? null;
  const tested = Boolean(status?.tested);
  const valid = Boolean(status?.valid);
  const ageHours = testedAt ? (Date.now() - testedAt) / (1000 * 60 * 60) : 0;
  const isStale = tested && ageHours > 24;

  return {
    tested,
    valid,
    testedAt,
    isStale,
  };
}

/**
 * Helper to obtain the UI status text and CSS class for a key status.
 */
export function getApiKeyStatusDisplay(
  status: ReturnType<typeof getApiKeyStatus>,
): { text: string; cssClass: string; title: string } {
  if (!status.tested) {
    return {
      text: "Not Tested",
      cssClass: "unknown",
      title: "Click Test to verify this API key",
    };
  }

  const dateLabel = status.testedAt
    ? `Tested ${new Date(status.testedAt).toLocaleString()}`
    : "Tested";

  if (status.valid) {
    return {
      text: status.isStale ? "Valid (Old)" : "Valid",
      cssClass: status.isStale ? "valid-stale" : "valid",
      title: dateLabel,
    };
  }

  return {
    text: status.isStale ? "Invalid (Old)" : "Invalid",
    cssClass: status.isStale ? "invalid-stale" : "invalid",
    title: dateLabel,
  };
}
