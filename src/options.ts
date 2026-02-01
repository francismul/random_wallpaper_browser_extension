/**
 * Options page
 * Handles display and management of user settings, API keys, and cache statistics
 * for the random wallpaper browser extension.
 */

import { testApiKey } from "./api";
import {
  DEFAULT_HISTORY_ENABLED,
  DEFAULT_HISTORY_MAX_SIZE,
  MAX_AUTO_REFRESH_INTERVAL,
  MIN_AUTO_REFRESH_INTERVAL,
  REFRESH_INTERVAL_MS,
  Settings,
  AVAILABLE_TRANSITIONS,
  TRANSITION_DISPLAY_NAMES,
  TransitionType,
  DEFAULT_ENABLED_TRANSITIONS,
} from "./config";
import {
  cleanExpiredImages,
  clearAllImages,
  clearHistory,
  getAllValidImages,
  getDatabaseStats,
  getHistoryCount,
  getLastFetchTime,
} from "./db";
import { Logger } from "./logger";
import { getSettings, saveSettings } from "./storage";
import { formatRelativeTime } from "./utils";

const options_logger = new Logger("Options Page");
/**
 * Shows/hides the header loading indicator
 * @param show - Whether to show the loading indicator
 */
function showHeaderLoading(show: boolean): void {
  const loadingIndicator = document.getElementById("loadingIndicator");
  if (loadingIndicator) {
    loadingIndicator.style.display = show ? "flex" : "none";
  }
}

/**
 * Displays a user-friendly message with an icon and proper styling
 * Enhanced to work in the header area for better visibility
 * @param text - The message text to display
 * @param type - Message type: 'success', 'error', or 'info'
 */
function showMessage(text: string, type: "success" | "error" | "info"): void {
  const messageEl = document.getElementById("message")!;
  messageEl.textContent = text;
  messageEl.className = `message ${type} show`;

  setTimeout(() => {
    messageEl.classList.remove("show");
  }, 3000);
}

/**
 * Auto-updates an element's innerText with relative time
 * Creates a live-updating time display that automatically refreshes
 * @param el - HTML element to update with time text
 * @param timestamp - Time in milliseconds to display relatively
 * @param intervalMs - How often to refresh the display (default 30 seconds)
 */
