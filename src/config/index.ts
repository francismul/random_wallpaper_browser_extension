/**
 * Configuration module for the random wallpaper browser extension.
 * Defines constants and types used across the extension.
 */

/**
 * Log levels
 */
export const LOG_LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Logger configuration interface
 */
export interface Config {
  level: LogLevel;
  useColors: boolean;
  timestamp: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: Config = {
  level: "INFO",
  useColors: true,
  timestamp: true,
};

/**
 * Color codes for browser console
 */
export const COLORS: Record<LogLevel, string> = {
  DEBUG: "color: gray",
  INFO: "color: dodgerblue",
  WARN: "color: orange",
  ERROR: "color: crimson; font-weight: bold",
};

// Constants for the extension
// Image Fetching
export const UNSPLASH_IMAGES_COUNT = 30; // Unsplash API maximum per request
export const PEXELS_IMAGES_COUNT = 80; // Pexels API maximum per request (user can configure multiple keys)
export const IMAGE_EXPIRY_HOURS = 24;

// Storage Management
export const MIN_STORAGE_THRESHOLD_GB = 1; // Minimum 1GB storage required

// Permanent Cache Settings
// Set expiry to 100 years in the future for permanent cache mode
export const PERMANENT_CACHE_MODE = true;
export const PERMANENT_CACHE_EXPIRY_YEARS = 100;
export const PERMANENT_CACHE_EXPIRY_MS =
  PERMANENT_CACHE_EXPIRY_YEARS * 365 * 24 * 60 * 60 * 1000;

// Refresh Intervals (new images fetch)
export const REFRESH_INTERVAL_HOURS = 6;
export const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
export const IMMEDIATE_FETCH_COOLDOWN_MS = 60000; // 60 seconds

// Auto-refresh (new tab page)
export const DEFAULT_AUTO_REFRESH_INTERVAL = 30; // seconds
export const MIN_AUTO_REFRESH_INTERVAL = 5; // seconds
export const MAX_AUTO_REFRESH_INTERVAL = 300; // seconds

// Chrome Alarms
export const ALARM_NAME = "refreshImages";

// Network Timeouts and Retries
export const DEFAULT_NETWORK_TIMEOUT_MS = 10000; // 10 seconds
export const API_REQUEST_TIMEOUT_MS = 15000; // 15 seconds for API calls
export const DOWNLOAD_TIMEOUT_MS = 30000; // 30 seconds for image downloads
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_INITIAL_BACKOFF_MS = 1000;
export const DEFAULT_BACKOFF_MULTIPLIER = 2;

// Clock Settings
export const DEFAULT_CLOCK_ENABLED = true;
export const DEFAULT_CLOCK_FORMAT_24H = false;
export const DEFAULT_CLOCK_SHOW_SECONDS = true;
export const DEFAULT_CLOCK_SHOW_DATE = true;

// History Settings
export const DEFAULT_HISTORY_ENABLED = true;
export const DEFAULT_HISTORY_MAX_SIZE = 15;
export const MIN_HISTORY_SIZE = 5;
export const MAX_HISTORY_SIZE = 50;

// Fallback Images
export const FALLBACK_IMAGE_COUNT = 20;

// Default Search Keywords
export const DEFAULT_UNSPLASH_KEYWORDS = "supercars, superbikes";
export const DEFAULT_PEXELS_KEYWORDS = "supercars, superbikes";

// DB constants
export const DB_NAME = "randomWallpaperExtension";
export const DB_VERSION = 1;

export const IMAGES_STORE_NAME = "imagesStore";
export const METADATA_STORE_NAME = "metadataStore";
export const HISTORY_STORE_NAME = "historyStore";

// Background
/**
 * Interface for tracking background service worker operational state and statistics
 * Provides comprehensive monitoring of fetch operations, message handling, and performance metrics
 */
export interface BackgroundState {
  /** Timestamp of when the service worker started */
  startTime: number;
  /** Timestamp of last successful image refresh */
  lastRefresh: number | null;
  /** Timestamp of last manual fetch (for rate limiting) */
  lastManualFetch: number;
  /** Total number of failed fetch attempts */
  failedFetches: number;
  /** Total number of successful fetch operations */
  successfulFetches: number;
  /** Total number of messages received */
  messageCount: number;
  /** Number of manual refresh requests */
  manualRefreshCount: number;
  /** Number of opportunistic refreshes triggered */
  opportunisticRefreshCount: number;
  /** Number of settings update notifications */
  settingsUpdateCount: number;
  /** Number of API key update notifications */
  apiKeyUpdateCount: number;
  /** Whether a fetch operation is currently in progress */
  isFetching: boolean;
}

export const DEFAULT_BACKGROUND_STATE: BackgroundState = {
  startTime: Date.now(),
  lastRefresh: null,
  lastManualFetch: 0,
  failedFetches: 0,
  successfulFetches: 0,
  messageCount: 0,
  manualRefreshCount: 0,
  opportunisticRefreshCount: 0,
  settingsUpdateCount: 0,
  apiKeyUpdateCount: 0,
  isFetching: false,
};

export interface AppState {
  historyEnabled: boolean;
  historyMaxSize: number;
  currentHistoryIndex: number;
  currentImages: ImageData[];
  historyList: HistoryEntry[];
  clockInterval: number | null;
  autoRefreshTimer: number | null;
  currentBlobUrl: string | null;
  isLoading: boolean;
  lastLoadTimestamp: number;
}

export const DEFAULT_APP_STATE: AppState = {
  currentImages: [],
  currentBlobUrl: null,
  historyList: [],
  currentHistoryIndex: -1,
  historyEnabled: DEFAULT_HISTORY_ENABLED,
  historyMaxSize: DEFAULT_HISTORY_MAX_SIZE,
  clockInterval: null,
  autoRefreshTimer: null,
  isLoading: false,
  lastLoadTimestamp: 0,
};

// DB Interfaces
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

// Transitions settings
export type TransitionType =
  | "fade"
  | "slide"
  | "pixelDissolve"
  | "wipe"
  | "ripple"
  | "noiseReveal"
  | "dissolve"
  | "pixel";

/**
 * All available transition types for user selection
 */
export const AVAILABLE_TRANSITIONS: TransitionType[] = [
  "fade",
  "slide",
  "pixelDissolve",
  "wipe",
  "ripple",
  "noiseReveal",
  "dissolve",
  "pixel",
];

/**
 * Transition display names for UI
 */
export const TRANSITION_DISPLAY_NAMES: Record<TransitionType, string> = {
  fade: "Fade",
  slide: "Slide",
  pixelDissolve: "Pixel Dissolve",
  wipe: "Wipe",
  ripple: "Ripple",
  noiseReveal: "Noise Reveal",
  dissolve: "Dissolve",
  pixel: "Pixelate",
};

/**
 * Default enabled transitions (only fade)
 */
export const DEFAULT_ENABLED_TRANSITIONS: TransitionType[] = ["wipe"];

export const DEFAULT_TRANSITION_TYPE: TransitionType = "wipe";
export const DEFAULT_TRANSITION_DURATION = 800;
export interface TransitionOptions {
  duration?: number; // in milliseconds
  easing?: (t: number) => number;
  direction?: "left" | "right" | "up" | "down";
}

/**
 * Comprehensive settings interface for the extension
 * Manages API keys, search preferences, display options, and caching behavior
 */
export interface Settings {
  /** API keys for external image services */
  apiKeys: {
    unsplash: string[];
    pexels: string[];
  };
  /** Search preferences and keywords for image fetching */
  searchPreferences: {
    /** Keywords for Unsplash image searches (comma-separated) */
    unsplashKeywords: string;
    /** Keywords for Pexels image searches (comma-separated) */
    pexelsKeywords: string;
  };

