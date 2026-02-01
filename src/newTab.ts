/**
 * New Tab Page Script
 * Handles image display, transitions, history navigation, clock, and auto-refresh
 * for the random wallpaper browser extension.
 */

import {
  addToHistory,
  getAllValidImages,
  getHistory,
  getHistoryImageById,
  getLastFetchTime,
  deleteImage,
  wasImageViewedRecently,
} from "./db";
import {
  REFRESH_INTERVAL_MS,
  ImageData,
  DEFAULT_HISTORY_ENABLED,
  DEFAULT_HISTORY_MAX_SIZE,
  DEFAULT_APP_STATE,
  TransitionType,
  DEFAULT_ENABLED_TRANSITIONS,
  HistoryEntry,
  Settings,
  DEFAULT_SETTINGS,
} from "./config";
import { Logger } from "./logger";
import { getSettings } from "./storage";
import { CanvasTransitionManager } from "./transitions";

const newTab_logger = new Logger("New Tab");

newTab_logger.debug("New Tab script loaded! 😒");

/**
 * DOM Elements - Cached for performance
 */
const wallpaperCanvas = document.getElementById(
  "wallpaperCanvas",
) as HTMLCanvasElement;
const loadingDiv = document.getElementById("loading") as HTMLElement;
const creditDiv = document.getElementById("credit") as HTMLElement;
const authorSpan = document.getElementById("author") as HTMLElement;
const sourceSpan = document.getElementById("source") as HTMLElement;
const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
const randomImageBtn = document.getElementById(
  "randomImageBtn",
) as HTMLButtonElement;

/**
 * Canvas transition manager
 */
let canvasTransitionManager: CanvasTransitionManager;
try {
  canvasTransitionManager = new CanvasTransitionManager(wallpaperCanvas);
} catch (error) {
  newTab_logger.error("Failed to initialize canvas transition manager:", error);
  throw error;
}

/**
 * History navigation elements
 */
const prevImageBtn = document.getElementById(
  "prevImageBtn",
) as HTMLButtonElement;
const nextImageBtn = document.getElementById(
  "nextImageBtn",
) as HTMLButtonElement;
const historyIndicator = document.getElementById(
  "historyIndicator",
) as HTMLElement;
const historyPosition = document.getElementById(
  "historyPosition",
) as HTMLElement;
const historyTotal = document.getElementById("historyTotal") as HTMLElement;

/**
 * Clock elements
 */
const clockContainer = document.getElementById("clockContainer") as HTMLElement;
const timeDisplay = document.getElementById("timeDisplay") as HTMLElement;
const dateDisplay = document.getElementById("dateDisplay") as HTMLElement;

/**
 * Application state management interface
 * Centralizes all global state variables for better maintainability
 */
const appState = DEFAULT_APP_STATE;

// Track all blob URLs to prevent memory leaks
const blobUrlCache = new Set<string>();

/**
 * Animation direction types for image transitions
 */
type AnimationDirection = "next" | "prev" | "fade";

/**
 * Get a random transition effect for general use
 * Uses all enabled transitions
 */
function getRandomTransition(
  enabledTransitions: TransitionType[],
): TransitionType {
  const validTransitions: TransitionType[] =
    enabledTransitions.length > 0
      ? enabledTransitions
      : DEFAULT_ENABLED_TRANSITIONS;
  const randomIndex = Math.floor(Math.random() * validTransitions.length);
  return validTransitions[randomIndex] as TransitionType;
}

/**
 * Displays an image with smooth canvas-based transitions
 * Handles credit information and history tracking
 * @param imageData - The image data to display
 * @param skipHistory - Whether to skip adding this image to history
 * @param animationDirection - Direction of transition animation
 * @throws Error if canvas transition fails
 */
