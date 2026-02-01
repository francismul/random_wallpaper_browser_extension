/**
 * Indexeddb database module for the random wallpaper browser extension.
 * Provides a way to store and retrieve images and metadata.
 */

import {
  IMAGES_STORE_NAME,
  DB_NAME,
  DB_VERSION,
  METADATA_STORE_NAME,
  HISTORY_STORE_NAME,
  Metadata,
  HistoryEntry,
  MIN_STORAGE_THRESHOLD_GB,
  ImageData,
  PERMANENT_CACHE_EXPIRY_MS,
} from "../config";
import { Logger } from "../logger";
import { getRandomIndex } from "../utils";

const db_logger = new Logger("IndexedDB");

// Simple lock to prevent concurrent write operations
let dbWriteLock = Promise.resolve();

/**
 * Acquires a write lock to prevent concurrent database writes
 * Returns a promise that resolves when the lock is acquired
 */
async function acquireWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const currentLock = dbWriteLock;
  let releaseLock: (() => void) | undefined;

  dbWriteLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  try {
    await currentLock;
    return await operation();
  } finally {
    if (releaseLock) {
      releaseLock();
    }
  }
}

/**
 * Check if an image has been viewed recently (within the last N hours)
 * Useful for avoiding showing the same image too frequently
 * @param imageId - Unique identifier of the image to check
 * @param withinHours - Number of hours to check back (default: 24)
 * @returns Promise that resolves to true if image was viewed recently
 * @throws Error if database operation fails
 */
export async function wasImageViewedRecently(
  imageId: string,
  withinHours: number = 24,
): Promise<boolean> {
  db_logger.debug("Checking if image was viewed recently", {
    imageId,
    withinHours,
  });
  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);
  const index = store.index("viewedAt");

  const cutoffTime = Date.now() - withinHours * 60 * 60 * 1000;

  db_logger.debug("Image Id passed:", { imageId });

  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.lowerBound(cutoffTime);
    const cursorRequest = index.openCursor(range);

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        const entry = cursor.value as HistoryEntry;

        if (entry.imageId === imageId) {
          db.close();
          db_logger.debug("Image was viewed recently", { imageId });
          resolve(true);
          return;
        }
        cursor.continue();
      } else {
        db.close();
        db_logger.debug("Image was not viewed recently", { imageId });
        resolve(false);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      db_logger.error(
        "A db transaction error has occurred",
        cursorRequest.error,
      );
      reject(cursorRequest.error);
    };
  });
}

/**
 * Initialize and open the IndexedDB database
 * Creates object stores and indexes if they don't exist
 * @returns Promise that resolves to the opened IDBDatabase instance
 * @throws Error if database initialization fails
 */
export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    db_logger.debug("Opening database...");
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      db_logger.error("Failed to open database:", request.error);
      reject(request.error);
    };
    request.onsuccess = () => {
      db_logger.debug("Database opened successfully");
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      db_logger.debug("Upgrading database...");
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(IMAGES_STORE_NAME)) {
        const store = db.createObjectStore(IMAGES_STORE_NAME, {
          keyPath: "id",
        });

        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
        db_logger.debug("Created images object store and indexes");
      }

      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        db.createObjectStore(METADATA_STORE_NAME, { keyPath: "key" });
        db_logger.debug("Created metadata object store");
      }

      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const store = db.createObjectStore(HISTORY_STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });

        store.createIndex("viewedAt", "viewedAt", { unique: false });
        store.createIndex("source", "source", { unique: false });
        store.createIndex("sourceViewedAt", ["source", "viewedAt"], {
          unique: false,
        });
        db_logger.debug("Created history object store and indexes");
      }
    };
  });
}

/**
 * Store multiple images in the database
 * Uses a single transaction for better performance
 * Protected by write lock to prevent concurrent modifications
 * @param images - Array of ImageData objects to store
 * @returns Promise that resolves when all images are stored
 * @throws Error if storage operation fails
 */
