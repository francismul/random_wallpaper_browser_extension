# Changelog

All notable changes to the Random Wallpaper Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2026-01-28

### Added

#### **Custom Logging System**

- Added new custom logging that helps with debugging the application with custom colors for different codes
- The logging system gives python logging module vibes

#### **Custom Context Menu**

- Added a custom context menu for the newtab page
- Supports:
  - Image download
  - History navigation
  - Getting a random new Image

#### **New Transitions**

- New Transition mechanism, relying on canvas and vanilla javascript to perform transitions
- Supported transitions
  - Wipe (default)
  - Slide
  - Fade
  - Ripple
  - Pixel Dissolve
  - Pixelation
  - Noise Reveal

### Changed

#### **Project Structure**

- Changed the project structure to adopt a better maintainable variant with separation of concerns on different modules

## [3.0.0] - 2026-01-18

### Changed

#### **Improved Permanent cache logic**

- All newly fetched images (API, fallback, placeholder) are assigned an expiry date 100 years in the future
- All existing images in the database are updated to have the permanent expiry date
- The cleanup job still runs normally but won't delete images with far-future expiry dates

- **When permanent cache mode is disabled**:
  - New images get the normal 24-hour expiry
  - Existing images with permanent expiry will eventually be cleaned up as they reach expiration (100 years from when they were set)

#### **Improved UI**

- **New Tab Page**:
  - Bento Layout: A customizable grid system now organizes the UI.

- **Options Page**:
  - Dark Mode Support: The entire page now defaults to a deep dark theme
  - Bento Sections: Settings are now grouped into distinct "Bento cards" that float in a responsive grid layout. Bevelled edges and drop shadows give them dept

### Added

#### **Github Workflow**

- Github workflow for the project

#### **pnpm package manager**

- **pnpm** - Added pnpm as the default package manager for better dependencies management.
- **Build Commands**:
  - `pnpm run build` - Standard build (no obfuscation, fast development)
  - `pnpm run build:obfuscated` - Basic obfuscated build
  - `pnpm run build:light` - Light obfuscation (balanced readability vs protection)
  - `pnpm run build:medium` - Medium obfuscation (recommended for production)
  - `pnpm run build:heavy` - Heavy obfuscation (maximum code protection)
  - `pnpm run build:fun` - Fun/experimental obfuscation level

## [2.1.1] - 2025-10-20

### Added

#### 💾 **Permanent Cache Mode**

- **User Control Over Cache Persistence**: Users can now choose to permanently store their cached wallpaper images
- **Prevent Automatic Deletion**: When enabled, cached images are never automatically deleted during background refresh
- **Growing Collection**: Cache grows over time as new images are fetched while preserving old favorites
- **Manual Cache Management**:
  - New "Force Refresh Cache" button in options page for manual cache refresh
  - Users can clear cache completely when needed
  - Full control over when to update image collection
- **Enhanced Cache Statistics**:
  - Visual indicators showing permanent cache status
  - Clear distinction between valid and expired items
  - Better understanding of cache size and storage usage
- **User Guide Documentation**: Comprehensive guide (`docs/permanent-cache-user-guide.md`) with:
  - Step-by-step setup instructions
  - Best practices for different user types (collectors, automatic management, power users)
  - FAQ and troubleshooting section
  - Storage considerations and management tips

#### � **Advanced Build System with Code Obfuscation**

- **Multiple Build Flavors**: Users and developers can now build the extension with different code obfuscation levels
- **Build Commands**:
  - `npm run build` - Standard build (no obfuscation, fast development)
  - `npm run build:obfuscated` - Basic obfuscated build
  - `npm run build:light` - Light obfuscation (balanced readability vs protection)
  - `npm run build:medium` - Medium obfuscation (recommended for production)
  - `npm run build:heavy` - Heavy obfuscation (maximum code protection)
  - `npm run build:fun` - Fun/experimental obfuscation level
- **Use Cases**:
  - **Development**: Standard build for debugging and development
  - **Production**: Medium/heavy builds for distributed versions
  - **Source Protection**: Obfuscation helps protect proprietary code modifications
  - **Performance Testing**: Different levels allow testing impact on extension performance
