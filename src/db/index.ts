/**
 * Indexeddb database module for the random wallpaper browser extension.
 * Provides a way to store and retrieve images and metadata.
 */

import {
  DB_NAME,
  Metadata,
  ImageData,
  DB_VERSION,
  HistoryEntry,
  IMAGES_STORE_NAME,
  HISTORY_STORE_NAME,
  METADATA_STORE_NAME,
  MIN_STORAGE_THRESHOLD_GB,
  PERMANENT_CACHE_EXPIRY_MS,
} from "../config";
import { Logger } from "../logger";
import { getRandomIndex } from "../utils";

const db_logger = new Logger("IndexedDB");

// ─── Write lock ──────────────────────────────────────────────────────────────

// Serialises concurrent write operations so transactions don't stomp each other.
let dbWriteLock = Promise.resolve();

async function acquireWriteLock<T>(
  operation: () => Promise<T>,
  timeoutMs: number = 30000,
): Promise<T> {
  const currentLock = dbWriteLock;
  let releaseLock: (() => void) | undefined;

  dbWriteLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await currentLock;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const operationPromise = operation();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`DB write lock timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Race the operation against the timeout so we don't deadlock forever.
    return await Promise.race([operationPromise, timeoutPromise]) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (releaseLock) releaseLock();
    if (timedOut) {
      db_logger.warn(
        "DB write lock timeout occurred; allowing subsequent operations to proceed",
      );
    }
  }
}

// ─── Connection management ────────────────────────────────────────────────────
//
// All public functions share ONE persistent IDBDatabase connection.  Opening a
// new connection per-operation is the original design's biggest performance
// cost: every IDBFactory.open() call goes through the browser's I/O path, adds
// latency, and —in the service worker context— can contend during startup.
//
// The promise is cached at module scope so subsequent calls are synchronous
// (Promise.resolve with the already-resolved IDBDatabase).  On unexpected
// close or open failure the cache is cleared so the next caller retries.

let _dbConnection: Promise<IDBDatabase> | null = null;

/**
 * Returns the shared, lazily-opened IDBDatabase connection.
 * Resets on failure so the next call retries cleanly.
 */
function getConnection(): Promise<IDBDatabase> {
  if (!_dbConnection) {
    _dbConnection = openDatabase();
    _dbConnection.catch(() => {
      _dbConnection = null;
    });
  }
  return _dbConnection;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    db_logger.debug("Opening database...");
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      db_logger.error("Failed to open database:", request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db_logger.debug("Database opened successfully");
      const db = request.result;
      // Reset cache if the browser closes the connection unexpectedly
      // (e.g. user clears storage, version change from another tab).
      db.onclose = () => {
        db_logger.warn(
          "Database connection closed unexpectedly — will reopen on next access",
        );
        _dbConnection = null;
      };

      // When another tab requests an upgrade, browsers fire "versionchange".
      // Close our connection so the upgrade can proceed and reopen on next access.
      db.onversionchange = () => {
        db_logger.warn(
          "Database version change detected — closing connection to allow upgrade",
        );
        db.close();
        _dbConnection = null;
      };

      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      db_logger.debug(
        `Upgrading database from v${event.oldVersion} → v${DB_VERSION}`,
      );
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = (event.target as IDBOpenDBRequest).transaction!;

      // ── v1: initial schema ────────────────────────────────────────────────
      if (!db.objectStoreNames.contains(IMAGES_STORE_NAME)) {
        const imageStore = db.createObjectStore(IMAGES_STORE_NAME, {
          keyPath: "id",
        });
        imageStore.createIndex("timestamp", "timestamp", { unique: false });
        imageStore.createIndex("expiresAt", "expiresAt", { unique: false });
        db_logger.debug("Created images object store and indexes");
      }

      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        db.createObjectStore(METADATA_STORE_NAME, { keyPath: "key" });
        db_logger.debug("Created metadata object store");
      }

      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const historyStore = db.createObjectStore(HISTORY_STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        historyStore.createIndex("viewedAt", "viewedAt", { unique: false });
        historyStore.createIndex("source", "source", { unique: false });
        historyStore.createIndex("sourceViewedAt", ["source", "viewedAt"], {
          unique: false,
        });
        db_logger.debug("Created history object store and indexes");
      }

      // ── v2: content-hash index for deduplication ──────────────────────────
      // IDBIndex on the optional `contentHash` field of ImageData.
      // `unique: false` because old records won't have the field, and hash
      // collisions (while astronomically unlikely) must not cause write errors.
      const imageStore = transaction.objectStore(IMAGES_STORE_NAME);
      if (!imageStore.indexNames.contains("contentHash")) {
        imageStore.createIndex("contentHash", "contentHash", { unique: false });
        db_logger.debug("Created contentHash index on images store");
      }
    };
  });
}

/**
 * Warms up (or returns) the shared database connection.
 * Callers that previously imported `initDB` continue to work unchanged.
 */
export const initDB = getConnection;

/**
 * Close the shared database connection and reset the cached promise.
 * Useful for tests or forcing a clean reopen after a failure.
 */
export async function closeDB(): Promise<void> {
  const conn = _dbConnection;
  _dbConnection = null;
  if (!conn) return;

  try {
    const db = await conn;
    db.close();
  } catch {
    // ignore errors on close; connection may already be closed or failed
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Collects all `contentHash` values currently in the images store using an
 * IDBIndex key-cursor.  A key-cursor yields only index keys + primary keys —
 * no blob data is loaded into memory, keeping this O(n) in hash strings only.
 */
async function getExistingContentHashes(db: IDBDatabase): Promise<Set<string>> {
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  if (!store.indexNames.contains("contentHash")) {
    return new Set(); // DB not yet upgraded; assume no hashes
  }

  const index = store.index("contentHash");
  const hashes = new Set<string>();

  return new Promise((resolve, reject) => {
    const request = index.openKeyCursor();
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursor>).result;
      if (cursor) {
        // cursor.key is the contentHash value (undefined for pre-v2 records)
        // It is expected to be a string, but may be an array if an index was
        // defined with multiple keys, so guard against that.
        if (typeof cursor.key === "string") {
          hashes.add(cursor.key);
        }
        cursor.continue();
      } else {
        resolve(hashes);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Promisified wrapper around IDBRequest to reduce boilerplate and ensure
 * errors are handled consistently.
 */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Helper for running a function inside an IDB transaction.
 * Resolves when the transaction completes, rejects on error/abort.
 */
async function withTransaction<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  let result: T;
  let settled = false;

  const waitForCompletion = new Promise<T>((resolve, reject) => {
    const finish = (value: T | PromiseLike<T>) => {
      if (!settled) {
        settled = true;
        resolve(value as T);
      }
    };

    tx.oncomplete = () => {
      finish(result);
    };
    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error("IDB transaction error"));
      }
    };
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error("IDB transaction aborted"));
      }
    };
  });

  const fnPromise = Promise.resolve(fn(tx)).then((r) => {
    result = r as T;
  });

  return Promise.all([fnPromise, waitForCompletion]).then(() => result);
}

/**
 * Picks a uniformly random valid (non-expired) image using a count + offset
 * cursor approach.  Accepts an existing `db` reference to avoid redundant
 * `getConnection()` calls from functions that already hold one.
 */
async function pickRandomValidImage(
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
        db_logger.debug("No valid images in the db");
        return resolve(null);
      }

      const randomIndex = getRandomIndex(count);
      let current = 0;

      const cursorRequest = index.openCursor(IDBKeyRange.lowerBound(now));
      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor) {
          db_logger.warn(
            "Cursor ended before reaching random index — possible race with image expiry",
          );
          return resolve(null);
        }
        if (current === randomIndex) {
          resolve(cursor.value as ImageData);
        } else {
          current++;
          cursor.continue();
        }
      };
      cursorRequest.onerror = () => {
        db_logger.error("Error iterating cursor:", cursorRequest.error);
        reject(cursorRequest.error);
      };
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
  const db = await getConnection();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);
  const index = store.index("viewedAt");

  const cutoffTime = Date.now() - withinHours * 60 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.lowerBound(cutoffTime);
    const cursorRequest = index.openCursor(range);

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        const entry = cursor.value as HistoryEntry;

        if (entry.imageId === imageId) {
          db_logger.debug("Image was viewed recently", { imageId });
          resolve(true);
          return;
        }
        cursor.continue();
      } else {
        db_logger.debug("Image was not viewed recently", { imageId });
        resolve(false);
      }
    };

    cursorRequest.onerror = () => {
      db_logger.error(
        "A db transaction error has occurred",
        cursorRequest.error,
      );
      reject(cursorRequest.error);
    };
  });
}

/**
 * Store multiple images in the database, skipping any whose content hash
 * already exists (deduplication).
 * Uses a single transaction for better performance.
 * Protected by write lock to prevent concurrent modifications.
 * @param images - Array of ImageData objects to store
 * @returns Promise that resolves when all new images are stored
 * @throws Error if storage operation fails
 */
export async function storeImages(images: ImageData[]): Promise<void> {
  if (images.length === 0) return;
  db_logger.debug(`Storing up to ${images.length} image(s) to the db`);

  return acquireWriteLock(async () => {
    const db = await getConnection();

    // ── content-hash deduplication ────────────────────────────────────────
    // Fetch the set of hashes already in the store (key-cursor, blobs not
    // loaded) and filter out any incoming images whose hash matches.
    const existingHashes = await getExistingContentHashes(db);
    const newImages = images.filter(
      (img) => !img.contentHash || !existingHashes.has(img.contentHash),
    );

    const skipped = images.length - newImages.length;
    if (skipped > 0) {
      db_logger.info(
        `Deduplication: skipping ${skipped} duplicate image(s), storing ${newImages.length}`,
      );
    }

    if (newImages.length === 0) return;

    const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
    const store = transaction.objectStore(IMAGES_STORE_NAME);

    for (const image of newImages) {
      store.put(image);
      db_logger.debug(`Queued image ${image.id} for storage`);
    }

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        db_logger.info(`Stored ${newImages.length} image(s) successfully`);
        resolve();
      };

      transaction.onerror = () => {
        db_logger.error("Error storing images:", transaction.error);
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

  const db = await getConnection();

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
        db_logger.debug(
          `Fetched ${validImages.length} valid images from the db`,
        );
        resolve(validImages);
      }
    };

    cursorRequest.onerror = () => {
      db_logger.error(
        "A db transaction error has occurred",
        cursorRequest.error,
      );
      reject(cursorRequest.error);
    };
  });
}

/**
 * Returns a random valid image, preferring one not viewed in the last ~18 min.
 * Makes up to 3 attempts to avoid a recently-seen image before giving up and
 * returning whatever was found last.
 */
export async function getRandomImage(): Promise<ImageData | null> {
  const db = await getConnection();
  let image = await pickRandomValidImage(db);
  let attempts = 3;

  while (image && attempts > 0) {
    if (!(await wasImageViewedRecently(image.id, 0.3))) {
      return image;
    }
    db_logger.debug(
      `Image recently viewed, trying another (${attempts} attempt(s) left)`,
    );
    image = await pickRandomValidImage(db);
    attempts--;
  }

  return image;
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
    const db = await getConnection();
    const now = Date.now();
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
          db_logger.debug("Deleted an expired item");
          deletedCount++;
          cursor.continue();
        } else {
          db_logger.debug(`Deleted ${deletedCount} item(s).`);
          resolve(deletedCount);
        }
      };

      cursorRequest.onerror = () => {
        db_logger.error(
          "DB cursor error when deleting expired items",
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
    const db = await getConnection();

    await withTransaction<void>(db, IMAGES_STORE_NAME, "readwrite", async (tx) => {
      const store = tx.objectStore(IMAGES_STORE_NAME);
      await promisifyRequest(store.clear());
    });
  });
}

/**
 * Delete images by source (e.g. 'other' for fallback images).
 * This is useful when switching from fallback-only mode to API-backed mode.
 * @param source - Source field of ImageData to delete
 * @returns Promise that resolves to the number of deleted images
 * @throws Error if database operation fails
 */
export async function deleteImagesBySource(
  source: ImageData["source"],
): Promise<number> {
  db_logger.debug("Deleting images by source", { source });

  return acquireWriteLock(async () => {
    const db = await getConnection();

    return withTransaction<number>(db, IMAGES_STORE_NAME, "readwrite", async (tx) => {
      const store = tx.objectStore(IMAGES_STORE_NAME);
      let deletedCount = 0;

      const cursorRequest = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        cursorRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const image = cursor.value as ImageData;
            if (image.source === source) {
              cursor.delete();
              deletedCount++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorRequest.onerror = () => {
          db_logger.error("Error deleting images by source", cursorRequest.error);
          reject(cursorRequest.error);
        };
      });

      db_logger.debug(
        `Deleted ${deletedCount} images with source ${source}`,
      );
      return deletedCount;
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
    const db = await getConnection();

    await withTransaction<void>(db, METADATA_STORE_NAME, "readwrite", async (tx) => {
      const store = tx.objectStore(METADATA_STORE_NAME);
      await promisifyRequest(store.put({ key: "lastFetch", value: timestamp }));
    });

    db_logger.debug("Set the last fetch time", { value: timestamp });
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
    const db = await getConnection();

    return withTransaction<number>(db, IMAGES_STORE_NAME, "readwrite", async (tx) => {
      const store = tx.objectStore(IMAGES_STORE_NAME);
      const permanentExpiryDate = Date.now() + PERMANENT_CACHE_EXPIRY_MS;
      let updatedCount = 0;

      const cursorRequest = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        cursorRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

          if (cursor) {
            const image = cursor.value as ImageData;
            image.expiresAt = permanentExpiryDate;

            const updateRequest = cursor.update(image);
            updateRequest.onsuccess = () => {
              updatedCount++;
              cursor.continue();
            };

            updateRequest.onerror = () => {
              db_logger.error(
                `Error updating image ${image.id} to permanent cache`,
                updateRequest.error,
              );
              reject(updateRequest.error);
            };
          } else {
            resolve();
          }
        };

        cursorRequest.onerror = () => {
          db_logger.error(
            "A db transaction error has occurred",
            cursorRequest.error,
          );
          reject(cursorRequest.error);
        };
      });

      db_logger.debug(
        `Updated ${updatedCount} images to permanent cache expiry`,
      );
      return updatedCount;
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
  const db = await getConnection();

  const result = await withTransaction<Metadata | null>(
    db,
    METADATA_STORE_NAME,
    "readonly",
    async (tx) => {
      const store = tx.objectStore(METADATA_STORE_NAME);
      const request = store.get("lastFetch");
      return (await promisifyRequest<Metadata | undefined>(request)) ?? null;
    },
  );

  db_logger.debug("Fetched last fetch time:", { result });
  return result ? result.value : null;
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
    const db = await getConnection();
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
      let settled = false;
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

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
                db_logger.debug(
                  `Added to history and removed ${removed} old entries`,
                );
                finish(() => resolve());
              }
            };

            cursorRequest.onerror = () => {
              db_logger.error(
                "A db transaction error has occurred",
                cursorRequest.error,
              );
              finish(() => reject(cursorRequest.error));
            };
          } else {
            db_logger.debug("Added to history, no old entries to remove");
            finish(() => resolve());
          }
        };

        countRequest.onerror = () => {
          db_logger.error(
            "A db transaction error has occurred",
            countRequest.error,
          );
          finish(() => reject(countRequest.error));
        };
      };

      addRequest.onerror = () => {
        db_logger.error(
          "A db transaction error has occurred",
          addRequest.error,
        );
        finish(() => reject(addRequest.error));
      };

      transaction.onerror = () => {
        db_logger.error(
          "A db transaction error has occurred",
          transaction.error,
        );
        finish(() => reject(transaction.error));
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

  const db = await getConnection();
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
        db_logger.debug(
          `Fetched ${history.length} history entries from the db`,
        );
        resolve(history);
      }
    };

    cursorRequest.onerror = () => {
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
  const db = await getConnection();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.get(imageId);

    request.onsuccess = () => {
      db_logger.debug("Fetched history image:", {
        imageId,
        result: request.result,
      });
      resolve(request.result ?? null);
    };

    request.onerror = () => {
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

  const db = await getConnection();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readwrite");
  const store = transaction.objectStore(IMAGES_STORE_NAME);

  return new Promise((resolve, reject) => {
    const deleteRequest = store.delete(imageId);

    deleteRequest.onsuccess = () => {
      db_logger.info("Image deleted successfully:", imageId);
      resolve();
    };

    deleteRequest.onerror = () => {
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

  const db = await getConnection();
  const transaction = db.transaction([HISTORY_STORE_NAME], "readonly");
  const store = transaction.objectStore(HISTORY_STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.count();

    request.onsuccess = () => {
      db_logger.debug("Fetched history items count", request.result);
      resolve(request.result);
    };

    request.onerror = () => {
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
    const db = await getConnection();
    const transaction = db.transaction([HISTORY_STORE_NAME], "readwrite");
    const store = transaction.objectStore(HISTORY_STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        db_logger.debug("All history cleared from the db");
        resolve();
      };

      request.onerror = () => {
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
  if (!navigator.storage?.estimate) {
    db_logger.warn(
      "Storage estimation not supported by this browser. Assuming sufficient space.",
    );
    // Return conservative defaults when API is not available
    return {
      available: MIN_STORAGE_THRESHOLD_GB * 1024 * 1024 * 1024 * 10,
      total: MIN_STORAGE_THRESHOLD_GB * 1024 * 1024 * 1024 * 100,
      used: 0,
      percentUsed: 0,
      hasEnoughSpace: true,
    };
  }

  const estimate = await navigator.storage.estimate();
  const used = estimate.usage ?? 0;
  const total = estimate.quota ?? 0;
  const available = total - used;
  const percentUsed = total > 0 ? (used / total) * 100 : 0;

  const minStorageBytes = MIN_STORAGE_THRESHOLD_GB * 1024 * 1024 * 1024;
  const hasEnoughSpace = available >= minStorageBytes;

  db_logger.debug("Estimated the storage successfully", {
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
  const db = await getConnection();
  const transaction = db.transaction([IMAGES_STORE_NAME], "readonly");
  const store = transaction.objectStore(IMAGES_STORE_NAME);
  const index = store.index("expiresAt");
  const now = Date.now();

  return new Promise((resolve, reject) => {
    const countRequest = index.count(IDBKeyRange.lowerBound(now));

    countRequest.onsuccess = () => {
      db_logger.debug("Fetched valid images count", countRequest.result);
      resolve(countRequest.result);
    };

    countRequest.onerror = () => {
      db_logger.error(
        "A db transaction error has occurred",
        countRequest.error,
      );
      reject(countRequest.error);
    };
  });
}

/**
 * Get comprehensive database statistics.
 * Opens three parallel read transactions on the shared connection for efficiency.
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
  const db = await getConnection();
  const now = Date.now();

  const [totalImages, validImages, totalHistory] = await Promise.all([
    // Total images
    new Promise<number>((resolve, reject) => {
      const tx = db.transaction([IMAGES_STORE_NAME], "readonly");
      const req = tx.objectStore(IMAGES_STORE_NAME).count();
      req.onsuccess = () => {
        db_logger.debug(`Total images: ${req.result}`);
        resolve(req.result);
      };
      req.onerror = () => {
        db_logger.error("Error counting total images", req.error);
        reject(req.error);
      };
    }),

    // Valid (non-expired) images
    new Promise<number>((resolve, reject) => {
      const tx = db.transaction([IMAGES_STORE_NAME], "readonly");
      const req = tx
        .objectStore(IMAGES_STORE_NAME)
        .index("expiresAt")
        .count(IDBKeyRange.lowerBound(now));
      req.onsuccess = () => {
        db_logger.debug(`Valid images: ${req.result}`);
        resolve(req.result);
      };
      req.onerror = () => {
        db_logger.error("Error counting valid images", req.error);
        reject(req.error);
      };
    }),

    // Total history entries
    new Promise<number>((resolve, reject) => {
      const tx = db.transaction([HISTORY_STORE_NAME], "readonly");
      const req = tx.objectStore(HISTORY_STORE_NAME).count();
      req.onsuccess = () => {
        db_logger.debug(`Total history: ${req.result}`);
        resolve(req.result);
      };
      req.onerror = () => {
        db_logger.error("Error counting history entries", req.error);
        reject(req.error);
      };
    }),
  ]);

  return {
    totalImages,
    validImages,
    expiredImages: totalImages - validImages,
    totalHistory,
  };
}