export async function storeImages(images: ImageData[]): Promise<void> {
  db_logger.debug("Storing images to the db");

  return acquireWriteLock(async () => {
    if (images.length === 0) return;

    const db = await initDB();

    const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
    const store = transaction.objectStore(IMAGES_STORE_NAME);

    for (const image of images) {
      store.put(image);
      db_logger.debug(`Queued image ${image.id} for storage`);
    }

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        db.close();
        db_logger.debug(`All images stored successfully`);
        resolve();
      };

      transaction.onerror = () => {
        db.close();
        db_logger.error(`Error storing images:`, transaction.error);
        reject(transaction.error);
      };
    });
  });
}

/**
 * Get all valid (non-expired) images from the database
 * Uses index-based cursor for memory efficiency, only processes valid images
 * @returns Promise that resolves to an array of valid ImageData objects
 * @throws Error if database operation fails
 */
export async function getAllValidImages(): Promise<ImageData[]> {
  db_logger.debug("Getting all valid images from the db");

  const db = await initDB();

  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  const index = store.index("expiresAt");

  const now = Date.now();

  return new Promise((resolve, reject) => {
    const validImages: ImageData[] = [];

    const cursorRequest = index.openCursor(IDBKeyRange.lowerBound(now));

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        validImages.push(cursor.value as ImageData);
        cursor.continue();
      } else {
        db.close();
        resolve(validImages);
        db_logger.debug(
          `Fetched ${validImages.length} valid images from the db`,
        );
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      db_logger.error(
        "A db transaction error has occurred",
        cursorRequest.error,
      );
      reject(cursorRequest.error);
    };
  });
}

// Optimize this specific function to reuse connection
export async function getRandomImage(): Promise<ImageData | null> {
  const db = await initDB();
  let attempts = 3;

  try {
    let image = await _getRandomImageWithDB(db);

    while (attempts >= 0) {
      if (!image) return null;

      if (!(await wasImageViewedRecently(image.id, 0.3))) {
        return image;
      }
      db_logger.debug("Getting new Random Image, attempt:", attempts);
      image = await _getRandomImageWithDB(db);
      attempts -= 1;
    }

    return image;
  } finally {
    db.close();
  }
}

// Helper that accepts an existing db connection
async function _getRandomImageWithDB(
  db: IDBDatabase,
): Promise<ImageData | null> {
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);
  const index = store.index("expiresAt");
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const countRequest = index.count(IDBKeyRange.lowerBound(now));

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count === 0) {
        db.close();
        db_logger.debug("No valid images found in the db");
        return resolve(null);
      }

      const randomIndex = getRandomIndex(count);
      let current = 0;

      const cursorRequest = index.openCursor(IDBKeyRange.lowerBound(now));
      cursorRequest.onsuccess = async (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) {
          db.close();
          db_logger.warn(
            "Cursor ended unexpectedly before finding random image. This may indicate a race condition with image expiry.",
          );
          resolve(null);
          return;
        }
        db_logger.debug("Current Value:", current, "Random Value:", randomIndex);
        if (current === randomIndex) {
          resolve(cursor.value as ImageData);
        } else {
          current++;
          cursor.continue();
        }
      };
      cursorRequest.onerror = () => {
        db.close();
        db_logger.error("Error iterating cursor:", cursorRequest.error);
        reject(cursorRequest.error);
      };
    };
  });
}

/**
 * Remove all expired images from the database
 * Iterates through all images and deletes those past their expiration time
 * Protected by write lock to prevent concurrent modifications
 * @returns Promise that resolves to the number of images deleted
 * @throws Error if database operation fails
 */
export async function cleanExpiredImages(): Promise<number> {
  db_logger.debug("Performing cleanup for expired images at", {
    date: Date.now(),
  });

  return acquireWriteLock(async () => {
    const now = Date.now();
    const db = await initDB();
    const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
    const store = transaction.objectStore(IMAGES_STORE_NAME);
    const index = store.index("expiresAt");

    let deletedCount = 0;

    return new Promise((resolve, reject) => {
      // Use index to only iterate through expired images (more efficient)
      const cursorRequest = index.openCursor(IDBKeyRange.upperBound(now));

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          cursor.delete();
          db_logger.debug(`Deleted an expired item`);
          deletedCount++;
          cursor.continue();
        } else {
          db.close();
          db_logger.debug(`Deleted ${deletedCount} items.`);
          resolve(deletedCount);
        }
      };

      cursorRequest.onerror = () => {
        db.close();
        db_logger.error(
          `DB cursor error when deleting expired items`,
          cursorRequest.error,
        );
        reject(cursorRequest.error);
      };
    });
  });
}

