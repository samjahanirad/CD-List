# Media Downloader Component

Downloads videos from YouTube and direct media URLs.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER CLICKS                             │
│                        "Get Data" button                        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DataCollector()                            │
│                                                                 │
│  Looks at the current page URL and asks:                        │
│  • Is this a YouTube video? → Extract video ID                  │
│  • Is this a direct media file (.mp4, .mp3)? → Use URL directly │
│  • Is this a DRM site (Netflix, etc)? → Show error              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         USER CLICKS                             │
│                        "Run CD" button                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                           Run()                                 │
│                                                                 │
│  Returns an "action" telling the extension what to do:          │
│  • YouTube → { action: 'youtube_download', videoId: '...' }     │
│  • Direct  → { action: 'download', url: '...' }                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Extension Popup                              │
│                  (search-page.js)                               │
│                                                                 │
│  Receives the action and handles it:                            │
│  • 'youtube_download' → Sends message to service worker         │
│  • 'download' → Sends message to service worker                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Service Worker                               │
│               (service-worker.js)                               │
│                                                                 │
│  For YouTube:                                                   │
│  1. Calls YouTube's InnerTube API (same API mobile apps use)    │
│  2. Pretends to be an Android/iOS app (gets direct URLs)        │
│  3. Finds the best video/audio format                           │
│  4. Returns the download URL                                    │
│                                                                 │
│  For direct files:                                              │
│  1. Uses Chrome's Downloads API                                 │
│  2. Downloads the file directly                                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      FILE DOWNLOADS                             │
│                    to your computer                             │
└─────────────────────────────────────────────────────────────────┘
```

## YouTube Download Flow (Detailed)

When you click "Run CD" on a YouTube page:

```
Component                    Extension Popup              Service Worker
   │                              │                            │
   │ {action:'youtube_download',  │                            │
   │  videoId:'abc123'}           │                            │
   │ ─────────────────────────────>                            │
   │                              │                            │
   │                              │ YOUTUBE_GET_STREAM         │
   │                              │ {videoId:'abc123'}         │
   │                              │ ───────────────────────────>
   │                              │                            │
   │                              │                            │ Calls InnerTube API
   │                              │                            │ (youtube.com/youtubei/v1/player)
   │                              │                            │
   │                              │         {url, filename}    │
   │                              │ <───────────────────────────
   │                              │                            │
   │                              │ DOWNLOAD_FILE              │
   │                              │ {url, filename}            │
   │                              │ ───────────────────────────>
   │                              │                            │
   │                              │                            │ chrome.downloads.download()
   │                              │                            │
   │                              │              Download ID   │
   │                              │ <───────────────────────────
```

## Why InnerTube API?

YouTube protects its videos using "signature encryption". When you watch a video:
- The browser gets encrypted stream URLs
- YouTube's JavaScript decrypts them
- This decryption changes frequently

**The trick:** YouTube's mobile apps (Android/iOS) often get direct, unencrypted URLs because they're "trusted" apps. The InnerTube API is the same API these apps use.

By pretending to be the Android YouTube app, we can sometimes get direct download URLs without needing to decrypt signatures.

## Limitations

- **Age-restricted videos**: May not work without being logged in
- **Some videos**: Still require signature decryption (will show error)
- **Music videos**: Often have extra protection
- **Region-locked**: Videos not available in your country won't work

## Files

```
CDs/media-downloader/
├── manifest.json    # Component metadata
├── index.js         # DataCollector() and Run() functions
└── README.md        # This file
```
