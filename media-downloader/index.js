/**
 * Media Downloader / MP3 Converter CD
 *
 * Detects direct media URLs from pages and downloads them.
 * For non-MP3 audio, requests conversion via extension action.
 *
 * Supported: .mp3, .mp4, .m4a, .webm, .ogg, .wav, .flac, .aac
 * Not supported: .m3u8 (HLS), .mpd (DASH), DRM-protected content
 */

var MEDIA_EXTENSIONS = {
  audio: ['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac', '.wma'],
  video: ['.mp4', '.webm', '.mkv', '.avi', '.mov'],
  stream: ['.m3u8', '.mpd']
};

/**
 * DataCollector - Collects candidate media URLs
 * @param {string} currentUrl - Current page URL
 */
function DataCollector(currentUrl) {
  var result = {
    timestamp: Date.now(),
    pageUrl: currentUrl || '',
    candidates: [],
    inputMode: null,
    message: ''
  };

  if (!currentUrl) {
    result.error = 'No URL provided.';
    return result;
  }

  // Helper: get file extension
  function getExtension(url) {
    try {
      var path = new URL(url).pathname.toLowerCase();
      var dotIdx = path.lastIndexOf('.');
      return dotIdx > 0 ? path.substring(dotIdx) : '';
    } catch (e) {
      return '';
    }
  }

  // Helper: get filename from URL
  function getFilename(url) {
    try {
      var path = new URL(url).pathname;
      var parts = path.split('/');
      return parts[parts.length - 1].split('?')[0] || 'media';
    } catch (e) {
      return 'media';
    }
  }

  // Helper: classify URL
  function classifyUrl(url) {
    var ext = getExtension(url);
    if (MEDIA_EXTENSIONS.audio.includes(ext)) return 'audio';
    if (MEDIA_EXTENSIONS.video.includes(ext)) return 'video';
    if (MEDIA_EXTENSIONS.stream.includes(ext)) return 'stream';
    return null;
  }

  // Check if current URL itself is a direct media file
  var currentExt = getExtension(currentUrl);
  var currentType = classifyUrl(currentUrl);

  if (currentType === 'stream') {
    result.error = 'This is a streaming manifest (.m3u8/.mpd). Cannot download directly - these are segmented streams that require special handling.';
    return result;
  }

  if (currentType) {
    result.candidates.push({
      url: currentUrl,
      filename: getFilename(currentUrl),
      type: currentType,
      extension: currentExt,
      source: 'direct-url'
    });
    result.inputMode = 'direct-url';
    result.message = 'Direct media URL detected: ' + currentExt.toUpperCase().replace('.', '');
    return result;
  }

  // For non-media pages, try to find media in common URL patterns
  // This is a heuristic approach since we can't access page DOM from sandbox

  // Check for YouTube
  if (currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/')) {
    result.error = 'YouTube uses encrypted adaptive streaming (DASH). Direct media URLs are not accessible. Use a dedicated YouTube downloader service.';
    return result;
  }

  // Check for other known streaming sites
  var streamingSites = ['netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'spotify.com'];
  for (var i = 0; i < streamingSites.length; i++) {
    if (currentUrl.includes(streamingSites[i])) {
      result.error = 'This site (' + streamingSites[i] + ') uses DRM-protected streaming. Content cannot be downloaded.';
      return result;
    }
  }

  // For other pages, prompt user to provide direct URL
  result.inputMode = 'manual';
  result.message = 'No direct media URL detected. To download media:\n' +
    '1. Find the direct media file URL (right-click media → Copy video/audio URL)\n' +
    '2. Navigate directly to that URL\n' +
    '3. Run Get Data again\n\n' +
    'Supported formats: ' + MEDIA_EXTENSIONS.audio.concat(MEDIA_EXTENSIONS.video).join(', ');

  return result;
}

/**
 * Run - Process and download/convert media
 * @param {Object} data - Data from DataCollector
 */
async function Run(data) {
  if (!data) {
    return {
      success: false,
      error: 'No data collected. Click "Get Data" first.'
    };
  }

  if (data.error) {
    return {
      success: false,
      error: data.error
    };
  }

  if (!data.candidates || data.candidates.length === 0) {
    return {
      success: false,
      error: 'No media files found. Navigate directly to a media file URL (.mp3, .mp4, etc.) and try again.'
    };
  }

  var media = data.candidates[0];
  var ext = media.extension.toLowerCase();
  var filename = media.filename;

  // Handle streaming manifests
  if (MEDIA_EXTENSIONS.stream.includes(ext)) {
    return {
      success: false,
      error: 'Cannot download streaming manifests (.m3u8/.mpd) directly. These are segmented streams used by sites like YouTube, Netflix, etc.'
    };
  }

  // If already MP3, download directly
  if (ext === '.mp3') {
    return {
      success: true,
      action: 'download',
      download: {
        url: media.url,
        filename: filename,
        saveAs: true
      },
      message: 'Downloading MP3: ' + filename
    };
  }

  // For other audio formats, offer conversion or direct download
  if (MEDIA_EXTENSIONS.audio.includes(ext)) {
    // Return convert action (extension needs handler for this)
    return {
      success: true,
      action: 'convert_to_mp3',
      source: {
        url: media.url,
        type: 'audio',
        extension: ext,
        filename: filename
      },
      outputFilename: filename.replace(ext, '.mp3'),
      message: 'Audio file detected (' + ext + '). Conversion to MP3 requested.',
      fallback: {
        action: 'download',
        download: {
          url: media.url,
          filename: filename,
          saveAs: true
        },
        message: 'If conversion is not available, downloading original: ' + filename
      }
    };
  }

  // For video formats, offer audio extraction or direct download
  if (MEDIA_EXTENSIONS.video.includes(ext)) {
    return {
      success: true,
      action: 'convert_to_mp3',
      source: {
        url: media.url,
        type: 'video',
        extension: ext,
        filename: filename
      },
      outputFilename: filename.replace(ext, '.mp3'),
      message: 'Video file detected (' + ext + '). Audio extraction to MP3 requested.',
      fallback: {
        action: 'download',
        download: {
          url: media.url,
          filename: filename,
          saveAs: true
        },
        message: 'If conversion is not available, downloading original video: ' + filename
      }
    };
  }

  // Unknown format - try direct download
  return {
    success: true,
    action: 'download',
    download: {
      url: media.url,
      filename: filename,
      saveAs: true
    },
    message: 'Downloading: ' + filename
  };
}
