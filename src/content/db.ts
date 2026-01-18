import {
  DB_NAME,
  DB_VERSION,
  METADATA_STORE_NAME,
  IMAGES_STORE_NAME,
  HISTORY_STORE_NAME,
  PERMANENT_CACHE_EXPIRY_MS,
} from "../config/constants";
import { getRandomIndex } from "../utils/random";

export interface ImageData {
  id: string;
  url: string;
  blob: Blob;
  source: "unsplash" | "pexels" | "other";
  downloadUrl: string;
  author: string;
  authorUrl: string;
  timestamp: number;
  expiresAt: number;
}

export interface Metadata {
  key: string;
  value: number;
}

export interface HistoryEntry {
  id?: number;
  imageId: string;
  viewedAt: number;
  source: "unsplash" | "pexels" | "other";
}

/**
 * Initialize and open the IndexedDB database
 * Creates object stores and indexes if they don't exist
 * @returns Promise that resolves to the opened IDBDatabase instance
 * @throws Error if database initialization fails
 */
export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(IMAGES_STORE_NAME)) {
        const store = db.createObjectStore(IMAGES_STORE_NAME, {
          keyPath: "id",
        });

        store.createIndex("timestamp", "timestamp", { unique: false });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        db.createObjectStore(METADATA_STORE_NAME, { keyPath: "key" });
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
      }
    };
  });
}

/**
 * Store multiple images in the database
 * Uses a single transaction for better performance
 * @param images - Array of ImageData objects to store
 * @returns Promise that resolves when all images are stored
 * @throws Error if storage operation fails
 */
export async function storeImages(images: ImageData[]): Promise<void> {
  if (images.length === 0) return;

  const db = await initDB();

  const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  for (const image of images) {
    store.put(image);
  }

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

/**
 * Get a random valid (non-expired) image from the database
 * Uses memory-efficient cursor approach with cryptographically secure randomness
 * @returns Promise that resolves to a random ImageData object or null if no valid images exist
 * @throws Error if database operation fails
 */
export async function getRandomImage(): Promise<ImageData | null> {
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);
  const index = store.index("expiresAt");
  const now = Date.now();

  return new Promise((resolve, reject) => {
    // First, count how many valid items exist
    const countRequest = index.count(IDBKeyRange.lowerBound(now));

    countRequest.onsuccess = () => {
      const count = countRequest.result;
      if (count === 0) {
        db.close();
        return resolve(null);
      }

      const randomIndex = getRandomIndex(count);
      let current = 0;

      // Cursor through valid images, stop when reaching randomIndex
      const cursorRequest = index.openCursor(IDBKeyRange.lowerBound(now));

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) {
          db.close();
          resolve(null);
          return;
        }

        if (current === randomIndex) {
          db.close();
          resolve(cursor.value as ImageData);
        } else {
          current++;
          cursor.continue();
        }
      };

      cursorRequest.onerror = () => {
        db.close();
        reject(cursorRequest.error);
      };
    };

    countRequest.onerror = () => {
      db.close();
      reject(countRequest.error);
    };
  });
}

/**
 * Get all valid (non-expired) images from the database
 * Uses index-based cursor for memory efficiency, only processes valid images
 * @returns Promise that resolves to an array of valid ImageData objects
 * @throws Error if database operation fails
 */
export async function getAllValidImages(): Promise<ImageData[]> {
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
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      reject(cursorRequest.error);
    };
  });
}

/**
 * Remove all expired images from the database
 * Iterates through all images and deletes those past their expiration time
 * @returns Promise that resolves to the number of images deleted
 * @throws Error if database operation fails
 */
export async function cleanExpiredImages(): Promise<number> {
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
  const store = transaction.objectStore(IMAGES_STORE_NAME);
  const index = store.index("expiresAt");
  const now = Date.now();

  let deletedCount = 0;

  return new Promise((resolve, reject) => {
    // Use index to only iterate through expired images (more efficient)
    const cursorRequest = index.openCursor(IDBKeyRange.upperBound(now));

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        db.close();
        resolve(deletedCount);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      reject(cursorRequest.error);
    };
  });
}

/**
 * Store the timestamp of the last fetch operation
 * Used to track when images were last retrieved from external APIs
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Promise that resolves when the timestamp is stored
 * @throws Error if storage operation fails
 */
