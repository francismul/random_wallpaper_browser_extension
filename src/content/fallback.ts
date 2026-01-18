import { FALLBACK_IMAGES } from "../config/fallbackImgUrls";
import { IMAGE_EXPIRY_HOURS, PERMANENT_CACHE_EXPIRY_MS } from "../config/constants";
import type { ImageData as DbImageData } from "./db";

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
 * Generates a beautiful offline placeholder image using Canvas API
 * Creates a gradient background with informative text for offline scenarios
 * @returns Promise that resolves to an ImageData object with the generated placeholder
 */
async function generateOfflinePlaceholder(): Promise<DbImageData> {
  const now = Date.now();
  
  // Check if permanent cache mode is enabled
  const permanentCache = await isPermanentCacheEnabled();
  const expiresAt = permanentCache 
    ? now + PERMANENT_CACHE_EXPIRY_MS 
    : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;

  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d")!;

  // Create a nice gradient
  const gradient = ctx.createLinearGradient(0, 0, 1920, 1080);
  gradient.addColorStop(0, "#667eea");
  gradient.addColorStop(1, "#764ba2");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1920, 1080);

  // Add text
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.font = "48px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Offline Mode", 960, 500);
  ctx.font = "24px -apple-system, sans-serif";
  ctx.fillText("Connect to internet to download wallpapers", 960, 550);

  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), "image/png");
  });

  return {
    id: "offline_placeholder",
    url: "",
    blob,
    source: "unsplash",
    downloadUrl: "",
    author: "System",
    authorUrl: "",
    timestamp: now,
    expiresAt,
  };
}

/**
 * Downloads and processes fallback images from predefined URLs
 * Handles offline scenarios and failed downloads gracefully
 * @returns Promise that resolves to array of ImageData objects
 * @throws Never throws - always returns at least one fallback image
 */
