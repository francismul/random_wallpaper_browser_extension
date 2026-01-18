import {
  IMAGE_EXPIRY_HOURS,
  PEXELS_IMAGES_COUNT,
  UNSPLASH_IMAGES_COUNT,
  PERMANENT_CACHE_EXPIRY_MS,
} from "../config/constants";
import { getRandomIndex } from "../utils/random";
import { recordApiRequest } from "./fallback";

/**
 * Extension settings interface for API keys and search preferences
 */
interface Settings {
  apiKeys: {
    unsplash: string[];
    pexels: string[];
  };
  searchPreferences: {
    unsplashKeywords: string;
    pexelsKeywords: string;
  };
}

/**
 * Downloads an image from a URL and returns it as a Blob
 * Includes timeout protection and content type validation
 * @param url - The image URL to download
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns Promise that resolves to the image Blob
 * @throws Error if download fails, times out, or file is not an image
 */
async function downloadImageBlob(
  url: string,
  timeoutMs: number = 30000
): Promise<Blob> {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const blob = await response.blob();

    if (!blob.type.startsWith("image/")) {
      throw new Error("Fetched file is not an image");
    }

    return blob;
  } catch (error) {
    if ((error as DOMException).name === "AbortError") {
      throw new Error("Image fetch timed out");
    }
    throw error;
  }
}

/**
 * Retrieves extension settings from Chrome local storage
 * Returns default values if no settings are found
 * @returns Promise that resolves to the Settings object
 */
async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings"], (result: any) => {
      resolve(
        result.settings || {
          apiKeys: { unsplash: [], pexels: [] },
          searchPreferences: { unsplashKeywords: "", pexelsKeywords: "" },
        }
      );
    });
  });
}

/**
 * Selects a random API key from an array of keys
 * Uses cryptographically secure randomness
 * @param keys - Array of API keys to choose from
 * @returns Random API key or null if array is empty
 */
function getRandomKey(keys: string[]): string | null {
  if (keys.length === 0) return null;
  const randomIndex = getRandomIndex(keys.length);
  return keys[randomIndex] || null;
}

/**
 * Checks if permanent cache mode is enabled in settings
 * @returns Promise that resolves to true if permanent cache mode is enabled
 */
async function isPermanentCacheEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result: any) => {
      const settings = result.settings || {};
      resolve(settings.cache?.permanentMode ?? false);
    });
  });
}

/**
 * Fetches random landscape images from Unsplash API
 * Downloads images as blobs for offline access and applies expiration timestamps
 * @param apiKey - Unsplash API key for authentication
 * @param keywords - Optional comma-separated keywords for search (random keyword will be selected)
 * @returns Promise that resolves to array of ImageData objects
 * @throws Error if API call fails or network is unavailable
 */
