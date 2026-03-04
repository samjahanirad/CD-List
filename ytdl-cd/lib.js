/**
 * YTDLCore — Pure JavaScript YouTube stream extractor with nsig decoding
 *
 * Runs in the CD sandbox (eval / new Function are allowed here).
 *
 * Flow:
 *   1. Call InnerTube with ANDROID_VR → ANDROID → TV_EMBED (updated 2026 configs)
 *   2. For each candidate URL: decode the encrypted "n" parameter (nsig)
 *      by fetching YouTube's player.js and running the decoder function.
 *   3. Return the decoded, download-ready URL.
 *
 * The "n" (nsig) parameter is what caused the 403-as-text-file issue.
 * All clients return URLs with an encrypted n param that YouTube CDN
 * rejects unless decoded. player.js is cached for the session.
 */
var YTDLCore = (function () {

  /* ── InnerTube config ── */
  var API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  var API_URL = 'https://www.youtube.com/youtubei/v1/player?key=' + API_KEY + '&prettyPrint=false';

  var CLIENTS = {
    ANDROID_VR: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      clientId: '28',
      androidSdkVersion: 30,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 10) gzip',
      userInterfaceTheme: 'USER_INTERFACE_THEME_DARK'
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

  /* ── Player JS cache (one fetch per session) ── */
  var _playerJs = null;

  /* ── Helpers ── */

  function buildCookieHeader(cookies) {
    if (!Array.isArray(cookies) || !cookies.length) return '';
    return cookies.map(function (c) { return c.name + '=' + c.value; }).join('; ');
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ── InnerTube fetch ── */

  async function fetchInnerTube(videoId, client, cookieHeader) {
    var ctx = {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: 'en',
      gl: 'US'
    };
    if (client.androidSdkVersion) ctx.androidSdkVersion = client.androidSdkVersion;
    if (client.userInterfaceTheme) ctx.userInterfaceTheme = client.userInterfaceTheme;

    var body = {
      videoId: videoId,
      context: { client: ctx },
      playbackContext: { contentPlaybackContext: {} },
      contentCheckOk: true,
      racyCheckOk: true
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
    if (client.userAgent) headers['User-Agent'] = client.userAgent;
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    var res = await fetch(API_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    var data = await res.json();
    var status = data.playabilityStatus && data.playabilityStatus.status;
    if (status === 'LOGIN_REQUIRED') throw new Error('Login required');
    if (status !== 'OK') {
      throw new Error('Not playable: ' + ((data.playabilityStatus && data.playabilityStatus.reason) || status));
    }
    if (!data.streamingData) throw new Error('No streaming data');
    return data;
  }

  /* ── Format selection ── */

  function selectFormat(streamingData, type) {
    var all = [].concat(streamingData.formats || [], streamingData.adaptiveFormats || []);
    var direct = all.filter(function (f) { return f.url; });

    if (type === 'audio') {
      return direct
        .filter(function (f) { return f.mimeType && f.mimeType.startsWith('audio/'); })
        .sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0); })[0] || null;
    }

    var combined = (streamingData.formats || [])
      .filter(function (f) { return f.url && f.mimeType && f.mimeType.includes('video'); })
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); });
    if (combined.length) return combined[0];

    return (streamingData.adaptiveFormats || [])
      .filter(function (f) { return f.url && f.mimeType && f.mimeType.startsWith('video/'); })
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); })[0] || null;
  }

  function buildFilename(playerData, format) {
    var title = (playerData.videoDetails && playerData.videoDetails.title) || 'video';
    var safe = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').substring(0, 80);
    var isAudio = format.mimeType && format.mimeType.startsWith('audio/');
    var ext = isAudio
      ? (format.mimeType.includes('mp4') ? '.m4a' : '.webm')
      : (format.mimeType && format.mimeType.includes('mp4') ? '.mp4' : '.webm');
    return safe + ext;
  }

  /* ── nsig (n-parameter) decoding ── */

  /**
   * Fetch and cache YouTube's player.js.
   * We get its URL from the YouTube watch page HTML.
   */
  async function getPlayerJs(videoId) {
    if (_playerJs) return _playerJs;

    var res = await fetch('https://www.youtube.com/watch?v=' + videoId);
    if (!res.ok) throw new Error('YouTube page HTTP ' + res.status);
    var html = await res.text();

    var m = html.match(/\/s\/player\/([a-zA-Z0-9_-]+)\/player_ias\.vflset\/[a-zA-Z_-]+\/base\.js/);
    if (!m) throw new Error('player.js URL not found in page');

    var jsRes = await fetch('https://www.youtube.com' + m[0]);
    if (!jsRes.ok) throw new Error('player.js HTTP ' + jsRes.status);

    _playerJs = await jsRes.text();
    return _playerJs;
  }

  /**
   * Extract the nsig decoder function body from player.js.
   * YouTube references it as: .get("n"))&&(b=ARRAY[IDX]||(ARRAY)[
   * or the simpler:           .get("n"))&&(b=FUNCNAME(b)
   */
  function findNsigFuncBody(playerJs) {
    // Pattern A: array reference — .get("n"))&&(b=ARR[IDX]||(ARR)[
    var mA = playerJs.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]{1,4})\[(\d+)\](?:\|\|\1\[)?/);
    if (mA) {
      var arrName = mA[1], idx = parseInt(mA[2]);
      var arrDef = playerJs.match(new RegExp(
        'var\\s+' + escRe(arrName) + '\\s*=\\s*\\[([^\\]]+)\\]'
      ));
      if (arrDef) {
        var fnName = arrDef[1].split(',')[idx];
        if (fnName) {
          fnName = fnName.trim();
          var body = extractFuncByName(playerJs, fnName);
          if (body) return body;
        }
      }
    }

    // Pattern B: direct call — .get("n"))&&(b=FN(b)
    var mB = playerJs.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]{1,4})\(b\)/);
    if (mB) {
      var body = extractFuncByName(playerJs, mB[1]);
      if (body) return body;
    }

    // Pattern C: looser array pattern
    var mC = playerJs.match(/\("n"\)\)&&\(b=([a-zA-Z0-9$]{1,4})\[/);
    if (mC) {
      var arrName2 = mC[1];
      var arrDef2 = playerJs.match(new RegExp(
        'var\\s+' + escRe(arrName2) + '\\s*=\\s*\\[([^\\]]+)\\]'
      ));
      if (arrDef2) {
        var fnName2 = arrDef2[1].split(',')[0];
        if (fnName2) {
          var body = extractFuncByName(playerJs, fnName2.trim());
          if (body) return body;
        }
      }
    }

    throw new Error('nsig function reference not found in player.js');
  }

  /**
   * Extract a function expression or declaration by name.
   * Returns a string like "function(a){...}" suitable for new Function().
   */
  function extractFuncByName(playerJs, name) {
    // Try: var NAME=function(a){...}
    var i1 = playerJs.indexOf('var ' + name + '=function(');
    if (i1 >= 0) {
      var fnStart = playerJs.indexOf('function(', i1);
      return extractBalancedFunc(playerJs, fnStart);
    }

    // Try: NAME=function(a){...}  (assignment without var)
    var i2 = playerJs.indexOf(name + '=function(');
    if (i2 >= 0) {
      var fnStart2 = playerJs.indexOf('function(', i2);
      return extractBalancedFunc(playerJs, fnStart2);
    }

    // Try: function NAME(a){...}
    var i3 = playerJs.indexOf('function ' + name + '(');
    if (i3 >= 0) {
      return extractBalancedFunc(playerJs, i3);
    }

    return null;
  }

  /**
   * Extract a complete function (balanced braces) starting at `start`.
   * Handles strings and nested braces.
   */
  function extractBalancedFunc(playerJs, start) {
    var braceStart = playerJs.indexOf('{', start);
    if (braceStart < 0) return null;

    var depth = 0, inStr = false, strCh = '', i = braceStart;
    while (i < playerJs.length) {
      var c = playerJs[i];
      if (inStr) {
        if (c === strCh && playerJs[i - 1] !== '\\') inStr = false;
      } else if (c === '"' || c === "'" || c === '`') {
        inStr = true; strCh = c;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) return playerJs.substring(start, i + 1);
      }
      i++;
    }
    return null;
  }

  /**
   * Decode the encrypted "n" parameter in a YouTube stream URL.
   * Fetches player.js (once per session), extracts the nsig function,
   * runs it via new Function(), and returns the URL with n replaced.
   */
  async function decodeNParam(url, videoId) {
    var parsed;
    try { parsed = new URL(url); } catch (e) { return url; }

    var n = parsed.searchParams.get('n');
    if (!n) return url; // No n param — URL is already clean

    try {
      var playerJs = await getPlayerJs(videoId);
      var funcBody = findNsigFuncBody(playerJs);

      // Run the nsig decoder. new Function() is allowed in the sandbox.
      // The nsig function is self-contained (all helpers defined inline).
      var decoderFn = new Function('return (' + funcBody + ')')();
      var decoded = decoderFn(n);

      if (typeof decoded !== 'string' || !decoded) {
        throw new Error('decoder returned empty/non-string: ' + decoded);
      }

      parsed.searchParams.set('n', decoded);
      return parsed.toString();
    } catch (e) {
      // If nsig decoding fails, return original URL.
      // The download will likely fail too, triggering youtube_download fallback.
      console.warn('nsig decode failed:', e.message);
      return url;
    }
  }

  /* ── Public API ── */

  /**
   * Extract a download-ready stream URL for a YouTube video.
   *
   * @param {string} videoId
   * @param {'video'|'audio'} type
   * @param {Array} cookies — [{name, value}] (used if available)
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
        var format = selectFormat(playerData.streamingData, type);
        if (!format) throw new Error('No direct-URL format found');

        // Decode the n (nsig) parameter so the CDN accepts the URL
        var url = await decodeNParam(format.url, videoId);

        var title = (playerData.videoDetails && playerData.videoDetails.title) || videoId;
        var author = (playerData.videoDetails && playerData.videoDetails.author) || '';

        return {
          url: url,
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
