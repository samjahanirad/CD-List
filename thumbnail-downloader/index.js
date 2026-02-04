/**
 * Thumbnail Downloader CD
 * Downloads video thumbnails from YouTube, Vimeo, and other video platforms
 * Uses Chrome Downloads API for direct file downloads
 *
 * Usage:
 * 1. Navigate to a YouTube/Vimeo/Dailymotion video page
 * 2. Click "Get Data" to collect thumbnail URLs
 * 3. Click "Run CD" to download the best quality thumbnail
 */

function DataCollector(currentUrl) {
  var result = {
    platform: null,
    videoId: null,
    thumbnails: [],
    sourceUrl: currentUrl || 'No URL provided'
  };

  if (!currentUrl) {
    result.error = 'No URL provided. Make sure you are on a video page.';
    return result;
  }

  var url = currentUrl;

  // Extract hostname from URL
  try {
    var urlObj = new URL(url);
    var hostname = urlObj.hostname;
  } catch (e) {
    result.error = 'Invalid URL format: ' + url;
    return result;
  }

  // YouTube
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
    result.platform = 'YouTube';
    var videoId = null;

    // youtube.com/watch?v=VIDEO_ID
    var match = url.match(/[?&]v=([^&]+)/);
    if (match) {
      videoId = match[1];
    }

    // youtu.be/VIDEO_ID
    if (!videoId) {
      match = url.match(/youtu\.be\/([^?&]+)/);
      if (match) {
        videoId = match[1];
      }
    }

    // youtube.com/embed/VIDEO_ID
    if (!videoId) {
      match = url.match(/youtube\.com\/embed\/([^?&]+)/);
      if (match) {
        videoId = match[1];
      }
    }

    // youtube.com/shorts/VIDEO_ID
    if (!videoId) {
      match = url.match(/youtube\.com\/shorts\/([^?&]+)/);
      if (match) {
        videoId = match[1];
      }
    }

    if (videoId) {
      result.videoId = videoId;
      result.thumbnails = [
        {
          quality: 'Max Resolution',
          resolution: '1280x720',
          url: 'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg'
        },
        {
          quality: 'SD',
          resolution: '640x480',
          url: 'https://img.youtube.com/vi/' + videoId + '/sddefault.jpg'
        },
        {
          quality: 'High Quality',
          resolution: '480x360',
          url: 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg'
        },
        {
          quality: 'Medium Quality',
          resolution: '320x180',
          url: 'https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg'
        },
        {
          quality: 'Default',
          resolution: '120x90',
          url: 'https://img.youtube.com/vi/' + videoId + '/default.jpg'
        }
      ];
      result.message = 'Found ' + result.thumbnails.length + ' thumbnails';
    } else {
      result.error = 'Could not extract video ID from YouTube URL';
    }
  }

  // Vimeo
  else if (hostname.includes('vimeo.com')) {
    result.platform = 'Vimeo';
    var vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      result.videoId = vimeoMatch[1];
      result.thumbnails = [
        {
          quality: 'Vimeo Thumbnail',
          resolution: 'Variable',
          url: 'https://vumbnail.com/' + vimeoMatch[1] + '.jpg'
        }
      ];
      result.message = 'Found thumbnail for Vimeo video';
    } else {
      result.error = 'Could not extract video ID from Vimeo URL';
    }
  }

  // Dailymotion
  else if (hostname.includes('dailymotion.com')) {
    result.platform = 'Dailymotion';
    var dmMatch = url.match(/dailymotion\.com\/video\/([^_?]+)/);
    if (dmMatch) {
      result.videoId = dmMatch[1];
      result.thumbnails = [
        {
          quality: 'Dailymotion Thumbnail',
          resolution: 'Variable',
          url: 'https://www.dailymotion.com/thumbnail/video/' + dmMatch[1]
        }
      ];
      result.message = 'Found thumbnail for Dailymotion video';
    } else {
      result.error = 'Could not extract video ID from Dailymotion URL';
    }
  }

  // Not supported
  else {
    result.platform = 'Unsupported';
    result.error = 'This website is not supported. Try YouTube, Vimeo, or Dailymotion.';
  }

  return result;
}

function Run(collectedData) {
  if (!collectedData) {
    return {
      success: false,
      error: 'No data collected. Click "Get Data" first while on a video page.'
    };
  }

  if (collectedData.error) {
    return {
      success: false,
      error: collectedData.error
    };
  }

  if (!collectedData.thumbnails || collectedData.thumbnails.length === 0) {
    return {
      success: false,
      error: 'No thumbnails found in collected data.'
    };
  }

  // Get the best quality thumbnail (first one)
  var bestThumb = collectedData.thumbnails[0];
  var videoId = collectedData.videoId || 'video';
  var platform = (collectedData.platform || 'unknown').toLowerCase();

  // Generate filename: platform-videoId-quality.jpg
  var filename = platform + '-' + videoId + '-thumbnail.jpg';

  // Return download action for the extension to handle
  return {
    success: true,
    action: 'download',
    download: {
      url: bestThumb.url,
      filename: filename,
      saveAs: true
    },
    message: 'Downloading ' + bestThumb.quality + ' thumbnail (' + bestThumb.resolution + ')',
    platform: collectedData.platform,
    videoId: collectedData.videoId,
    thumbnailUrl: bestThumb.url
  };
}

