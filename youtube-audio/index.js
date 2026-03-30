// CD Metadata
const CD_ID = "youtube-audio";
const CD_NAME = "YouTube Audio Downloader";
const CD_VERSION = "5.0.0";
const CD_DESCRIPTION = "Downloads the audio track of the current YouTube video as .m4a or .webm.";

// ─── DataCollector ────────────────────────────────────────────────────────────

async function DataCollector(currentUrl, context) {
  if (!currentUrl.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video page first.");
  }

  const urlVideoId = new URLSearchParams(currentUrl.split("?")[1] || "").get("v");
  if (!urlVideoId) throw new Error("Cannot read video ID from URL.");

  const pr = window.ytInitialPlayerResponse;
  if (!pr) throw new Error("YouTube player data not found. Refresh the page.");

  const prVideoId = pr.videoDetails?.videoId;
  if (prVideoId && urlVideoId !== prVideoId) throw new Error("Player data is stale. Refresh the page.");

  const title = (pr.videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 100);

  // ── 1. Fetch fresh authenticated player response via InnerTube API ─────────
  // Runs in page context → browser sends YouTube session cookies automatically.
  // The server returns signed, ready-to-use URLs for the authenticated session,
  // bypassing the need to parse and execute obfuscated cipher/n-param JS.
  const streamingData = await fetchStreamingData(urlVideoId);

  // ── 2. Pick best format (direct URL only) ────────────────────────────────
  const adaptiveFormats = streamingData.adaptiveFormats || [];
  const regularFormats  = streamingData.formats || [];
  const directUrl = (f) => !!f.url;

  const audioFormat =
    [141, 140, 251, 250, 249]
      .map((itag) => adaptiveFormats.find((f) => f.itag === itag && directUrl(f)))
      .find(Boolean) ||
    adaptiveFormats.find((f) => (f.mimeType || "").startsWith("audio/") && directUrl(f)) ||
    regularFormats.find((f) => f.itag === 18 && directUrl(f)) ||
    regularFormats.find((f) => f.mimeType && directUrl(f));

  if (!audioFormat) {
    const allFormats = [...adaptiveFormats, ...regularFormats];
    const hasCipher  = allFormats.some((f) => f.signatureCipher || f.cipher);
    throw new Error(
      hasCipher
        ? "Video requires signature decryption (age-restricted?). No direct URL available."
        : "No downloadable stream found for this video."
    );
  }

  const isCombined = !(audioFormat.mimeType || "").startsWith("audio/");

  // ── 3. Fetch base.js and descramble n parameter ───────────────────────────
  const playerSrc = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src).find((src) => src.includes("base.js"));

  let _n = "skipped (no player script)";

  if (playerSrc) {
    let js;
    if (window.__cdYtJs && window.__cdYtJsSrc === playerSrc) {
      js = window.__cdYtJs;
    } else {
      js = await fetch(playerSrc, { credentials: "include" }).then((r) => r.text());
      window.__cdYtJs = js; window.__cdYtJsSrc = playerSrc;
    }

    const urlObj = new URL(audioFormat.url);
    const nRaw   = urlObj.searchParams.get("n");

    if (nRaw) {
      try {
        const nOut = descrambleN(js, nRaw);
        if (nOut !== nRaw) { urlObj.searchParams.set("n", nOut); _n = "ok"; }
        else { _n = "warn: same value"; }
        audioFormat.url = urlObj.toString();
      } catch (e) { _n = "FAILED: " + e.message; }
    } else { _n = "no n param"; }
  }

  // ── 4. Attach pot token if present ───────────────────────────────────────
  let _pot = "none";
  const pot = streamingData.serviceIntegrityDimensions?.poToken;
  if (pot) {
    const u = new URL(audioFormat.url);
    u.searchParams.set("pot", pot);
    audioFormat.url = u.toString();
    _pot = "attached";
  }

  // ── 5. Validate ───────────────────────────────────────────────────────────
  let _valid = "unchecked";
  try {
    const r = await fetch(audioFormat.url, { method: "HEAD", credentials: "include" });
    if (r.ok || r.status === 206) {
      _valid = "ok (" + r.status + ")";
    } else {
      _valid = "FAILED (" + r.status + ")";
      throw new Error("CDN rejected URL (" + r.status + ")  n=" + _n + "  pot=" + _pot);
    }
  } catch (e) {
    if (e.message.startsWith("CDN rejected")) throw e;
    _valid = "fetch-error: " + e.message;
  }

  const mimeType = audioFormat.mimeType || "";
  const ext = isCombined ? "mp4" : mimeType.includes("webm") ? "webm" : "m4a";

  return { title, audioUrl: audioFormat.url, filename: `${title}.${ext}`,
           itag: audioFormat.itag, mimeType, isCombined, _n, _pot, _valid };
}