async function displayImage(
  imageData: ImageData,
  skipHistory: boolean = false,
  animationDirection: AnimationDirection = "fade",
  settings: Settings,
): Promise<void> {
  try {
    // Store current image data for context menu download
    currentImageData = imageData;

    // Hide context menu when new image loads
    hideContextMenu();

    // Fade out credit during transition
    creditDiv.classList.remove("visible");

    newTab_logger.debug(`Animation Direction: ${animationDirection}`);
    newTab_logger.debug(`Skip History: ${skipHistory}`);

    // Get enabled transitions from settings
    const enabledTransitions =
      settings.transition?.enabledTransitions || DEFAULT_ENABLED_TRANSITIONS;

    newTab_logger.debug("Checking the enabled Transitions value:", {
      enabledTransitions,
    });

    // Select transition based on animation direction
    let transitionType: TransitionType;
    let direction: "left" | "right" | "up" | "down" = "right";

    if (animationDirection === "next") {
      // Going to older images - eliminate left-to-right transitions
      transitionType = getRandomTransition(enabledTransitions);
      direction = Math.random() > 0.5 ? "left" : "up";
      newTab_logger.debug("Next button ClIcked", { transitionType, direction });
    } else if (animationDirection === "prev") {
      // Going to newer images - eliminate right-to-left transitions
      transitionType = getRandomTransition(enabledTransitions);
      direction = Math.random() > 0.5 ? "right" : "down";
      newTab_logger.debug("Prev button ClIcked", { transitionType, direction });
    } else {
      // General transition - use all enabled transitions
      transitionType = getRandomTransition(enabledTransitions);
      // Randomly select any direction for initial load to add variety
      const directions: ("left" | "right" | "up" | "down")[] = [
        "left",
        "right",
        "up",
        "down",
      ];
      const randomIndex = Math.floor(Math.random() * directions.length);
      direction = directions[randomIndex]!;

      newTab_logger.debug("Not a button Event", transitionType, direction);
    }

    newTab_logger.debug(`Final Direction: ${direction}`);

    // Perform canvas transition
    await canvasTransitionManager.transition(imageData.blob, transitionType, {
      duration: 600,
      direction: direction,
    });

    // Update credit information
    updateCreditInfo(imageData);

    // Fade in credit after transition
    setTimeout(() => {
      creditDiv.classList.add("visible");
    }, 200);

    // Add to history if not skipping and viewing current image
    if (
      !skipHistory &&
      appState.currentHistoryIndex === -1 &&
      appState.historyEnabled
    ) {
      try {
        await addToHistory(
          imageData.id,
          imageData.source,
          appState.historyMaxSize,
        );
        await loadHistoryList();
        updateHistoryUI();
      } catch (error) {
        newTab_logger.error("Failed to add to history:", error);
      }
    }
  } catch (error) {
    newTab_logger.error("Failed to display image:", error);
    throw error;
  }
}

/**
 * Updates the credit information displayed for the current image
 * Shows photographer and source information with proper attribution links
 * @param imageData - The image data containing credit and source information
 */
function updateCreditInfo(imageData: ImageData): void {
  const authorLink = document.createElement("a");
  authorLink.href = imageData.authorUrl;
  authorLink.target = "_blank";
  authorLink.textContent = imageData.author;

  const sourceLink = document.createElement("a");
  sourceLink.href = getSourceUrl(imageData.source);
  sourceLink.target = "_blank";
  sourceLink.textContent = getSourceDisplayName(imageData.source);

  authorSpan.innerHTML = "";
  authorSpan.appendChild(authorLink);
  sourceSpan.innerHTML = "";
  sourceSpan.appendChild(sourceLink);
}

/**
 * Generates the appropriate source URL for different image sources
 * Handles Unsplash UTM parameters and Pexels photographer pages
 * @param source - The image source type ('unsplash', 'pexels', or 'other')
 * @returns The formatted URL for the image source
 */
function getSourceUrl(source: ImageData["source"]): string {
  switch (source) {
    case "unsplash":
      return "https://unsplash.com";
    case "pexels":
      return "https://pexels.com";
    default:
      return "#";
  }
}

/**
 * Gets the display name for different image sources
 * Provides user-friendly names for attribution display
 * @param source - The image source type
 * @returns The human-readable source name
 */
function getSourceDisplayName(source: ImageData["source"]): string {
  switch (source) {
    case "unsplash":
      return "Unsplash";
    case "pexels":
      return "Pexels";
    default:
      return "Other";
  }
}

/**
 * Displays fallback information when no images are available
 * Shows guidance to users on how to resolve image availability issues
 * Includes database statistics and troubleshooting information
 */
async function showFallbackInfo(): Promise<void> {
  try {
    const infoDiv = document.createElement("div");
    infoDiv.style.cssText = `
        position: fixed;
        top: 30px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(12px);
        color: white;
        padding: 16px 28px;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 500;
        z-index: 100;
        text-align: center;
        max-width: 500px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.1);
      `;

    const icon = "📱";
    infoDiv.innerHTML = `
        ${icon}. 
        <a href="#" id="openSettingsLink" 
           style="color: #4da6ff; text-decoration: underline; font-weight: 600;">
          Configure API keys
        </a> to get fresh wallpapers!
      `;

    document.body.appendChild(infoDiv);

    // Auto-hide after 6 seconds with fade animation
    setTimeout(() => {
      infoDiv.style.transition = "opacity 0.8s ease-out";
      infoDiv.style.opacity = "0";
      setTimeout(() => infoDiv.remove(), 800);
    }, 6000);

    // Handle settings link click
    document
      .getElementById("openSettingsLink")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
      });
  } catch (error) {
    newTab_logger.error("Failed to show fallback info:", error);
  }
}

