/**
 * Background Service Worker
 * Enhanced background script for periodic image fetching, caching, and settings management
 * Provides intelligent fallback handling, rate limiting awareness, and comprehensive error recovery
 */

import { fetchAllImages } from "./content/api.js";
import {
  storeImages,
  getLastFetchTime,
  setLastFetchTime,
  cleanExpiredImages,
  initDB,
  getAllValidImages,
  getDatabaseStats,
  getValidImageCount,
  setAllImagesToPermanentCache,
} from "./content/db.js";
import {
  getFallbackImages,
  getImagesWithFallback,
  getImageSourceStrategy,
} from "./content/fallback.js";
import {
  REFRESH_INTERVAL_HOURS,
  REFRESH_INTERVAL_MS,
  ALARM_NAME,
  IMMEDIATE_FETCH_COOLDOWN_MS,
} from "./config/constants.js";

/**
 * Interface for tracking background service worker operational state and statistics
 * Provides comprehensive monitoring of fetch operations, message handling, and performance metrics
 */
interface BackgroundState {
  /** Timestamp of when the service worker started */
  startTime: number;
  /** Timestamp of last successful image refresh */
  lastRefresh: number | null;
  /** Timestamp of last manual fetch (for rate limiting) */
  lastManualFetch: number;
  /** Total number of failed fetch attempts */
  failedFetches: number;
  /** Total number of successful fetch operations */
  successfulFetches: number;
  /** Total number of messages received */
  messageCount: number;
  /** Number of manual refresh requests */
  manualRefreshCount: number;
  /** Number of opportunistic refreshes triggered */
  opportunisticRefreshCount: number;
  /** Number of settings update notifications */
  settingsUpdateCount: number;
  /** Number of API key update notifications */
  apiKeyUpdateCount: number;
  /** Whether a fetch operation is currently in progress */
  isFetching: boolean;
}

/**
 * Global background state for tracking operational metrics and preventing concurrent operations
 * Provides comprehensive monitoring and coordination of background service worker activities
 */
const backgroundState: BackgroundState = {
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
};

/**
 * Checks if it's time to refresh images based on configured interval
 * Uses enhanced timestamp validation and provides detailed logging
 * @returns Promise resolving to true if refresh is needed, false otherwise
 */
async function shouldRefreshImages(): Promise<boolean> {
  try {
    const lastFetch = await getLastFetchTime();

    if (lastFetch === null) {
      console.log("🔄 No previous fetch detected - initial refresh required");
      return true;
    }

    const timeSinceLastFetch = Date.now() - lastFetch;
    const hoursAgo = Math.round(timeSinceLastFetch / (1000 * 60 * 60));
    const shouldRefresh = timeSinceLastFetch >= REFRESH_INTERVAL_MS;

    if (shouldRefresh) {
      console.log(
        `⏰ Refresh needed - last fetch was ${hoursAgo} hours ago (threshold: ${REFRESH_INTERVAL_HOURS} hours)`
      );
    } else {
      console.log(`✅ Images are fresh - last fetched ${hoursAgo} hours ago`);
    }

    return shouldRefresh;
  } catch (error) {
    console.error("❌ Error checking refresh status:", error);
    return true; // Default to refresh on error
  }
}

/**
 * Fetches and caches new images using enhanced fallback system
 * Provides comprehensive error handling, performance monitoring, and intelligent fallback
 * Integrates with rate limiting and API usage tracking for optimal resource management
 */