  /** Automatic image refresh configuration */
  autoRefresh: {
    /** Whether auto-refresh is enabled */
    enabled: boolean;
    /** Refresh interval in seconds */
    interval: number;
  };

  /** Clock display settings */
  clock: {
    /** Whether to show the clock */
    enabled: boolean;
    /** Use 24-hour format instead of 12-hour */
    format24: boolean;
    /** Show seconds in time display */
    showSeconds: boolean;
    /** Show date along with time */
    showDate: boolean;
  };
  /** UI button visibility settings */
  ui: {
    /** Whether to show the refresh button */
    showRefreshButton: boolean;
    /** Whether to show the settings button */
    showSettingsButton: boolean;
  };

  /** History management settings */
  history: {
    /** Whether to track image viewing history */
    enabled: boolean;
    /** Maximum number of history entries to keep */
    maxSize: number;
  };

  /** Cache management settings */
  cache: {
    /** Whether to keep cached images permanently (never auto-delete) */
    permanentMode: boolean;
  };

  /** Transition settings for image changes */
  transition?: {
    /** Enabled transition effects that can be used */
    enabledTransitions: TransitionType[];
    /** Duration of transition in milliseconds */
    duration: number;
  };

  /** API key validation status cache */
  apiKeyStatus?: {
    [key: string]: {
      /** Whether this key has been tested */
      tested: boolean;
      /** Whether the key is valid */
      valid: boolean;
      /** Timestamp when key was tested */
      testedAt: number;
    };
  };

  /**
   * Refresh cooldown tracking to prevent excessive manual fetches
   * Stores the timestamp of the last manual refresh attempt
   */
  forceRefreshCooldown?: number;
}

/**
 * Default settings configuration
 * Provides fallback values for all extension settings
 */
export const DEFAULT_SETTINGS: Settings = {
  apiKeys: {
    unsplash: [],
    pexels: [],
  },
  searchPreferences: {
    unsplashKeywords: DEFAULT_UNSPLASH_KEYWORDS,
    pexelsKeywords: DEFAULT_PEXELS_KEYWORDS,
  },
  autoRefresh: {
    enabled: false,
    interval: DEFAULT_AUTO_REFRESH_INTERVAL,
  },
  clock: {
    enabled: DEFAULT_CLOCK_ENABLED,
    format24: DEFAULT_CLOCK_FORMAT_24H,
    showSeconds: DEFAULT_CLOCK_SHOW_SECONDS,
    showDate: DEFAULT_CLOCK_SHOW_DATE,
  },
  ui: {
    showRefreshButton: true,
    showSettingsButton: true,
  },
  history: {
    enabled: DEFAULT_HISTORY_ENABLED,
    maxSize: DEFAULT_HISTORY_MAX_SIZE,
  },
  cache: {
    permanentMode: false, // Default to false - allow automatic cache cleanup
  },
  transition: {
    enabledTransitions: DEFAULT_ENABLED_TRANSITIONS,
    duration: DEFAULT_TRANSITION_DURATION,
  },
  forceRefreshCooldown: 0,
};

// Api Download Options
export interface DownloadOptions {
  maxRetries?: number;
  timeoutMs?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
}