- **Dependencies**: Added `javascript-obfuscator` (v4.1.1) and `glob` (v11.0.3) for build enhancement

#### 🎨 **Improved Options Page UX**

- **Sticky Message Bar**: Success/error messages now stay fixed at the top of the page
- **No More Scrolling**: Users no longer need to scroll back to the top to see save confirmations
- **Better Visibility**: Messages remain visible while reviewing other settings
- **Enhanced User Feedback**: Immediate visual confirmation of actions without navigation disruption
- **Improved Workflow**: Save settings and continue editing without losing context

### Changed

#### 📁 **Codebase Organization**

- **Modular Structure**: Split large files into smaller, focused modules
- **Better Separation of Concerns**: Configuration data separated from application logic
- **Easier Maintenance**: Improved readability and maintainability of code

## [2.1.0] - 2025-10-10

### Added

#### 💾 **True Offline Mode**

- **Blob Storage**: Downloads and stores complete image blobs (~2-5MB each) in IndexedDB
- **Complete Offline Functionality**: Works without internet after initial cache
- **Storage Size**: ~160-400MB total for 80 cached images
- **Memory Management**:
  - Object URLs created with `URL.createObjectURL()` for blob display
  - Automatic cleanup with `URL.revokeObjectURL()` to prevent memory leaks
  - Cleanup on image change, preload completion, and page unload
- **Parallel Downloads**: Fetches all blobs concurrently for faster caching
- **Fallback Blobs**: 20 default images also downloaded as blobs
- **Progress Logging**: Console logs show download progress and blob count

#### 🎬 **Smooth Animation Transitions**

- **GPU-Accelerated Animations**: Hardware-accelerated transitions using CSS transform and opacity
- **Crossfade Effect**: New images fade in smoothly over the previous image without flashing
- **Smart Preloading**: Images preloaded in background before display to ensure instant transitions
- **No Loading Flash**: Removed loading indicators for seamless blob-to-display pipeline
- **Performance Optimized**: 60fps transitions with proper image cleanup to prevent memory leaks
- **Directional Animations**: Different animations based on navigation context (fade for random, slide for history)

#### 📜 **Image History Navigation**

- **IndexedDB History Store**: FIFO queue tracking viewed images with automatic size management
- **Previous/Next Navigation**: Arrow buttons to navigate through recently viewed images
- **Keyboard Shortcuts**: Arrow keys (←/→) for quick history navigation
- **Hover-Only Controls**: Navigation arrows appear only on hover to keep UI clean
- **Position Indicator**: Visual indicator showing current position in history (e.g., "3/15")
- **Configurable History Size**: Adjustable max history items (5-50) via options page
- **History Statistics**: View total history count and clear history from options
- **Smart History Management**:
  - Auto-removes oldest entries when limit reached
  - Tracks duplicates for accurate chronology
  - Previous button navigates back through history
  - Next button always loads a new random image
- **Persistent Navigation**: History survives page refresh and browser restarts

### Changed

- **API Fetching**: Now downloads complete image files instead of just metadata
- **Image Display**: Converts blobs to object URLs instead of direct URL references
- **Storage Strategy**: Increased from ~16KB (URLs) to ~160-400MB (blobs) for offline support
- **IndexedDB Schema**: Upgraded to v2 with new history object store
- **Navigation UI**: Removed refresh button, next arrow always shows new random image
- **Transition System**: Complete rewrite using JavaScript-based crossfade for smooth, flash-free animations

## [2.0.0] - 2025-10-10

### 🎉 Major Rewrite - "Cute Wallpapers Reborn"

This version represents a complete rewrite and rebranding from the original "Cute Wallpapers Extension" to "Random Wallpaper Extension" with a TypeScript-first architecture.

### Added

#### 🎨 **Options Page & Settings Management**

- Comprehensive settings interface (no more code editing!)
- API key management: add, test, and delete keys via UI
- **Persistent API test status** - Test results saved across sessions
- Multiple API keys per source support
- Search keyword preferences for custom image themes
- Auto-refresh configuration (5-300 seconds)
- Clock display settings (12/24-hour format, optional seconds)
- Cache statistics dashboard with relative time display

