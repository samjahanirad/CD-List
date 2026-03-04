/**
 * YTDLCore — Pure JavaScript YouTube stream extractor
 *
 * Runs entirely in the CD sandbox using fetch().
 * Uses YouTube's InnerTube API to obtain direct stream URLs
 * without requiring any Node.js dependencies.
 *
 * Tries InnerTube clients in order (2026-updated):
 *   1. ANDROID_VR  — most reliable for direct non-nsig URLs (early 2026)
 *   2. ANDROID     — second best; updated to v19.47.36 / SDK 34
 *   3. TV_EMBED    — last resort
 *
 * WEB client removed — always requires nsig decryption in 2025+.
 * URL validation removed — CORS blocks range-GET from sandbox, causing
 * false negatives even for valid ANDROID_VR URLs. Trust the client.
 */
var YTDLCore = (function () {

  var INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  var INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?key=' + INNERTUBE_KEY + '&prettyPrint=false';

  var CLIENTS = {
    ANDROID_VR: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      clientId: '28',
      androidSdkVersion: 30,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 10) gzip'
    },
    ANDROID: {
      clientName: 'ANDROID',
      clientVersion: '19.47.36',
      clientId: '3',
      androidSdkVersion: 34,
      userAgent: 'com.google.android.youtube/19.47.36 (Linux; U; Android 14) gzip',
      userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT'
    },
    TV_EMBED: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      clientId: '85'
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
   */
  async function fetchInnerTube(videoId, client, cookieHeader) {
    var clientCtx = {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: 'en',
      gl: 'US'
    };

    if (client.androidSdkVersion) {
      clientCtx.androidSdkVersion = client.androidSdkVersion;
    }
    if (client.userInterfaceTheme) {
      clientCtx.userInterfaceTheme = client.userInterfaceTheme;
    }

    var body = {
      videoId: videoId,
      context: { client: clientCtx },
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: {} }
    };

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
   */
  function selectFormat(streamingData, type) {
    var allFormats = [].concat(
      streamingData.formats || [],
      streamingData.adaptiveFormats || []
    );

    var direct = allFormats.filter(function (f) { return f.url; });

    if (type === 'audio') {
      var audioFormats = direct
        .filter(function (f) { return f.mimeType && f.mimeType.startsWith('audio/'); })
        .sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); });
      return audioFormats[0] || null;
    }

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
   * @param {string} videoId
   * @param {'video'|'audio'} type
   * @param {Array} cookies - [{name, value}] from the user's browser
   * @returns {Promise<{url, filename, title, author, quality, mimeType, client}>}
   */
  async function getStreamUrl(videoId, type, cookies) {
    if (!videoId) throw new Error('videoId is required');
    type = type || 'video';

    var cookieHeader = buildCookieHeader(cookies);
    var errors = [];
    var clientOrder = ['ANDROID_VR', 'ANDROID', 'TV_EMBED'];

    for (var i = 0; i < clientOrder.length; i++) {
      var clientName = clientOrder[i];
      var client = CLIENTS[clientName];

      try {
        var playerData = await fetchInnerTube(videoId, client, cookieHeader);
        var status = playerData.playabilityStatus && playerData.playabilityStatus.status;

        if (status === 'LOGIN_REQUIRED') {
          throw new Error('Login required — age-restricted or private video');
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
          throw new Error('No direct-URL format found');
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

    throw new Error('All clients failed:\n' + errors.join('\n'));
  }

  return { getStreamUrl: getStreamUrl };

})();
