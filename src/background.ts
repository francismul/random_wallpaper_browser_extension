/**
 * Background Service Worker
 * Enhanced background script for periodic image fetching, caching, and settings management
 * Provides intelligent fallback handling, rate limiting awareness, and comprehensive error recovery
 */

import { fetchAllImages } from "./api";
import {
  cleanExpiredImages,
  getLastFetchTime,
  getStorageInfo,
  getValidImageCount,
  initDB,
  setLastFetchTime,
  storeImages,
} from "./db";
import { getFallbackImages } from "./fallback";
import {
  ALARM_NAME,
  DEFAULT_BACKGROUND_STATE,
  IMMEDIATE_FETCH_COOLDOWN_MS,
  MIN_STORAGE_THRESHOLD_GB,
  REFRESH_INTERVAL_HOURS,
  REFRESH_INTERVAL_MS,
} from "./config";
import { Logger } from "./logger";
import { getSettings } from "./storage";
import { areApiKeysConfigured } from "./utils";

const background_logger = new Logger("Service worker");

background_logger.debug("Background script at your service. 🫡");

const backgroundState = DEFAULT_BACKGROUND_STATE;

/**
 * Checks if it's time to refresh images based on configured interval
 * Uses enhanced timestamp validation and provides detailed logging
 * @returns Promise resolving to true if refresh is needed, false otherwise
 */