/**
 * Displays an error message to the user
 * Shows error with fade-in animation and auto-hide functionality
 * @param message - The error message to display to the user
 */
function showError(message: string): void {
  loadingDiv.style.display = "none";

  const errorDiv = document.createElement("div");
  errorDiv.className = "error";
  errorDiv.innerHTML = `
    <p>${message}</p>
    <p style="margin-top: 10px; font-size: 14px; opacity: 0.8;">
      <a href="#" id="openOptionsFromError" 
         style="color: #4da6ff; text-decoration: underline;">
        Configure API keys
      </a> to get fresh wallpapers!
    </p>
  `;
  document.body.appendChild(errorDiv);

  document
    .getElementById("openOptionsFromError")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
}

/**
 * Loads the viewing history from the database
 * Populates appState.historyList with recently viewed images
 * Limited by appState.historyMaxSize setting
 */
async function loadHistoryList(): Promise<void> {
  try {
    appState.historyList = await getHistory(appState.historyMaxSize);
  } catch (error) {
    newTab_logger.error("Failed to load history:", error);
    appState.historyList = [];
  }
}

/**
 * Updates the navigation button states based on current history position
 * Enables/disables previous/next buttons and updates visual indicators
 * Handles edge cases when at beginning or end of history
 * Respects history enabled setting to show/hide navigation
 */
function updateHistoryUI(): void {
  if (!appState.historyEnabled) {
    // Hide all navigation elements when history is disabled
    prevImageBtn.style.display = "none";
    nextImageBtn.style.display = "none";
    historyIndicator.classList.remove("visible");
    return;
  }

  if (appState.historyList.length === 0) {
    prevImageBtn.style.display = "none";
    nextImageBtn.style.display = "none";
    historyIndicator.classList.remove("visible");
    return;
  }

  if (appState.currentHistoryIndex === -1) {
    // Viewing current/latest image
    prevImageBtn.style.display =
      appState.historyList.length > 0 ? "flex" : "none";
    nextImageBtn.style.display = "none"; // Hide next when viewing current
    historyIndicator.classList.remove("visible");
  } else {
    // Viewing historical image
    prevImageBtn.style.display =
      appState.currentHistoryIndex < appState.historyList.length - 1
        ? "flex"
        : "none";
    nextImageBtn.style.display = "flex"; // Show next to go forward in history
    historyIndicator.classList.add("visible");

    historyPosition.textContent = (appState.currentHistoryIndex + 1).toString();
    historyTotal.textContent = appState.historyList.length.toString();
  }
}

/**
 * Navigates to the previous image in history
 * Handles expired/deleted images gracefully by skipping them
 * Pauses auto-refresh timer while navigating
 */
async function navigateToPrevious(
  depth: number = 0,
  settings: Settings,
): Promise<void> {
  const MAX_RECURSION_DEPTH = 10;

  if (appState.currentHistoryIndex >= appState.historyList.length - 1) return;

  // Prevent stack overflow from too many recursive calls
  if (depth >= MAX_RECURSION_DEPTH) {
    newTab_logger.warn("Max recursion depth reached in navigateToPrevious");
    return;
  }

  // Pause auto-refresh timer when navigating history
  pauseAutoRefresh();

  appState.currentHistoryIndex++;
  const historyEntry = appState.historyList[appState.currentHistoryIndex];

  if (!historyEntry) return;

  try {
    const imageData = await getHistoryImageById(historyEntry.imageId);

    if (imageData) {
      await displayImage(imageData, true, "prev", settings);
      updateHistoryUI();
    } else {
      // Image expired/deleted, remove from history and try next one
      appState.historyList.splice(appState.currentHistoryIndex, 1);
      appState.currentHistoryIndex--;
      if (appState.currentHistoryIndex < appState.historyList.length - 1) {
        settings
          ? await navigateToPrevious(depth + 1, settings)
          : await navigateToPrevious(depth + 1, DEFAULT_SETTINGS); // Recursively try next one
      }
    }
  } catch (error) {
    newTab_logger.error("Failed to navigate to previous image:", error);
  }
}

/**
 * Navigates to the next image in history (forward)
 * Pauses auto-refresh timer while navigating
 */
