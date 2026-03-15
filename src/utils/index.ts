/**
 * Utility functions for the random wallpaper browser extension.
 * Provides common helper methods used across the extension.
 */

import {
  IMAGE_EXPIRY_HOURS,
  PERMANENT_CACHE_EXPIRY_MS,
  Settings,
} from "../config";

/**
 * Generate a cryptographically secure random index
 * Uses rejection sampling to avoid modulo bias
 * @param max - Maximum value (exclusive)
 * @returns Random index between 0 and max-1
 */
export function getRandomIndex(max: number): number {
  if (max <= 0) {
    throw new Error("Max must be greater than 0");
  }

  const randomBuffer = new Uint32Array(1);
  const range = 2 ** 32;
  const limit = range - (range % max);

  let randomValue: number;

  do {
    crypto.getRandomValues(randomBuffer);
    randomValue = randomBuffer[0]!;
  } while (randomValue >= limit);

  return randomValue % max;
}

/**
 * Checks if any API keys are configured in the extension settings
 * Used to determine if the extension can fetch images from external sources
 * @returns Promise that resolves to true if at least one API key is configured
 */
export async function areApiKeysConfigured(
  settings: Settings,
): Promise<boolean> {
  return (
    settings.apiKeys.unsplash.length > 0 || settings.apiKeys.pexels.length > 0
  );
}

/**
 * Compute image expiry timestamp based on settings
 * Respects permanent cache mode if enabled
 * @returns Promise that resolves to the expiry timestamp in milliseconds
 */
export async function computeExpiry(
  isPermanentCacheEnabled: boolean,
): Promise<number> {
  const now = Date.now();
  const permanent = isPermanentCacheEnabled;

  return permanent
    ? now + PERMANENT_CACHE_EXPIRY_MS
    : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;
}

/**
 * Formats a timestamp into a human-readable relative time string
 * Handles various time units from seconds to years with proper pluralization
 * @param timestamp - The timestamp in milliseconds to format
 * @returns A human-readable relative time string (e.g., "2 hours ago", "in 5 minutes")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = timestamp - now; // note: positive if in future
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const isFuture = diff > 0;
  const suffix = isFuture ? "in " : "";
  const postfix = isFuture ? "" : " ago";

  if (seconds < 10) return isFuture ? "In a few seconds" : "Just now";
  if (seconds < 60)
    return `${suffix}${seconds} second${seconds !== 1 ? "s" : ""}${postfix}`;
  if (minutes < 60)
    return `${suffix}${minutes} minute${minutes !== 1 ? "s" : ""}${postfix}`;
  if (hours < 24)
    return `${suffix}${hours} hour${hours !== 1 ? "s" : ""}${postfix}`;
  if (days < 7) return `${suffix}${days} day${days !== 1 ? "s" : ""}${postfix}`;
  if (weeks < 4)
    return `${suffix}${weeks} week${weeks !== 1 ? "s" : ""}${postfix}`;
  if (months < 12)
    return `${suffix}${months} month${months !== 1 ? "s" : ""}${postfix}`;
  return `${suffix}${years} year${years !== 1 ? "s" : ""}${postfix}`;
}

/**
 * Formats a timestamp into a human-readable "time ago" string
 */
export function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  return "Just now";
}


/**
 * Computes the SHA-256 hash of a Blob (or File).
 * Uses `crypto.subtle` — available in all modern browsers and extension contexts.
 * @param blob - The Blob to hash
 * @returns A promise resolving to the lowercase hexadecimal hash string
 */
export async function hashBlob(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes the SHA-256 hash of a File.
 * @param file - The file to hash
 * @returns A promise resolving to the hexadecimal hash string
 */
export async function getFileHash(file: File): Promise<string> {
  return hashBlob(file);
}