async function shouldRefreshImages(): Promise<boolean> {
  try {
    const lastFetch = await getLastFetchTime();

    if (lastFetch === null) {
      background_logger.info(
        "No previous fetch detected - initial refresh required",
      );
      return true;
    }

    const timeSinceLastFetch = Date.now() - lastFetch;
    const hoursAgo = Math.round(timeSinceLastFetch / (1000 * 60 * 60));
    const shouldRefresh = timeSinceLastFetch >= REFRESH_INTERVAL_MS;

    if (shouldRefresh) {
      background_logger.info(
        `Refresh needed - last fetch was ${hoursAgo} hours ago (threshold: ${REFRESH_INTERVAL_HOURS} hours)`,
      );
    } else {
      background_logger.debug(
        `Images are fresh - last fetched ${hoursAgo} hours ago`,
      );
    }

    return shouldRefresh;
  } catch (error) {
    background_logger.error("Error checking refresh status:", error);
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
    background_logger.warn("Fetch operation already in progress, skipping...");
    return;
  }

  backgroundState.isFetching = true;
  const startTime = Date.now();

  try {
    // Step 0: Check available storage space
    background_logger.debug("Checking available storage space...");
    try {
      const storageInfo = await getStorageInfo();
      const availableGB = (
        storageInfo.available /
        (1024 * 1024 * 1024)
      ).toFixed(2);
      background_logger.info(
        `Storage - Available: ${availableGB}GB, Used: ${storageInfo.percentUsed.toFixed(1)}%`,
      );

      if (!storageInfo.hasEnoughSpace) {
        background_logger.warn(
          `Low storage space (${availableGB}GB available). Minimum ${MIN_STORAGE_THRESHOLD_GB}GB required.`,
        );
        background_logger.warn(
          "Skipping image fetch to prevent storage issues.",
        );
        backgroundState.isFetching = false;
        return;
      }
      background_logger.debug(
        `Sufficient storage space available (${availableGB}GB)`,
      );
    } catch (storageError) {
      background_logger.warn("Could not check storage space:", storageError);
      background_logger.debug(
        "Continuing with fetch (storage API not supported)...",
      );
    }

    // Step 1: Check cache settings and handle permanent cache mode
    background_logger.debug(
      "Checking cache settings if permanent cache mode is enabled...",
    );
    const settings = await getSettings();
    const permanentCacheEnabled = settings.cache?.permanentMode;

    if (!permanentCacheEnabled) {
      background_logger.debug("Permanent cache mode not enabled");
      background_logger.debug("Can perform cleaning of expired images...");
      const deletedCount = await cleanExpiredImages();
      if (deletedCount > 0) {
        background_logger.info(`Cleaned ${deletedCount} expired images`);
      } else {
        background_logger.debug("No expired images to clean");
      }
    } else {
      background_logger.debug(
        "Skipping image cleanup, permanent cache mode is on",
      );
    }

    // Fetch images
    background_logger.debug(
      "Checking if api keys are available for images update",
    );

    const apisPresent = await areApiKeysConfigured(settings);

    if (!apisPresent) {
      background_logger.debug("No apis keys present, skipping image fetching");
    } else {
      background_logger.info("Fetching from configured APIs");

      try {
        const images = await fetchAllImages(settings);
        if (images.length <= 0) {
          background_logger.warn("Zero images downloaded");
          backgroundState.failedFetches++;
        } else {
          background_logger.info(
            `Successfully downloaded ${images.length} images from APIs`,
          );
          backgroundState.successfulFetches++;

          background_logger.info(
            `Storing ${images.length} images in IndexedDB...`,
          );
          await storeImages(images);
          const now = Date.now();
          await setLastFetchTime(now);
          backgroundState.lastRefresh = now;

          const duration = now - startTime;
          background_logger.info(
            `Successfully cached ${images.length} images in ${duration}ms`,
          );
        }
      } catch (error) {
        background_logger.warn(
          "API fetch failed, falling back to enhanced fallback system:",
          error,
        );
        backgroundState.failedFetches++;
      }
    }
  } catch (error) {
    background_logger.error("Critical error during image refresh:", error);
    backgroundState.failedFetches++;

    // Emergency fallback: ensure we have at least some images
    try {
      const existingImages = await getValidImageCount();
      if (existingImages <= 0) {
        background_logger.info(
          "Trying to download some default emergency images",
        );
        const fallbackImages = await getFallbackImages();
        if (fallbackImages && fallbackImages.length > 0) {
          background_logger.info(
            `Storing ${fallbackImages.length} emergency fallback images in IndexedDB...`,
          );
          await storeImages(fallbackImages);
          const now = Date.now();
          await setLastFetchTime(now);
          backgroundState.lastRefresh = now;
          background_logger.info(
            `Successfully cached ${fallbackImages.length} emergency fallback images`,
          );
        } else {
          background_logger.warn(
            "Emergency fallback did not provide any images to cache",
          );
        }
      }
    } catch (emergencyError) {
      background_logger.error("Emergency fallback failed:", emergencyError);
    }
  } finally {
    backgroundState.isFetching = false;
    const totalDuration = Date.now() - startTime;
    background_logger.debug(`Image refresh completed in ${totalDuration}ms`);

    // Log operational statistics
    background_logger.info(
      `Session stats - Successful fetches: ${backgroundState.successfulFetches}, Failed: ${backgroundState.failedFetches}`,
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
    background_logger.info(
      `Refresh alarm configured: every ${REFRESH_INTERVAL_HOURS} hours (${
        REFRESH_INTERVAL_HOURS * 60
      } minutes)`,
    );
    background_logger.debug(
      `Next alarm will trigger at: ${new Date(
        Date.now() + REFRESH_INTERVAL_HOURS * 60 * 60 * 1000,
      ).toLocaleString()}`,
    );
  } catch (error) {
    background_logger.error("Failed to setup refresh alarm:", error);
  }
}

/**
 * Handles alarm events with enhanced logging and error recovery
 * Processes periodic refresh alarms and provides detailed status reporting
 * @param alarm - Chrome alarm object containing alarm details
 */
function handleAlarmEvent(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === ALARM_NAME) {
    background_logger.info(
      "Scheduled alarm triggered - initiating image refresh",
    );
    background_logger.debug(`Alarm fired at: ${new Date().toLocaleString()}`);

    refreshImages()
      .then(() => {
        background_logger.info("Scheduled refresh completed successfully");
      })
      .catch((error) => {
        background_logger.error("Scheduled refresh failed:", error);
        backgroundState.failedFetches++;
      });
  } else {
    background_logger.warn(`Unknown alarm received: ${alarm.name}`);
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
  details: chrome.runtime.InstalledDetails,
): Promise<void> {
  background_logger.info("Extension installed/updated:", details.reason);

  try {
    // Initialize database with error handling
    background_logger.debug("Initializing IndexedDB database...");
    await initDB();
    background_logger.info("Database initialized successfully");

    // Set up alarm system
    background_logger.debug("Setting up refresh alarm...");
    setupRefreshAlarm();

    // Check if initial fetch is needed
    const needsRefresh = await shouldRefreshImages();
    if (needsRefresh) {
      background_logger.info("Performing initial image fetch...");
      await refreshImages();
    } else {
      const lastFetch = await getLastFetchTime();
      if (lastFetch) {
        const hoursAgo = Math.round(
          (Date.now() - lastFetch) / (1000 * 60 * 60),
        );
        background_logger.info(
          `Images are already fresh (fetched ${hoursAgo} hours ago)`,
        );
      }
    }

    background_logger.info("Extension initialization completed successfully");
  } catch (error) {
    background_logger.error("Extension initialization failed:", error);
    backgroundState.failedFetches++;
  }
}

// Register extension installation event listener
chrome.runtime.onInstalled.addListener(handleExtensionInstall);

/**
 * Check on startup (service worker wake)
 */
chrome.runtime.onStartup.addListener(async () => {
  background_logger.info("Service worker started");

  // Initialize database
  await initDB();

  // Ensure alarm is set
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    background_logger.warn("Alarm not found, recreating...");
    setupRefreshAlarm();
  }

  // Check if we need to refresh
  if (await shouldRefreshImages()) {
    background_logger.info(
      "Time to refresh images (last fetch was over 6 hours ago)",
    );
    await refreshImages();
  } else {
    const lastFetch = await getLastFetchTime();
    if (lastFetch) {
      const hoursAgo = Math.floor((Date.now() - lastFetch) / (1000 * 60 * 60));
      background_logger.info(
        `Images are fresh (last fetched ${hoursAgo} hours ago)`,
      );
    }
  }
});