async function navigateToNext(
  depth: number = 0,
  settings: Settings,
): Promise<void> {
  const MAX_RECURSION_DEPTH = 10;

  if (appState.currentHistoryIndex <= 0) return;

  // Prevent stack overflow from too many recursive calls
  if (depth >= MAX_RECURSION_DEPTH) {
    newTab_logger.warn("Max recursion depth reached in navigateToNext");
    return;
  }

  // Pause auto-refresh timer when navigating history
  pauseAutoRefresh();

  appState.currentHistoryIndex--;

  if (appState.currentHistoryIndex === -1) {
    // Back to current/latest image
    await loadRandomImage(settings);
  } else {
    const historyEntry = appState.historyList[appState.currentHistoryIndex];

    if (!historyEntry) return;

    try {
      const imageData = await getHistoryImageById(historyEntry.imageId);

      if (imageData) {
        await displayImage(imageData, true, "next", settings);
      } else {
        // Image expired/deleted, remove from history and try next one
        appState.historyList.splice(appState.currentHistoryIndex, 1);
        if (appState.currentHistoryIndex > 0) {
          await navigateToNext(depth + 1, settings); // Recursively try next one
        }
      }
    } catch (error) {
      newTab_logger.error("Failed to navigate to next image:", error);
    }
  }

  updateHistoryUI();
}

/**
 * Loads and applies history settings from Chrome storage
 * Updates appState with current history configuration
 */
async function loadHistorySettings(settings: Settings): Promise<void> {
  try {
    appState.historyEnabled =
      settings.history?.enabled ?? DEFAULT_HISTORY_ENABLED;
    appState.historyMaxSize =
      settings.history?.maxSize ?? DEFAULT_HISTORY_MAX_SIZE;

    await loadHistoryList();
    updateHistoryUI();
  } catch (error) {
    newTab_logger.error("Failed to load history settings:", error);
  }
}

/**
 * Gets a random image efficiently from cache or database
 * Uses in-memory cache for O(1) selection, falls back to DB if needed
 * Avoids recently viewed images by checking history
 * @param maxAttempts - Maximum attempts to find an unviewed image
 * @returns Random image data or null if none available
 */
async function getRandomImageEfficient(
  maxAttempts: number = 5,
): Promise<ImageData | null> {
  // Ensure cache is populated
  if (appState.currentImages.length === 0) {
    appState.currentImages = await getAllValidImages();
  }

  if (appState.currentImages.length === 0) {
    return null;
  }

  // Try to find an image not viewed recently
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const randomIndex = Math.floor(
      Math.random() * appState.currentImages.length,
    );
    const candidate = appState.currentImages[randomIndex];

    if (!candidate) continue;

    // Check if image was viewed in the last 20 minutes (0.33 hours)
    const recentlyViewed = await wasImageViewedRecently(candidate.id, 0.33);

    if (!recentlyViewed) {
      return candidate;
    }

    newTab_logger.debug(
      `Image ${candidate.id} was viewed recently, attempt ${attempt + 1}/${maxAttempts}`,
    );
  }

  // If all attempts failed, return a random image anyway
  // (better than showing nothing)
  const fallbackIndex = Math.floor(
    Math.random() * appState.currentImages.length,
  );
  return appState.currentImages[fallbackIndex] || null;
}

/**
 * Loads a random image using the enhanced fallback system
 * Utilizes the new getImagesWithFallback for intelligent image selection
 * Includes smart duplicate detection and better error handling
 * Resumes auto-refresh timer after loading
 */
async function loadRandomImage(settings: Settings): Promise<void> {
  try {
    appState.currentHistoryIndex = -1;
    creditDiv.classList.remove("visible");

    const randomImageData = await getRandomImageEfficient();

    if (!randomImageData) {
      showError("No images available. Please check your configuration.");
      await showFallbackInfo();

      return;
    }

    await displayImage(randomImageData, false, "fade", settings);

    // Resume auto-refresh timer after loading current image
    await resumeAutoRefresh(settings);

    // Refresh cache periodically if it's getting stale
    // This happens in the background without blocking the UI
    if (appState.currentImages.length > 0) {
      getAllValidImages().then((freshImages) => {
        appState.currentImages = freshImages;
      });
    }
  } catch (error) {
    newTab_logger.error("Error loading image:", error);
    showError("Error loading image. Please try again.");
  }
}

/**
 * Updates the clock display with current time
 * Handles both 12-hour and 24-hour formats with optional seconds
 * @param format24 - Whether to use 24-hour format (true) or 12-hour format (false)
 * @param showSeconds - Whether to display seconds in the time
 */