#### ⚡ **Immediate Fetch System**

- **No waiting for 6-hour cycle** when adding API keys
- Instant background fetch triggered on settings save
- 10-second cooldown to prevent API spam
- Smart detection of settings changes
- Background message passing for reliability

#### 🛡️ **Fallback System**

- 20 high-quality default images from Unsplash
- Works immediately without API keys required
- Automatic fallback on API failures
- User notification with setup guidance
- Seamless first-time user experience
- No broken states or empty screens

#### 📈 **Enhanced Image Fetching**

- **Unsplash**: 30 images per fetch (API maximum)
- **Pexels**: 50 images per fetch (optimized from max 80)
- **Total**: 80 images per 6-hour refresh cycle
- Keyword search support for both APIs
- Single API support (works with just Unsplash OR Pexels)
- Random API key rotation for load distribution

#### 🕐 **Digital Clock Feature**

- Live clock display on new tab page
- Toggle between 12-hour and 24-hour format
- Optional seconds display with real-time updates
- Configurable via options page
- Beautiful design matching wallpaper aesthetic

#### 🎲 **True Cryptographic Randomness**

- Uses `crypto.getRandomValues()` for hardware-based entropy
- Cryptographically secure random selection
- Applied to image selection and API key rotation
- No patterns or biases in distribution
- Fair selection across all cached images

#### 📊 **Improved Cache Statistics**

- Relative time display ("2 hours ago", "3 days ago")
- Total, valid, and expired image counts
- Breakdown by source (Unsplash vs Pexels)
- Last fetch timestamp with smart formatting
- Clear cache functionality

### Changed

#### 🏗️ **Complete Architecture Rewrite**

- Migrated from JavaScript to **TypeScript**
- Modern build system using **esbuild**
- Manifest V3 compliance throughout
- Chrome Alarms API for reliable scheduling
- chrome.storage.local for settings synchronization
- IndexedDB for efficient image caching
- ES2020 module system

#### 🔄 **Background Worker Improvements**

- 6-hour automatic refresh (unchanged but more reliable)
- Service worker sleep-aware wake-up checks
- Fallback integration for zero-config startup
- Immediate fetch handler for options page
- Better error handling and recovery
- Cleanup of expired images before fetch

#### 🎨 **New Tab Page Enhancements**

- Auto-refresh with configurable intervals
- Digital clock display
- Refresh button for instant new image
- Settings button for quick access to options
- Fallback notification (only shown when using defaults)
- Smooth fade-in animations
- Photo credits with clickable links

### Removed (Temporarily - Better Implementation Coming!)

- 🔄 **Video background support** - Will be reimplemented with better performance and controls
- 🔄 **Inspirational quotes feature** - Will return with customizable quote sources and styling
- ✅ **config.example.ts** - Permanently replaced by Options Page UI (better UX)
- ✅ **Manual code editing for API keys** - Permanently replaced by Options Page (no going back!)
- ✅ **30-minute refresh cycle** - Replaced by 6-hour cycle for API efficiency (this is the way forward)

**Note**: Video backgrounds and quotes will return in future updates with improved implementations. The 6-hour refresh cycle is here to stay as it balances freshness with API rate limits.

### Technical Improvements

- **Storage Strategy**: chrome.storage.local + IndexedDB separation
- **Build System**: TypeScript → ES2020 via esbuild
- **Cache Hit Rate**: 90%+ with smart expiry management
- **API Efficiency**: Reduced requests with 6-hour cycle + immediate fetch on demand
- **Randomness**: Crypto-secure selection using Web Crypto API
- **Reliability**: Chrome Alarms persist across browser restarts
- **Performance**: Instant load from IndexedDB (<100ms)

### Migration from v1.x (Cute Wallpapers)

- Repository renamed: `cute-wallpaper-extension` → `random-wallpaper-extension`
- All settings now managed via Options Page
- No video support (image-focused experience)
- Longer refresh cycle (6 hours vs 30 minutes)
- More images per fetch (80 vs previous counts)
- TypeScript codebase (was JavaScript)