/**
 * Enhanced runtime message handler with comprehensive error handling and state tracking
 * Handles various action types including refresh requests, status checks, and API key updates
 * Provides detailed logging and response feedback for debugging and monitoring
 * @param message - Message object containing action and optional payload
 * @param sender - Information about the message sender
 * @param sendResponse - Function to send response back to sender
 * @returns boolean indicating whether response will be sent asynchronously
 */
chrome.runtime.onMessage.addListener(
  (
    message: { action: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void,
  ): boolean => {
    background_logger.debug(
      "Received message:",
      message,
      "from sender:",
      sender.tab?.url || "extension",
    );
    backgroundState.messageCount++;

    try {
      // Handle force refresh request
      if (message.action === "forceRefresh") {
        background_logger.info("Force refresh requested");
        backgroundState.manualRefreshCount++;

        (async () => {
          try {
            await refreshImages();
            background_logger.info("Force refresh completed successfully");
            sendResponse({
              success: true,
              message: "Images force refreshed successfully",
            });
          } catch (error: any) {
            background_logger.error("Force refresh failed:", error);
            backgroundState.failedFetches++;
            sendResponse({
              success: false,
              error: error.message || "Failed to force refresh images",
            });
          }
        })();
        return true; // Keep channel open for async response
      }

      // Handle refresh status check
      if (message.action === "checkRefreshStatus") {
        background_logger.debug("Refresh status check requested");

        (async () => {
          try {
            const lastFetch = await getLastFetchTime();
            const hoursAgo = lastFetch
              ? Math.floor((Date.now() - lastFetch) / (1000 * 60 * 60))
              : null;
            background_logger.debug(
              `Last fetch: ${
                lastFetch ? new Date(lastFetch).toLocaleString() : "never"
              }`,
            );

            sendResponse({
              success: true,
              lastFetch,
              hoursAgo,
              formattedTime: lastFetch
                ? new Date(lastFetch).toLocaleString()
                : "Never",
            });
          } catch (error: any) {
            background_logger.error("Failed to check refresh status:", error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true; // Keep channel open for async response
      }

      // Handle refresh needed check with opportunistic refresh
      if (message.action === "checkRefreshNeeded") {
        background_logger.debug(
          "Checking if refresh is needed (triggered from page)...",
        );

        (async () => {
          try {
            const needsRefresh = await shouldRefreshImages();
            if (needsRefresh) {
              background_logger.info(
                "Refresh is overdue! Triggering opportunistic refresh...",
              );
              backgroundState.opportunisticRefreshCount++;

              try {
                await refreshImages();
                background_logger.info(
                  "Opportunistic refresh completed successfully",
                );
                sendResponse({
                  success: true,
                  triggered: true,
                  message: "Cache was stale, refreshed automatically",
                });
              } catch (error: any) {
                background_logger.error(
                  "Opportunistic refresh failed:",
                  error,
                );
                backgroundState.failedFetches++;
                sendResponse({
                  success: false,
                  triggered: false,
                  error: error.message || "Opportunistic refresh failed",
                });
              }
            } else {
              background_logger.debug("Cache is fresh, no refresh needed");
              sendResponse({
                success: true,
                triggered: false,
                message: "Cache is fresh",
              });
            }
          } catch (error: any) {
            background_logger.error("Failed to check refresh status:", error);
            sendResponse({ success: false, error: error.message });
          }
        })();
        return true; // Keep channel open for async response
      }

      // Handle settings update notification
      if (message.action === "settingsUpdated") {
        background_logger.info("Settings updated, will apply on next refresh");
        backgroundState.settingsUpdateCount++;
        sendResponse({
          success: true,
          message: "Settings will be applied on next refresh",
        });
        return false;
      }

      // Handle API key update notification with cooldown protection
      if (message.action === "apiKeysUpdated") {
        background_logger.info("API keys updated, checking cooldown...");

        const now = Date.now();
        const timeSinceLastManualFetch = now - backgroundState.lastManualFetch;

        // Prevent spam: 10-second cooldown for API-triggered fetches
        if (timeSinceLastManualFetch < IMMEDIATE_FETCH_COOLDOWN_MS) {
          const remainingCooldown = Math.ceil(
            (IMMEDIATE_FETCH_COOLDOWN_MS - timeSinceLastManualFetch) / 1000,
          );
          background_logger.warn(
            `Cooldown active. Please wait ${remainingCooldown}s`,
          );
          sendResponse({
            success: false,
            error: `Please wait ${remainingCooldown} seconds before fetching again`,
            cooldownRemaining: remainingCooldown,
          });
          return false;
        }

        backgroundState.lastManualFetch = now;
        backgroundState.apiKeyUpdateCount++;
        background_logger.info(
          "Fetching images immediately after API key update...",
        );

        (async () => {
          try {
            await refreshImages();
            background_logger.info(
              "API key triggered refresh completed successfully",
            );
            sendResponse({
              success: true,
              message: "Images refreshed successfully with new API keys",
            });
          } catch (error: any) {
            background_logger.error("API key triggered refresh failed:", error);
            backgroundState.failedFetches++;
            sendResponse({
              success: false,
              error:
                error.message || "Failed to refresh images with new API keys",
            });
          }
        })();
        return true; // Keep channel open for async response
      }

      // Handle requests for background statistics
      if (message.action === "getBackgroundStats") {
        background_logger.debug("Background statistics requested");
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
        background_logger.info("Force refresh cache requested");

        // Force refresh ignores permanent cache setting and always fetches new images
        // Use async IIFE to properly handle the response
        (async () => {
          try {
            await refreshImages();
            background_logger.info("Force refresh completed successfully");
            sendResponse({ success: true });
          } catch (error) {
            background_logger.error("Force refresh failed:", error);
            sendResponse({ success: false, error: "Failed to refresh cache" });
          }
        })();

        return true; // Keep message channel open for async response
      }

      // Handle unknown message actions
      background_logger.warn("Unknown message action:", message.action);
      sendResponse({
        success: false,
        error: `Unknown action: ${message.action}`,
      });
      return false;
    } catch (error) {
      background_logger.error("Message handler error:", error);
      backgroundState.failedFetches++;
      sendResponse({
        success: false,
        error: "Internal error processing message",
      });
      return false;
    }
  },
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
background_logger.info("Background service worker loaded and ready");
background_logger.info(
  `Extension version: ${chrome.runtime.getManifest().version}`,
);
background_logger.info(
  `Service worker started at: ${new Date().toLocaleString()}`,
);
background_logger.debug(
  "Event listeners registered for alarms, installation, and messages",
);
