/**
 * Api module for the random wallpaper browser extension.
 * Provides a way for fetching images from unsplash and pexels.
 */

import { Logger } from "../logger";
import {
  DownloadOptions,
  PEXELS_IMAGES_COUNT,
  UNSPLASH_IMAGES_COUNT,
  DEFAULT_MAX_RETRIES,
  DOWNLOAD_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_BACKOFF_MULTIPLIER,
  API_REQUEST_TIMEOUT_MS,
  ImageData,
  Settings,
} from "../config";
import { computeExpiry, getRandomIndex } from "../utils";
import {
  getLastKeywordIndex,
  saveLastKeywordIndex,
} from "../storage";

const api_logger = new Logger("API");

/**
 * Gets the next keyword sequentially from the merged keyword list
 * Rotates through keywords in order instead of random selection
 * @param unsplashKeywords - Unsplash keywords (comma-separated)
 * @param pexelsKeywords - Pexels keywords (comma-separated)
 * @returns Promise that resolves to the selected keyword or null if no keywords
 */
async function getNextKeywordSequentially(
  unsplashKeywords: string,
  pexelsKeywords: string,
): Promise<string | null> {
  // Merge and deduplicate keywords from both sources
  const allKeywords = [
    ...unsplashKeywords.split(",").map((k) => k.trim()),
    ...pexelsKeywords.split(",").map((k) => k.trim()),
  ]
    .filter((k) => k.length > 0)
    .filter((k, index, self) => self.indexOf(k) === index); // Remove duplicates

  if (allKeywords.length === 0) {
    api_logger.debug("No keywords configured");
    return null;
  }

  // Get last used index and increment
  const lastIndex = await getLastKeywordIndex();
  const nextIndex = (lastIndex + 1) % allKeywords.length;

  // Save the new index for next time
  await saveLastKeywordIndex(nextIndex);

  const selectedKeyword = allKeywords[nextIndex] || null;
  if (selectedKeyword) {
    api_logger.info(
      `Selected keyword [${nextIndex + 1}/${allKeywords.length}]: "${selectedKeyword}"`,
    );
  }

  return selectedKeyword;
}

/**
 * Connection speed cache (updated periodically)
 */
let cachedConnectionSpeed: "slow" | "medium" | "fast" = "medium";
let lastSpeedTest = 0;
const SPEED_TEST_INTERVAL_MS = 300000; // Test every 5 minutes

/**
 * Tests connection speed by downloading a small file
 * @returns Connection speed classification
 */
async function testConnectionSpeed(): Promise<
  "slow" | "medium" | "fast"