/**
 * Clear all images from the database
 * Useful for resetting the cache or freeing up storage space
 * Protected by write lock to prevent concurrent modifications
 * @returns Promise that resolves when all images are cleared
 * @throws Error if database operation fails
 */
export async function clearAllImages(): Promise<void> {
  db_logger.debug("Clearing all images from the db");

  return acquireWriteLock(async () => {
    const db = await initDB();
    const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
    const store = transaction.objectStore(IMAGES_STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        db.close();
        db_logger.debug("All images cleared from the db");
        resolve();
      };

      request.onerror = () => {
        db.close();
        db_logger.error("A db transaction error has occurred", request.error);
        reject(request.error);
      };
    });
  });
}

/**
 * Store the timestamp of the last fetch operation
 * Used to track when images were last retrieved from external APIs
 * Protected by write lock to prevent concurrent modifications
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Promise that resolves when the timestamp is stored
 * @throws Error if storage operation fails
 */
export async function setLastFetchTime(timestamp: number): Promise<void> {
  return acquireWriteLock(async () => {
    db_logger.debug("Setting last fetch time");
    const db = await initDB();

    const transaction = db.transaction([METADATA_STORE_NAME], "readwrite");
    const store = transaction.objectStore(METADATA_STORE_NAME);

    store.put({ key: "lastFetch", value: timestamp });

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        db.close();
        db_logger.debug("Set the last fetch time", { value: timestamp });
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        db_logger.error("A db transaction error occurred:", transaction.error);
        reject(transaction.error);
      };
    });
  });
}

/**
 * Update all images to have permanent cache expiry dates
 * Sets expiresAt to a far future date (100 years from now)
 * Used when permanent cache mode is enabled
 * @returns Promise that resolves to the number of images updated
 * @throws Error if database operation fails
 */
export async function setAllImagesToPermanentCache(): Promise<number> {
  db_logger.debug("Setting all images to permanent cache expiry");

  return acquireWriteLock(async () => {
    const db = await initDB();
    const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
    const store = transaction.objectStore(IMAGES_STORE_NAME);

    const permanentExpiryDate = Date.now() + PERMANENT_CACHE_EXPIRY_MS;
    let updatedCount = 0;

    return new Promise((resolve, reject) => {
      const cursorRequest = store.openCursor();

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

        if (cursor) {
          const image = cursor.value as ImageData;

          // Update the expiresAt field to far future date
          image.expiresAt = permanentExpiryDate;

          const updateRequest = cursor.update(image);

          updateRequest.onsuccess = () => {
            updatedCount++;
            cursor.continue();
          };

          updateRequest.onerror = () => {
            db.close();
            db_logger.error(
              `Error updating image ${image.id} to permanent cache`,
              updateRequest.error,
            );
            reject(updateRequest.error);
          };
        } else {
          // No more entries
          db.close();
          db_logger.debug(
            `Updated ${updatedCount} images to permanent cache expiry`,
          );
          resolve(updatedCount);
        }
      };

      cursorRequest.onerror = () => {
        db.close();
        db_logger.error(
          "A db transaction error has occurred",
          cursorRequest.error,
        );
        reject(cursorRequest.error);
      };
    });
  });
}

/**
 * Get the timestamp of the last fetch operation
 * @returns Promise that resolves to the timestamp or null if never set
 * @throws Error if database operation fails
 */