function startRelativeTimeUpdater(
  el: HTMLElement,
  timestamp: number,
  intervalMs = 30_000,
): void {
  const update = () => {
    el.textContent = formatRelativeTime(timestamp);
  };
  update(); // initial
  const interval = setInterval(update, intervalMs);

  // stop updating when element is removed
  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      clearInterval(interval);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Renders the API keys list with current status and management controls
 * Displays masked keys, validation status, and provides test/delete functionality
 * @param settings - Current settings containing API keys and their test status
 */
function renderApiKeys(settings: Settings): void {
  const container = document.getElementById("apiKeysList")!;
  container.innerHTML = "";

  const unsplashStatusEl = document.getElementById("unsplashStatus")!;
  const pexelsStatusEl = document.getElementById("pexelsStatus")!;

  const unsplashCount = settings.apiKeys.unsplash.length;
  const pexelsCount = settings.apiKeys.pexels.length;

  if (unsplashCount > 0) {
    const validUnsplash = settings.apiKeys.unsplash.filter((key) => {
      const keyHash = `unsplash_${key}`;
      return settings.apiKeyStatus?.[keyHash]?.valid;
    }).length;

    const statusText =
      validUnsplash > 0
        ? `Active (${validUnsplash}/${unsplashCount} valid)`
        : `Configured (${unsplashCount} key${unsplashCount > 1 ? "s" : ""})`;
    const statusColor = validUnsplash > 0 ? "#28a745" : "#ffc107";

    unsplashStatusEl.innerHTML = `📷 Unsplash: <span style="color: ${statusColor}; font-weight: 600;">${statusText}</span>`;
  } else {
    unsplashStatusEl.innerHTML = `📷 Unsplash: <span style="color: #dc3545; font-weight: 600;">Not Configured</span>`;
  }

  if (pexelsCount > 0) {
    const validPexels = settings.apiKeys.pexels.filter((key) => {
      const keyHash = `pexels_${key}`;
      return settings.apiKeyStatus?.[keyHash]?.valid;
    }).length;

    const statusText =
      validPexels > 0
        ? `Active (${validPexels}/${pexelsCount} valid)`
        : `Configured (${pexelsCount} key${pexelsCount > 1 ? "s" : ""})`;
    const statusColor = validPexels > 0 ? "#28a745" : "#ffc107";

    pexelsStatusEl.innerHTML = `🖼️ Pexels: <span style="color: ${statusColor}; font-weight: 600;">${statusText}</span>`;
  } else {
    pexelsStatusEl.innerHTML = `🖼️ Pexels: <span style="color: #dc3545; font-weight: 600;">Not Configured</span>`;
  }

  const allKeys = [
    ...settings.apiKeys.unsplash.map((key) => ({
      source: "unsplash" as const,
      key,
    })),
    ...settings.apiKeys.pexels.map((key) => ({
      source: "pexels" as const,
      key,
    })),
  ];

  if (allKeys.length === 0) {
    container.innerHTML = `
      <div class="help-text">
        <p>⚠️ No API keys configured. Extension will use default fallback images until you add at least one API key.</p>
        <p>📝 <strong>How to get API keys:</strong></p>
        <ul>
          <li><strong>Unsplash:</strong> Register at <a href="https://unsplash.com/developers" target="_blank">developers.unsplash.com</a></li>
          <li><strong>Pexels:</strong> Register at <a href="https://www.pexels.com/api/" target="_blank">pexels.com/api</a></li>
        </ul>
      </div>
    `;
    return;
  }

  allKeys.forEach(({ source, key }) => {
    const item = document.createElement("div");
    item.className = "api-key-item";

    // Create masked key display (show first 8 and last 4 characters)
    const maskedKey =
      key.length > 12
        ? key.slice(0, 8) +
          "•".repeat(Math.max(0, key.length - 12)) +
          key.slice(-4)
        : key.slice(0, 4) +
          "•".repeat(Math.max(0, key.length - 8)) +
          key.slice(-4);

    // Get stored test status with enhanced information
    const keyHash = `${source}_${key}`;
    const status = settings.apiKeyStatus?.[keyHash];
    let statusText = "Not Tested";
    let statusClass = "unknown";
    let statusTitle = "Click Test to verify this API key";

    if (status?.tested) {
      const ageHours = (Date.now() - status.testedAt) / (1000 * 60 * 60);
      const isStale = ageHours > 24; // Consider status stale after 24 hours

      if (status.valid) {
        statusText = isStale ? "Valid (Old)" : "Valid";
        statusClass = isStale ? "valid-stale" : "valid";
        statusTitle = `Tested ${formatRelativeTime(status.testedAt)}`;
      } else {
        statusText = isStale ? "Invalid (Old)" : "Invalid";
        statusClass = isStale ? "invalid-stale" : "invalid";
        statusTitle = `Failed test ${formatRelativeTime(status.testedAt)}`;
      }
    }

    item.innerHTML = `
      <span class="source">${source.charAt(0).toUpperCase() + source.slice(1)}</span>
      <span class="key" title="${key}">${maskedKey}</span>
      <span class="status ${statusClass}" title="${statusTitle}">${statusText}</span>
      <button class="test-btn secondary" data-source="${source}" data-key="${key}" title="Test API key validity">Test</button>
      <button class="delete-btn danger" data-source="${source}" data-key="${key}" title="Remove this API key">Delete</button>
    `;

    container.appendChild(item);
  });

  container.querySelectorAll(".test-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const source = target.dataset.source as "unsplash" | "pexels";
      const key = target.dataset.key!;
      const statusEl = target.previousElementSibling!;

      // Update UI to show testing state
      target.disabled = true;
      target.textContent = "Testing...";
      statusEl.textContent = "Testing...";
      statusEl.className = "status testing";

      try {
        const isValid = await testApiKey(source, key);

        // Update status display
        statusEl.textContent = isValid ? "Valid" : "Invalid";
        statusEl.className = `status ${isValid ? "valid" : "invalid"}`;
        (statusEl as HTMLElement).title =
          `Tested ${formatRelativeTime(Date.now())}`;

        // Save test result to storage with timestamp
        const currentSettings = await getSettings();
        if (!currentSettings.apiKeyStatus) {
          currentSettings.apiKeyStatus = {};
        }
        const keyHash = `${source}_${key}`;
        currentSettings.apiKeyStatus[keyHash] = {
          tested: true,
          valid: isValid,
          testedAt: Date.now(),
        };
        await saveSettings(currentSettings);

        // Show user feedback
        if (isValid) {
          showMessage(
            `✓ ${source.charAt(0).toUpperCase() + source.slice(1)} API key is valid!`,
            "success",
          );
        } else {
          showMessage(
            `✗ ${source.charAt(0).toUpperCase() + source.slice(1)} API key failed validation`,
            "error",
          );
        }
      } catch (error) {
        options_logger.error("API key test failed:", error);
        statusEl.textContent = "Test Failed";
        statusEl.className = "status error";
        showMessage("API key test failed due to network error", "error");
      } finally {
        // Reset button state
        target.disabled = false;
        target.textContent = "Test";
      }
    });
  });

  container.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const source = target.dataset.source as "unsplash" | "pexels";
      const key = target.dataset.key!;

      // Confirm deletion with enhanced dialog
      const maskedKey =
        key.length > 12
          ? key.slice(0, 8) +
            "•".repeat(Math.max(0, key.length - 12)) +
            key.slice(-4)
          : key.slice(0, 4) +
            "•".repeat(Math.max(0, key.length - 8)) +
            key.slice(-4);

      const confirmed = confirm(
        `Are you sure you want to delete this ${source} API key?\n\nKey: ${maskedKey}\n\nThis action cannot be undone.`,
      );

      if (!confirmed) return;

      try {
        const currentSettings = await getSettings();
        currentSettings.apiKeys[source] = currentSettings.apiKeys[
          source
        ].filter((k) => k !== key);

        // Remove test status for this key
        if (currentSettings.apiKeyStatus) {
          const keyHash = `${source}_${key}`;
          delete currentSettings.apiKeyStatus[keyHash];
        }

        await saveSettings(currentSettings);

        // Re-render the API keys list
        renderApiKeys(currentSettings);
        showMessage(
          `${source.charAt(0).toUpperCase() + source.slice(1)} API key deleted successfully`,
          "success",
        );

        // If no keys left, show guidance message
        const totalKeys =
          currentSettings.apiKeys.unsplash.length +
          currentSettings.apiKeys.pexels.length;
        if (totalKeys === 0) {
          showMessage(
            "All API keys removed. Extension will use fallback images until new keys are added.",
            "info",
          );
        }
      } catch (error) {
        options_logger.error("Failed to delete API key:", error);
        showMessage("Failed to delete API key. Please try again.", "error");
      }
    });
  });
}

/**
 * Loads and displays enhanced cache statistics using improved database functions
 * Shows comprehensive information about stored images, expiration status, and source distribution
 * @returns Promise resolving to the last fetch timestamp for reuse
 */