// Calls YouTube's InnerTube /player endpoint from within the page context.
// The browser automatically attaches the user's YouTube session cookies,
// so YouTube returns signed URLs valid for this session — no cipher decryption needed.
async function fetchStreamingData(videoId) {
  const cfg     = window.ytcfg?.data_ || {};
  const apiKey  = cfg.INNERTUBE_API_KEY || "";
  const client  = (cfg.INNERTUBE_CONTEXT?.client) || {
    clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en", gl: "US"
  };

  const url = "https://www.youtube.com/youtubei/v1/player"
    + (apiKey ? "?key=" + apiKey + "&prettyPrint=false" : "?prettyPrint=false");

  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId,
      context: { client },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });

  if (!res.ok) throw new Error("InnerTube API error: " + res.status);
  const data = await res.json();

  if (!data.streamingData) {
    const reason = data.playabilityStatus?.reason || "unknown";
    throw new Error("No streaming data from InnerTube API: " + reason);
  }
  return data.streamingData;
}

// ─── descrambleN ─────────────────────────────────────────────────────────────

function descrambleN(js, nRaw) {
  const PATTERNS = [
    /\.get\("n"\)\)\s*&&\s*\(\s*([a-zA-Z])\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)/,
    /\b([a-zA-Z])\s*&&\s*\(\s*\1\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)/,
    /\b([a-zA-Z])\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)\s*,\s*[a-zA-Z.[\]]+\.set\(\s*"n"\s*,\s*\1\s*\)/,
    /\.set\(\s*"n"\s*,\s*([a-zA-Z0-9$[\].]+)\(\s*([a-zA-Z])\s*\)\s*\)/,
    /\b([a-zA-Z])\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)\s*;\s*[a-zA-Z.[\]]+\.set\(\s*"n"/,
  ];

  let ref = null;
  for (const pat of PATTERNS) {
    const m = js.match(pat);
    if (m) { ref = (pat === PATTERNS[3]) ? m[1] : m[2]; break; }
  }
  if (!ref) throw new Error("n-descrambler reference not found");

  const arrayMatch = ref.match(/^([a-zA-Z0-9$]+)\[(\d+)\]$/);
  let invocation;

  if (arrayMatch) {
    const [, arrName, idxStr] = arrayMatch;
    const esc      = arrName.replace(/[$]/g, "\\$");
    const startRe  = new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\[");
    const sm       = js.match(startRe);
    if (!sm) throw new Error("array '" + arrName + "' not found");
    const lit = extractBrackets(js, sm.index + sm[0].length - 1);
    if (!lit) throw new Error("could not extract array '" + arrName + "'");
    invocation = "return (" + lit + ")[" + idxStr + "](" + JSON.stringify(nRaw) + ");";

  } else {
    const esc  = ref.replace(/[$]/g, "\\$");
    const sm   = js.match(new RegExp("(?:(?:var|let|const)\\s+)?" + esc + "\\s*=\\s*function\\(([^)]+)\\)\\s*\\{"));
    if (!sm) throw new Error("fn '" + ref + "' not found");
    const body = extractBody(js, js.indexOf("{", sm.index + sm[0].length - 1));
    if (!body) throw new Error("could not extract body of '" + ref + "'");
    invocation = "return (function(" + sm[1] + "){" + body + "})(" + JSON.stringify(nRaw) + ");";
  }

  return runWithDeps(js, invocation, 0);
}

function runWithDeps(js, code, depth) {
  if (depth > 5) throw new Error("too many dependency attempts");
  try {
    return new Function(code)();
  } catch (e) {
    if (!(e instanceof ReferenceError)) throw e;
    const name = (e.message.match(/^([a-zA-Z$_][a-zA-Z0-9$_]*)\s+is not defined/) || [])[1];
    if (!name) throw e;
    const dep = findDefinition(js, name);
    if (!dep) throw new Error("dep '" + name + "' not found in player");
    return runWithDeps(js, dep + "\n" + code, depth + 1);
  }
}

function findDefinition(js, name) {
  const esc = name.replace(/[$]/g, "\\$");
  const arr = js.match(new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\["));
  if (arr) { const c = extractBrackets(js, arr.index + arr[0].length - 1); if (c) return "var " + name + "=" + c + ";"; }
  const obj = js.match(new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\{"));
  if (obj) { const c = extractBody(js, js.indexOf("{", obj.index + obj[0].length - 1)); if (c) return "var " + name + "={" + c + "};"; }
  const fn = js.match(new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*function\\([^)]*\\)\\s*\\{"));
  if (fn) { const c = extractBody(js, js.indexOf("{", fn.index + fn[0].length - 1)); if (c) return fn[0].replace(/(?:var|let|const)\s+/, "var ") + c + "};"; }
  return null;
}

function extractBrackets(src, pos) {
  if (src[pos] !== "[") return null;
  let depth = 0, inStr = null;
  for (let i = pos; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === inStr && src[i-1] !== "\\") inStr = null; }
    else if (c === '"' || c === "'" || c === "`") { inStr = c; }
    else if (c === "[") depth++;
    else if (c === "]") { if (--depth === 0) return src.slice(pos, i + 1); }
  }
  return null;
}

function extractBody(src, pos) {
  if (src[pos] !== "{") return null;
  let depth = 0, inStr = null;
  for (let i = pos; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === inStr && src[i-1] !== "\\") inStr = null; }
    else if (c === '"' || c === "'" || c === "`") { inStr = c; }
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return src.slice(pos + 1, i); }
  }
  return null;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

function Run(data) {
  return {
    action: "download",
    download: { url: data.audioUrl, filename: data.filename },
    message: `Downloading: ${data.filename}`,
  };
}
