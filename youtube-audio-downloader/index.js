/**
 * YouTube Audio Downloader CD
 * Downloads audio (MP3) from YouTube videos
 * Uses cobalt.tools API for audio extraction
 *
 * Usage:
 * 1. Navigate to a YouTube video page
 * 2. Click "Get Data" to collect video information
 * 3. Click "Run CD" to download the audio as MP3
 */

/**
 * DataCollector - Called when user clicks "Get Data"
 * Detects YouTube video and collects metadata
 */
function DataCollector(currentUrl) {
  var result = {
    timestamp: Date.now(),
    platform: null,
    videoId: null,
    videoUrl: null,
    title: null,
    media: []
  };

  if (!currentUrl) {
    result.error = 'No URL provided. Make sure you are on a YouTube video page.';
    return result;
  }

  // Parse URL
  try {
    var urlObj = new URL(currentUrl);
    var hostname = urlObj.hostname;

    // Check if YouTube
    if (!hostname.includes('youtube.com') && !hostname.includes('youtu.be')) {
      result.error = 'This component only works with YouTube. Current site: ' + hostname;
      return result;
    }

    result.platform = 'YouTube';

    // Extract video ID
    var videoId = null;

    // youtube.com/watch?v=VIDEO_ID
    var match = currentUrl.match(/[?&]v=([^&]+)/);
    if (match) {
      videoId = match[1];
    }

    // youtu.be/VIDEO_ID
    if (!videoId) {
      match = currentUrl.match(/youtu\.be\/([^?&]+)/);
      if (match) {
        videoId = match[1];
      }
    }

    // youtube.com/embed/VIDEO_ID
    if (!videoId) {
      match = currentUrl.match(/youtube\.com\/embed\/([^?&]+)/);
      if (match) {
        videoId = match[1];
      }
    }

    // youtube.com/shorts/VIDEO_ID
    if (!videoId) {
      match = currentUrl.match(/youtube\.com\/shorts\/([^?&]+)/);
      if (match) {
        videoId = match[1];
      }
    }

    if (!videoId) {
      result.error = 'Could not extract video ID from YouTube URL. Make sure you are on a video page.';
      return result;
    }

    result.videoId = videoId;
    result.videoUrl = 'https://www.youtube.com/watch?v=' + videoId;

    // Add to media array
    result.media.push({
      url: result.videoUrl,
      videoId: videoId,
      type: 'audio',
      format: 'mp3',
      filename: 'youtube-' + videoId + '.mp3'
    });

    result.message = 'YouTube video detected. Video ID: ' + videoId;

  } catch (e) {
    result.error = 'Invalid URL format: ' + e.message;
  }

  return result;
}

/**
 * Run - Called when user clicks "Run CD"
 * Downloads audio from YouTube using cobalt.tools API
 */
async function Run(collectedData) {
  if (!collectedData) {
    return {
      success: false,
      error: 'No data collected. Click "Get Data" first while on a YouTube video page.'
    };
  }

  if (collectedData.error) {
    return {
      success: false,
      error: collectedData.error
    };
  }

  if (!collectedData.media || collectedData.media.length === 0) {
    return {
      success: false,
      error: 'No media found. Make sure you are on a YouTube video page.'
    };
  }

  var media = collectedData.media[0];
  var videoUrl = collectedData.videoUrl;
  var videoId = collectedData.videoId;

  // Use cobalt.tools API to get download URL
  try {
    var response = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: videoUrl,
        audioFormat: 'mp3',
        isAudioOnly: true,
        filenameStyle: 'basic'
      })
    });

    if (!response.ok) {
      throw new Error('API request failed: ' + response.status);
    }

    var data = await response.json();

    // Check response status
    if (data.status === 'error') {
      throw new Error(data.text || 'Failed to process video');
    }

    // Handle different response types
    var downloadUrl = null;
    var filename = 'youtube-' + videoId + '.mp3';

    if (data.status === 'tunnel' || data.status === 'redirect') {
      downloadUrl = data.url;
    } else if (data.status === 'stream') {
      downloadUrl = data.url;
    } else if (data.url) {
      downloadUrl = data.url;
    }

    if (!downloadUrl) {
      throw new Error('Could not get download URL from API response');
    }

    // Use filename from API if available
    if (data.filename) {
      filename = data.filename;
      // Ensure .mp3 extension
      if (!filename.toLowerCase().endsWith('.mp3')) {
        filename += '.mp3';
      }
    }

    // Return download action
    return {
      success: true,
      action: 'download',
      download: {
        url: downloadUrl,
        filename: filename,
        saveAs: true
      },
      message: 'Downloading audio: ' + filename,
      videoId: videoId,
      platform: 'YouTube'
    };

  } catch (error) {
    // If cobalt.tools fails, try alternative API
    try {
      var altResponse = await fetch('https://co.wuk.sh/api/json', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: videoUrl,
          aFormat: 'mp3',
          isAudioOnly: true
        })
      });

      if (!altResponse.ok) {
        throw new Error('Backup API failed');
      }

      var altData = await altResponse.json();

      if (altData.status === 'error') {
        throw new Error(altData.text || 'Backup API error');
      }

      if (altData.url) {
        return {
          success: true,
          action: 'download',
          download: {
            url: altData.url,
            filename: 'youtube-' + videoId + '.mp3',
            saveAs: true
          },
          message: 'Downloading audio from YouTube',
          videoId: videoId,
          platform: 'YouTube'
        };
      }
    } catch (altError) {
      // Both APIs failed
    }

    return {
      success: false,
      error: 'Failed to get download URL: ' + error.message + '. The video may be unavailable or protected.'
    };
  }
}