async function refreshImages(): Promise<void> {
  // Prevent concurrent fetch operations
  if (backgroundState.isFetching) {
    console.log("🔄 Fetch operation already in progress, skipping...");
    return;
  }

  backgroundState.isFetching = true;
  const startTime = Date.now();

  console.log("🚀 Starting enhanced image refresh...");
  console.log("⬇️ Downloading images as blobs for offline support...");

  try {
    // Step 1: Check cache settings and handle permanent cache mode
    console.log("🔍 Checking cache settings...");
    const settings = await new Promise<any>((resolve) => {
      chrome.storage.local.get(['settings'], (result) => {
        resolve(result.settings || {});
      });
    });

    const permanentCacheEnabled = settings.cache?.permanentMode ?? false;
    
    if (permanentCacheEnabled) {
      console.log("🔒 Permanent cache mode enabled - updating all images to permanent expiry...");
      const updatedCount = await setAllImagesToPermanentCache();
      console.log(`✅ Updated ${updatedCount} images to permanent cache expiry`);
    }

    // Step 2: Clean expired images (will only delete if expiry dates are in the past)
    console.log("🧹 Cleaning expired images...");
    const deletedCount = await cleanExpiredImages();
    if (deletedCount > 0) {
      console.log(`✅ Cleaned ${deletedCount} expired images`);
    } else {
      console.log("✅ No expired images to clean");
    }

    // Step 2: Get current database statistics for monitoring
    const dbStats = await getDatabaseStats();
    console.log(
      `📊 Database stats - Total: ${dbStats.totalImages}, Valid: ${dbStats.validImages}, Expired: ${dbStats.expiredImages}`
    );

    // Step 3: Use enhanced fallback system for intelligent image selection
    console.log(
      "🤖 Using enhanced fallback system for optimal image selection..."
    );
    const strategy = await getImageSourceStrategy();
    console.log(
      `📋 Image source strategy: ${strategy.strategy} (reason: ${strategy.reason})`
    );

    let images: any[] = [];

    if (strategy.strategy === "placeholder") {
      console.log("🔌 Offline mode detected, generating placeholder...");
      // This will be handled by the enhanced fallback system
      images = await getImagesWithFallback(true); // Background refresh allows API calls
    } else if (strategy.strategy === "fallback") {
      console.log("🎨 Using fallback images (no API keys configured)...");
      images = await getImagesWithFallback(true); // Background refresh allows API calls
    } else {
      // Strategy recommends API usage or cached images
      console.log("🌐 Fetching from configured APIs with rate limiting...");

      try {
        images = await fetchAllImages();
        console.log(
          `📥 Successfully downloaded ${images.length} images from APIs`
        );

        // Track successful API usage
        backgroundState.successfulFetches++;
      } catch (apiError) {
        console.warn(
          "⚠️ API fetch failed, falling back to enhanced fallback system:",
          apiError
        );
        backgroundState.failedFetches++;

        // Use enhanced fallback system which handles rate limits and cache intelligently
        images = await getImagesWithFallback(true); // Background refresh allows API calls
        console.log(`🎯 Enhanced fallback provided ${images.length} images`);
      }
    }

    // Step 4: Validate and store images
    if (images.length > 0) {
      console.log(`💾 Storing ${images.length} images in IndexedDB...`);
      await storeImages(images);

      // Update last fetch time and track successful refresh
      const now = Date.now();
      await setLastFetchTime(now);
      backgroundState.lastRefresh = now;

      const duration = now - startTime;
      console.log(
        `✅ Successfully cached ${images.length} images in ${duration}ms`
      );

      // Log performance metrics
      const validCount = await getValidImageCount();
      console.log(`📈 Cache now contains ${validCount} valid images`);
    } else {
      console.warn("❌ No images were obtained from any source");
      backgroundState.failedFetches++;

      // Check if we have existing cache to fall back to
      const existingImages = await getAllValidImages();
      if (existingImages.length > 0) {
        console.log(
          `💡 Keeping ${existingImages.length} existing cached images`
        );
      } else {
        console.error(
          "🚨 No images available - cache is empty and no fallback succeeded"
        );
      }
    }
  } catch (error) {
    console.error("💥 Critical error during image refresh:", error);
    backgroundState.failedFetches++;

    // Emergency fallback: ensure we have at least some images
    try {
      const existingImages = await getAllValidImages();
      if (existingImages.length === 0) {
        console.log("🆘 Emergency fallback: loading default images...");
        const emergencyImages = await getFallbackImages();
        if (emergencyImages.length > 0) {
          await storeImages(emergencyImages);
          await setLastFetchTime(Date.now());
          console.log(
            `🩹 Emergency fallback complete: ${emergencyImages.length} images cached`
          );
        }
      }
    } catch (emergencyError) {
      console.error("🔥 Emergency fallback failed:", emergencyError);
    }
  } finally {
    backgroundState.isFetching = false;
    const totalDuration = Date.now() - startTime;
    console.log(`⏱️ Image refresh completed in ${totalDuration}ms`);

    // Log operational statistics
    console.log(
      `📊 Session stats - Successful fetches: ${backgroundState.successfulFetches}, Failed: ${backgroundState.failedFetches}`
    );
  }
}