export async function getFallbackImages(): Promise<DbImageData[]> {
  const now = Date.now();
  
  // Check if permanent cache mode is enabled
  const permanentCache = await isPermanentCacheEnabled();
  const expiresAt = permanentCache 
    ? now + PERMANENT_CACHE_EXPIRY_MS 
    : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;

  // Check if online - if offline, return placeholder immediately
  if (!navigator.onLine) {
    console.warn("Offline: Using embedded placeholder image for fallback");
    const placeholder = await generateOfflinePlaceholder();
    return [placeholder];
  }

  // Download all fallback images as blobs
  const imagePromises = FALLBACK_IMAGES.map(async (fallbackImage) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(fallbackImage.url, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch fallback image: ${response.status}`);
      }
      const blob = await response.blob();

      return {
        ...fallbackImage,
        blob,
        timestamp: now,
        expiresAt,
      };
    } catch (error) {
      console.error(
        `Failed to download fallback image ${fallbackImage.id}:`,
        error
      );
      return null;
    }
  });

  const images = await Promise.all(imagePromises);
  const validImages = images.filter((img): img is DbImageData => img !== null);

  // If all fallback downloads failed, generate placeholder directly (no recursion risk)
  if (validImages.length === 0) {
    console.warn(
      "All fallback downloads failed, generating offline placeholder"
    );
    const placeholder = await generateOfflinePlaceholder();
    return [placeholder];
  }

  return validImages;
}

/**
 * Determines if fallback images should be used instead of API calls
 * Checks for configured API keys, rate limits, and quota exhaustion
 * @returns Promise that resolves to true if fallback images should be used
 */
export async function shouldUseFallbackImages(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["settings", "apiLimits"], (result: any) => {
      const settings = result.settings || {
        apiKeys: { unsplash: [], pexels: [] },
      };
      const apiLimits = result.apiLimits || {};
      
      const hasApiKeys =
        settings.apiKeys.unsplash.length > 0 ||
        settings.apiKeys.pexels.length > 0;
      
      // Check if we should use fallback due to rate limiting
      const isRateLimited = checkRateLimits(apiLimits);
      
      resolve(!hasApiKeys || isRateLimited);
    });
  });
}

/**
 * Determines if offline placeholder should be used when all other sources fail
 * Checks network status and IndexedDB data availability
 * @returns Promise that resolves to true if offline placeholder should be used
 */
export async function shouldUseOfflinePlaceholder(): Promise<boolean> {
  // If offline, we should use placeholder
  if (!navigator.onLine) {
    return true;
  }
  
  // If online, check if we have valid cached data
  try {
    const { getValidImageCount } = await import('./db');
    const validImageCount = await getValidImageCount();
    
    // If no valid images and we should use fallback (no API keys or rate limited)
    if (validImageCount === 0 && await shouldUseFallbackImages()) {
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking IndexedDB data:', error);
    return true; // Fallback to placeholder on error
  }
}

/**
 * Gets the most appropriate image source based on current conditions
 * **USER INTERACTION VERSION**: Prioritizes cached data and never makes API calls
 * API calls are only allowed during background refresh (every 6 hours) or when adding new API keys
 * @param allowApiCalls - If false (default), never makes API calls - used for user navigation
 * @returns Promise that resolves to the recommended image source strategy
 */
export async function getImageSourceStrategy(allowApiCalls: boolean = false): Promise<{
  strategy: 'api' | 'cached' | 'fallback' | 'placeholder';
  reason: string;
}> {
  // PRIORITY 1: Always check cached images first (even if online with API keys)
  try {
    const { getValidImageCount } = await import('./db');
    const validImageCount = await getValidImageCount();
    
    if (validImageCount > 0) {
      return { 
        strategy: 'cached', 
        reason: `Using ${validImageCount} cached images (no network requests needed)` 
      };
    }
  } catch (error) {
    console.error('Failed to check cached images:', error);
  }
  
  // PRIORITY 2: Check network status
  if (!navigator.onLine) {
    return { 
      strategy: 'placeholder', 
      reason: 'Offline with no cached images - using generated placeholder' 
    };
  }
  
  // PRIORITY 3: Only consider API calls if explicitly allowed (background refresh only)
  if (allowApiCalls && !(await shouldUseFallbackImages())) {
    return { 
      strategy: 'api', 
      reason: 'Background refresh: API access available' 
    };
  }
  
  // PRIORITY 4: Use fallback URLs if online but no API access or API calls not allowed
  return { 
    strategy: 'fallback', 
    reason: allowApiCalls 
      ? 'Background refresh: API keys missing or rate limited' 
      : 'User interaction: Using fallback URLs (no API calls for navigation)'
  };
}

/**
 * Checks if any API service is currently rate limited
 * @param apiLimits - Object containing rate limit data for each service
 * @returns True if any service is rate limited, false otherwise
 */
function checkRateLimits(apiLimits: any): boolean {
  const now = Date.now();
  const hourInMs = 60 * 60 * 1000;
  
  // Check Unsplash rate limits (1000 requests per hour)
  if (apiLimits.unsplash) {
    const unsplashHourlyRequests = apiLimits.unsplash.requests || 0;
    const lastUnsplashReset = apiLimits.unsplash.lastReset || 0;
    
    if (now - lastUnsplashReset < hourInMs && unsplashHourlyRequests >= 1000) {
      console.warn("Unsplash rate limit reached, using fallback images");
      return true;
    }
  }
  
  // Check Pexels rate limits (200 requests per hour for free tier)
  if (apiLimits.pexels) {
    const pexelsHourlyRequests = apiLimits.pexels.requests || 0;
    const lastPexelsReset = apiLimits.pexels.lastReset || 0;
    
    if (now - lastPexelsReset < hourInMs && pexelsHourlyRequests >= 200) {
      console.warn("Pexels rate limit reached, using fallback images");
      return true;
    }
  }
  
  return false;
}

/**
 * Records an API request for rate limiting purposes
 * Updates the request count and resets counters when necessary
 * @param service - The API service name ('unsplash' or 'pexels')
 */
export async function recordApiRequest(service: 'unsplash' | 'pexels'): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiLimits"], (result: any) => {
      const apiLimits = result.apiLimits || {};
      const now = Date.now();
      const hourInMs = 60 * 60 * 1000;
      
      if (!apiLimits[service]) {
        apiLimits[service] = { requests: 0, lastReset: now };
      }
      
      // Reset counter if an hour has passed
      if (now - apiLimits[service].lastReset >= hourInMs) {
        apiLimits[service] = { requests: 0, lastReset: now };
      }
      
      // Increment request count
      apiLimits[service].requests += 1;
      
      chrome.storage.local.set({ apiLimits }, () => {
        resolve();
      });
    });
  });
}

/**
 * Gets current API usage statistics for monitoring
 * @returns Promise that resolves to usage statistics for each service
 */
export async function getApiUsageStats(): Promise<{
  unsplash: { requests: number; remaining: number; resetTime: number };
  pexels: { requests: number; remaining: number; resetTime: number };
}> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiLimits"], (result: any) => {
      const apiLimits = result.apiLimits || {};
      const now = Date.now();
      const hourInMs = 60 * 60 * 1000;
      
      const unsplashData = apiLimits.unsplash || { requests: 0, lastReset: now };
      const pexelsData = apiLimits.pexels || { requests: 0, lastReset: now };
      
      resolve({
        unsplash: {
          requests: unsplashData.requests,
          remaining: Math.max(0, 1000 - unsplashData.requests),
          resetTime: unsplashData.lastReset + hourInMs,
        },
        pexels: {
          requests: pexelsData.requests,
          remaining: Math.max(0, 200 - pexelsData.requests),
          resetTime: pexelsData.lastReset + hourInMs,
        },
      });
    });
  });
}

/**
 * Enhanced fallback system with intelligent image source selection
 * **USER INTERACTION VERSION**: Never makes API calls - only uses cached and fallback images
 * **BACKGROUND REFRESH VERSION**: Can make API calls when explicitly allowed
 * 
 * Priority order:
 * 1. Valid cached images from IndexedDB (always checked first)
 * 2. API calls (only if allowApiCalls=true, for background refresh)
 * 3. Fallback image URLs (downloaded from network)
 * 4. Offline placeholder (generated locally)
 * 
 * @param allowApiCalls - If true, allows API calls (for background refresh only)
 * @returns Promise that resolves to array of available images (never empty)
 */
export async function getImagesWithFallback(allowApiCalls: boolean = false): Promise<DbImageData[]> {
  const strategy = await getImageSourceStrategy(allowApiCalls);
  console.log(`🎯 Image source strategy: ${strategy.strategy} - ${strategy.reason}`);
  
  try {
    switch (strategy.strategy) {
      case 'cached':
        // PRIORITY 1: Always try cached images first
        try {
          const { getAllValidImages } = await import('./db');
          const cachedImages = await getAllValidImages();
          if (cachedImages.length > 0) {
            console.log(`✅ Using ${cachedImages.length} cached images (no network requests)`);
            return cachedImages;
          }
          console.log('📭 No cached images available, falling back...');
        } catch (error) {
          console.error('❌ Cache access failed:', error);
        }
        // Fall through to next strategy
        
      case 'api':
        // PRIORITY 2: API calls (only allowed during background refresh)
        if (allowApiCalls) {
          try {
            const { fetchAllImages } = await import('./api');
            const apiImages = await fetchAllImages();
            if (apiImages.length > 0) {
              console.log(`📥 Background refresh: Downloaded ${apiImages.length} images from APIs`);
              return apiImages as unknown as DbImageData[];
            }
            console.warn('⚠️ API returned no images, falling back to fallback URLs');
          } catch (error) {
            console.error('❌ API call failed during background refresh:', error);
          }
        } else {
          console.log('🚫 API calls not allowed for user interactions, using fallback URLs');
        }
        // Fall through to fallback URLs
        
      case 'fallback':
        // PRIORITY 3: Fallback image URLs
        try {
          const fallbackImages = await getFallbackImages();
          if (fallbackImages.length > 0) {
            console.log(`🎯 Using ${fallbackImages.length} fallback images from URLs`);
            return fallbackImages;
          }
          console.warn('⚠️ Fallback images failed, generating offline placeholder');
        } catch (error) {
          console.error('❌ Fallback images failed:', error);
        }
        // Fall through to placeholder
        
      case 'placeholder':
      default:
        // PRIORITY 4: Generated offline placeholder (never fails)
        console.log('🎨 Generating offline placeholder image');
        const placeholder = await generateOfflinePlaceholder();
        return [placeholder];
    }
  } catch (error) {
    console.error('All image sources failed, generating emergency placeholder:', error);
    // Emergency fallback - should never fail
    try {
      const placeholder = await generateOfflinePlaceholder();
      return [placeholder];
    } catch (placeholderError) {
      console.error('Even placeholder generation failed:', placeholderError);
      // Return a minimal fallback
      const now = Date.now();
      const permanentCache = await isPermanentCacheEnabled();
      const expiresAt = permanentCache 
        ? now + PERMANENT_CACHE_EXPIRY_MS 
        : now + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000;
      
      return [{
        id: 'emergency_fallback',
        url: '',
        blob: new Blob([''], { type: 'image/png' }),
        source: 'other' as const,
        downloadUrl: '',
        author: 'System',
        authorUrl: '',
        timestamp: now,
        expiresAt,
      }];
    }
  }
}