async function loadCacheStats(): Promise<number | null> {
  try {
    const [images, lastFetch, dbStats] = await Promise.all([
      getAllValidImages(),
      getLastFetchTime(),
      getDatabaseStats(),
    ]);

    const now = Date.now();
    const totalItems = images.length;
    const validItems = images.filter((img) => img.expiresAt > now).length;
    const expiredItems = totalItems - validItems;

    // Source distribution with enhanced information
    const unsplashCount = images.filter(
      (img) => img.source === "unsplash",
    ).length;
    const pexelsCount = images.filter((img) => img.source === "pexels").length;
    const fallbackCount = images.filter((img) => img.source === "other").length;

    // Update UI elements with enhanced information
    document.getElementById("totalItems")!.textContent = totalItems.toString();
    document.getElementById("validItems")!.textContent = validItems.toString();
    document.getElementById("expiredItems")!.textContent =
      expiredItems.toString();
    document.getElementById("unsplashCount")!.textContent =
      unsplashCount.toString();
    document.getElementById("pexelsCount")!.textContent =
      pexelsCount.toString();

    // Add fallback count if element exists
    const fallbackEl = document.getElementById("fallbackCount");
    if (fallbackEl) {
      fallbackEl.textContent = fallbackCount.toString();
    }

    // Enhanced database statistics display
    const dbStatsEl = document.getElementById("dbStats");
    if (dbStatsEl && dbStats) {
      dbStatsEl.innerHTML = `
        <div>Total Images: ${dbStats.totalImages}</div>
        <div>Valid Images: ${dbStats.validImages}</div>
        <div>Expired Images: ${dbStats.expiredImages}</div>
        <div>History Entries: ${dbStats.totalHistory}</div>
      `;
    }

    // Cache health indicator
    const healthEl = document.getElementById("cacheHealth");
    if (healthEl) {
      const healthPercentage =
        totalItems > 0 ? Math.round((validItems / totalItems) * 100) : 0;
      const healthStatus =
        healthPercentage >= 80
          ? "Excellent"
          : healthPercentage >= 60
            ? "Good"
            : healthPercentage >= 40
              ? "Fair"
              : "Poor";
      const healthColor =
        healthPercentage >= 80
          ? "#28a745"
          : healthPercentage >= 60
            ? "#28a745"
            : healthPercentage >= 40
              ? "#ffc107"
              : "#dc3545";

      healthEl.innerHTML = `<span style="color: ${healthColor}; font-weight: 600;">${healthStatus} (${healthPercentage}%)</span>`;
    }

    // Use auto-updating relative time for last fetch with enhanced display
    const lastFetchEl = document.getElementById("lastFetchTime")!;
    if (lastFetch) {
      startRelativeTimeUpdater(lastFetchEl, lastFetch);

      // Add freshness indicator
      const hoursSinceFetch = (now - lastFetch) / (1000 * 60 * 60);
      const freshnessEl = document.getElementById("freshness");
      if (freshnessEl) {
        let freshnessStatus: string;
        let freshnessColor: string;

        if (hoursSinceFetch < 1) {
          freshnessStatus = "Very Fresh";
          freshnessColor = "#28a745";
        } else if (hoursSinceFetch < 6) {
          freshnessStatus = "Fresh";
          freshnessColor = "#28a745";
        } else if (hoursSinceFetch < 24) {
          freshnessStatus = "Stale";
          freshnessColor = "#ffc107";
        } else {
          freshnessStatus = "Very Stale";
          freshnessColor = "#dc3545";
        }

        freshnessEl.innerHTML = `<span style="color: ${freshnessColor}; font-weight: 600;">${freshnessStatus}</span>`;
      }
    } else {
      lastFetchEl.textContent = "Never";

      const freshnessEl = document.getElementById("freshness");
      if (freshnessEl) {
        freshnessEl.innerHTML =
          '<span style="color: #dc3545; font-weight: 600;">No Data</span>';
      }
    }

    return lastFetch;
  } catch (error) {
    options_logger.error("Error loading cache stats:", error);
    showMessage("Failed to load cache statistics", "error");
    return null;
  }
}

/**
 * Renders the transition effects checkboxes with current settings
 * @param settings - Current settings containing enabled transitions
 */
function renderTransitionsList(settings: Settings): void {
  const container = document.getElementById("transitionsList");
  if (!container) return;

  container.innerHTML = "";

  const enabledTransitions =
    settings.transition?.enabledTransitions || DEFAULT_ENABLED_TRANSITIONS;

  AVAILABLE_TRANSITIONS.forEach((transition) => {
    const isEnabled = enabledTransitions.includes(transition);

    const checkboxDiv = document.createElement("div");
    checkboxDiv.className = "checkbox-group";
    checkboxDiv.style.cssText =
      "display: flex; align-items: center; gap: 10px;";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `transition-${transition}`;
    checkbox.checked = isEnabled;
    checkbox.dataset.transition = transition;

    const label = document.createElement("label");
    label.htmlFor = `transition-${transition}`;
    label.style.margin = "0";
    label.textContent = TRANSITION_DISPLAY_NAMES[transition];

    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(label);
    container.appendChild(checkboxDiv);
  });
}

/**
 * Loads and displays history statistics
 * Shows current number of history entries for navigation tracking
 */
async function loadHistoryStats(): Promise<void> {
  try {
    options_logger.debug("Loading history stats");
    const count = await getHistoryCount();
    options_logger.debug(`History count: ${count}`);
    const historyCountEl = document.getElementById("historyCount");
    if (historyCountEl) {
      historyCountEl.textContent = count.toString();
    }

    // Add history health indicator
    const historyHealthEl = document.getElementById("historyHealth");
    if (historyHealthEl) {
      const settings = await getSettings();
      const maxSize = settings.history?.maxSize ?? DEFAULT_HISTORY_MAX_SIZE;
      const percentage = Math.round((count / maxSize) * 100);

      let healthStatus: string;
      let healthColor: string;

      if (percentage < 50) {
        healthStatus = "Light Usage";
        healthColor = "#28a745";
      } else if (percentage < 80) {
        healthStatus = "Moderate Usage";
        healthColor = "#ffc107";
      } else if (percentage < 100) {
        healthStatus = "Heavy Usage";
        healthColor = "#fd7e14";
      } else {
        healthStatus = "At Capacity";
        healthColor = "#dc3545";
      }

      historyHealthEl.innerHTML = `<span style="color: ${healthColor}; font-weight: 600;">${healthStatus} (${count}/${maxSize})</span>`;
    }
  } catch (error) {
    options_logger.error("Error loading history stats:", error);
    showMessage("Failed to load history statistics", "error");
  }
}

/**
 * Sets up all event listeners for the options page
 * Includes enhanced validation, user feedback, and error handling
 */