export async function getLastFetchTime(): Promise<number | null> {
  db_logger.debug("Getting the last fetch time");
  const db = await initDB();
  const transaction = db.transaction([METADATA_STORE_NAME], "readonly");
  const store = transaction.objectStore(METADATA_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get("lastFetch");

    request.onsuccess = () => {
      db.close();
      const result = request.result as Metadata | undefined;
      db_logger.debug("Fetched last fetch time:", { result });
      resolve(result ? result.value : null);
    };

    request.onerror = () => {
      db.close();
      db_logger.error("A db transaction error has occurred", request.error);
      reject(request.error);
    };
  });
}

/**
 * Add an image to the viewing history with automatic size management
 * Maintains a FIFO queue of viewed images, removing oldest when exceeding maxSize
 * @param imageId - Unique identifier of the viewed image
 * @param source - Source of the image (unsplash or pexels)
 * @param maxSize - Maximum number of history entries to keep (default: 15)
 * @returns Promise that resolves when the history entry is added and old entries cleaned
 * @throws Error if database operation fails
 */
export async function addToHistory(
  imageId: string,
  source: "unsplash" | "pexels" | "other",
  maxSize: number = 15,
): Promise<void> {
  db_logger.debug("Adding an Item to history");

  return acquireWriteLock(async () => {
    const db = await initDB();
    const transaction = db.transaction([HISTORY_STORE_NAME], "readwrite");
    const store = transaction.objectStore(HISTORY_STORE_NAME);

    // Add new history entry
    const entry: Omit<HistoryEntry, "id"> = {
      imageId,
      viewedAt: Date.now(),
      source,
    };

    const addRequest = store.add(entry);

    return new Promise((resolve, reject) => {
      addRequest.onsuccess = () => {
        // After adding, check if we need to remove old entries
        const countRequest = store.count();

        countRequest.onsuccess = () => {
          const count = countRequest.result;

          if (count > maxSize) {
            // Remove oldest entries (FIFO) - more efficient approach
            const index = store.index("viewedAt");
            const cursorRequest = index.openCursor(); // Ascending order (oldest first)
            let removed = 0;
            const toRemove = count - maxSize;

            cursorRequest.onsuccess = (event) => {
              const cursor = (event.target as IDBRequest<IDBCursorWithValue>)
                .result;

              if (cursor && removed < toRemove) {
                cursor.delete();
                removed++;
                cursor.continue();
              } else {
                // Done removing old entries
                db.close();
                db_logger.debug(
                  `Added to history and removed ${removed} old entries`,
                );
                resolve();
              }
            };

            cursorRequest.onerror = () => {
              db.close();
              db_logger.error(
                "A db transaction error has occurred",
                cursorRequest.error,
              );
              reject(cursorRequest.error);
            };
          } else {
            db.close();
            db_logger.debug("Added to history, no old entries to remove");
            resolve();
          }
        };

        countRequest.onerror = () => {
          db.close();
          db_logger.error(
            "A db transaction error has occurred",
            countRequest.error,
          );
          reject(countRequest.error);
        };
      };

      addRequest.onerror = () => {
        db.close();
        db_logger.error(
          "A db transaction error has occurred",
          addRequest.error,
        );
        reject(addRequest.error);
      };

      transaction.onerror = () => {
        db.close();
        db_logger.error(
          "A db transaction error has occurred",
          transaction.error,
        );
        reject(transaction.error);
      };
    });
  });
}

/**
 * Retrieve viewing history with optional filtering and pagination
 * Returns most recent entries first (descending order by viewedAt)
 * @param limit - Maximum number of history entries to return (default: 15)
 * @param sourceFilter - Optional filter by image source ('unsplash' or 'pexels')
 * @returns Promise that resolves to an array of HistoryEntry objects
 * @throws Error if database operation fails
 */
