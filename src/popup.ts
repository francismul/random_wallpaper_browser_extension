/**
 * Popup
 * Handles display and management of user settings, API keys, and cache statistics
 * for the random wallpaper browser extension.
 */

import { createIcons, icons } from "lucide";

import {
  getHistory,
  getLastFetchTime,
  getAllValidImages,
  getHistoryImageById,
} from "./db";
import { Logger } from "./logger";
import { ImageData } from "./config";
import { formatRelativeTime } from "./utils";
import { checkOnline } from "./api";
import {
  requestCurrentImageId,
  subscribeToCurrentImageUpdates,
} from "./messaging";

const popup_logger = new Logger("Popup");

function showMessage(text: string, type: "success" | "error" | "info" = "info") {
  // Simple transient message overlay for quick feedback
  const existing = document.getElementById("popupMessage");
  if (existing) existing.remove();

  const message = document.createElement("div");
  message.id = "popupMessage";
  message.textContent = text;
  message.style.position = "fixed";
  message.style.bottom = "16px";
  message.style.left = "50%";
  message.style.transform = "translateX(-50%)";
  message.style.padding = "10px 14px";
  message.style.borderRadius = "999px";
  message.style.fontSize = "12px";
  message.style.zIndex = "999";
  message.style.boxShadow = "0 8px 16px rgba(0,0,0,0.4)";
  message.style.opacity = "0";
  message.style.transition = "opacity 0.2s ease";

  switch (type) {
    case "success":
      message.style.background = "#065f46";
      message.style.color = "#a7f3d0";
      break;
    case "error":
      message.style.background = "#7f1d1d";
      message.style.color = "#fecaca";
      break;
    default:
      message.style.background = "rgba(31, 41, 55, 0.95)";
      message.style.color = "#e5e7eb";
  }

  document.body.appendChild(message);
  requestAnimationFrame(() => (message.style.opacity = "1"));
  setTimeout(() => {
    message.style.opacity = "0";
    setTimeout(() => message.remove(), 300);
  }, 2500);
}

let currentImageData: ImageData | null = null;
let currentBlobUrl: string | null = null;