async function setupEventListeners(): Promise<void> {
  // Auto-refresh interval display update with validation
  const autoRefreshIntervalEl = document.getElementById("autoRefreshInterval");
  if (autoRefreshIntervalEl) {
    autoRefreshIntervalEl.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      let value = parseInt(target.value);

      // Enforce bounds
      if (value < MIN_AUTO_REFRESH_INTERVAL) {
        value = MIN_AUTO_REFRESH_INTERVAL;
        target.value = value.toString();
      } else if (value > MAX_AUTO_REFRESH_INTERVAL) {
        value = MAX_AUTO_REFRESH_INTERVAL;
        target.value = value.toString();
      }

      const displayEl = document.getElementById("intervalDisplay");
      if (displayEl) {
        displayEl.textContent = `${value}s`;
      }
    });
  }

  // History max size display update with validation
  const historyMaxSizeEl = document.getElementById("historyMaxSize");
  if (historyMaxSizeEl) {
    historyMaxSizeEl.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      let value = parseInt(target.value);

      // Enforce reasonable bounds (5-100)
      if (value < 5) {
        value = 5;
        target.value = value.toString();
      } else if (value > 100) {
        value = 100;
        target.value = value.toString();
      }

      const displayEl = document.getElementById("historySizeDisplay");
      if (displayEl) {
        displayEl.textContent = value.toString();
      }
    });
  }

  // Keyword character counters
  const unsplashKeywordsEl = document.getElementById("unsplashKeywords");
  if (unsplashKeywordsEl) {
    unsplashKeywordsEl.addEventListener("input", (e) => {
      const target = e.target as HTMLTextAreaElement;
      const counterEl = document.getElementById("unsplashKeywordsCounter");
      if (counterEl) {
        counterEl.textContent = `${target.value.length} characters`;
      }
    });
  }

  const pexelsKeywordsEl = document.getElementById("pexelsKeywords");
  if (pexelsKeywordsEl) {
    pexelsKeywordsEl.addEventListener("input", (e) => {
      const target = e.target as HTMLTextAreaElement;
      const counterEl = document.getElementById("pexelsKeywordsCounter");
      if (counterEl) {
        counterEl.textContent = `${target.value.length} characters`;
      }
    });
  }

  // Enhanced API key addition with comprehensive validation
  const addApiKeyBtn = document.getElementById("addApiKeyBtn");
  if (addApiKeyBtn) {
    addApiKeyBtn.addEventListener("click", async () => {
      const sourceEl = document.getElementById(
        "apiSource",
      ) as HTMLSelectElement;
      const keyInputEl = document.getElementById(
        "apiKeyInput",
      ) as HTMLInputElement;

      if (!sourceEl || !keyInputEl) return;

      const source = sourceEl.value as "unsplash" | "pexels";
      const key = keyInputEl.value.trim();

      // Enhanced validation
      if (!key) {
        showMessage("Please enter an API key", "error");
        keyInputEl.focus();
        return;
      }

      if (key.length < 10) {
        showMessage(
          "API key appears to be too short. Please check your key.",
          "error",
        );
        keyInputEl.focus();
        return;
      }

      // Check for invalid characters
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
        showMessage(
          "API key contains invalid characters. Please check your key.",
          "error",
        );
        keyInputEl.focus();
        return;
      }

      try {
        const currentSettings = await getSettings();

        if (currentSettings.apiKeys[source].includes(key)) {
          showMessage("This API key is already added", "error");
          keyInputEl.focus();
          return;
        }

        // Check if this is the first API key being added
        const wasEmpty =
          currentSettings.apiKeys.unsplash.length === 0 &&
          currentSettings.apiKeys.pexels.length === 0;

        currentSettings.apiKeys[source].push(key);
        await saveSettings(currentSettings);

        keyInputEl.value = "";
        renderApiKeys(currentSettings);
        showMessage(
          `${source.charAt(0).toUpperCase() + source.slice(1)} API key added successfully`,
          "success",
        );

        // If this was the first API key, trigger immediate fetch
        if (wasEmpty) {
          showMessage("Fetching images with your new API key...", "info");
          chrome.runtime.sendMessage(
            { action: "apiKeysUpdated" },
            (response) => {
              if (chrome.runtime.lastError) {
                options_logger.warn(
                  "Background script message failed:",
                  chrome.runtime.lastError,
                );
                showMessage(
                  "API key added, but failed to trigger image fetch. Images will be fetched automatically.",
                  "info",
                );
              } else if (response?.success) {
                showMessage(
                  "Images fetched successfully! Open a new tab to see them.",
                  "success",
                );
                // Refresh stats to show new images
                setTimeout(() => {
                  loadCacheStats();
                  loadHistoryStats();
                }, 1000);
              } else {
                showMessage(
                  "API key added, but failed to fetch images. Please check your key or try again later.",
                  "error",
                );
              }
            },
          );
        }
      } catch (error) {
        options_logger.error("Failed to add API key:", error);
        showMessage("Failed to add API key. Please try again.", "error");
      }
    });
  }

  // Enhanced settings save with comprehensive validation
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", async () => {
      const originalText = saveSettingsBtn.textContent;

      try {
        // Show loading indicator and disable button during save
        showHeaderLoading(true);
        saveSettingsBtn.textContent = "Saving...";
        (saveSettingsBtn as HTMLButtonElement).disabled = true;

        const currentSettings = await getSettings();

        // Validate and save search preferences
        const unsplashKeywords =
          (
            document.getElementById("unsplashKeywords") as HTMLTextAreaElement
          )?.value.trim() || "";
        const pexelsKeywords =
          (
            document.getElementById("pexelsKeywords") as HTMLTextAreaElement
          )?.value.trim() || "";

        // Validate keywords length
        if (unsplashKeywords.length > 500) {
          showMessage(
            "Unsplash keywords are too long (max 500 characters)",
            "error",
          );
          return;
        }
        if (pexelsKeywords.length > 500) {
          showMessage(
            "Pexels keywords are too long (max 500 characters)",
            "error",
          );
          return;
        }

        currentSettings.searchPreferences = {
          unsplashKeywords,
          pexelsKeywords,
        };

        // Validate and save auto refresh settings
        const autoRefreshEnabled =
          (document.getElementById("autoRefreshEnabled") as HTMLInputElement)
            ?.checked ?? false;
        const autoRefreshInterval = parseInt(
          (document.getElementById("autoRefreshInterval") as HTMLInputElement)
            ?.value || "30",
        );

        // Validate interval is a valid number
        if (isNaN(autoRefreshInterval)) {
          showMessage("Auto-refresh interval must be a valid number", "error");
          return;
        }

        // Validate interval bounds
        if (
          autoRefreshInterval < MIN_AUTO_REFRESH_INTERVAL ||
          autoRefreshInterval > MAX_AUTO_REFRESH_INTERVAL
        ) {
          showMessage(
            `Auto-refresh interval must be between ${MIN_AUTO_REFRESH_INTERVAL} and ${MAX_AUTO_REFRESH_INTERVAL} seconds`,
            "error",
          );
          return;
        }

        currentSettings.autoRefresh = {
          enabled: autoRefreshEnabled,
          interval: autoRefreshInterval,
        };

        // Save clock settings
        currentSettings.clock = {
          enabled:
            (document.getElementById("clockEnabled") as HTMLInputElement)
              ?.checked ?? true,
          format24:
            (document.getElementById("clock24Hour") as HTMLInputElement)
              ?.checked ?? false,
          showSeconds:
            (document.getElementById("clockShowSeconds") as HTMLInputElement)
              ?.checked ?? true,
          showDate:
            (document.getElementById("clockShowDate") as HTMLInputElement)
              ?.checked ?? true,
        };

        // Save UI button visibility settings
        currentSettings.ui = {
          showRefreshButton:
            (document.getElementById("showRefreshButton") as HTMLInputElement)
              ?.checked ?? true,
          showSettingsButton:
            (document.getElementById("showSettingsButton") as HTMLInputElement)
              ?.checked ?? true,
        };

        // Validate and save history settings
        const historyEnabled =
          (document.getElementById("historyEnabled") as HTMLInputElement)
            ?.checked ?? true;
        const historyMaxSize = parseInt(
          (document.getElementById("historyMaxSize") as HTMLInputElement)
            ?.value || "15",
        );

        // Validate history max size is a valid number
        if (isNaN(historyMaxSize)) {
          showMessage("History max size must be a valid number", "error");
          return;
        }

        // Validate history max size bounds
        if (historyMaxSize < 5 || historyMaxSize > 100) {
          showMessage("History max size must be between 5 and 100", "error");
          return;
        }

        currentSettings.history = {
          enabled: historyEnabled,
          maxSize: historyMaxSize,
        };

        // Save cache settings
        currentSettings.cache = {
          permanentMode:
            (
              document.getElementById(
                "permanentCacheEnabled",
              ) as HTMLInputElement
            )?.checked ?? false,
        };

        // Save transition settings
        const enabledTransitions: TransitionType[] = [];
        AVAILABLE_TRANSITIONS.forEach((transition) => {
          const checkbox = document.getElementById(
            `transition-${transition}`,
          ) as HTMLInputElement;
          if (checkbox?.checked) {
            enabledTransitions.push(transition);
          }
        });

        // Ensure at least one transition is enabled (default to fade)
        if (enabledTransitions.length === 0) {
          enabledTransitions.push("fade");
          showMessage(
            "At least one transition must be enabled. Defaulting to 'Fade'.",
            "info",
          );
        }

        currentSettings.transition = {
          enabledTransitions,
          duration: currentSettings.transition?.duration || 800,
        };

        await saveSettings(currentSettings);

        showMessage("Settings saved successfully!", "success");

        // Notify background script to reload settings
        chrome.runtime.sendMessage({ action: "settingsUpdated" }, () => {
          if (chrome.runtime.lastError) {
            options_logger.warn(
              "Background script notification failed:",
              chrome.runtime.lastError,
            );
          }
        });
      } catch (error) {
        options_logger.error("Failed to save settings:", error);
        showMessage("Failed to save settings. Please try again.", "error");
      } finally {
        // Reset button state and hide loading indicator
        showHeaderLoading(false);
        saveSettingsBtn.textContent = originalText;
        (saveSettingsBtn as HTMLButtonElement).disabled = false;
      }
    });
  }

  // Enhanced settings reset with confirmation
  const resetSettingsBtn = document.getElementById("resetSettingsBtn");
  if (resetSettingsBtn) {
    resetSettingsBtn.addEventListener("click", async () => {
      const confirmed = confirm(
        "Are you sure you want to reset all settings to defaults?\n\n" +
          "This will:\n" +
          "• Remove all API keys\n" +
          "• Reset all preferences to defaults\n" +
          "• Clear API key test results\n\n" +
          "This action cannot be undone.",
      );

      if (!confirmed) return;

      try {
        const { DEFAULT_SETTINGS } = await import("./config");
        await saveSettings(DEFAULT_SETTINGS);
        showMessage("Settings reset to defaults", "success");

        // Reload page after brief delay
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } catch (error) {
        options_logger.error("Failed to reset settings:", error);
        showMessage("Failed to reset settings. Please try again.", "error");
      }
    });
  }

  // Enhanced cache management buttons
  const refreshStatsBtn = document.getElementById("refreshStatsBtn");
  if (refreshStatsBtn) {
    refreshStatsBtn.addEventListener("click", async () => {
      const originalText = refreshStatsBtn.textContent;

      try {
        refreshStatsBtn.textContent = "Refreshing...";
        (refreshStatsBtn as HTMLButtonElement).disabled = true;

        await Promise.all([loadCacheStats(), loadHistoryStats()]);

        showMessage("Statistics refreshed", "success");
      } catch (error) {
        options_logger.error("Failed to refresh stats:", error);
        showMessage("Failed to refresh statistics", "error");
      } finally {
        refreshStatsBtn.textContent = originalText;
        (refreshStatsBtn as HTMLButtonElement).disabled = false;
      }
    });
  }

  const clearCacheBtn = document.getElementById("clearCacheBtn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", async () => {
      const confirmed = confirm(
        "Are you sure you want to clear the entire cache?\n\n" +
          "This will delete all stored images and force the extension to re-download them.\n" +
          "This action cannot be undone.",
      );

      if (!confirmed) return;

      const originalText = clearCacheBtn.textContent;

      try {
        clearCacheBtn.textContent = "Clearing...";
        (clearCacheBtn as HTMLButtonElement).disabled = true;

        await clearAllImages();
        await clearHistory(); // Also clear history to avoid broken links
        await loadCacheStats();
        await loadHistoryStats();

        showMessage(
          "Cache cleared successfully. New images will be downloaded automatically.",
          "success",
        );
      } catch (error) {
        options_logger.error("Failed to clear cache:", error);
        showMessage("Failed to clear cache. Please try again.", "error");
      } finally {
        clearCacheBtn.textContent = originalText;
        (clearCacheBtn as HTMLButtonElement).disabled = false;
      }
    });
  }

  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", async () => {
      const confirmed = confirm(
        "Are you sure you want to clear image history?\n\n" +
          "This will delete all navigation history and recently viewed image tracking.\n" +
          "This action cannot be undone.",
      );

      if (!confirmed) return;

      const originalText = clearHistoryBtn.textContent;

      try {
        clearHistoryBtn.textContent = "Clearing...";
        (clearHistoryBtn as HTMLButtonElement).disabled = true;

        await clearHistory();
        await loadHistoryStats();

        showMessage("History cleared successfully", "success");
      } catch (error) {
        options_logger.error("Failed to clear history:", error);
        showMessage("Failed to clear history. Please try again.", "error");
      } finally {
        clearHistoryBtn.textContent = originalText;
        (clearHistoryBtn as HTMLButtonElement).disabled = false;
      }
    });
  }

  // Enhanced cache cleanup button
  const cleanupCacheBtn = document.getElementById("cleanupCacheBtn");
  if (cleanupCacheBtn) {
    cleanupCacheBtn.addEventListener("click", async () => {
      const originalText = cleanupCacheBtn.textContent;

      try {
        cleanupCacheBtn.textContent = "Cleaning...";
        (cleanupCacheBtn as HTMLButtonElement).disabled = true;

        // Clean expired images using enhanced function
        await cleanExpiredImages();
        await loadCacheStats();

        showMessage("Expired images cleaned successfully", "success");
      } catch (error) {
        options_logger.error("Failed to cleanup cache:", error);
        showMessage("Failed to cleanup cache. Please try again.", "error");
      } finally {
        cleanupCacheBtn.textContent = originalText;
        (cleanupCacheBtn as HTMLButtonElement).disabled = false;
      }
    });
  }

  // Force Refresh Cache button
  const forceRefreshCacheBtn = document.getElementById("forceRefreshCacheBtn");
  if (forceRefreshCacheBtn) {
    // Check if button is on cooldown
    const currentSettings = await getSettings();

    const forceRefreshCooldown = currentSettings.forceRefreshCooldown || 0;
    const now = Date.now();

    if (forceRefreshCooldown > now) {
      const remainingSeconds = Math.ceil((forceRefreshCooldown - now) / 1000);
      (forceRefreshCacheBtn as HTMLButtonElement).disabled = true;
      forceRefreshCacheBtn.textContent = `Wait ${remainingSeconds}s`;
      // Update countdown every second
      const countdownInterval = setInterval(() => {
        const currentNow = Date.now();
        if (forceRefreshCooldown <= currentNow) {
          clearInterval(countdownInterval);
          (forceRefreshCacheBtn as HTMLButtonElement).disabled = false;
          forceRefreshCacheBtn.textContent = "Force Refresh Cache";
        } else {
          const remaining = Math.ceil(
            (forceRefreshCooldown - currentNow) / 1000,
          );
          forceRefreshCacheBtn.textContent = `Wait ${remaining}s`;
        }
      }, 1000);
    }

    forceRefreshCacheBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      options_logger.debug("Force refresh button clicked!");

      const originalText = forceRefreshCacheBtn.textContent;

      options_logger.debug("Original Text", { originalText });

      try {
        showHeaderLoading(true);
        forceRefreshCacheBtn.textContent = "Refreshing...";
        (forceRefreshCacheBtn as HTMLButtonElement).disabled = true;

        // First, check if service worker is responsive
        options_logger.debug("Checking service worker responsiveness...");
        
        // Set a timeout to prevent infinite "Refreshing..." state
        const timeoutId = setTimeout(() => {
          options_logger.error("Force refresh timed out after 30 seconds");
          showMessage(
            "Force refresh timed out. The background script may not be responding.",
            "error",
          );
          (forceRefreshCacheBtn as HTMLButtonElement).disabled = false;
          forceRefreshCacheBtn.textContent = originalText;
          showHeaderLoading(false);
        }, 30000); // 30 second timeout

        // Send message to background script to force refresh cache
        chrome.runtime.sendMessage(
          { action: "forceRefreshCache" },
          async (response) => {
            clearTimeout(timeoutId); // Clear timeout on response

            options_logger.debug("Received response:", response);
            options_logger.debug("Last error:", chrome.runtime.lastError);

            if (chrome.runtime.lastError) {
              options_logger.error(
                "Force refresh failed:",
                chrome.runtime.lastError,
              );
              showMessage(
                `Force refresh failed: ${chrome.runtime.lastError.message}`,
                "error",
              );
              (forceRefreshCacheBtn as HTMLButtonElement).disabled = false;
              forceRefreshCacheBtn.textContent = originalText;
              showHeaderLoading(false);
            } else if (response?.success) {
              options_logger.info("Force refresh successful!");
              showMessage(
                "Cache refreshed successfully! New images will be available shortly.",
                "success",
              );

              // Set 1-minute cooldown
              const cooldownEnd = Date.now() + 60000; // 60 seconds
              currentSettings.forceRefreshCooldown = cooldownEnd;
              await saveSettings(currentSettings);

              // Start countdown
              let remainingSeconds = 60;
              forceRefreshCacheBtn.textContent = `Wait ${remainingSeconds}s`;

              const countdownInterval = setInterval(() => {
                remainingSeconds--;
                if (remainingSeconds <= 0) {
                  clearInterval(countdownInterval);
                  (forceRefreshCacheBtn as HTMLButtonElement).disabled = false;
                  forceRefreshCacheBtn.textContent = originalText;
                } else {
                  forceRefreshCacheBtn.textContent = `Wait ${remainingSeconds}s`;
                }
              }, 1000);

              // Refresh cache statistics after successful refresh
              setTimeout(loadCacheStats, 2000);
              showHeaderLoading(false);
            } else {
              options_logger.error("Force refresh returned failure:", response);
              showMessage(
                response?.error ||
                  "Cache refresh failed. Please check your API keys and try again.",
                "error",
              );
              (forceRefreshCacheBtn as HTMLButtonElement).disabled = false;
              forceRefreshCacheBtn.textContent = originalText;
              showHeaderLoading(false);
            }
          },
        );
      } catch (error) {
        options_logger.error("Failed to trigger cache refresh:", error);
        showMessage(
          "Failed to trigger cache refresh. Please try again.",
          "error",
        );
        (forceRefreshCacheBtn as HTMLButtonElement).disabled = false;
        forceRefreshCacheBtn.textContent = originalText;
        showHeaderLoading(false);
      }
    });
  }
}