export async function getHistory(
  limit: number = 15,
  sourceFilter?: "unsplash" | "pexels" | "other",
): Promise<HistoryEntry[]> {
  db_logger.debug("Getting history from the db", { limit, sourceFilter });

  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);

  return new Promise((resolve, reject) => {
    const history: HistoryEntry[] = [];

    // Use appropriate index for better performance
    const index = sourceFilter
      ? store.index("sourceViewedAt")
      : store.index("viewedAt");

    // Open cursor in descending order (most recent first)
    const range = sourceFilter
      ? IDBKeyRange.bound([sourceFilter, 0], [sourceFilter, Date.now()])
      : undefined;

    const cursorRequest = index.openCursor(range, "prev");

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor && history.length < limit) {
        history.push(cursor.value as HistoryEntry);
        cursor.continue();
      } else {
        db.close();
        db_logger.debug(
          `Fetched ${history.length} history entries from the db`,
        );
        resolve(history);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      db_logger.error(
        "A db transaction error has occurred",
        cursorRequest.error,
      );
      reject(cursorRequest.error);
    };
  });
}

/**
 * Retrieve a specific image from history by its ID
 * Useful for displaying full details of a previously viewed image
 * @param imageId - Unique identifier of the image to retrieve
 * @returns Promise that resolves to ImageData object or null if not found
 * @throws Error if database operation fails
 */
export async function getHistoryImageById(
  imageId: string,
): Promise<ImageData | null> {
  db_logger.debug("Getting history image by ID from the db", { imageId });
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get(imageId);

    request.onsuccess = () => {
      db.close();
      db_logger.debug("Fetched history image:", {
        imageId,
        result: request.result,
      });
      resolve(request.result || null);
    };

    request.onerror = () => {
      db.close();
      db_logger.error("A db transaction error has occurred", request.error);
      reject(request.error);
    };
  });
}

/**
 * Deletes an image from the database by its ID
 * @param imageId - The ID of the image to delete
 * @returns Promise that resolves when the image is deleted
 * @throws Error if database operation fails
 */
export async function deleteImage(imageId: string): Promise<void> {
  db_logger.debug("Deleting image:", imageId);

  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  return new Promise((resolve, reject) => {
    const deleteRequest = store.delete(imageId);

    deleteRequest.onsuccess = () => {
      db.close();
      db_logger.info("Image deleted successfully:", imageId);
      resolve();
    };

    deleteRequest.onerror = () => {
      db.close();
      db_logger.error("Error deleting image:", deleteRequest.error);
      reject(deleteRequest.error);
    };
  });
}

/**
 * Get the total number of history entries
 * Useful for pagination and storage management
 * @returns Promise that resolves to the number of history entries
 * @throws Error if database operation fails
 */
export async function getHistoryCount(): Promise<number> {
  db_logger.debug("Getting history items count");

  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.count();

    request.onsuccess = () => {
      db.close();
      db_logger.debug("Fetched history items count", request.result);
      resolve(request.result);
    };

    request.onerror = () => {
      db.close();
      db_logger.error("A db transaction error has occurred", request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear all viewing history entries
 * Useful for privacy or storage management
 * @returns Promise that resolves when all history is cleared
 * @throws Error if database operation fails
 */
export async function clearHistory(): Promise<void> {
  db_logger.debug("Clearing history data");

  return acquireWriteLock(async () => {
    const db = await initDB();
    const transaction = db.transaction([HISTORY_STORE_NAME], "readwrite");
    const store = transaction.objectStore(HISTORY_STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        db.close();
        db_logger.debug("All history cleared from the db");
        resolve();
      };

      request.onerror = () => {
        db.close();
        db_logger.error("A db transaction error has occurred", request.error);
        reject(request.error);
      };
    });
  });
}

/**
 * Check available storage space using StorageManager API
 * @returns Promise that resolves to storage info with available bytes and percentage
 * @throws Error if storage estimation is not supported
 */
export async function getStorageInfo(): Promise<{
  available: number;
  total: number;
  used: number;
  percentUsed: number;
  hasEnoughSpace: boolean;
}> {
  db_logger.debug("Estimating storage disk available to use");
  if (!navigator.storage || !navigator.storage.estimate) {
    db_logger.warn(
      "Storage estimation not supported by this browser. Assuming sufficient space.",
    );
    // Return conservative defaults when API is not available
    return {
      available: MIN_STORAGE_THRESHOLD_GB * 1024 * 1024 * 1024 * 10, // 10GB default
      total: MIN_STORAGE_THRESHOLD_GB * 1024 * 1024 * 1024 * 100, // 100GB default
      used: 0,
      percentUsed: 0,
      hasEnoughSpace: true, // Assume available when API not supported
    };
  }

  const estimate = await navigator.storage.estimate();
  const used = estimate.usage || 0;
  const total = estimate.quota || 0;
  const available = total - used;
  const percentUsed = total > 0 ? (used / total) * 100 : 0;

  // Check if we have at least available
  const minStorageBytes = MIN_STORAGE_THRESHOLD_GB * 1024 * 1024 * 1024;
  const hasEnoughSpace = available >= minStorageBytes;

  db_logger.debug("Estimated the storage successfuly", {
    used,
    total,
    available,
    percentUsed,
  });

  return {
    available,
    total,
    used,
    percentUsed,
    hasEnoughSpace,
  };
}

/**
 * Get the count of valid (non-expired) images in the database
 * Memory efficient - only counts, doesn't load image data
 * @returns Promise that resolves to the number of valid images
 * @throws Error if database operation fails
 */
export async function getValidImageCount(): Promise<number> {
  db_logger.debug("Getting count of valid images from the db");
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);
  const index = store.index("expiresAt");
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const countRequest = index.count(IDBKeyRange.lowerBound(now));

    countRequest.onsuccess = () => {
      db.close();
      db_logger.debug("Fetched valid images");
      resolve(countRequest.result);
    };

    countRequest.onerror = () => {
      db.close();
      db_logger.error(
        "A db transaction error has occurred",
        countRequest.error,
      );
      reject(countRequest.error);
    };
  });
}

