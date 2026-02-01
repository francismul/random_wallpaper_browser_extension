/**
 * Fallback Image Handler
 * Manages downloading, caching, and clearing of fallback images
 * for the random wallpaper browser extension.
 */

import {
  IMAGE_EXPIRY_HOURS,
  PERMANENT_CACHE_EXPIRY_MS,
  DEFAULT_NETWORK_TIMEOUT_MS,
} from "../config";
import { getSettings } from "../storage";
import { FALLBACK_IMAGES } from "./images";
import type { ImageData as DbImageData } from "../config";
import { clearAllImages } from "../db";
import { Logger } from "../logger";

const fallback_logger = new Logger("Fallback");

/**
 * Clears fallback images from IndexedDB
 * Should be called when user configures API keys for the first time
 */
export async function clearFallbackImages(): Promise<void> {
  fallback_logger.info("Clearing fallback images from database...");
  try {
    await clearAllImages();
    fallback_logger.info("Fallback images cleared successfully");
  } catch (error) {
    fallback_logger.error("Failed to clear fallback images:", error);
    throw error;
  }
}

/**
 * Downloads and processes fallback images from predefined URLs
 * Handles offline scenarios and failed downloads gracefully
 * @returns Promise that resolves to array of ImageData objects
 * @throws Never throws - always returns at least one fallback image
 */
export async function getFallbackImages(): Promise<DbImageData[]> {
  if (!navigator.onLine) {
    fallback_logger.warn("Offline detected.");
    return [];
  }

  fallback_logger.debug(
    "Downloading and processing fallback images from predefined urls",
  );

  const now = Date.now();

  const settings = await getSettings();

  const permanentCache = settings.cache?.permanentMode;

  const expiresAt = permanentCache
    ? now + PERMANENT_CACHE_EXPIRY_MS
    : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;

  const imagePromises = FALLBACK_IMAGES.map(async (fallbackImage) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        DEFAULT_NETWORK_TIMEOUT_MS,
      );

      const response = await fetch(fallbackImage.url, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        fallback_logger.error(
          `Failed to fetch fallback image: ${response.status}`,
        );
        fallback_logger.error(`${response.statusText}`);
        return null;
      }
      const blob = await response.blob();

      fallback_logger.debug("Fetched fallback images successfully", {
        timestamp: now,
        expiresAt,
      });

      return {
        ...fallbackImage,
        blob,
        timestamp: now,
        expiresAt,
      };
    } catch (error) {
      fallback_logger.error(
        `Failed to download fallback image ${fallbackImage.id}:`,
        error,
      );
      return null;
    }
  });

  const images = await Promise.all(imagePromises);
  const validImages = images.filter((img): img is DbImageData => img !== null);

  // If all fallback downloads failed, generate placeholder directly (no recursion risk)
  if (validImages.length === 0) {
    fallback_logger.warn("All fallback downloads failed");
    return [];
  }

  fallback_logger.info(
    `Successfully downloaded ${validImages.length} fallback images`,
  );
  return validImages;
}