/**
 * Sets up periodic alarm for automatic image refresh
 * Configures Chrome alarm API to trigger image refresh at specified intervals
 * Includes enhanced logging and error handling for alarm management
 */
function setupRefreshAlarm(): void {
  try {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: REFRESH_INTERVAL_HOURS * 60,
    });
    console.log(
      `⏰ Refresh alarm configured: every ${REFRESH_INTERVAL_HOURS} hours (${
        REFRESH_INTERVAL_HOURS * 60
      } minutes)`
    );
    console.log(
      `🎯 Next alarm will trigger at: ${new Date(
        Date.now() + REFRESH_INTERVAL_HOURS * 60 * 60 * 1000
      ).toLocaleString()}`
    );
  } catch (error) {
    console.error("❌ Failed to setup refresh alarm:", error);
  }
}

/**
 * Handles alarm events with enhanced logging and error recovery
 * Processes periodic refresh alarms and provides detailed status reporting
 * @param alarm - Chrome alarm object containing alarm details
 */
function handleAlarmEvent(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === ALARM_NAME) {
    console.log("⏰ Scheduled alarm triggered - initiating image refresh");
    console.log(`📅 Alarm fired at: ${new Date().toLocaleString()}`);

    refreshImages()
      .then(() => {
        console.log("✅ Scheduled refresh completed successfully");
      })
      .catch((error) => {
        console.error("❌ Scheduled refresh failed:", error);
        backgroundState.failedFetches++;
      });
  } else {
    console.warn(`⚠️ Unknown alarm received: ${alarm.name}`);
  }
}

// Register alarm event listener
chrome.alarms.onAlarm.addListener(handleAlarmEvent);

/**
 * Enhanced initialization on extension install or update
 * Provides comprehensive setup with detailed logging and error handling
 * Includes database initialization, alarm setup, and initial fetch logic
 * @param details - Chrome runtime installation details
 */
async function handleExtensionInstall(
  details: chrome.runtime.InstalledDetails
): Promise<void> {
  console.log("🚀 Extension installed/updated:", details.reason);
  console.log(`📦 Extension version: ${chrome.runtime.getManifest().version}`);

  try {
    // Initialize database with error handling
    console.log("🗄️ Initializing IndexedDB database...");
    await initDB();
    console.log("✅ Database initialized successfully");

    // Set up alarm system
    console.log("⏰ Setting up refresh alarm...");
    setupRefreshAlarm();

    // Check if initial fetch is needed
    const needsRefresh = await shouldRefreshImages();
    if (needsRefresh) {
      console.log("🔄 Performing initial image fetch...");
      await refreshImages();
    } else {
      const lastFetch = await getLastFetchTime();
      if (lastFetch) {
        const hoursAgo = Math.round(
          (Date.now() - lastFetch) / (1000 * 60 * 60)
        );
        console.log(
          `✅ Images are already fresh (fetched ${hoursAgo} hours ago)`
        );
      }
    }

    console.log("🎉 Extension initialization completed successfully");
  } catch (error) {
    console.error("💥 Extension initialization failed:", error);
    backgroundState.failedFetches++;
  }
}