/**
 * Sets up the live log viewer using BroadcastChannel
 * Receives logs from all parts of the extension and displays them
 */
function setupLogViewer(): void {
  const container = document.getElementById("logsContainer");
  const clearBtn = document.getElementById("clearLogsBtn");
  const popoutBtn = document.getElementById("popoutLogsBtn");
  const autoScrollCheckbox = document.getElementById(
    "logsAutoScroll",
  ) as HTMLInputElement;

  // Popup elements
  const popup = document.getElementById("logPopup");
  const popupContainer = document.getElementById("popupLogsContainer");
  const closePopupBtn = document.getElementById("closePopupBtn");

  if (!container || !clearBtn) return;

  let isFirstLog = true;

  // Clear button handler - clears both
  clearBtn.addEventListener("click", () => {
    const emptyMsg =
      '<div style="color: #666; padding-top: 20px;">Waiting for logs...</div>';
    const mainEmptyMsg =
      '<div style="color: #666; padding-top: 130px;">Waiting for logs...</div>';

    container.innerHTML = mainEmptyMsg;

    if (popupContainer) {
      popupContainer.innerHTML = emptyMsg;
    }
    isFirstLog = true;
  });

  // Popout handlers
  if (popoutBtn && popup) {
    popoutBtn.addEventListener("click", () => {
      popup.classList.remove("hidden");
      // Sync content if empty for popup
      if (isFirstLog && popupContainer && popupContainer.innerHTML === "") {
        popupContainer.innerHTML =
          '<div style="color: #666; text-align: center; padding-top: 20px;">Waiting for logs...</div>';
      }
    });
  }

  if (closePopupBtn && popup) {
    closePopupBtn.addEventListener("click", () => {
      popup.classList.add("hidden");
    });
  }

  // Broadcast Channel Listener
  try {
    const channel = new BroadcastChannel("extension_debug_logs");
    channel.onmessage = (event) => {
      const { timestamp, level, name, rawMessage, message } = event.data;

      if (isFirstLog) {
        container.innerHTML = "";
        if (popupContainer) popupContainer.innerHTML = "";
        isFirstLog = false;
      }

      // Create log line content
      const timeStr = new Date(timestamp).toLocaleTimeString();
      const textContent = rawMessage || message;

      // Color coding based on level
      let color = "#ddd";
      if (level === "ERROR") color = "#ff6b6b";
      else if (level === "WARN") color = "#feca57";
      else if (level === "INFO") color = "#54a0ff";
      else if (level === "DEBUG") color = "#1dd1a1";

      const logHtml = `
        <span style="color: #666; font-size: 11px;">[${timeStr}]</span>
        <span style="color: ${color}; font-weight: bold; min-width: 50px; display: inline-block;">[${level}]</span>
        <span style="color: #aaa; font-weight: 600;">[${name}]:</span>
        <span style="color: ${color}; white-space: pre-wrap;">${textContent}</span>
      `;

      // Helper to create line element
      const createLine = (isPopup = false) => {
        const line = document.createElement("div");
        line.style.borderBottom = "1px solid #222";
        line.style.padding = isPopup ? "1px 2px" : "4px 0";
        line.style.fontSize = "12px";
        line.style.lineHeight = "1.4";
        line.innerHTML = logHtml;
        return line;
      };

      // Append to main container
      container.appendChild(createLine(false));

      // Append to popup container
      if (popupContainer) {
        popupContainer.appendChild(createLine(true));
      }

      // Auto-scroll if enabled
      if (autoScrollCheckbox && autoScrollCheckbox.checked) {
        container.scrollTop = container.scrollHeight;
        if (popupContainer) {
          popupContainer.scrollTop = popupContainer.scrollHeight;
        }
      }
    };
  } catch (e) {
    console.error("BroadcastChannel not supported", e);
    const errorMsg =
      '<div style="color: #ff6b6b; padding: 20px;">Error: Log viewer requires BroadcastChannel support.</div>';
    container.innerHTML = errorMsg;
    if (popupContainer) popupContainer.innerHTML = errorMsg;
  }
}