/**
 * Get comprehensive database statistics
 * Useful for monitoring storage usage and performance
 * Uses separate transactions for better concurrency and to avoid blocking
 * @returns Promise that resolves to database statistics object
 * @throws Error if database operation fails
 */
export async function getDatabaseStats(): Promise<{
  totalImages: number;
  validImages: number;
  expiredImages: number;
  totalHistory: number;
}> {
  db_logger.debug("Getting database statistics");
  const now = Date.now();

  // Use separate transactions for better concurrency and to avoid blocking
  const [totalImages, validImages, totalHistory] = await Promise.all([
    // Count total images
    (async (): Promise<number> => {
      const db = await initDB();
      const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
      const store = transaction.objectStore(IMAGES_STORE_NAME);

      return new Promise((resolve, reject) => {
        const request = store.count();

        request.onsuccess = () => {
          db.close();
          resolve(request.result);
          db_logger.debug(`Total images in the db: ${request.result}`);
        };

        request.onerror = () => {
          db.close();
          db_logger.error(`Error counting total images`, request.error);
          reject(request.error);
        };
      });
    })(),

    // Count valid images
    (async (): Promise<number> => {
      db_logger.debug("Counting valid images in the db");
      const db = await initDB();
      const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
      const store = transaction.objectStore(IMAGES_STORE_NAME);
      const index = store.index("expiresAt");

      return new Promise((resolve, reject) => {
        const request = index.count(IDBKeyRange.lowerBound(now));

        request.onsuccess = () => {
          db.close();
          db_logger.debug(`Valid images in the db: ${request.result}`);
          resolve(request.result);
        };

        request.onerror = () => {
          db.close();
          db_logger.error(`Error counting valid images`, request.error);
          reject(request.error);
        };
      });
    })(),

    // Count total history
    (async (): Promise<number> => {
      db_logger.debug("Counting total history entries in the db");
      const db = await initDB();
      const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
      const store = transaction.objectStore(HISTORY_STORE_NAME);

      return new Promise((resolve, reject) => {
        const request = store.count();

        request.onsuccess = () => {
          db.close();
          db_logger.debug(`Total history entries in the db: ${request.result}`);
          resolve(request.result);
        };

        request.onerror = () => {
          db.close();
          db_logger.error(`Error counting history entries`, request.error);
          reject(request.error);
        };
      });
    })(),
  ]);

  return {
    totalImages,
    validImages,
    expiredImages: totalImages - validImages,
    totalHistory,
  };
}