> {
  try {
    // Use Network Information API if available
    const nav = navigator as any;
    if (nav.connection) {
      const effectiveType = nav.connection.effectiveType;
      if (effectiveType === "slow-2g" || effectiveType === "2g") {
        return "slow";
      }
      if (effectiveType === "3g") {
        return "medium";
      }
      if (effectiveType === "4g" || effectiveType === "5g") {
        return "fast";
      }
    }

    // Fallback: download a small test file
    const testUrl =
      "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=50";
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(testUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    const duration = Date.now() - startTime;

    // Classify based on response time
    if (duration < 500) return "fast";
    if (duration < 2000) return "medium";
    return "slow";
  } catch (error) {
    api_logger.warn("Connection speed test failed, defaulting to medium");
    return "medium";
  }
}

/**
 * Gets dynamic timeout based on connection speed
 * @returns Timeout in milliseconds
 */
async function getDynamicTimeout(): Promise<number> {
  const now = Date.now();

  // Update speed test if needed
  if (now - lastSpeedTest > SPEED_TEST_INTERVAL_MS) {
    cachedConnectionSpeed = await testConnectionSpeed();
    lastSpeedTest = now;
    api_logger.debug("Connection speed detected:", cachedConnectionSpeed);
  }

  // Return appropriate timeout
  switch (cachedConnectionSpeed) {
    case "slow":
      return 60000; // 60 seconds for slow connections
    case "medium":
      return DOWNLOAD_TIMEOUT_MS; // 30 seconds
    case "fast":
      return 20000; // 20 seconds for fast connections
  }
}

/**
 * HTTP status codes that should not be retried
 */
const NON_RETRYABLE_STATUS_CODES = new Set([
  400, // bad request
  401, // unauthorized
  402, // payment required
  403, // forbidden
  404, // not found
  409, // conflict
  422, // unprocessable entity
  429, // too many requests
  500, // internal server error
  501, // not implemented
  502, // bad gateway
  503, // service unavailable
]);

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Downloads a file from a URL with retry logic and exponential backoff
 * Handles network unavailability gracefully
 *
 * @param url - The URL to download from
 * @param options - Configuration options for download behavior
 * @returns Promise that resolves to a Blob
 * @throws Error if download fails after all retries or encounters non-retryable error
 */
async function downloadFile(
  url: string,
  options: DownloadOptions = {},
): Promise<Blob> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs,
    initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
  } = options;

  // Use dynamic timeout if not specified
  const actualTimeout = timeoutMs || (await getDynamicTimeout());

  api_logger.debug("Starting download", { url, timeout: actualTimeout });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort("Download timeout exceeded"),
        actualTimeout,
      );

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new HttpError(
          response.status,
          `HTTP ${response.status} ${response.statusText}`,
        );
      }

      const blob = await response.blob();
      api_logger.info("Download succeeded", { url });
      return blob;
    } catch (error) {
      const err = error as Error;

      // Check if error is a timeout (AbortError with our specific reason)
      const isTimeout =
        err.name === "AbortError" &&
        (err.message.includes("timeout") || err.message.includes("aborted"));

      api_logger.warn("Download failed", {
        url,
        attempt: attempt + 1,
        error: err.message,
        errorType: isTimeout ? "timeout" : err.name,
      });

      if (
        err instanceof HttpError &&
        NON_RETRYABLE_STATUS_CODES.has(err.status)
      ) {
        api_logger.error("Non-retryable download error", {
          url,
          status: err.status,
        });
        throw err;
      }

      if (attempt === maxRetries) {
        api_logger.error("Download exhausted retries", {
          url,
          finalError: isTimeout ? "timeout" : err.message,
        });
        throw err;
      }

      const delay = initialBackoffMs * Math.pow(backoffMultiplier, attempt);

      api_logger.debug("Retrying download after delay", {
        url,
        delayMs: delay,
        nextAttempt: attempt + 2,
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error("Unreachable download failure");
}

/**
 * Downloads a single image with individual retry logic
 * @param photo - Photo metadata from API
 * @param source - Image source (unsplash or pexels)
 * @param expiresAt - Expiration timestamp
 * @param timestamp - Download timestamp
 * @returns Promise that resolves to ImageData or null if all retries fail
 */
async function downloadSingleImage(
  photo: any,
  source: "unsplash" | "pexels",
  expiresAt: number,
  timestamp: number,
): Promise<ImageData | null> {
  const photoId = source === "unsplash" ? photo.id : photo.id;
  const imageUrl =
    source === "unsplash" ? photo.urls.regular : photo.src.large2x;
  const downloadUrl = source === "unsplash" ? photo.links.download : photo.url;
  const author =
    source === "unsplash" ? photo.user.name : photo.photographer;
  const authorUrl =
    source === "unsplash" ? photo.user.links.html : photo.photographer_url;

  let lastError: Error | null = null;

  // Try downloading with individual retry logic
  for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
    try {
      api_logger.debug(`Downloading ${source} image`, {
        id: photoId,
        attempt: attempt + 1,
      });

      const blob = await downloadFile(imageUrl, {
        maxRetries: 1, // Already handling retries here
      });

      api_logger.info(`Successfully downloaded ${source} image`, {
        id: photoId,
      });

      return {
        id: `${source}_${photoId}`,
        url: imageUrl,
        blob,
        source,
        downloadUrl,
        author,
        authorUrl,
        timestamp,
        expiresAt,
      };
    } catch (error) {
      lastError = error as Error;
      api_logger.warn(`${source} image download failed`, {
        id: photoId,
        attempt: attempt + 1,
        error: lastError.message,
      });

      // Wait before retry (except on last attempt)
      if (attempt < DEFAULT_MAX_RETRIES - 1) {
        const delay = DEFAULT_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  api_logger.error(
    `Failed to download ${source} image after ${DEFAULT_MAX_RETRIES} attempts`,
    { id: photoId, lastError: lastError?.message },
  );
  return null;
}

/**
 * Fetches random landscape images from Unsplash API
 * @param apiKey - Unsplash API key for authentication
 * @param keyword - Selected keyword for this batch
 * @returns Promise that resolves to array of ImageData objects
 */
async function fetchUnsplashImages(
  apiKey: string,
  isPermanentCacheEnabled: boolean,
  keyword: string | null,
): Promise<ImageData[]> {
  try {
    if (!navigator.onLine) {
      api_logger.warn("Network offline, skipping Unsplash fetch");
      return [];
    }

    let url = `https://api.unsplash.com/photos/random?count=${UNSPLASH_IMAGES_COUNT}&orientation=landscape`;

    if (keyword) {
      url += `&query=${encodeURIComponent(keyword)}`;
    }

    api_logger.info(
      `Fetching Unsplash images metadata${keyword ? ` with keyword: "${keyword}"` : " (random/curated)"}`,
    );

    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${apiKey}` },
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const metadataCount = data.length;
    api_logger.info(
      `Received ${metadataCount} Unsplash image metadata entries`,
    );

    const now = Date.now();
    const expiresAt = await computeExpiry(isPermanentCacheEnabled);

    // Download each image individually - failures won't affect others
    api_logger.info(
      `Starting individual downloads for ${metadataCount} Unsplash images`,
    );
    const downloadPromises = data.map((photo: any) =>
      downloadSingleImage(photo, "unsplash", expiresAt, now),
    );

    const results = await Promise.allSettled(downloadPromises);

    // Process results and track statistics
    const successfulImages: ImageData[] = [];
    let failedCount = 0;

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value !== null) {
        successfulImages.push(result.value);
      } else {
        failedCount++;
        const photoId = data[index]?.id || `unknown_${index}`;
        api_logger.warn("Unsplash image permanently failed", {
          id: photoId,
          reason:
            result.status === "rejected"
              ? result.reason?.message
              : "Download failed",
        });
      }
    });

    api_logger.info(
      `Unsplash results${keyword ? ` [${keyword}]` : ""}: ${successfulImages.length}/${metadataCount} images downloaded successfully${failedCount > 0 ? `, ${failedCount} failed` : ""}`,
    );

    return successfulImages;
  } catch (error) {
    api_logger.error("Unsplash API metadata fetch failed", { error });
    return [];
  }
}

/**
 * Fetches landscape images from Pexels API (curated or search results)
 * @param apiKey - Pexels API key for authentication
 * @param keyword - Selected keyword for this batch
 * @returns Promise that resolves to array of ImageData objects
 */
async function fetchPexelsImages(
  apiKey: string,
  isPermanentCacheEnabled: boolean,
  keyword: string | null,
): Promise<ImageData[]> {
  try {
    if (!navigator.onLine) {
      api_logger.warn("Network offline, skipping Pexels fetch");
      return [];
    }

    let url: string;
    if (keyword) {
      url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
        keyword,
      )}&per_page=${PEXELS_IMAGES_COUNT}&orientation=landscape`;
    } else {
      url = `https://api.pexels.com/v1/curated?per_page=${PEXELS_IMAGES_COUNT}&page=${getRandomIndex(10) + 1}`;
    }

    api_logger.info(
      `Fetching Pexels images metadata${keyword ? ` with keyword: "${keyword}"` : " (curated)"}`,
    );

    const response = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const metadataCount = data.photos.length;
    api_logger.info(`Received ${metadataCount} Pexels image metadata entries`);

    const now = Date.now();
    const expiresAt = await computeExpiry(isPermanentCacheEnabled);

    // Download each image individually - failures won't affect others
    api_logger.info(
      `Starting individual downloads for ${metadataCount} Pexels images`,
    );
    const downloadPromises = data.photos.map((photo: any) =>
      downloadSingleImage(photo, "pexels", expiresAt, now),
    );

    const results = await Promise.allSettled(downloadPromises);

    // Process results and track statistics
    const successfulImages: ImageData[] = [];
    let failedCount = 0;

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value !== null) {
        successfulImages.push(result.value);
      } else {
        failedCount++;
        const photoId = data.photos[index]?.id || `unknown_${index}`;
        api_logger.warn("Pexels image permanently failed", {
          id: photoId,
          reason:
            result.status === "rejected"
              ? result.reason?.message
              : "Download failed",
        });
      }
    });

    api_logger.info(
      `Pexels results${keyword ? ` [${keyword}]` : ""}: ${successfulImages.length}/${metadataCount} images downloaded successfully${failedCount > 0 ? `, ${failedCount} failed` : ""}`,
    );

    return successfulImages;
  } catch (error) {
    api_logger.error("Pexels API metadata fetch failed", { error });
    return [];
  }
}