function updateClock(format24: boolean, showSeconds: boolean) {
  const now = new Date();

  let hours = now.getHours();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();

  let timeString: string;

  if (format24) {
    const h = hours.toString().padStart(2, "0");
    const m = minutes.toString().padStart(2, "0");
    const s = seconds.toString().padStart(2, "0");
    timeString = showSeconds ? `${h}:${m}:${s}` : `${h}:${m}`;
  } else {
    const period = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12; // Convert to 12-hour format
    const h = hours.toString();
    const m = minutes.toString().padStart(2, "0");
    const s = seconds.toString().padStart(2, "0");
    timeString = showSeconds
      ? `${h}:${m}:${s} ${period}`
      : `${h}:${m} ${period}`;
  }

  timeDisplay.textContent = timeString;
}

/**
 * Updates the date display with current date
 * Formats date in a user-friendly format (e.g., "Monday, January 15, 2024")
 */
function updateDate() {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  dateDisplay.textContent = now.toLocaleDateString("en-US", options);
}

/**
 * Sets up the clock based on user preferences from Chrome storage
 * Manages clock interval lifecycle and display format options
 * Handles both 12/24 hour formats, seconds display, and date display
 */
async function setupClock(settings: Settings): Promise<void> {
  // Properly clear existing interval if it exists
  if (
    appState.clockInterval !== null &&
    typeof appState.clockInterval === "number"
  ) {
    clearInterval(appState.clockInterval);
    appState.clockInterval = null;
  }

  if (settings.clock.enabled) {
    clockContainer.style.display = "block";
    clockContainer.classList.remove("hidden");

    if (settings.clock.showDate) {
      dateDisplay.style.display = "block";
      updateDate();
    } else {
      dateDisplay.style.display = "none";
    }

    updateClock(settings.clock.format24, settings.clock.showSeconds);

    const interval = settings.clock.showSeconds ? 1000 : 60000;
    appState.clockInterval = window.setInterval(() => {
      updateClock(settings.clock.format24, settings.clock.showSeconds);
      if (settings.clock.showDate) {
        updateDate();
      }
    }, interval);

    newTab_logger.debug(
      `Clock enabled: ${
        settings.clock.format24 ? "24h" : "12h"
      } format, seconds: ${settings.clock.showSeconds}`,
    );
  } else {
    clockContainer.style.display = "none";
    clockContainer.classList.add("hidden");
    newTab_logger.debug("Clock disabled");
  }
}

/**
 * Sets up button visibility based on user preferences
 * Manages visibility of refresh and settings buttons on the new tab page
 */
async function setupButtonVisibility(settings: Settings): Promise<void> {
  // Handle refresh button visibility
  if (settings.ui?.showRefreshButton === false) {
    randomImageBtn.style.display = "none";
    newTab_logger.debug("Refresh button hidden");
  } else {
    randomImageBtn.style.display = "flex";
    newTab_logger.debug("Refresh button visible");
  }

  // Handle settings button visibility
  if (settings.ui?.showSettingsButton === false) {
    settingsBtn.style.display = "none";
    newTab_logger.debug("Settings button hidden");
  } else {
    settingsBtn.style.display = "flex";
    newTab_logger.debug("Settings button visible");
  }
}

/**
 * Pauses the auto-refresh timer without clearing it
 * Stores remaining time for resuming later
 */
function pauseAutoRefresh(): void {
  if (appState.autoRefreshTimer) {
    clearInterval(appState.autoRefreshTimer);
    appState.autoRefreshTimer = null;
  }
}

/**
 * Resumes the auto-refresh timer with current settings
 * Only resumes if user is viewing the current (non-history) image
 */
async function resumeAutoRefresh(settings: Settings): Promise<void> {
  // Only resume if viewing current image (not in history)
  if (appState.currentHistoryIndex !== -1) {
    return;
  }

  await setupAutoRefresh(settings);
}

/**
 * Sets up automatic image refresh based on user preferences
 * Manages auto-refresh timer lifecycle and interval settings
 * Allows users to automatically cycle through images at specified intervals
 */
async function setupAutoRefresh(settings: Settings): Promise<void> {
  if (appState.autoRefreshTimer) {
    clearInterval(appState.autoRefreshTimer);
    appState.autoRefreshTimer = null;
  }

  if (settings.autoRefresh.enabled && appState.currentHistoryIndex === -1) {
    const intervalMs = settings.autoRefresh.interval * 1000;
    appState.autoRefreshTimer = window.setInterval(() => {
      loadRandomImage(settings);
    }, intervalMs);

    newTab_logger.debug(
      `Auto-refresh enabled: ${settings.autoRefresh.interval}s`,
    );
  }
}

