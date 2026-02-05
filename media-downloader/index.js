/**
 * Media Downloader CD
 *
 * Downloads media from:
 * - Direct media URLs (.mp4, .mp3, .webm, etc.)
 * - YouTube (extracts available streams)
 *
 * Note: YouTube uses adaptive streaming. Some formats may not be available
 * without signature decryption (which requires yt-dlp).
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
    candidates: [],
    videoInfo: null,
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

  // Check for YouTube
  if (currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/')) {
    result.site = 'youtube';

    // Extract video ID
    var videoId = null;
    var match = currentUrl.match(/[?&]v=([^&]+)/) || currentUrl.match(/youtu\.be\/([^?&]+)/);
    if (match) {
      videoId = match[1];
    }

    if (!videoId) {
      result.error = 'Could not extract YouTube video ID';
      return result;
    }

    result.videoInfo = {
      id: videoId,
      url: 'https://www.youtube.com/watch?v=' + videoId,
      thumbnails: {
        maxres: 'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg',
        hq: 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg',
        default: 'https://img.youtube.com/vi/' + videoId + '/default.jpg'
      }
    };

    result.message = 'YouTube video detected. Video ID: ' + videoId + '\n\nClick "Run CD" to attempt stream extraction.';
    return result;
  }

  // Check for YouTube Shorts
  if (currentUrl.includes('youtube.com/shorts/')) {
    result.site = 'youtube';
    var shortsMatch = currentUrl.match(/youtube\.com\/shorts\/([^?&]+)/);
    if (shortsMatch) {
      var shortsId = shortsMatch[1];
      result.videoInfo = {
        id: shortsId,
        url: 'https://www.youtube.com/watch?v=' + shortsId,
        thumbnails: {
          maxres: 'https://img.youtube.com/vi/' + shortsId + '/maxresdefault.jpg'
        }
      };
      result.message = 'YouTube Short detected. Video ID: ' + shortsId;
      return result;
    }
  }

  // Check if direct media URL
  var urlType = classifyUrl(currentUrl);

  if (urlType === 'stream') {
    result.error = 'Streaming manifest detected (.m3u8/.mpd). These are segmented streams that require special handling.';
    return result;
  }

  if (urlType) {
    result.site = 'direct';
    result.candidates.push({
      url: currentUrl,
      filename: getFilename(currentUrl),
      type: urlType,
      extension: getExtension(currentUrl),
      source: 'direct-url'
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
  result.message = 'No media detected on this page.\n\n' +
    'Supported:\n' +
    '• YouTube videos (youtube.com/watch?v=...)\n' +
    '• Direct media URLs (.mp4, .mp3, .webm, etc.)\n\n' +
    'Not supported:\n' +
    '• Netflix, Spotify, Disney+ (DRM protected)\n' +
    '• Embedded players without direct URLs';

  return result;
}

/**
 * Run - Download or extract media
 */
async function Run(data) {
  if (!data) {
    return { success: false, error: 'No data. Click "Get Data" first.' };
  }

  if (data.error) {
    return { success: false, error: data.error };
  }

  // Handle YouTube
  if (data.site === 'youtube' && data.videoInfo) {
    return await handleYouTube(data.videoInfo);
  }

  // Handle direct media URLs
  if (data.site === 'direct' && data.candidates && data.candidates.length > 0) {
    return handleDirectMedia(data.candidates[0]);
  }

  return {
    success: false,
    error: 'No downloadable media found.'
  };
}

/**
 * Handle YouTube video extraction
 */
