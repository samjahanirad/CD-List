/**
 * YTDLCore — Pure JavaScript YouTube stream extractor
 *
 * Runs entirely in the CD sandbox using fetch().
 * Uses YouTube's InnerTube API to obtain direct stream URLs
 * without requiring any Node.js dependencies.
 *
 * Tries three InnerTube clients in order:
 *   1. ANDROID  — most likely to return direct (non-ciphered) URLs
 *   2. TV_EMBED — second best for direct URLs
 *   3. WEB      — fallback; may return ciphered URLs (skipped if no direct URL)
 */
var YTDLCore = (function () {

  var INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  var INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?key=' + INNERTUBE_KEY + '&prettyPrint=false';

  var CLIENTS = {
    ANDROID: {
      clientName: 'ANDROID',
      clientVersion: '19.09.37',
      clientId: '3',
      androidSdkVersion: 30,
      userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
    },
    TV_EMBED: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      clientId: '85'
    },
    WEB: {
      clientName: 'WEB',
      clientVersion: '2.20250120.01.00',
      clientId: '1'
    }
  };

  /**
   * Convert cookie array [{name, value}] to Cookie header string.
   */
  function buildCookieHeader(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) return '';
    return cookies.map(function (c) { return c.name + '=' + c.value; }).join('; ');
  }

  /**
   * Call InnerTube player endpoint for a given client config.
   * @param {string} videoId
   * @param {Object} client
   * @param {string} cookieHeader
   * @returns {Promise<Object>} raw player response
   */
  async function fetchInnerTube(videoId, client, cookieHeader) {
    var body = {
      videoId: videoId,
      context: {
        client: {
          clientName: client.clientName,
          clientVersion: client.clientVersion,
          hl: 'en',
          gl: 'US'
        }
      },
      contentCheckOk: true,
      racyCheckOk: true
    };

    if (client.androidSdkVersion) {
      body.context.client.androidSdkVersion = client.androidSdkVersion;
    }

    if (client.clientName === 'TVHTML5_SIMPLY_EMBEDDED_PLAYER') {
      body.context.thirdParty = { embedUrl: 'https://www.youtube.com' };
    }

    var headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': client.clientId,
      'X-Youtube-Client-Version': client.clientVersion,
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/'
    };

    if (client.userAgent) {
      headers['User-Agent'] = client.userAgent;
    }

    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    var response = await fetch(INNERTUBE_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error('InnerTube ' + client.clientName + ' HTTP ' + response.status);
    }

    return response.json();
  }

  /**
   * Pick the best format from streaming data.
   * Only considers formats with a direct URL (no cipher decryption needed).
   * @param {Object} streamingData
   * @param {'video'|'audio'} type
   * @returns {Object|null} selected format or null
   */
  function selectFormat(streamingData, type) {
    var allFormats = [].concat(
      streamingData.formats || [],
      streamingData.adaptiveFormats || []
    );

    // Only formats with a plain URL (skip signatureCipher — sandbox can't decipher)
    var direct = allFormats.filter(function (f) { return f.url; });

    if (type === 'audio') {
      var audioFormats = direct
        .filter(function (f) { return f.mimeType && f.mimeType.startsWith('audio/'); })
        .sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
      return audioFormats[0] || null;
    }

    // Prefer combined video+audio (streamingData.formats), then adaptive video
    var combined = (streamingData.formats || [])
      .filter(function (f) { return f.url && f.mimeType && f.mimeType.includes('video'); })
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); });

    if (combined.length > 0) return combined[0];

    var adaptive = (streamingData.adaptiveFormats || [])
      .filter(function (f) { return f.url && f.mimeType && f.mimeType.startsWith('video/'); })
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); });

    return adaptive[0] || null;
  }

  /**
   * Build a safe filename from the video title.
   */
  function buildFilename(playerData, format) {
    var title = (playerData.videoDetails && playerData.videoDetails.title) || 'video';
    var safe = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').substring(0, 80);
    var isAudio = format.mimeType && format.mimeType.startsWith('audio/');
    var ext = isAudio
      ? (format.mimeType.includes('mp4') ? '.m4a' : '.webm')
      : (format.mimeType && format.mimeType.includes('mp4') ? '.mp4' : '.webm');
    return safe + ext;
  }

  /**
   * Extract stream URL and metadata for a YouTube video.
   *
   * @param {string} videoId - 11-character YouTube video ID
   * @param {'video'|'audio'} type - media type to extract
   * @param {Array} cookies - cookie objects [{name, value}] from the user's browser
   * @returns {Promise<{url, filename, title, author, quality, mimeType}>}
   */
  async function getStreamUrl(videoId, type, cookies) {
    if (!videoId) throw new Error('videoId is required');
    type = type || 'video';

    var cookieHeader = buildCookieHeader(cookies);
    var errors = [];
    var clientOrder = ['ANDROID', 'TV_EMBED', 'WEB'];

    for (var i = 0; i < clientOrder.length; i++) {
      var clientName = clientOrder[i];
      var client = CLIENTS[clientName];

      try {
        var playerData = await fetchInnerTube(videoId, client, cookieHeader);
        var status = playerData.playabilityStatus && playerData.playabilityStatus.status;

        if (status === 'LOGIN_REQUIRED') {
          throw new Error('Login required — video may be age-restricted or private');
        }
        if (status !== 'OK') {
          var reason = (playerData.playabilityStatus && playerData.playabilityStatus.reason) || status;
          throw new Error('Video not playable: ' + reason);
        }

        if (!playerData.streamingData) {
          throw new Error('No streaming data in response');
        }

        var format = selectFormat(playerData.streamingData, type);
        if (!format) {
          throw new Error('No direct-URL format found (may be cipher-protected)');
        }

        var title = (playerData.videoDetails && playerData.videoDetails.title) || videoId;
        var author = (playerData.videoDetails && playerData.videoDetails.author) || '';

        return {
          url: format.url,
          filename: buildFilename(playerData, format),
          title: title,
          author: author,
          quality: format.qualityLabel || format.audioQuality || 'unknown',
          mimeType: format.mimeType || '',
          client: clientName
        };
      } catch (e) {
        errors.push(clientName + ': ' + e.message);
      }
    }

    throw new Error('All extraction methods failed:\n' + errors.join('\n'));
  }

  // Public API
  return {
    getStreamUrl: getStreamUrl
  };

})();