async function fetchUnsplashImages(
  apiKey: string,
  keywords?: string
): Promise<ImageData[]> {
  try {
    // Check if online before attempting
    if (!navigator.onLine) {
      console.warn("No network connection, skipping Unsplash fetch");
      return [];
    }

    // Unsplash max is 30 images per request
    let url = `https://api.unsplash.com/photos/random?count=${UNSPLASH_IMAGES_COUNT}&orientation=landscape`;

    // Parse keywords once and reuse
    const keywordList = keywords
      ? keywords
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      : [];

    if (keywordList.length > 0) {
      const randomKeyword = keywordList[getRandomIndex(keywordList.length)];
      url += `&query=${encodeURIComponent(randomKeyword!)}`;
    }

    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${apiKey}` },
      signal: AbortSignal.timeout(15000), // 15 second timeout for API call
    });

    // Record API request for rate limiting
    await recordApiRequest("unsplash");

    if (!response.ok) {
      throw new Error(`Unsplash API error: ${response.status}`);
    }

    const data = await response.json();
    const now = Date.now();
    
    // Check if permanent cache mode is enabled
    const permanentCache = await isPermanentCacheEnabled();
    const expiresAt = permanentCache 
      ? now + PERMANENT_CACHE_EXPIRY_MS 
      : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;

    // Download images as blobs for offline support
    const imagePromises = data.map(async (photo: any) => {
      try {
        const blob = await downloadImageBlob(photo.urls.regular);
        return {
          id: `unsplash_${photo.id}`,
          url: photo.urls.regular,
          blob,
          source: "unsplash" as const,
          downloadUrl: photo.links.download,
          author: photo.user.name,
          authorUrl: photo.user.links.html,
          timestamp: now,
          expiresAt,
        };
      } catch (error) {
        console.error(`Failed to download Unsplash image ${photo.id}:`, error);
        return null;
      }
    });

    const images = await Promise.all(imagePromises);
    return images.filter((img): img is ImageData => img !== null);
  } catch (error) {
    console.error("Failed to fetch from Unsplash:", error);
    return [];
  }
}

/**
 * Fetches landscape images from Pexels API (curated or search results)
 * Downloads images as blobs for offline access and applies expiration timestamps
 * @param apiKey - Pexels API key for authentication
 * @param keywords - Optional comma-separated keywords for search (random keyword will be selected)
 * @returns Promise that resolves to array of ImageData objects
 * @throws Error if API call fails or network is unavailable
 */
async function fetchPexelsImages(
  apiKey: string,
  keywords?: string
): Promise<ImageData[]> {
  try {
    // Check if online before attempting
    if (!navigator.onLine) {
      console.warn("No network connection, skipping Pexels fetch");
      return [];
    }

    let url: string;
    const randomPage = getRandomIndex(10) + 1; // Random page 1-10

    // Parse keywords once and reuse
    const keywordList = keywords
      ? keywords
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      : [];

    if (keywordList.length > 0) {
      const randomKeyword = keywordList[getRandomIndex(keywordList.length)];
      url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
        randomKeyword!
      )}&per_page=${PEXELS_IMAGES_COUNT}&orientation=landscape`;
    } else {
      url = `https://api.pexels.com/v1/curated?per_page=${PEXELS_IMAGES_COUNT}&page=${randomPage}`;
    }

    const response = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(15000), // 15 second timeout for API call
    });

    // Record API request for rate limiting
    await recordApiRequest("pexels");

    if (!response.ok) {
      throw new Error(`Pexels API error: ${response.status}`);
    }

    const data = await response.json();
    const now = Date.now();
    
    // Check if permanent cache mode is enabled
    const permanentCache = await isPermanentCacheEnabled();
    const expiresAt = permanentCache 
      ? now + PERMANENT_CACHE_EXPIRY_MS 
      : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;

    // Download images as blobs for offline support
    const imagePromises = data.photos.map(async (photo: any) => {
      try {
        const blob = await downloadImageBlob(photo.src.large2x);
        return {
          id: `pexels_${photo.id}`,
          url: photo.src.large2x,
          blob,
          source: "pexels" as const,
          downloadUrl: photo.url,
          author: photo.photographer,
          authorUrl: photo.photographer_url,
          timestamp: now,
          expiresAt,
        };
      } catch (error) {
        console.error(`Failed to download Pexels image ${photo.id}:`, error);
        return null;
      }
    });

    const images = await Promise.all(imagePromises);
    return images.filter((img): img is ImageData => img !== null);
  } catch (error) {
    console.error("Failed to fetch from Pexels:", error);
    return [];
  }
}

/**
 * Fetches images from all configured API sources
 * Combines results from Unsplash and Pexels based on available API keys
 * Executes API calls in parallel for better performance
 * @returns Promise that resolves to array of ImageData objects from all sources
 */
export async function fetchAllImages(): Promise<ImageData[]> {
  console.log("Fetching images from APIs...");

  const settings = await getSettings();
  const unsplashKey = getRandomKey(settings.apiKeys.unsplash);
  const pexelsKey = getRandomKey(settings.apiKeys.pexels);

  const promises: Promise<ImageData[]>[] = [];

  if (unsplashKey) {
    promises.push(
      fetchUnsplashImages(
        unsplashKey,
        settings.searchPreferences.unsplashKeywords
      )
    );
  } else {
    console.warn("No Unsplash API key configured");
  }

  if (pexelsKey) {
    promises.push(
      fetchPexelsImages(pexelsKey, settings.searchPreferences.pexelsKeywords)
    );
  } else {
    console.warn("No Pexels API key configured");
  }

  if (promises.length === 0) {
    console.warn("No API keys configured, returning empty array");
    return [];
  }

  const results = await Promise.all(promises);
  const allImages = results.flat();

  console.log(`Fetched ${allImages.length} images total`);
  return allImages;
}

/**
 * Checks if any API keys are configured in the extension settings
 * Used to determine if the extension can fetch images from external sources
 * @returns Promise that resolves to true if at least one API key is configured
 */
export async function areApiKeysConfigured(): Promise<boolean> {
  const settings = await getSettings();
  return (
    settings.apiKeys.unsplash.length > 0 || settings.apiKeys.pexels.length > 0
  );
}

/**
 * Checks if the browser is currently online
 * Used to prevent unnecessary API calls when offline
 * @returns True if browser is online, false otherwise
 */
export function isOnline(): boolean {
  return navigator.onLine;
}

/**
 * Gets the count of available API keys for each service
 * Useful for load balancing and monitoring API key usage
 * @returns Promise that resolves to an object with key counts per service
 */
export async function getApiKeyStats(): Promise<{
  unsplash: number;
  pexels: number;
  total: number;
}> {
  const settings = await getSettings();
  const unsplashCount = settings.apiKeys.unsplash.length;
  const pexelsCount = settings.apiKeys.pexels.length;

  return {
    unsplash: unsplashCount,
    pexels: pexelsCount,
    total: unsplashCount + pexelsCount,
  };
}
