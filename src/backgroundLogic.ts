/**
 * Background logic extracted from the service worker entrypoint.
 *
 * This module is intentionally free of any direct `chrome.*` API calls so it can
 * be unit tested in a Node-like environment and reused in the real extension.
 */

import { Logger } from "./logger";
import {
  getStorageInfo,
  cleanExpiredImages,
  getLastFetchTime,
  setLastFetchTime,
  storeImages,
  getValidImageCount,
} from "./db";
import { getFallbackImages, clearFallbackImages } from "./fallback";
import { areApiKeysConfigured } from "./utils";
import { fetchAllImages } from "./api";
import { getSettings } from "./storage";
import {
  REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_HOURS,
  MIN_STORAGE_THRESHOLD_GB,
} from "./config";

const background_logger = new Logger("Service Worker");

/**
 * Tracks runtime state for the service worker.
 *
 * This is a mutable object so callers (including tests) can inspect stats
 * after operations complete.
 */
export interface BackgroundState {
  startTime: number;
  lastRefresh: number | null;
  lastManualFetch: number;
  failedFetches: number;
  successfulFetches: number;
  messageCount: number;
  manualRefreshCount: number;
  opportunisticRefreshCount: number;
  settingsUpdateCount: number;
  apiKeyUpdateCount: number;
  isFetching: boolean;
  /**
   * The last known image ID currently displayed (for cross-context sync)
   */
  currentImageId: string | null;
}

export const backgroundState: BackgroundState = {
  startTime: Date.now(),
  lastRefresh: null,
  lastManualFetch: 0,
  failedFetches: 0,
  successfulFetches: 0,
  messageCount: 0,
  manualRefreshCount: 0,
  opportunisticRefreshCount: 0,
  settingsUpdateCount: 0,
  apiKeyUpdateCount: 0,
  isFetching: false,
  currentImageId: null,
};

/**
 * Get the last known current image ID from the shared background state.
 * Useful for contexts that want to sync to the currently displayed image.
 */
export function getCurrentImageId(): string | null {
  return backgroundState.currentImageId;
}

/**
 * Set the current image ID in shared background state.
 */
export function setCurrentImageId(imageId: string | null): void {
  backgroundState.currentImageId = imageId;
}

export interface RefreshImagesDeps {
  logger?: Logger;
  getSettings?: typeof getSettings;
  getStorageInfo?: typeof getStorageInfo;
  cleanExpiredImages?: typeof cleanExpiredImages;
  areApiKeysConfigured?: typeof areApiKeysConfigured;
  fetchAllImages?: typeof fetchAllImages;
  getLastFetchTime?: typeof getLastFetchTime;
  setLastFetchTime?: typeof setLastFetchTime;
  storeImages?: typeof storeImages;
  getValidImageCount?: typeof getValidImageCount;
  getFallbackImages?: typeof getFallbackImages;
  clearFallbackImages?: typeof clearFallbackImages;
  state?: BackgroundState;
}

const DEFAULT_DEPS: RefreshImagesDeps = {
  logger: background_logger,
  getSettings,
  getStorageInfo,
  cleanExpiredImages,
  areApiKeysConfigured,
  fetchAllImages,
  getLastFetchTime,
  setLastFetchTime,
  storeImages,
  getValidImageCount,
  getFallbackImages,
  clearFallbackImages,
  state: backgroundState,
};

/**
 * Determine whether images should be refreshed based on last fetch time.
 *
 * This is intentionally tolerant: if any error happens (corrupt metadata, DB
 * failure) it returns `true` so refresh is attempted and the extension can
 * recover.
 */
export async function shouldRefreshImages(
  deps: RefreshImagesDeps = {},
): Promise<boolean> {
  const {
    logger = DEFAULT_DEPS.logger,
    getLastFetchTime: _getLastFetchTime = DEFAULT_DEPS.getLastFetchTime!,
  } = deps;

  try {
    const lastFetch = await _getLastFetchTime();

    if (lastFetch === null) {
      logger?.info("No previous fetch detected - initial refresh required");
      return true;
    }

    const timeSinceLastFetch = Date.now() - lastFetch;
    const hoursAgo = Math.round(timeSinceLastFetch / (1000 * 60 * 60));
    const shouldRefresh = timeSinceLastFetch >= REFRESH_INTERVAL_MS;

    if (shouldRefresh) {
      logger?.info(
        `Refresh needed - last fetch was ${hoursAgo} hours ago (threshold: ${REFRESH_INTERVAL_HOURS} hours)`,
      );
    } else {
      logger?.debug(`Images are fresh - last fetched ${hoursAgo} hours ago`);
    }

    return shouldRefresh;
  } catch (error) {
    logger?.error(`Error checking refresh status: ${error}`);
    return true; // Default to refresh on error
  }
}

/**
 * Refreshes images by fetching from configured APIs, storing them, and
 * cleaning up any fallback images.
 *
 * This function is intentionally written so it can be unit-tested by passing
 * mocks for its dependencies.
 */