/**
 * Initializes the options page with enhanced functionality
 * Sets up all UI elements, loads current settings, and configures event listeners
 * Includes comprehensive error handling and user experience enhancements
 */
async function init(): Promise<void> {
  try {
    options_logger.debug("Options settings initializing... ☠️");

    const loadingEl = document.getElementById("loading");

    if (loadingEl) {
      loadingEl.style.display = "block";
    }

    const settings = await getSettings();

    options_logger.debug("settings have been loaded", { settings });

    // Render API keys with enhanced status tracking
    renderApiKeys(settings);

    // Load search preferences with validation
    const unsplashKeywordsEl = document.getElementById(
      "unsplashKeywords",
    ) as HTMLTextAreaElement;
    const pexelsKeywordsEl = document.getElementById(
      "pexelsKeywords",
    ) as HTMLTextAreaElement;

    if (unsplashKeywordsEl) {
      unsplashKeywordsEl.value = settings.searchPreferences.unsplashKeywords;
      // Add character counter if element exists
      const unsplashCounterEl = document.getElementById(
        "unsplashKeywordsCounter",
      );
      if (unsplashCounterEl) {
        unsplashCounterEl.textContent = `${unsplashKeywordsEl.value.length} characters`;
      }
    }

    if (pexelsKeywordsEl) {
      pexelsKeywordsEl.value = settings.searchPreferences.pexelsKeywords;
      // Add character counter if element exists
      const pexelsCounterEl = document.getElementById("pexelsKeywordsCounter");
      if (pexelsCounterEl) {
        pexelsCounterEl.textContent = `${pexelsKeywordsEl.value.length} characters`;
      }
    }

    // Load auto refresh settings with validation
    const autoRefreshEnabledEl = document.getElementById(
      "autoRefreshEnabled",
    ) as HTMLInputElement;
    const autoRefreshIntervalEl = document.getElementById(
      "autoRefreshInterval",
    ) as HTMLInputElement;

    if (autoRefreshEnabledEl) {
      autoRefreshEnabledEl.checked = settings.autoRefresh.enabled;
    }

    if (autoRefreshIntervalEl) {
      // Ensure interval is within valid bounds
      const validInterval = Math.max(
        MIN_AUTO_REFRESH_INTERVAL,
        Math.min(MAX_AUTO_REFRESH_INTERVAL, settings.autoRefresh.interval),
      );
      autoRefreshIntervalEl.value = validInterval.toString();

      const intervalDisplayEl = document.getElementById("intervalDisplay");
      if (intervalDisplayEl) {
        intervalDisplayEl.textContent = `${validInterval}s`;
      }
    }

    // Load clock settings
    const clockSettings = [
      { id: "clockEnabled", value: settings.clock.enabled },
      { id: "clock24Hour", value: settings.clock.format24 },
      { id: "clockShowSeconds", value: settings.clock.showSeconds },
      { id: "clockShowDate", value: settings.clock.showDate },
    ];

    clockSettings.forEach(({ id, value }) => {
      const element = document.getElementById(id) as HTMLInputElement;
      if (element) {
        element.checked = value;
      }
    });

    // Load UI button visibility settings
    const showRefreshButtonEl = document.getElementById(
      "showRefreshButton",
    ) as HTMLInputElement;
    const showSettingsButtonEl = document.getElementById(
      "showSettingsButton",
    ) as HTMLInputElement;

    if (showRefreshButtonEl) {
      showRefreshButtonEl.checked = settings.ui?.showRefreshButton ?? true;
    }

    if (showSettingsButtonEl) {
      showSettingsButtonEl.checked = settings.ui?.showSettingsButton ?? true;
    }

    // Load history settings with validation
    const historyEnabledEl = document.getElementById(
      "historyEnabled",
    ) as HTMLInputElement;
    const historyMaxSizeEl = document.getElementById(
      "historyMaxSize",
    ) as HTMLInputElement;

    if (historyEnabledEl) {
      historyEnabledEl.checked =
        settings.history?.enabled ?? DEFAULT_HISTORY_ENABLED;
    }

    if (historyMaxSizeEl) {
      const validMaxSize =
        settings.history?.maxSize ?? DEFAULT_HISTORY_MAX_SIZE;
      historyMaxSizeEl.value = validMaxSize.toString();

      const historySizeDisplayEl =
        document.getElementById("historySizeDisplay");
      if (historySizeDisplayEl) {
        historySizeDisplayEl.textContent = validMaxSize.toString();
      }
    }

    // Load cache settings
    const permanentCacheEnabledEl = document.getElementById(
      "permanentCacheEnabled",
    ) as HTMLInputElement;
    if (permanentCacheEnabledEl) {
      permanentCacheEnabledEl.checked = settings.cache?.permanentMode ?? false;
    }

    // Load and render transition settings
    renderTransitionsList(settings);

    // Load statistics in parallel for better performance
    // Capture lastFetch to reuse and avoid duplicate DB call
    const [lastFetch] = await Promise.all([
      loadCacheStats(),
      loadHistoryStats(),
    ]);

    // Set up enhanced event listeners
    setupEventListeners();

    // Set up log viewer
    setupLogViewer();

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    showMessage("Options loaded successfully", "success");

    // Check for stale cache after initialization completes, reusing lastFetch
    checkAndTriggerRefresh(lastFetch).catch((error) => {
      options_logger.error("Background refresh check failed:", error);
    });
  } catch (error) {
    options_logger.error("An error occurred when initializing options page:", {
      error,
    });
    showMessage("Failed to load options. Please refresh the page.", "error");
  }
}

