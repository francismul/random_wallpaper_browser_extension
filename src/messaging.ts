/**
 * Messaging utilities for cross-context communication using the service worker.
 *
 * Provides a small pub/sub API for pages (popup/new tab/options) to subscribe
 * to updates and request current state without needing to implement their own
 * message routing.
 */

type MessageHandler = (message: any, sender: chrome.runtime.MessageSender) => void;

const subscribers = new Set<MessageHandler>();

// Global listener that dispatches to subscribers
chrome.runtime.onMessage.addListener((message, sender) => {
  for (const handler of subscribers) {
    try {
      handler(message, sender);
    } catch (e) {
      console.warn("Messaging subscriber threw", e);
    }
  }

  // Return false so sender is not kept open by default
  return false;
});

/**
 * Subscribe to all messages received by the service worker.
 * Returns an unsubscribe function.
 */
export function subscribeToMessages(handler: MessageHandler): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

/**
 * Subscribe specifically to current-image updates.
 * Returns an unsubscribe function.
 */
export function subscribeToCurrentImageUpdates(
  handler: (imageId: string) => void,
): () => void {
  return subscribeToMessages((message) => {
    if (message?.action === "currentImageUpdated" && typeof message.imageId === "string") {
      handler(message.imageId);
    }
  });
}

/**
 * Broadcast a message to all extension contexts (including background).
 */
export function broadcastMessage(message: any): void {
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    // no-op (e.g. called from weird context)
  }
}

/**
 * Request the current image ID from the background service worker.
 * Returns null if the background does not respond.
 */
export function requestCurrentImageId(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { action: "getCurrentImageId" },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }

          if (response?.success && typeof response.imageId === "string") {
            resolve(response.imageId);
          } else {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Broadcast the current image ID to all contexts.
 */
export function broadcastCurrentImageId(imageId: string): void {
  broadcastMessage({ action: "currentImageUpdated", imageId });
}