export async function refreshImages(
  deps: RefreshImagesDeps = {},
): Promise<void> {
  const {
    logger = DEFAULT_DEPS.logger,
    getSettings: _getSettings = DEFAULT_DEPS.getSettings!,
    getStorageInfo: _getStorageInfo = DEFAULT_DEPS.getStorageInfo!,
    cleanExpiredImages: _cleanExpiredImages = DEFAULT_DEPS.cleanExpiredImages!,
    areApiKeysConfigured:
      _areApiKeysConfigured = DEFAULT_DEPS.areApiKeysConfigured!,
    fetchAllImages: _fetchAllImages = DEFAULT_DEPS.fetchAllImages!,
    getLastFetchTime: _getLastFetchTime = DEFAULT_DEPS.getLastFetchTime!,
    setLastFetchTime: _setLastFetchTime = DEFAULT_DEPS.setLastFetchTime!,
    storeImages: _storeImages = DEFAULT_DEPS.storeImages!,
    getValidImageCount: _getValidImageCount = DEFAULT_DEPS.getValidImageCount!,
    getFallbackImages: _getFallbackImages = DEFAULT_DEPS.getFallbackImages!,
    clearFallbackImages:
      _clearFallbackImages = DEFAULT_DEPS.clearFallbackImages!,
    state = DEFAULT_DEPS.state!,
  } = deps;

  if (state.isFetching) {
    logger?.warn("Fetch operation already in progress, skipping...");
    return;
  }

  state.isFetching = true;
  const startTime = Date.now();

  try {
    logger?.debug(`Checking available storage space`);
    const storageInfo = await _getStorageInfo();
    const availableGB = (storageInfo.available / (1024 * 1024 * 1024)).toFixed(
      2,
    );

    logger?.info(
      `Storage - Available: ${availableGB}GB, Used: ${storageInfo.percentUsed.toFixed(
        1,
      )}%`,
    );

    if (!storageInfo.hasEnoughSpace) {
      logger?.warn(
        `Low storage space (${availableGB}GB available). Minimum ${MIN_STORAGE_THRESHOLD_GB}GB required.`,
      );
      logger?.warn("Skipping image fetch to prevent storage issues.");
      state.isFetching = false;
      return;
    }

    logger?.debug(`Sufficient storage space available (${availableGB}GB)`);

    const settings = await _getSettings();
    const permanentCacheMode = settings.cache?.permanentMode;

    if (permanentCacheMode) {
      logger?.debug(`Skipping image cleanup, permanent cache mode is on`);
    } else {
      logger?.debug(`Permanent cache mode is off, performing cleanup`);
      const deletedCount = await _cleanExpiredImages();
      if (deletedCount > 0) {
        logger?.debug(`Cleaned ${deletedCount} expired images`);
      } else {
        logger?.debug(`No expired images to clean`);
      }
    }

    logger?.debug(`Checking if api keys are present for images update.`);
    const apiPresent = await _areApiKeysConfigured(settings);

    if (!apiPresent) {
      logger?.debug("No apis keys present, skipping image fetching");
      throw new Error("Api Keys are missing");
    }

    logger?.debug(`Api keys are present, proceeding with fetch`);

    const images = await _fetchAllImages(settings);

    if (images.length === 0) {
      logger?.warn("Fetch returned zero images - treating as failure");
      throw new Error("No images returned from API");
    }

    logger?.info(`Downloaded: ${images.length}`);
    logger?.info(`Caching ${images.length} images to db`);

    const now = Date.now();
    await _storeImages(images);

    // When we successfully fetched real API images, delete any prior fallback
    // images so we don't mix fallback + real images indefinitely.
    try {
      await _clearFallbackImages();
    } catch (error) {
      logger?.warn(
        "Failed to clear fallback images after successful fetch:",
        error,
      );
    }

    await _setLastFetchTime(now);
    state.lastRefresh = now;
    state.successfulFetches += 1;

    logger?.info(
      `Cached ${images.length} images in ${Date.now() - startTime}ms`,
    );
  } catch (error: unknown) {
    state.failedFetches += 1;
    logger?.debug(`Error: ${error}, Falling back to emergency fetch`);

    const existingImages = await _getValidImageCount();
    if (existingImages > 0) {
      logger?.debug(
        `Emergency fallback skipped, available images: ${existingImages}`,
      );
    } else {
      logger?.info("Getting default emergency images");
      const fallBackImages = await _getFallbackImages();
      if (fallBackImages.length < 1) {
        logger?.debug(`Emergency fallback failed, check your internet!`);
      } else {
        logger?.debug(`Caching fallback images: ${fallBackImages.length}`);
        await _storeImages(fallBackImages);
        logger?.debug(`Cached ${fallBackImages.length} images`);
      }
    }

    const finalImageCount = await _getValidImageCount();
    if (finalImageCount === 0) {
      logger?.error("Refresh failed: no valid images available after fallback");
      throw new Error(
        "Failed to refresh images: no images available after fallback",
      );
    }
  } finally {
    state.isFetching = false;
    const totalDuration = Date.now() - startTime;
    logger?.debug(`Image refresh completed in ${totalDuration}ms`);
    logger?.info(
      `Session stats - Successful fetches: ${state.successfulFetches}, Failed: ${state.failedFetches}`,
    );
  }
}