// Register extension installation event listener
chrome.runtime.onInstalled.addListener(handleExtensionInstall);

/**
 * Check on startup (service worker wake)
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log("Service worker started");

  // Initialize database
  await initDB();

  // Ensure alarm is set
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    console.log("Alarm not found, recreating...");
    setupRefreshAlarm();
  }

  // Check if we need to refresh
  if (await shouldRefreshImages()) {
    console.log("Time to refresh images (last fetch was over 6 hours ago)");
    await refreshImages();
  } else {
    const lastFetch = await getLastFetchTime();
    if (lastFetch) {
      const hoursAgo = Math.floor((Date.now() - lastFetch) / (1000 * 60 * 60));
      console.log(`Images are fresh (last fetched ${hoursAgo} hours ago)`);
    }
  }
});

/**
 * Enhanced runtime message handler with comprehensive error handling and state tracking
 * Handles various action types including refresh requests, status checks, and API key updates
 * Provides detailed logging and response feedback for debugging and monitoring
 * @param message - Message object containing action and optional payload
 * @param sender - Information about the message sender (unused but kept for compatibility)
 * @param sendResponse - Function to send response back to sender
 * @returns boolean indicating whether response will be sent asynchronously
 */
chrome.runtime.onMessage.addListener(
  (
    message: { action: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void
  ): boolean => {
    console.log(
      "📨 Received message:",
      message,
      "from sender:",
      _sender.tab?.url || "extension"
    );
    backgroundState.messageCount++;

    try {
      // Handle force refresh request
      if (message.action === "forceRefresh") {
        console.log("🔄 Force refresh requested");
        backgroundState.manualRefreshCount++;

        refreshImages()
          .then(() => {
            console.log("✅ Force refresh completed successfully");
            sendResponse({
              success: true,
              message: "Images force refreshed successfully",
            });
          })
          .catch((error) => {
            console.error("❌ Force refresh failed:", error);
            backgroundState.failedFetches++;
            sendResponse({
              success: false,
              error: error.message || "Failed to force refresh images",
            });
          });
        return true; // Keep channel open for async response
      }

      // Handle refresh status check
      if (message.action === "checkRefreshStatus") {
        console.log("📊 Refresh status check requested");

        getLastFetchTime()
          .then((lastFetch) => {
            const hoursAgo = lastFetch
              ? Math.floor((Date.now() - lastFetch) / (1000 * 60 * 60))
              : null;
            console.log(
              `📅 Last fetch: ${
                lastFetch ? new Date(lastFetch).toLocaleString() : "never"
              }`
            );

            sendResponse({
              success: true,
              lastFetch,
              hoursAgo,
              formattedTime: lastFetch
                ? new Date(lastFetch).toLocaleString()
                : "Never",
            });
          })
          .catch((error) => {
            console.error("❌ Failed to check refresh status:", error);
            sendResponse({ success: false, error: error.message });
          });
        return true; // Keep channel open for async response
      }

      // Handle refresh needed check with opportunistic refresh
      if (message.action === "checkRefreshNeeded") {
        console.log(
          "🔍 Checking if refresh is needed (triggered from page)..."
        );

        shouldRefreshImages()
          .then((needsRefresh) => {
            if (needsRefresh) {
              console.log(
                "⚠️ Refresh is overdue! Triggering opportunistic refresh..."
              );
              backgroundState.opportunisticRefreshCount++;

              refreshImages()
                .then(() => {
                  console.log(
                    "✅ Opportunistic refresh completed successfully"
                  );
                  sendResponse({
                    success: true,
                    refreshed: true,
                    message: "Cache was stale, refreshed automatically",
                  });
                })
                .catch((error) => {
                  console.error("❌ Opportunistic refresh failed:", error);
                  backgroundState.failedFetches++;
                  sendResponse({
                    success: false,
                    refreshed: false,
                    error: error.message || "Opportunistic refresh failed",
                  });
                });
            } else {
              console.log("✅ Cache is fresh, no refresh needed");
              sendResponse({
                success: true,
                refreshed: false,
                message: "Cache is fresh",
              });
            }
          })
          .catch((error) => {
            console.error("❌ Failed to check refresh status:", error);
            sendResponse({ success: false, error: error.message });
          });
        return true; // Keep channel open for async response
      }

      // Handle settings update notification
      if (message.action === "settingsUpdated") {
        console.log("⚙️ Settings updated, will apply on next refresh");
        backgroundState.settingsUpdateCount++;
        sendResponse({
          success: true,
          message: "Settings will be applied on next refresh",
        });
        return false;
      }

      // Handle API key update notification with cooldown protection
      if (message.action === "apiKeysUpdated") {
        console.log("🔑 API keys updated, checking cooldown...");

        const now = Date.now();
        const timeSinceLastManualFetch = now - backgroundState.lastManualFetch;

        // Prevent spam: 10-second cooldown for API-triggered fetches
        if (timeSinceLastManualFetch < IMMEDIATE_FETCH_COOLDOWN_MS) {
          const remainingCooldown = Math.ceil(
            (IMMEDIATE_FETCH_COOLDOWN_MS - timeSinceLastManualFetch) / 1000
          );
          console.log(`⏳ Cooldown active. Please wait ${remainingCooldown}s`);
          sendResponse({
            success: false,
            error: `Please wait ${remainingCooldown} seconds before fetching again`,
            cooldownRemaining: remainingCooldown,
          });
          return false;
        }

        backgroundState.lastManualFetch = now;
        backgroundState.apiKeyUpdateCount++;
        console.log("🚀 Fetching images immediately after API key update...");

        refreshImages()
          .then(() => {
            console.log("✅ API key triggered refresh completed successfully");
            sendResponse({
              success: true,
              message: "Images refreshed successfully with new API keys",
            });
          })
          .catch((error) => {
            console.error("❌ API key triggered refresh failed:", error);
            backgroundState.failedFetches++;
            sendResponse({
              success: false,
              error:
                error.message || "Failed to refresh images with new API keys",
            });
          });
        return true; // Keep channel open for async response
      }

      // Handle requests for background statistics
      if (message.action === "getBackgroundStats") {
        console.log("📊 Background statistics requested");
        const uptime = Date.now() - backgroundState.startTime;
        const stats = {
          ...backgroundState,
          uptime,
          uptimeFormatted: formatDuration(uptime),
          lastActivity:
            backgroundState.lastRefresh || backgroundState.startTime,
        };
        sendResponse({ success: true, stats });
        return false;
      }

      // Handle force refresh cache requests (ignores permanent cache setting)
      if (message.action === "forceRefreshCache") {
        console.log("🔄 Force refresh cache requested");
        
        // Force refresh ignores permanent cache setting and always fetches new images
        refreshImages()
          .then(() => {
            sendResponse({ success: true });
          })
          .catch((error) => {
            console.error("❌ Force refresh failed:", error);
            sendResponse({ success: false, error: "Failed to refresh cache" });
          });
        
        return true; // Async response
      }

      // Handle unknown message actions
      console.warn("⚠️ Unknown message action:", message.action);
      sendResponse({
        success: false,
        error: `Unknown action: ${message.action}`,
      });
      return false;
    } catch (error) {
      console.error("💥 Message handler error:", error);
      backgroundState.failedFetches++;
      sendResponse({
        success: false,
        error: "Internal error processing message",
      });
      return false;
    }
  }
);

/**
 * Formats duration in milliseconds to human-readable string
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Log successful background service worker initialization
console.log("🚀 Background service worker loaded and ready");
console.log(`📦 Extension version: ${chrome.runtime.getManifest().version}`);
console.log(`⏰ Service worker started at: ${new Date().toLocaleString()}`);
console.log(
  "🎯 Event listeners registered for alarms, installation, and messages"
);
