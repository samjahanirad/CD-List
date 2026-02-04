/**
 * Thumbnail Downloader CD
 * Downloads video thumbnails from YouTube, Vimeo, and other video platforms
 * Pure JavaScript - No dependencies
 */

function DataCollector() {
  var result = {
    platform: null,
    videoId: null,
    thumbnails: [],
    pageUrl: window.location.href,
    pageTitle: document.title
  };

  var url = window.location.href;
  var hostname = window.location.hostname;

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
          url: 'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg',
          width: 1280,
          height: 720
        },
        {
          quality: 'SD',
          url: 'https://img.youtube.com/vi/' + videoId + '/sddefault.jpg',
          width: 640,
          height: 480
        },
        {
          quality: 'High Quality',
          url: 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg',
          width: 480,
          height: 360
        },
        {
          quality: 'Medium Quality',
          url: 'https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg',
          width: 320,
          height: 180
        },
        {
          quality: 'Default',
          url: 'https://img.youtube.com/vi/' + videoId + '/default.jpg',
          width: 120,
          height: 90
        }
      ];
    }
  }

  // Vimeo
  else if (hostname.includes('vimeo.com')) {
    result.platform = 'Vimeo';
    var vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
    if (vimeoMatch) {
      result.videoId = vimeoMatch[1];
      // Vimeo thumbnails require API call, get from meta tags
      var ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage && ogImage.content) {
        result.thumbnails.push({
          quality: 'OG Image',
          url: ogImage.content,
          width: null,
          height: null
        });
      }
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
          quality: 'Thumbnail',
          url: 'https://www.dailymotion.com/thumbnail/video/' + dmMatch[1],
          width: null,
          height: null
        }
      ];
    }
  }

  // Generic - Try to find video thumbnails from meta tags
  else {
    result.platform = 'Generic';

    // Try og:image
    var ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage && ogImage.content) {
      result.thumbnails.push({
        quality: 'OG Image',
        url: ogImage.content,
        width: null,
        height: null
      });
    }

    // Try twitter:image
    var twitterImage = document.querySelector('meta[name="twitter:image"]');
    if (twitterImage && twitterImage.content) {
      result.thumbnails.push({
        quality: 'Twitter Image',
        url: twitterImage.content,
        width: null,
        height: null
      });
    }

    // Try to find video poster
    var videos = document.querySelectorAll('video[poster]');
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].poster) {
        result.thumbnails.push({
          quality: 'Video Poster ' + (i + 1),
          url: videos[i].poster,
          width: null,
          height: null
        });
      }
    }
  }

  return result;
}

function Run(data) {
  // Collect fresh data if not provided
  var thumbData = data || DataCollector();

  if (!thumbData.thumbnails || thumbData.thumbnails.length === 0) {
    return {
      success: false,
      message: 'No thumbnails found on this page',
      platform: thumbData.platform
    };
  }

  // Get the best quality thumbnail (first one)
  var bestThumb = thumbData.thumbnails[0];

  // Create download link
  var link = document.createElement('a');
  link.href = bestThumb.url;
  link.target = '_blank';

  // Generate filename
  var filename = 'thumbnail';
  if (thumbData.platform) {
    filename = thumbData.platform.toLowerCase() + '_' + (thumbData.videoId || 'thumb');
  }

  // Try to get extension from URL
  var ext = '.jpg';
  var extMatch = bestThumb.url.match(/\.(jpg|jpeg|png|webp|gif)/i);
  if (extMatch) {
    ext = '.' + extMatch[1].toLowerCase();
  }

  link.download = filename + ext;

  // For cross-origin images, open in new tab instead
  // (download attribute doesn't work for cross-origin)
  window.open(bestThumb.url, '_blank');

  return {
    success: true,
    message: 'Thumbnail opened in new tab',
    platform: thumbData.platform,
    videoId: thumbData.videoId,
    thumbnailUrl: bestThumb.url,
    quality: bestThumb.quality,
    allThumbnails: thumbData.thumbnails.length
  };
}