function cleanup() {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

window.addEventListener("unload", cleanup);

/**
 * Gets the most recently viewed image from history, falling back to any valid image.
 */
async function getCurrentImage(): Promise<ImageData | null> {
  try {
    const history = await getHistory(1);
    if (history.length > 0) {
      const entry = history[0]!;
      const imageData = await getHistoryImageById(entry.imageId);
      if (imageData) return imageData;
    }
  } catch (e) {
    popup_logger.warn(
      "Could not load image from history, falling back to any valid image",
      e,
    );
  }

  try {
    const images = await getAllValidImages();
    if (images.length > 0) {
      return images[Math.floor(Math.random() * images.length)]!;
    }
  } catch (e) {
    popup_logger.error("Could not load any valid image", e);
  }
  return null;
}

/**
 * Synchronize the popup to a new image ID.
 * Loads the image from the database and updates the thumbnail if found.
 */
async function syncToCurrentImage(imageId: string): Promise<void> {
  try {
    if (currentImageData?.id === imageId) return; // already showing

    const imageData = await getHistoryImageById(imageId);
    if (imageData) {
      currentImageData = imageData;
      await loadThumbnail(imageData);
    }
  } catch (e) {
    popup_logger.warn("Failed to sync current image from ID", e);
  }
}

function getSourceDisplayName(source: ImageData["source"]): string {
  switch (source) {
    case "unsplash":
      return "Unsplash";
    case "pexels":
      return "Pexels";
    default:
      return "Wallpaper";
  }
}

async function loadThumbnail(imageData: ImageData) {
  cleanup();

  const thumbnailEl = document.getElementById("thumbnail") as HTMLElement;
  const badgeEl = document.getElementById("sourceBadge") as HTMLElement;
  const authorEl = document.getElementById("photoAuthor") as HTMLElement;

  const blobUrl = URL.createObjectURL(imageData.blob);
  currentBlobUrl = blobUrl;

  thumbnailEl.style.backgroundImage = `url('${blobUrl}')`;
  badgeEl.textContent = getSourceDisplayName(imageData.source);

  const authorLink = document.createElement("a");
  authorLink.href = imageData.authorUrl || "#";
  authorLink.target = "_blank";
  authorLink.textContent = imageData.author || "Unknown";
  authorLink.style.color = "white";
  authorLink.style.textDecoration = "none";

  authorEl.innerHTML = "Photo by ";
  authorEl.appendChild(authorLink);
}

async function loadStatus() {
  const lastFetchEl = document.getElementById("lastFetchValue") as HTMLElement;
  const cacheEl = document.getElementById("cacheValue") as HTMLElement;
  const cacheBarEl = document.getElementById("cacheFill") as HTMLElement;
  const statusBadgeEl = document.getElementById("statusBadge") as HTMLElement;
  const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;

  try {
    const [images, lastFetch] = await Promise.all([
      getAllValidImages(),
      getLastFetchTime(),
    ]);

    // Online status (uses real connectivity check)
    const online = await checkOnline();
    statusBadgeEl.textContent = online ? "Online" : "Offline";
    statusBadgeEl.className = online
      ? "status-badge online"
      : "status-badge offline";

    if (refreshBtn) {
      refreshBtn.disabled = !online;
      refreshBtn.title = online ? "" : "Offline — check your connection";
    }

    // Last fetched
    lastFetchEl.textContent = lastFetch
      ? formatRelativeTime(lastFetch)
      : "Never";

    // Cache count
    const count = images.length;
    cacheEl.textContent = `${count} image${count !== 1 ? "s" : ""}`;

    // Cache bar (progress relative to 30 max)
    const pct = Math.min(100, Math.round((count / 30) * 100));
    cacheBarEl.style.width = `${pct}%`;
  } catch (e) {
    popup_logger.error("Failed to load status", e);
    lastFetchEl.textContent = "—";
    cacheEl.textContent = "—";
  }
}

async function handleRefresh() {
  const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
  const icon = refreshBtn.querySelector("i");
  if (icon) icon.style.animation = "spin 0.8s linear infinite";
  refreshBtn.disabled = true;

  try {
    const online = await checkOnline();
    if (!online) {
      showMessage(
        "Cannot refresh: offline. Please check your internet connection.",
        "error",
      );
      return;
    }

    chrome.runtime.sendMessage({ action: "checkRefreshNeeded" });

    // Re-load thumbnail after a short delay for visual feedback
    await new Promise((r) => setTimeout(r, 800));
    const imageData = await getCurrentImage();
    if (imageData) {
      currentImageData = imageData;
      await loadThumbnail(imageData);
    }
    await loadStatus();
  } catch (e) {
    popup_logger.error("Refresh failed", e);
  } finally {
    if (icon) icon.style.animation = "";
    refreshBtn.disabled = false;
  }
}

async function init() {
  createIcons({ icons });

  const imageData = await getCurrentImage();
  if (imageData) {
    currentImageData = imageData;
    await loadThumbnail(imageData);
  } else {
    // No wallpaper available — show placeholder state
    const thumbnailEl = document.getElementById("thumbnail") as HTMLElement;
    thumbnailEl.style.background = "#27272a";
    const badgeEl = document.getElementById("sourceBadge") as HTMLElement;
    badgeEl.textContent = "No image";
  }

  // Listen for image changes from other contexts (new tab, service worker)
  const unsubscribe = subscribeToCurrentImageUpdates((imageId) => {
    syncToCurrentImage(imageId).catch((e) => {
      popup_logger.error("Failed to sync image from message", e);
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.currentImageId?.newValue) {
      const newId = changes.currentImageId.newValue;
      if (typeof newId === "string") {
        syncToCurrentImage(newId).catch((e) => {
          popup_logger.error("Failed to sync image from storage change", e);
        });
      }
    }
  });

  // Unsubscribe when popup unloads
  window.addEventListener("unload", () => unsubscribe());

  await loadStatus();

  // Update online/offline status in real time
  window.addEventListener("online", loadStatus);
  window.addEventListener("offline", loadStatus);

  // Try to synchronise to the current image immediately (without waiting for storage)
  try {
    const currentImageId = await requestCurrentImageId();
    if (currentImageId) {
      await syncToCurrentImage(currentImageId);
    }
  } catch (e) {
    popup_logger.debug("Could not sync current image on init", e);
  }

  // Wire up buttons
  document
    .getElementById("refreshBtn")
    ?.addEventListener("click", handleRefresh);

  document.getElementById("heartBtn")?.addEventListener("click", () => {
    if (!currentImageData) return;
    const blobUrl = URL.createObjectURL(currentImageData.blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `wallpaper-${currentImageData.id}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document
    .getElementById("openSettingsLink")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
}

document.addEventListener("DOMContentLoaded", init);
