/**
 * Logging module that gives python logging module vibes
 * for the random wallpaper browser extension.
 */

import {
  Config,
  COLORS,
  LogLevel,
  LOG_LEVELS,
  DEFAULT_CONFIG,
} from "../config";

/**
 * Formats the current timestamp in ISO 8601 format.
 * @returns {string} The formatted timestamp.
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 *
 */
/**
 * Lightweight logging utility inspired by Python's `logging` module.
 *
 * The logger emits messages to the console and optionally broadcasts them via
 * BroadcastChannel for the Options page log viewer.
 *
 * Log level filtering is applied globally, so changing the level affects all
 * existing Logger instances.
 */
export class Logger {
  /**
   * Shared configuration used by all Logger instances.
   * The options can be updated at runtime via `setGlobalConfig`.
   */
  static globalConfig: Config = DEFAULT_CONFIG;

  /**
   * Update global logging configuration (affects all logger instances).
   */
  static setGlobalConfig(config: Partial<Config>): void {
    this.globalConfig = { ...this.globalConfig, ...config };
  }

  /**
   * Update global log level (affects all logger instances).
   *
   * This is the recommended way to adjust verbosity at runtime.
   */
  static setGlobalLevel(level: LogLevel): void {
    this.setGlobalConfig({ level });
  }

  /**
   * Get the current global logging configuration.
   */
  static getGlobalConfig(): Config {
    return this.globalConfig;
  }

  name: string;
  config: Partial<Config>;
  private broadcastChannel: BroadcastChannel | null = null;

  constructor(name: string = "Extension", config: Partial<Config> = {}) {
    this.name = name;
    this.config = config;
    try {
      this.broadcastChannel = new BroadcastChannel("extension_debug_logs");
    } catch (e) {
      // Ignore if BroadcastChannel is not available
    }
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  debug(message: string, ...args: any[]): void {
    this._log("DEBUG", message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this._log("INFO", message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this._log("WARN", message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this._log("ERROR", message, ...args);
  }

  private _log(level: LogLevel, message: string, ...args: any[]): void {
    // Merge global config with instance overrides so log level changes propagate
    // to all existing logger instances.
    const config: Config = { ...Logger.globalConfig, ...this.config };

    if (LOG_LEVELS[level] < LOG_LEVELS[config.level]) return;

    const parts: string[] = [];

    if (config.timestamp) {
      parts.push(`[${formatTimestamp()}]`);
    }

    parts.push(`[${level}]`);
    parts.push(`[${this.name}]`);
    parts.push(message);

    const output = parts.join(" ");

    if (config.useColors) {
      console.log(`%c${output}`, COLORS[level], ...args);
    } else {
      console.log(output, ...args);
    }

    // Broadcast log for Options page viewer
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          timestamp: new Date().toISOString(),
          level,
          name: this.name,
          message: output, // Send full formatted message
          rawMessage: message, // And raw message
          // detailed args are risky to clone, so we omit them or try simple stringify
          hasArgs: args.length > 0,
        });
      } catch (e) {
        // Ignore serialization errors
      }
    }
  }
}
