/**
 * Background script for the Random Wallpaper Browser Extension
 *
 *  This script runs in a service worker context and manages background tasks such as:
 *  - Periodic image refreshing via alarms
 *  - Responding to messages from other contexts (new tab page, popup, options)
 */

import {
  ALARM_NAME,
  IMMEDIATE_FETCH_COOLDOWN_MS,
  REFRESH_INTERVAL_HOURS,
  DEFAULT_CONFIG,
  LogLevel,
} from "./config";
import { initDB, getLastFetchTime } from "./db";
import { Logger } from "./logger";
import { getSettings } from "./storage";
import {
  backgroundState,
  refreshImages,
  shouldRefreshImages,
  getCurrentImageId,
  setCurrentImageId,
} from "./backgroundLogic";

const background_logger = new Logger("Service Worker");

// Apply user-configured log level (if any) for the background context.
// This runs early so background logs are filtered according to the user's
// preference immediately after startup.
getSettings()
  .then((settings) => {
    const level = (settings.logging?.level ?? DEFAULT_CONFIG.level) as LogLevel;
    Logger.setGlobalLevel(level);
    background_logger.debug(`Applied log level from settings: ${level}`);
  })
  .catch((error) => {
    background_logger.warn("Unable to load settings for log level:", error);
  });

background_logger.debug("Background script at your service.");

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

// Sync current image change notifications to all connected contexts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.currentImageId?.newValue) {
    const imageId = changes.currentImageId.newValue;
    if (typeof imageId === "string") {
      setCurrentImageId(imageId);
      chrome.runtime.sendMessage({
        action: "currentImageUpdated",
        imageId,
      });
    }
  }
});

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
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void,
  ): boolean => {
    background_logger.debug(`Received message: ${message.action}`);
    background_logger.debug(`from sender: ${sender.tab?.url || "extension"}`);
    backgroundState.messageCount++;

    try {
      // Handle current image update broadcast
      if (message.action === "currentImageUpdated") {
        const imageId = (message as any).imageId;
        if (typeof imageId === "string") {
          setCurrentImageId(imageId);
          background_logger.debug("Updated current image id via message", {
            imageId,
          });
        }
        sendResponse({ success: true });
        return false;
      }

      // Provide current image id on request
      if (message.action === "getCurrentImageId") {
        sendResponse({
          success: true,
          imageId: getCurrentImageId(),
        });
        return false;
      }

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
        background_logger.debug("Checking if refresh is needed");

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
                sendResponse({
                  success: true,
                  triggered: true,
                  message: "Cache was stale, refreshed automatically",
                });
              } catch (error: any) {
                background_logger.error("Opportunistic refresh failed:", error);
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
      // This is fired when the options page saves settings and notifies the
      // background worker so it can apply them immediately (e.g. log level change).
      if (message.action === "settingsUpdated") {
        backgroundState.settingsUpdateCount++;

        // Apply any provided log level immediately
        if (typeof message.logLevel === "string") {
          const level = message.logLevel as LogLevel;
          Logger.setGlobalLevel(level);
          background_logger.info(`Log level updated to: ${level}`);
        }

        background_logger.info("Settings updated, will apply on next refresh");
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
