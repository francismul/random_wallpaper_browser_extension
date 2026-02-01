/**
 * Logging module that gives python logging module vibes
 * for the random wallpaper browser extension.
 */

import {
  LOG_LEVELS,
  LogLevel,
  Config,
  DEFAULT_CONFIG,
  COLORS,
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
export class Logger {
  name: string;
  config: Config;
  private broadcastChannel: BroadcastChannel | null = null;

  constructor(name: string = "Extension", config: Partial<Config> = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
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
    if (LOG_LEVELS[level] < LOG_LEVELS[this.config.level]) return;

    const parts: string[] = [];

    if (this.config.timestamp) {
      parts.push(`[${formatTimestamp()}]`);
    }

    parts.push(`[${level}]`);
    parts.push(`[${this.name}]`);
    parts.push(message);

    const output = parts.join(" ");

    if (this.config.useColors) {
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