/**
 * Checks if images need to be refreshed and triggers refresh if necessary
 * Monitors last fetch time and ensures images stay current
 * Helps maintain a fresh cache of images for optimal user experience
 */
async function checkAndTriggerRefresh(): Promise<void> {
  try {
    const lastFetch = await getLastFetchTime();
    const now = Date.now();

    if (!lastFetch || now - lastFetch >= REFRESH_INTERVAL_MS) {
      newTab_logger.debug("⏰ Refresh overdue, notifying background worker...");
      chrome.runtime.sendMessage({ action: "checkRefreshNeeded" });
    }
  } catch (error) {
    newTab_logger.error("Failed to check refresh status:", error);
  }
}

/**
 * Event Listeners - Button actions
 */
settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

randomImageBtn.addEventListener("click", async () => {
  const settings = await getSettings();
  await loadRandomImage(settings);
});

prevImageBtn.addEventListener("click", async () => {
  const settings = await getSettings();
  await navigateToPrevious(undefined, settings);
});

nextImageBtn.addEventListener("click", async () => {
  const settings = await getSettings();
  await navigateToNext(undefined, settings);
});

/**
 * Custom Context Menu Implementation
 */
const contextMenu = document.getElementById("contextMenu") as HTMLElement;
const historyModal = document.getElementById("historyModal") as HTMLElement;
const historyList = document.getElementById("historyList") as HTMLElement;
const closeHistoryModalBtn = document.getElementById(
  "closeHistoryModal",
) as HTMLElement;

// Store current image data for download
let currentImageData: ImageData | null = null;

// Track UI visibility state
let isUIHidden = false;

/**
 * Shows the custom context menu at the specified position
 */
function showContextMenu(x: number, y: number): void {
  contextMenu.classList.add("visible");

  // Position the menu, ensuring it stays within viewport
  const menuRect = contextMenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let posX = x;
  let posY = y;

  // Adjust if menu would go off-screen
  if (x + menuRect.width > viewportWidth) {
    posX = viewportWidth - menuRect.width - 10;
  }

  if (y + menuRect.height > viewportHeight) {
    posY = viewportHeight - menuRect.height - 10;
  }

  contextMenu.style.left = `${posX}px`;
  contextMenu.style.top = `${posY}px`;
}

/**
 * Hides the custom context menu
 */
function hideContextMenu(): void {
  contextMenu.classList.remove("visible");
}

/**
 * Deletes the current image and loads a new one with transition
 */
async function deleteCurrentImage(settings: Settings): Promise<void> {
  if (!currentImageData) {
    newTab_logger.error("No current image to delete");
    return;
  }

  try {
    const imageIdToDelete = currentImageData.id;
    newTab_logger.info("Deleting current image:", imageIdToDelete);

    // Determine if we're in history view
    const inHistoryView = appState.currentHistoryIndex >= 0;

    if (inHistoryView) {
      // Remove from history list
      const deletedIndex = appState.currentHistoryIndex;
      appState.historyList.splice(deletedIndex, 1);

      // Delete from database
      await deleteImage(imageIdToDelete);

      // Navigate to next image in history if available
      if (appState.historyList.length > 0) {
        // Try to go to the next image (higher index)
        if (deletedIndex < appState.historyList.length) {
          appState.currentHistoryIndex = deletedIndex;
          const nextEntry = appState.historyList[deletedIndex];
          if (nextEntry) {
            const nextImage = await getHistoryImageById(nextEntry.imageId);
            if (nextImage) {
              await displayImage(nextImage, true, "fade", settings);
            }
          }
        } else {
          // Go to previous image (lower index)
          appState.currentHistoryIndex = Math.max(0, deletedIndex - 1);
          const prevEntry = appState.historyList[appState.currentHistoryIndex];
          if (prevEntry) {
            const prevImage = await getHistoryImageById(prevEntry.imageId);
            if (prevImage) {
              await displayImage(prevImage, true, "fade", settings);
            }
          }
        }
      } else {
        // No more history, load random image
        await loadRandomImage(settings);
      }
    } else {
      // Not in history view - delete and load new random image
      await deleteImage(imageIdToDelete);
      await loadRandomImage(settings);
    }

    updateHistoryUI();
    newTab_logger.info("Image deleted successfully");
  } catch (error) {
    newTab_logger.error("Failed to delete image:", error);
    showError("Failed to delete image");
  }
}

/**
 * Toggles the visibility of UI elements (everything except canvas)
 */
