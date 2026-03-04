/**
 * ytdl-cd
 *
 * Downloads YouTube videos using the bundled YTDLCore library.
 * Tries ANDROID_VR → ANDROID → TV_EMBED clients (2026 configs).
 * Each candidate URL is validated with a real GET range request before use.
 * Falls back to the service-worker downloader if all sandbox extractions fail.
 *
 * Usage:
 *   1. Navigate to a YouTube video page
 *   2. Click "Get Data" — collects the video ID
 *   3. Click "Run CD"  — downloads the video
 */

/**
 * Extracts a YouTube video ID from a variety of URL formats.
 * @param {string} url
 * @returns {string|null}
 */
function extractVideoId(url) {
  if (!url) return null;

  var patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
    /\/watch\/([a-zA-Z0-9_-]{11})/
  ];

  for (var i = 0; i < patterns.length; i++) {
    var m = url.match(patterns[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Called when the user clicks "Get Data".
 *
 * Extracts the YouTube video ID from the current page URL and
 * captures the user's YouTube browser cookies (passed by the core
 * as a second argument when manifest.useCookies is true).
 *
 * @param {string} currentUrl - Active tab URL
 * @param {Object} [context]  - Core-injected context: { cookies: [{name,value}] }
 * @returns {Object} Collected data passed to Run()
 */
function DataCollector(currentUrl, context) {
  var result = {
    pageUrl: currentUrl || '',
    videoId: null,
    cookies: (context && Array.isArray(context.cookies)) ? context.cookies : [],
    message: ''
  };

  if (!currentUrl) {
    result.error = 'No URL provided.';
    return result;
  }

  var isYouTube = currentUrl.includes('youtube.com') || currentUrl.includes('youtu.be');
  if (!isYouTube) {
    result.error = 'Not a YouTube page. Navigate to a YouTube video first.';
    return result;
  }

  var videoId = extractVideoId(currentUrl);
  if (!videoId) {
    result.error = 'Could not extract video ID from URL: ' + currentUrl;
    return result;
  }

  result.videoId = videoId;
  result.message = [
    'Video ID: ' + videoId,
    'Cookies collected: ' + result.cookies.length,
    '',
    'Click "Run CD" to download the video.'
  ].join('\n');

  return result;
}

/**
 * Called when the user clicks "Run CD".
 *
 * Uses the bundled YTDLCore library to call YouTube's InnerTube API
 * directly from the sandbox, extract a direct stream URL, and return
 * a download action for the core to execute.
 *
 * @param {Object} data - Return value from DataCollector()
 * @returns {Promise<Object>} Download action or error object
 */
async function Run(data) {
  if (!data) {
    return { success: false, error: 'No data. Click "Get Data" first.' };
  }

  if (data.error) {
    return { success: false, error: data.error };
  }

  if (!data.videoId) {
    return { success: false, error: 'No video ID collected. Click "Get Data" on a YouTube video page.' };
  }

  try {
    // YTDLCore (lib.js) tries ANDROID_VR → ANDROID → TV_EMBED.
    // Each URL is validated with a real GET range request so n-param
    // protected URLs are caught before Chrome ever sees them.
    var stream = await YTDLCore.getStreamUrl(data.videoId, 'video', data.cookies);

    return {
      success: true,
      action: 'download',
      download: {
        url: stream.url,
        filename: stream.filename,
        saveAs: true
      },
      message: [
        'Downloading: ' + stream.title,
        'Quality: ' + stream.quality,
        'Format: ' + (stream.mimeType || 'unknown'),
        'Client: ' + stream.client
      ].join('\n')
    };
  } catch (err) {
    // All sandbox clients failed — hand off to the service worker which
    // has full cipher decryption support.
    return {
      success: true,
      action: 'youtube_download',
      videoId: data.videoId,
      type: 'video',
      message: 'Using built-in downloader (sandbox extraction failed).\nReason: ' + err.message
    };
  }
}