/**
 * Fetches images from all configured API sources
 * Fetches from all API keys in parallel: 30 images per Unsplash key, 80 per Pexels key
 * @returns Promise that resolves to array of ImageData objects from all sources
 */
export async function fetchAllImages(settings: Settings): Promise<ImageData[]> {
  if (!navigator.onLine) {
    api_logger.warn("Network offline, skipping fetch");
    return [];
  }

  const startTime = Date.now();
  const unsplashKeyCount = settings.apiKeys.unsplash.length;
  const pexelsKeyCount = settings.apiKeys.pexels.length;
  const expectedUnsplashImages = unsplashKeyCount * UNSPLASH_IMAGES_COUNT;
  const expectedPexelsImages = pexelsKeyCount * PEXELS_IMAGES_COUNT;
  const expectedTotalImages = expectedUnsplashImages + expectedPexelsImages;

  // Select ONE keyword sequentially for this entire fetch session
  // Both Unsplash and Pexels will use the same keyword
  const selectedKeyword = await getNextKeywordSequentially(
    settings.searchPreferences.unsplashKeywords,
    settings.searchPreferences.pexelsKeywords,
  );

  api_logger.info(
    `Starting image fetch - Expected: ${expectedTotalImages} images (${expectedUnsplashImages} Unsplash + ${expectedPexelsImages} Pexels)`,
  );

  try {
    const promises: Promise<ImageData[]>[] = [
      ...settings.apiKeys.unsplash.map((key) =>
        fetchUnsplashImages(
          key,
          settings.cache.permanentMode,
          selectedKeyword,
        ),
      ),
      ...settings.apiKeys.pexels.map((key) =>
        fetchPexelsImages(
          key,
          settings.cache.permanentMode,
          selectedKeyword,
        ),
      ),
    ];

    if (promises.length === 0) {
      api_logger.warn("No API keys configured");
      return [];
    }

    const results = await Promise.all(promises);
    const allImages = results.flat();

    const duration = Date.now() - startTime;
    const successRate = expectedTotalImages > 0
      ? ((allImages.length / expectedTotalImages) * 100).toFixed(1)
      : "0";

    api_logger.info(
      `Image fetch completed in ${duration}ms - Retrieved: ${allImages.length}/${expectedTotalImages} images (${successRate}% success rate)`,
    );

    // Warn if success rate is below 80%
    if (allImages.length < expectedTotalImages * 0.8) {
      const missedImages = expectedTotalImages - allImages.length;
      api_logger.warn(
        `Low success rate detected: ${missedImages} images failed to download`,
      );
    }

    return allImages;
  } catch (error) {
    api_logger.error(`An unexpected error occurred`, { error });
    return [];
  }
}