function toggleUIVisibility(): void {
  isUIHidden = !isUIHidden;
  
  if (isUIHidden) {
    document.body.classList.add("ui-hidden");
    newTab_logger.debug("UI hidden");
  } else {
    document.body.classList.remove("ui-hidden");
    newTab_logger.debug("UI visible");
  }

  // Update context menu text
  const toggleUIText = document.getElementById("toggleUIText");
  if (toggleUIText) {
    toggleUIText.textContent = isUIHidden ? "Show UI" : "Hide UI";
  }
}

/**
 * Downloads the current image to user's storage
 */
async function downloadCurrentImage(): Promise<void> {
  if (!currentImageData) {
    newTab_logger.error("No current image to download");
    return;
  }

  try {
    // Create a blob URL from the current image
    const blobUrl = URL.createObjectURL(currentImageData.blob);

    // Create a temporary download link
    const link = document.createElement("a");
    link.href = blobUrl;

    // Generate filename from id
    link.download = `${currentImageData.id}.jpg`;

    // Trigger download
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Clean up blob URL after a short delay
    setTimeout(() => URL.revokeObjectURL(blobUrl), 100);

    newTab_logger.debug(`Downloaded image: ${link.download}`);
  } catch (error) {
    newTab_logger.error("Failed to download image:", error);
  }
}
/**
 * Shows the history modal with list of viewed images
 */
async function showHistoryModal(settings: Settings): Promise<void> {
  try {
    const historyEnabled = settings.history?.enabled;

    let history: HistoryEntry[] = [];

    if (!historyEnabled) {
      historyList.innerHTML =
        '<div class="history-empty">History is disabled, visit options page!</div>';
    } else {
      history = await getHistory();

      if (history.length === 0) {
        historyList.innerHTML =
          '<div class="history-empty">No history yet. Start browsing images!</div>';
      } else {
        // Create history items
        const items = await Promise.all(
          history.map(async (entry, index) => {
            const isCurrent =
              index === appState.currentHistoryIndex ||
              (appState.currentHistoryIndex === -1 && index === 0);

            const timeAgo = formatTimeAgo(entry.viewedAt);
            const sourceDisplay =
              entry.source.charAt(0).toUpperCase() + entry.source.slice(1);

            return `
            <div class="history-item ${isCurrent ? "current" : ""}" data-index="${index}">
              <div class="history-item-info">
                <div class="history-item-source">${sourceDisplay}</div>
                <div class="history-item-time">${timeAgo}</div>
              </div>
              <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          `;
          }),
        );

        historyList.innerHTML = items.join("");

        // Add click handlers to history items
        historyList.querySelectorAll(".history-item").forEach((item) => {
          item.addEventListener("click", async () => {
            const index = parseInt((item as HTMLElement).dataset.index || "0");
            await navigateToHistoryIndex(index, settings);
            hideHistoryModal();
          });
        });
      }
    }

    historyModal.classList.add("visible");
  } catch (error) {
    newTab_logger.error("Failed to show history modal:", error);
  }
}

/**
 * Hides the history modal
 */
function hideHistoryModal(): void {
  historyModal.classList.remove("visible");
}

/**
 * Formats a timestamp into a human-readable "time ago" string
 */
function formatTimeAgo(timestamp: number): string {
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
 * Navigates to a specific history index
 */
async function navigateToHistoryIndex(
  index: number,
  settings: Settings,
): Promise<void> {
  const history = await getHistory();

  if (index < 0 || index >= history.length) {
    return;
  }

  const historyEntry = history[index]!;
  const imageData = await getHistoryImageById(historyEntry.imageId);

  if (!imageData) {
    newTab_logger.error("Failed to load history image");
    return;
  }

  appState.currentHistoryIndex = index;
  await displayImage(imageData, true, "fade", settings);
  updateHistoryUI();
}

// Context menu event listeners
document.body.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showContextMenu(event.clientX, event.clientY);
});

// Hide context menu on left click anywhere
document.addEventListener("click", () => {
  hideContextMenu();
});

// Context menu item actions
document
  .getElementById("contextDownload")
  ?.addEventListener("click", async (e) => {
    e.stopPropagation();
    await downloadCurrentImage();
    hideContextMenu();
  });

document
  .getElementById("contextDelete")
  ?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const settings = await getSettings();
    hideContextMenu();
    await deleteCurrentImage(settings);
  });

document
  .getElementById("contextHistory")
  ?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const settings = await getSettings();
    hideContextMenu();
    await showHistoryModal(settings);
  });

document
  .getElementById("contextToggleUI")
  ?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleUIVisibility();
    hideContextMenu();
  });

