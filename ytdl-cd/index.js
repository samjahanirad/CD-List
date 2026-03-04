/**
 * ytdl-cd
 *
 * Downloads YouTube videos using the bundled pure-JS YTDLCore library.
 *
 * Usage:
 *   1. Navigate to a YouTube video page
 *   2. Click "Get Data" — collects the video ID and your YouTube cookies
 *   3. Click "Run CD"  — extracts the stream URL and downloads the file
 *
 * Notes:
 *   - Works for most public YouTube videos without login
 *   - If logged in to YouTube, your session cookies are used automatically
 *     to access age-restricted or member-only content
 *   - Uses a bundled YTDLCore library (lib.js) — no external services needed
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
    // YTDLCore is injected by lib.js before this code runs
    var stream = await YTDLCore.getStreamUrl(data.videoId, 'video', data.cookies);

    // Validate the stream URL before triggering a download.
    // YouTube CDN URLs with an undecrypted "n" parameter return a 403 HTML
    // error page which Chrome saves as a text file instead of a video.
    try {
      var headRes = await fetch(stream.url, { method: 'HEAD' });
      var ct = headRes.headers.get('content-type') || '';
      if (!headRes.ok || (!ct.startsWith('video/') && !ct.startsWith('audio/'))) {
        throw new Error('URL check: ' + headRes.status + ' ' + (ct || 'unknown content-type'));
      }
    } catch (validateErr) {
      throw new Error('Stream URL invalid (' + validateErr.message + ')');
    }

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
        'Extracted via: ' + stream.client + ' client'
      ].join('\n')
    };
  } catch (err) {
    // lib.js extraction failed or URL was invalid — fall back to the
    // service-worker's built-in YouTube handler which handles cipher decryption.
    return {
      success: true,
      action: 'youtube_download',
      videoId: data.videoId,
      type: 'video',
      message: 'Using built-in downloader.\nReason: ' + err.message
    };
  }
}
