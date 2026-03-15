/**
 * Shared logic for the New Tab page.
 *
 * This module contains pure functions that can be unit tested without DOM access.
 * The goal is to isolate logic from DOM manipulation so the UI code remains thin.
 */

import type { TransitionType, ImageData, Settings } from "./config";

/**
 * Animation direction types for image transitions
 */
export type AnimationDirection = "next" | "prev" | "fade";

/**
 * Build a shuffled permutation of image IDs.
 * Uses Fisher-Yates to ensure uniform randomness.
 * If `lastId` is specified, ensures it is not the first element (to avoid
 * immediate repeats when cycling).
 */
export function buildShuffleOrder(
  imageIds: string[],
  lastId?: string,
): string[] {
  const ids = [...imageIds];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = tmp;
  }

  if (lastId && ids.length > 1 && ids[0] === lastId) {
    const tmp = ids[0]!;
    ids[0] = ids[1]!;
    ids[1] = tmp;
  }

  return ids;
}

/**
 * Choose the next image ID from a shuffled queue.
 * Skips any IDs found in `recentIds` if possible.
 * Returns the next ID and updated shuffle index.
 */
export function pickNextFromShuffle(
  shuffleOrder: string[],
  shuffleIndex: number,
  recentIds: Set<string>,
): { nextId?: string; nextIndex: number } {
  if (shuffleOrder.length === 0) {
    return { nextIndex: 0 };
  }

  const maxAttempts = shuffleOrder.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const idx = shuffleIndex % shuffleOrder.length;
    const candidateId = shuffleOrder[idx];
    shuffleIndex = (idx + 1) % shuffleOrder.length;

    if (!candidateId) continue;
    if (!recentIds.has(candidateId)) {
      return { nextId: candidateId, nextIndex: shuffleIndex };
    }
  }

  // If all candidates are recent, just return the next in queue.
  const idx = shuffleIndex % shuffleOrder.length;
  const fallbackId = shuffleOrder[idx]!;
  return {
    nextId: fallbackId,
    nextIndex: (idx + 1) % shuffleOrder.length,
  };
}


/**
 * Selects a random transition from the enabled list.
 * Falls back to a default list if none are enabled.
 */
export function getRandomTransition(
  enabledTransitions: TransitionType[],
  defaultTransitions: TransitionType[] = ["fade", "slide", "wipe"],
): TransitionType {
  const validTransitions: TransitionType[] =
    enabledTransitions.length > 0 ? enabledTransitions : defaultTransitions;
  const randomIndex = Math.floor(Math.random() * validTransitions.length);
  return validTransitions[randomIndex] as TransitionType;
}

/**
 * Returns the source URL for a given image source type.
 */
export function getSourceUrl(source: ImageData["source"]): string {
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
 * Returns a user-friendly display name for the image source.
 */
export function getSourceDisplayName(source: ImageData["source"]): string {
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
 * Formats a Date object into a time string.
 * Returns both time string and optional period (AM/PM) for 12h mode.
 */
export function formatTime(
  date: Date,
  format24: boolean,
  showSeconds: boolean,
): { time: string; period: string | null } {
  let hours = date.getHours();
  let period: string | null = null;

  const minutes = date.getMinutes();
  const seconds = date.getSeconds();

  if (format24) {
    const h = hours.toString().padStart(2, "0");
    const m = minutes.toString().padStart(2, "0");
    const s = seconds.toString().padStart(2, "0");
    return {
      time: showSeconds ? `${h}:${m}:${s}` : `${h}:${m}`,
      period: null,
    };
  }

  period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const h = hours.toString();
  const m = minutes.toString().padStart(2, "0");
  const s = seconds.toString().padStart(2, "0");

  return {
    time: showSeconds ? `${h}:${m}:${s}` : `${h}:${m}`,
    period,
  };
}

/**
 * Formats a Date object into a user-friendly date string.
 */
export function formatDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  return date.toLocaleDateString("en-US", options);
}

/**
 * Determines whether auto-refresh should be active based on settings.
 * This is extracted to allow unit testing and keep UI code clean.
 */
export function isAutoRefreshEnabled(settings: Settings): boolean {
  return settings.autoRefresh?.enabled === true;
}
