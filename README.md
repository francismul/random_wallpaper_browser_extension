# Random Wallpaper Extension

- 🌐 **Works Without Internet**: All images cached locally, displays work completely offline
- ⏳ **Auto Expiry**: Images expire after 24 hours to keep content fresh
- 🔁 **Automatic Refresh**: Fetches new images every 6 hours in the backgroundaper Extension

A TypeScript-based browser extension I built that displays beautiful random wallpapers from Unsplash and Pexels on every new tab. It features a comprehensive settings page, smart caching, and works even without API keys!

## ✨ Features

- 🖼 **Dual API Integration**: Fetches high-quality images from both Unsplash and Pexels (80 images per refresh!)
- ⚙️ **Options Page**: Full-featured settings interface for managing API keys, preferences, and cache
- 🔑 **Flexible API Keys**: Add multiple keys per source, test them, and even use just one API if you prefer
- �️ **Smart Fallback**: 20 beautiful default images when no API keys are configured
- 🔍 **Search Keywords**: Customize image themes for each API source
- �💾 **Smart Caching**: Stores images in IndexedDB for offline access
- ⏳ **Auto Expiry**: Images expire after 24 hours to keep content fresh
- 🔁 **Automatic Refresh**: Fetches new images every 6 hours in the background
- 🔄 **Auto-Refresh Display**: Optional auto-rotating images on new tab (5-300s intervals)
- 🕐 **Clock Display**: Beautiful clock with date, 12/24hr format, and optional seconds
- 🎲 **True Random Selection**: Uses Web Crypto API for cryptographically secure randomness
- ⚡ **Fast Loading**: All images served from local cache
- 📊 **Cache Statistics**: Real-time stats showing total, valid, expired images by source
- 🎨 **Beautiful UI**: Clean, modern interface with smooth transitions

## 🚀 Setup Instructions

### 1. Build the Extension

First, build the extension (you can add API keys later through the options page):

```bash
# Install dependencies
pnpm install

# Build the extension
pnpm run build
```

or use build scripts (Windows)

```powershell
# command prompt / powershell
setup.bat

# or
setup.ps1
```

(Linux/Mac users can use)

```bash
chmod +x setup.sh
./setup.sh
```

### 2. Load in Browser