async function handleYouTube(videoInfo) {
  var videoId = videoInfo.id;

  try {
    // Fetch the YouTube page to extract player data
    var response = await fetch('https://www.youtube.com/watch?v=' + videoId, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch YouTube page: ' + response.status);
    }

    var html = await response.text();

    // Extract ytInitialPlayerResponse
    var playerMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!playerMatch) {
      // Try alternative pattern
      playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    }

    if (!playerMatch) {
      // Fallback: offer thumbnail download
      return {
        success: true,
        action: 'download',
        download: {
          url: videoInfo.thumbnails.maxres,
          filename: 'youtube-' + videoId + '-thumbnail.jpg',
          saveAs: true
        },
        message: 'Could not extract video streams. Downloading thumbnail instead.\n\nFor full video download, use yt-dlp:\nyt-dlp "https://youtube.com/watch?v=' + videoId + '"',
        note: 'YouTube stream extraction failed - page structure may have changed'
      };
    }

    // Parse player response
    var playerData;
    try {
      playerData = JSON.parse(playerMatch[1]);
    } catch (e) {
      throw new Error('Failed to parse player data');
    }

    // Check for playability
    var playability = playerData.playabilityStatus;
    if (playability && playability.status !== 'OK') {
      var reason = playability.reason || playability.status;
      return {
        success: false,
        error: 'Video not available: ' + reason
      };
    }

    // Get video title
    var title = 'youtube-' + videoId;
    if (playerData.videoDetails && playerData.videoDetails.title) {
      title = playerData.videoDetails.title
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);
    }

    // Extract streaming formats
    var formats = [];

    if (playerData.streamingData) {
      // Regular formats (video+audio combined)
      if (playerData.streamingData.formats) {
        playerData.streamingData.formats.forEach(function(f) {
          if (f.url) {
            formats.push({
              url: f.url,
              quality: f.qualityLabel || f.quality || 'unknown',
              mimeType: f.mimeType || '',
              type: 'combined',
              hasAudio: true,
              hasVideo: true
            });
          }
        });
      }

      // Adaptive formats (separate audio/video)
      if (playerData.streamingData.adaptiveFormats) {
        playerData.streamingData.adaptiveFormats.forEach(function(f) {
          if (f.url) {
            var isAudio = f.mimeType && f.mimeType.includes('audio');
            formats.push({
              url: f.url,
              quality: f.qualityLabel || f.audioQuality || f.quality || 'unknown',
              mimeType: f.mimeType || '',
              bitrate: f.bitrate,
              type: isAudio ? 'audio' : 'video',
              hasAudio: isAudio,
              hasVideo: !isAudio
            });
          }
        });
      }
    }

    // Filter for formats with direct URLs (no signature required)
    var availableFormats = formats.filter(function(f) {
      return f.url && !f.url.includes('signature') && !f.url.includes('&s=');
    });

    if (availableFormats.length === 0) {
      // All formats require signature decryption
      return {
        success: true,
        action: 'download',
        download: {
          url: videoInfo.thumbnails.maxres,
          filename: title + '-thumbnail.jpg',
          saveAs: true
        },
        message: 'Video streams require signature decryption (not available in browser).\n\n' +
          'Downloading thumbnail instead.\n\n' +
          'For full video, use yt-dlp:\n' +
          'yt-dlp -f "bestaudio" --extract-audio --audio-format mp3 "https://youtube.com/watch?v=' + videoId + '"',
        ytdlpCommand: 'yt-dlp -x --audio-format mp3 "https://youtube.com/watch?v=' + videoId + '"'
      };
    }

    // Find best audio format
    var audioFormats = availableFormats.filter(function(f) {
      return f.type === 'audio';
    }).sort(function(a, b) {
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    // Find best combined format
    var combinedFormats = availableFormats.filter(function(f) {
      return f.type === 'combined';
    });

    // Prefer audio-only for MP3 conversion path
    if (audioFormats.length > 0) {
      var bestAudio = audioFormats[0];
      var ext = '.webm';
      if (bestAudio.mimeType.includes('mp4')) ext = '.m4a';

      return {
        success: true,
        action: 'download',
        download: {
          url: bestAudio.url,
          filename: title + ext,
          saveAs: true
        },
        message: 'Downloading audio: ' + title + ext + '\n\nQuality: ' + bestAudio.quality,
        availableFormats: availableFormats.length,
        note: 'To convert to MP3, use: ffmpeg -i "' + title + ext + '" "' + title + '.mp3"'
      };
    }

    // Fall back to combined format
    if (combinedFormats.length > 0) {
      var best = combinedFormats[0];
      return {
        success: true,
        action: 'download',
        download: {
          url: best.url,
          filename: title + '.mp4',
          saveAs: true
        },
        message: 'Downloading video: ' + title + '.mp4\n\nQuality: ' + best.quality,
        availableFormats: availableFormats.length
      };
    }

    // Last resort - any available format
    var anyFormat = availableFormats[0];
    return {
      success: true,
      action: 'download',
      download: {
        url: anyFormat.url,
        filename: title + '.mp4',
        saveAs: true
      },
      message: 'Downloading: ' + title
    };

  } catch (error) {
    // On any error, offer thumbnail download
    return {
      success: true,
      action: 'download',
      download: {
        url: videoInfo.thumbnails.maxres,
        filename: 'youtube-' + videoId + '-thumbnail.jpg',
        saveAs: true
      },
      message: 'Stream extraction failed: ' + error.message + '\n\nDownloading thumbnail instead.\n\nFor video download, use yt-dlp:\nyt-dlp "https://youtube.com/watch?v=' + videoId + '"',
      error: error.message
    };
  }
}

/**
 * Handle direct media URL download
 */
function handleDirectMedia(media) {
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