export async function setLastFetchTime(timestamp: number): Promise<void> {
  const db = await initDB();

  const transaction = db.transaction([METADATA_STORE_NAME], "readwrite");
  const store = transaction.objectStore(METADATA_STORE_NAME);

  store.put({ key: "lastFetch", value: timestamp });

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

/**
 * Get the timestamp of the last fetch operation
 * @returns Promise that resolves to the timestamp or null if never set
 * @throws Error if database operation fails
 */
export async function getLastFetchTime(): Promise<number | null> {
  const db = await initDB();
  const transaction = db.transaction([METADATA_STORE_NAME], "readonly");
  const store = transaction.objectStore(METADATA_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get("lastFetch");

    request.onsuccess = () => {
      db.close();
      const result = request.result as Metadata | undefined;
      resolve(result ? result.value : null);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Get the count of valid (non-expired) images in the database
 * Memory efficient - only counts, doesn't load image data
 * @returns Promise that resolves to the number of valid images
 * @throws Error if database operation fails
 */
export async function getValidImageCount(): Promise<number> {
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);
  const index = store.index("expiresAt");
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const countRequest = index.count(IDBKeyRange.lowerBound(now));

    countRequest.onsuccess = () => {
      db.close();
      resolve(countRequest.result);
    };

    countRequest.onerror = () => {
      db.close();
      reject(countRequest.error);
    };
  });
}



/**
 * Clear all images from the database
 * Useful for resetting the cache or freeing up storage space
 * @returns Promise that resolves when all images are cleared
 * @throws Error if database operation fails
 */
export async function clearAllImages(): Promise<void> {
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.clear();

    request.onsuccess = () => {
      db.close();
      resolve();
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
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
          reject(updateRequest.error);
        };
      } else {
        // No more entries
        db.close();
        resolve(updatedCount);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      reject(cursorRequest.error);
    };
  });
}

/**
 * Gets the permanent cache mode setting from Chrome storage
 * @returns Promise that resolves to true if permanent cache mode is enabled
 */
export async function isPermanentCacheEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result: any) => {
      const settings = result.settings || {};
      resolve(settings.cache?.permanentMode ?? false);
    });
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
  maxSize: number = 15
): Promise<void> {
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
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

            if (cursor && removed < toRemove) {
              cursor.delete();
              removed++;
              cursor.continue();
            } else {
              // Done removing old entries
              db.close();
              resolve();
            }
          };

          cursorRequest.onerror = () => {
            db.close();
            reject(cursorRequest.error);
          };
        } else {
          db.close();
          resolve();
        }
      };

      countRequest.onerror = () => {
        db.close();
        reject(countRequest.error);
      };
    };

    addRequest.onerror = () => {
      db.close();
      reject(addRequest.error);
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
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
  sourceFilter?: "unsplash" | "pexels" | "other"
): Promise<HistoryEntry[]> {
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
        resolve(history);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
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
  imageId: string
): Promise<ImageData | null> {
  const db = await initDB();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get(imageId);

    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
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
  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.count();

    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };

    request.onerror = () => {
      db.close();
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
  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readwrite");
  const store = transaction.objectStore(HISTORY_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.clear();

    request.onsuccess = () => {
      db.close();
      resolve();
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Remove history entries older than a specified timestamp
 * Efficient cleanup using index-based cursor for better performance
 * @param olderThan - Unix timestamp in milliseconds; entries older than this will be removed
 * @returns Promise that resolves when old history entries are removed
 * @throws Error if database operation fails
 */
export async function removeOldHistory(olderThan: number): Promise<number> {
  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readwrite");
  const store = transaction.objectStore(HISTORY_STORE_NAME);
  const index = store.index("viewedAt");

  let deletedCount = 0;

  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.upperBound(olderThan);
    const cursorRequest = index.openCursor(range);

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        cursor.delete();
        deletedCount++;
        cursor.continue();
      } else {
        db.close();
        resolve(deletedCount);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      reject(cursorRequest.error);
    };
  });
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
  withinHours: number = 24
): Promise<boolean> {
  const db = await initDB();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);
  const index = store.index("viewedAt");

  const cutoffTime = Date.now() - (withinHours * 60 * 60 * 1000);

  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.lowerBound(cutoffTime);
    const cursorRequest = index.openCursor(range);

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        const entry = cursor.value as HistoryEntry;
        if (entry.imageId === imageId) {
          db.close();
          resolve(true);
          return;
        }
        cursor.continue();
      } else {
        db.close();
        resolve(false);
      }
    };

    cursorRequest.onerror = () => {
      db.close();
      reject(cursorRequest.error);
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
        };
        
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      });
    })(),

    // Count valid images
    (async (): Promise<number> => {
      const db = await initDB();
      const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
      const store = transaction.objectStore(IMAGES_STORE_NAME);
      const index = store.index("expiresAt");

      return new Promise((resolve, reject) => {
        const request = index.count(IDBKeyRange.lowerBound(now));
        
        request.onsuccess = () => {
          db.close();
          resolve(request.result);
        };
        
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
      });
    })(),

    // Count total history
    (async (): Promise<number> => {
      const db = await initDB();
      const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
      const store = transaction.objectStore(HISTORY_STORE_NAME);

      return new Promise((resolve, reject) => {
        const request = store.count();
        
        request.onsuccess = () => {
          db.close();
          resolve(request.result);
        };
        
        request.onerror = () => {
          db.close();
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