#### Chrome/Edge

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist` folder

#### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select the `manifest.json` file in the `dist` folder

### 3. Configure API Keys (Optional)

The extension works immediately with 20 beautiful fallback images! For fresh daily content:

#### Get API Keys (Both Free!)

- **Unsplash**: [https://unsplash.com/developers](https://unsplash.com/developers) - Create app, copy Access Key
- **Pexels**: [https://www.pexels.com/api/](https://www.pexels.com/api/) - Sign up, copy API Key

#### Add Keys via Options Page

1. Right-click the extension icon → **Options** (or click the ⚙️ button on new tab)
2. Add your API keys in the settings
3. Click "Test" to verify they work
4. Configure search keywords (optional)
5. Set up auto-refresh preferences (optional)
6. Save changes

**The extension fetches images immediately when you add API keys!** No need to wait for the 6-hour cycle.

## 📖 How It Works

### Background Service Worker

- **On Install**: Initializes IndexedDB and loads fallback images
- **When API Keys Added**: Immediately fetches fresh images (no waiting!)
- **Every 6 Hours**: Automatically fetches new images via Chrome Alarms API
- **On Startup**: Checks if last fetch was >6 hours ago and refreshes if needed
- **Smart Scheduling**: Uses alarms to work even when service worker is asleep
- **Fallback System**: Uses 20 default images when no API keys configured

### Image Fetching Strategy

- **Unsplash**: Fetches 30 images (API maximum)
- **Pexels**: Fetches 50 images (optimized for variety)
- **Total**: Up to 80 images per refresh cycle!
- **Single API**: Works with just Unsplash OR Pexels (30-50 images)
- **Keywords**: Optional search terms to customize image themes
- **Blob Storage**: Downloads full image blobs (~2-5MB each) for true offline support
- **Storage Size**: Expect ~160-400MB total storage (80 images × 2-5MB each)
- **Memory Management**: Object URLs created/revoked automatically to prevent memory leaks
- **Offline First**: All stored in IndexedDB with metadata (source, author, URL, timestamps)
- **Expiry**: Each image expires after 24 hours, cleaned automatically

### New Tab Display

- **Always from Cache**: Never fetches directly from APIs (instant loading!)
- **True Offline**: Displays work completely without internet connection
- **Blob URLs**: Creates temporary object URLs from stored blobs for display
- **Memory Safety**: Automatically revokes old blob URLs to prevent memory leaks
- **True Random**: Uses crypto-secure `crypto.getRandomValues()` for selection
- **Refresh Button**: Gets a different random image from the existing cache
- **Auto-Refresh**: Optional timer to rotate images (configurable 5-300 seconds)
- **Clock Display**: Shows current time and date with customizable format
- **Smooth Transitions**: Images fade in beautifully with CSS animations
- **Photo Credits**: Displays photographer name and source with links

### Settings Sync

- Settings stored in `chrome.storage.local`
- Changes apply instantly across all tabs
- Survives extension updates and browser restarts
- API key test results persist

## 🛠 Development

### Watch Mode

```bash
npm run watch
```

### Project Structure

```
src/
├── background.ts          # Service worker (periodic fetching, immediate fetch on key add)
├── manifest.json          # Extension manifest
├── newTab.html           # New tab page UI
├── options.html          # Settings page UI
├── content/
│   ├── api.ts            # Unsplash/Pexels API integration (80 images!)
│   ├── db.ts             # IndexedDB wrapper
│   ├── newTab.ts         # New tab page logic (auto-refresh, clock)
│   └── fallback.ts       # 20 default wallpapers
├── options.ts            # Settings page logic (API testing, stats)
└── utils/
    └── random.ts         # Crypto-random utilities
```

### Technologies Used

- **TypeScript**: Type-safe development
- **esbuild**: Fast bundling to vanilla JS
- **IndexedDB**: Client-side image storage (up to 80 images)
- **chrome.storage.local**: Settings synchronization
- **Web Crypto API**: Cryptographically secure random number generation
- **Chrome Extension APIs**: Alarms, Storage, Runtime

## 🎯 Key Behaviors

### Immediate Fetch on API Key Addition

When you add API keys through the options page:

1. Background worker fetches images immediately
2. Updates last fetch timestamp
3. New tab shows fresh images right away
4. Then waits for the regular 6-hour cycle

### Service Worker Sleep Management

The service worker may sleep when the browser is idle. When it wakes up:

1. Checks `lastFetch` timestamp from IndexedDB
2. Compares with current time
3. If >6 hours have passed, triggers a fresh API fetch
4. Otherwise, uses existing cached images

### Fallback System

- **No API Keys**: Uses 20 beautiful default images
- **Single API**: Works perfectly with just Unsplash OR Pexels
- **API Failure**: Falls back to cached images or defaults
- **First Run**: Shows fallback images with notification to configure keys

### Image Refresh Logic

- **Immediate**: When API keys are added/updated
- **Automatic**: Background process every 6 hours
- **Manual**: Click refresh button (uses existing cache)
- **Auto-Rotate**: Optional timer on new tab (5-300s intervals)

## 📝 Notes

- **API Limits**: Unsplash (50 req/hr), Pexels (200 req/hr) - I stay well within limits
- **Refresh Interval**: 6-hour cycle keeps you under rate limits
- **Storage**: URLs only (not blobs) to save space (~16KB for 80 images)
- **Persistence**: API keys and settings survive extension updates
- **Privacy**: Your API keys never leave your browser
- **Offline**: Works perfectly offline after initial fetch

## 📄 License

MIT

## 🤝 Contributing

Feel free to submit issues or pull requests!

---

**Enjoy your beautiful new tab experience! 🎨✨**

_Built with TypeScript, love, and a passion for beautiful wallpapers._