/**
 * Tests an API key for validity and rate limit status
 * Makes a lightweight request to verify the key works and hasn't exceeded limits
 * @param source - The image source service ('unsplash' or 'pexels')
 * @param key - The API key to test
 * @returns Promise resolving to true if key is valid and working
 */
export async function testApiKey(
  source: "unsplash" | "pexels",
  key: string,
): Promise<boolean> {
  try {
    if (!navigator.onLine) {
      api_logger.warn("Network offline, skipping fetch");
      return false;
    }

    api_logger.debug("Testing the provided api key");

    let response: Response;

    if (source === "unsplash") {
      // Use lightweight endpoint to test key
      response = await fetch("https://api.unsplash.com/photos/random?count=1", {
        headers: {
          Authorization: `Client-ID ${key}`,
          "Accept-Version": "v1",
        },
      });

      if (response.ok) api_logger.debug("Your unsplash api key is valid");
    } else {
      // Use curated endpoint for Pexels (lighter than search)
      response = await fetch("https://api.pexels.com/v1/curated?per_page=1", {
        headers: {
          Authorization: key,
          Accept: "application/json",
        },
      });

      if (response.ok) api_logger.debug("Your pexels api key is valid");
    }

    // Check for specific error conditions
    if (response.status === 401) {
      api_logger.warn(`API key test failed: Unauthorized (${source})`);
      return false;
    }

    if (response.status === 403) {
      api_logger.warn(`API key test failed: Rate limit exceeded (${source})`);
      return false;
    }

    if (response.status === 429) {
      api_logger.warn(`API key test failed: Too many requests (${source})`);
      return false;
    }

    return response.ok;
  } catch (error) {
    api_logger.error(`API key test error for ${source}:`, error);
    return false;
  }
}