/**
 * Checks if background refresh is needed and triggers it if necessary
 * Ensures missed alarms don't leave cache stale by proactively checking refresh status
 * Integrates with enhanced constants and improved error handling
 * @param lastFetchTime - Optional pre-fetched last fetch time to avoid duplicate DB calls
 */
async function checkAndTriggerRefresh(
  lastFetchTime?: number | null,
): Promise<void> {
  try {
    const lastFetch = lastFetchTime ?? (await getLastFetchTime());
    const now = Date.now();

    if (lastFetch && now - lastFetch >= REFRESH_INTERVAL_MS) {
      options_logger.debug(
        "⏰ Refresh overdue, notifying background worker...",
      );

      // Send message to background script with enhanced error handling
      chrome.runtime.sendMessage(
        { action: "checkRefreshNeeded" },
        (response) => {
          if (chrome.runtime.lastError) {
            options_logger.warn(
              "Background refresh check failed:",
              chrome.runtime.lastError,
            );
            showMessage(
              "Background refresh check failed. Images may not be up to date.",
              "info",
            );
          } else if (response?.triggered) {
            showMessage("Background refresh triggered successfully", "info");
          }
        },
      );
    } else {
      options_logger.debug("✅ Cache is fresh, no refresh needed");
    }
  } catch (error) {
    options_logger.error("Failed to check refresh status:", error);
    // Don't show error message as this is a background operation
  }
}

/**
 * Initializes the options page when DOM is ready
 * Sets up the complete page functionality and performs initial data loading
 */
document.addEventListener("DOMContentLoaded", () => {
  // Initialize page - checkAndTriggerRefresh is now called within init() to avoid race conditions
  init().catch((error) => {
    options_logger.error("Failed to initialize options page", { error });
    showMessage(
      "Failed to initialize options page. Please refresh and try again.",
      "error",
    );
  });
});