document
  .getElementById("contextRandom")
  ?.addEventListener("click", async (e) => {
    const settings = await getSettings();
    e.stopPropagation();
    hideContextMenu();
    await loadRandomImage(settings);
  });

// History modal close handlers
closeHistoryModalBtn.addEventListener("click", () => {
  hideHistoryModal();
});

historyModal.addEventListener("click", (e) => {
  // Close modal if clicking outside the content
  if (e.target === historyModal) {
    hideHistoryModal();
  }
});

/**
 * Keyboard navigation support
 */
document.addEventListener("keydown", async (e) => {
  const settings = await getSettings();
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (appState.historyEnabled) {
      await navigateToPrevious(undefined, settings);
    }
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (appState.historyEnabled) {
      await navigateToNext(undefined, settings);
    }
  }
});

/**
 * Chrome storage change listener - Update settings dynamically
 */
chrome.storage.onChanged.addListener(async (changes: any, areaName: any) => {
  const settings = await getSettings();
  if (areaName === "local" && changes.settings) {
    setupAutoRefresh(settings);
    setupClock(settings);
    loadHistorySettings(settings);
  }
});

/**
 * Clean up resources on page unload to prevent memory leaks
 */
window.addEventListener("beforeunload", () => {
  // Clean up canvas transition manager
  if (canvasTransitionManager) {
    canvasTransitionManager.destroy();
  }

  // Clean up current blob URL
  if (appState.currentBlobUrl) {
    URL.revokeObjectURL(appState.currentBlobUrl);
  }

  // Clean up any remaining blob URLs in cache
  blobUrlCache.forEach((url) => {
    URL.revokeObjectURL(url);
  });
  blobUrlCache.clear();
});

/**
 * Refresh cached images intelligently
 * Only refreshes if cache is stale or empty
 * Runs in background to avoid blocking UI
 */
async function refreshImageCache(): Promise<void> {
  try {
    const freshImages = await getAllValidImages();
    
    // Only update if there's a meaningful change
    if (freshImages.length !== appState.currentImages.length) {
      appState.currentImages = freshImages;
      newTab_logger.debug(`Cache updated: ${freshImages.length} images`);
    }
  } catch (error) {
    newTab_logger.error("Failed to refresh image cache:", error);
  }
}

/**
 * Refresh cached images periodically (every 2 minutes)
 * Ensures the local cache stays updated with valid images
 * More frequent than before to catch new/expired images faster
 */
setInterval(refreshImageCache, 2 * 60 * 1000);

/**
 * Initialize the new tab page
 */
(async () => {
  try {
    const settings = await getSettings();
    
    // Eagerly load image cache for fast random selection
    try {
      appState.currentImages = await getAllValidImages();
      newTab_logger.debug(`Loaded ${appState.currentImages.length} images into cache`);
    } catch (error) {
      newTab_logger.error("Failed to load image cache:", error);
      appState.currentImages = [];
    }

    // Setup clock with error boundary
    try {
      await setupClock(settings);
    } catch (error) {
      newTab_logger.error("Failed to setup clock:", error);
      // Non-critical, continue initialization
    }

    // Setup button visibility with error boundary
    try {
      await setupButtonVisibility(settings);
    } catch (error) {
      newTab_logger.error("Failed to setup button visibility:", error);
      // Non-critical, continue initialization
    }

    // Load history settings with error boundary
    try {
      await loadHistorySettings(settings);
    } catch (error) {
      newTab_logger.error("Failed to load history settings:", error);
      // Non-critical, continue with defaults
    }

    // Load random image - critical operation
    try {
      await loadRandomImage(settings);
    } catch (error) {
      newTab_logger.error("Failed to load random image:", error);
      showError("Failed to load image. Please refresh the page.");
      return; // Stop initialization if image loading fails
    }

    // Show fallback info with error boundary
    try {
      if (appState.currentImages.length === 0) await showFallbackInfo();
    } catch (error) {
      newTab_logger.error("Failed to show fallback info:", error);
      // Non-critical, continue initialization
    }

    // Setup auto-refresh with error boundary
    try {
      await setupAutoRefresh(settings);
    } catch (error) {
      newTab_logger.error("Failed to setup auto-refresh:", error);
      // Non-critical, continue initialization
    }

    // Check and trigger refresh with error boundary
    try {
      await checkAndTriggerRefresh();
    } catch (error) {
      newTab_logger.error("Failed to check/trigger refresh:", error);
      // Non-critical, background operation
    }
  } catch (error) {
    // Catch-all for any unexpected errors
    newTab_logger.error("Unexpected error during initialization:", error);
    showError("Failed to initialize page. Please refresh.");
  }
})();
