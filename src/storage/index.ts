/**
 * Storage module for the random wallpaper browser extension.
 * Provides a way to manage image storage and caching.
 */

import { Logger } from "../logger";
import { DEFAULT_SETTINGS, Settings } from "../config";

const storage_logger = new Logger("Storage");

/**
 * Retrieves a value from Chrome local storage by key
 * @param key The key to retrieve
 * @returns Promise that resolves to the stored value or undefined
 */
export function getFromStorage<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result: any) => {
      resolve(result[key]);
    });
  });
}

/**
 * Retrieves extension settings from Chrome local storage
 * Returns default values if no settings are found
 * @returns Promise that resolves to the Settings object
 */
export async function getSettings(): Promise<Settings> {
  storage_logger.debug("Fetching settings from storage");
  let settings = await getFromStorage<Settings>("settings");

  if (!settings) {
    storage_logger.debug("Nothing in the store");
    storage_logger.debug("Defaulting to default settings");
    return DEFAULT_SETTINGS;
  }

  storage_logger.debug("Settings fetched successfully");
  return settings;
}

/**
 * Saves settings to Chrome storage
 * @param settings - The settings object to persist
 * @returns Promise that resolves when settings are saved
 */
export async function saveSettings(settings: Settings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
  });
}

/**
 * Gets the last used keyword index for sequential selection
 * @returns Promise that resolves to the last keyword index
 */
export async function getLastKeywordIndex(): Promise<number> {
  storage_logger.debug("Fetching last keyword index");
  const index = await getFromStorage<number>("lastKeywordIndex");
  return index ?? -1;
}

/**
 * Saves the last used keyword index
 * @param index - The keyword index to save
 * @returns Promise that resolves when index is saved
 */
export async function saveLastKeywordIndex(index: number): Promise<void> {
  storage_logger.debug("Saving last keyword index:", index);
  return new Promise((resolve) => {
    chrome.storage.local.set({ lastKeywordIndex: index }, resolve);
  });
}