### User Experience Improvements

- ✅ Zero configuration required (works with fallback images)
- ✅ Immediate feedback when adding API keys
- ✅ Persistent API test status
- ✅ Relative time display (more human-readable)
- ✅ No waiting for 6-hour cycle on first setup
- ✅ Better error handling and user guidance
- ✅ Clean, modern options interface

---

## [1.0.0] - 2024-10-06 (Cute Wallpapers - Legacy)

### Added

- 🎨 **Dual API Support**: Integration with both Pexels and Unsplash APIs
- 🎬 **Video Backgrounds**: Support for video wallpapers from Pexels
- ⚡ **Advanced Caching System**: IndexedDB-based caching for instant loading
- 🌐 **Offline Support**: Works without internet using cached content
- 🔄 **Background Fetching**: Automatic content fetching every 30 minutes
- 🎛️ **Cache Management**: User controls for cache duration, size, and intervals
- 📊 **Real-time Statistics**: Cache performance monitoring in options
- 🎯 **Smart Content Balance**: 70% Pexels (with videos), 30% Unsplash
- 🔧 **Enhanced Options Page**: Comprehensive settings with API key testing
- 📱 **Responsive Design**: Optimized for all screen sizes
- 🎨 **Improved Text Visibility**: Enhanced shadows and overlays
- ⌨️ **Keyboard Shortcuts**: Quick access to refresh and search
- 🔒 **Privacy-focused**: Local API key storage, no data collection

### Technical Features

- IndexedDB cache with LRU eviction
- Intelligent cache cleanup (only removes expired if replacements exist)
- Rate-limited API requests with automatic retries
- Cache-first loading strategy for 90%+ hit rate
- Background service worker for content management
- Graceful fallbacks: Cache → API → Demo content
- Support for both image and video content types
- Real-time cache statistics and health monitoring

### Performance

- ⚡ Instant loading (0ms for cached content vs 500-2000ms API calls)
- 📉 95% reduction in real-time API requests
- 🔋 Reduced battery usage through efficient caching
- 🌐 Full offline functionality with cached content

### User Experience

- Beautiful video backgrounds with smooth autoplay
- Enhanced search functionality across both APIs
- Auto-refresh with configurable intervals
- Manual cache preloading option
- Clear cache management tools
- API key validation and testing
- Comprehensive error handling and user feedback

## [0.3.0] - 2024-10-05 (Cute Wallpapers - Legacy)

### Added

- Pexels API integration alongside Unsplash
- Video background support
- Improved error handling
- API key validation

### Fixed

- Manifest V3 permission issues
- API response parsing errors
- Text visibility on light backgrounds

## [0.2.0] - 2024-10-04 (Cute Wallpapers - Legacy)

### Added

- Options page with settings
- Auto-refresh functionality

### Changed

- Improved UI design
- Enhanced error handling
- Better responsive layout

## [0.1.0] - 2024-10-03 (Cute Wallpapers - Legacy)

### Added

- Initial release
- Basic Unsplash API integration
- New tab page replacement
- Random inspirational quotes
- Fallback images for demo mode
- Basic responsive design

### Security

- Local API key storage
- No external data collection
- Secure API communication

---

## Version Naming Convention

- **Major (X.0.0)**: Breaking changes, major rewrites, architectural changes
- **Minor (x.Y.0)**: New features, enhancements, backwards compatible
- **Patch (x.y.Z)**: Bug fixes, small improvements, backwards compatible

## Project History

**v2.0.0+**: Random Wallpaper Extension (TypeScript rewrite)  
**v0.1.0-v1.0.0**: Cute Wallpapers Extension (JavaScript original)

---

## Links

- **Repository**: https://github.com/yourusername/random-wallpaper-extension
- **Issues**: https://github.com/yourusername/random-wallpaper-extension/issues
- **API Keys**:
  - Unsplash: https://unsplash.com/developers
  - Pexels: https://www.pexels.com/api/
