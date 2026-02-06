/**
 * Media Downloader CD
 *
 * Downloads media from:
 * - YouTube (via YouTube.js - handles signature decryption)
 * - Direct media URLs (.mp4, .mp3, .webm, etc.)
 *
 * Uses background service worker for YouTube.js integration.
 */

var MEDIA_EXTENSIONS = {
  audio: ['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac', '.wma', '.opus'],
  video: ['.mp4', '.webm', '.mkv', '.avi', '.mov'],
  stream: ['.m3u8', '.mpd']
};

/**
 * DataCollector - Detects media on the page
 */
function DataCollector(currentUrl) {
  var result = {
    timestamp: Date.now(),
    pageUrl: currentUrl || '',
    site: null,
    videoId: null,
    candidates: [],
    message: ''
  };

  if (!currentUrl) {
    result.error = 'No URL provided.';
    return result;
  }

  // Helper functions
  function getExtension(url) {
    try {
      var path = new URL(url).pathname.toLowerCase();
      var dotIdx = path.lastIndexOf('.');
      return dotIdx > 0 ? path.substring(dotIdx) : '';
    } catch (e) {
      return '';
    }
  }

  function getFilename(url) {
    try {
      var path = new URL(url).pathname;
      var parts = path.split('/');
      return parts[parts.length - 1].split('?')[0] || 'media';
    } catch (e) {
      return 'media';
    }
  }

  function classifyUrl(url) {
    var ext = getExtension(url);
    if (MEDIA_EXTENSIONS.audio.includes(ext)) return 'audio';
    if (MEDIA_EXTENSIONS.video.includes(ext)) return 'video';
    if (MEDIA_EXTENSIONS.stream.includes(ext)) return 'stream';
    return null;
  }

  // Extract YouTube video ID from various URL formats
  function extractYouTubeId(url) {
    var patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/
    ];

    for (var i = 0; i < patterns.length; i++) {
      var match = url.match(patterns[i]);
      if (match) return match[1];
    }
    return null;
  }

  // Check for YouTube
  var youtubeId = extractYouTubeId(currentUrl);
  if (youtubeId) {
    result.site = 'youtube';
    result.videoId = youtubeId;
    result.message = 'YouTube video detected!\n\nVideo ID: ' + youtubeId + '\n\nClick "Run CD" to download video (with audio).';
    return result;
  }

  // Check if direct media URL
  var urlType = classifyUrl(currentUrl);

  if (urlType === 'stream') {
    result.error = 'Streaming manifest detected (.m3u8/.mpd). These are segmented streams that cannot be downloaded directly.';
    return result;
  }

  if (urlType) {
    result.site = 'direct';
    result.candidates.push({
      url: currentUrl,
      filename: getFilename(currentUrl),
      type: urlType,
      extension: getExtension(currentUrl)
    });
    result.message = 'Direct ' + urlType + ' file detected: ' + getFilename(currentUrl);
    return result;
  }

  // Check for known DRM sites
  var drmSites = ['netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'spotify.com'];
  for (var i = 0; i < drmSites.length; i++) {
    if (currentUrl.includes(drmSites[i])) {
      result.error = 'This site uses DRM protection. Content cannot be downloaded.';
      return result;
    }
  }

  // Unknown page
  result.site = 'unknown';
  result.message = 'No media detected.\n\nSupported:\n• YouTube (youtube.com/watch?v=...)\n• Direct media URLs (.mp4, .mp3, etc.)';

  return result;
}

/**
 * Run - Download media
 * For YouTube: calls background service worker with YouTube.js
 * For direct URLs: returns download action
 */
async function Run(data) {
  if (!data) {
    return { success: false, error: 'No data. Click "Get Data" first.' };
  }

  if (data.error) {
    return { success: false, error: data.error };
  }

  // Handle YouTube via background service
  if (data.site === 'youtube' && data.videoId) {
    return {
      success: true,
      action: 'youtube_download',
      videoId: data.videoId,
      type: 'video', // 'video' for video+audio, 'audio' for audio only
      message: 'Fetching YouTube video...'
    };
  }

  // Handle direct media URLs
  if (data.site === 'direct' && data.candidates && data.candidates.length > 0) {
    var media = data.candidates[0];
    return {
      success: true,
      action: 'download',
      download: {
        url: media.url,
        filename: media.filename,
        saveAs: true
      },
      message: 'Downloading: ' + media.filename
    };
  }

  return { success: false, error: 'No downloadable media found.' };
}
