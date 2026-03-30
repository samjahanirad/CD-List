// CD Metadata
const CD_ID = "youtube-audio";
const CD_NAME = "YouTube Audio Downloader";
const CD_VERSION = "3.0.0";
const CD_DESCRIPTION = "Downloads the audio track of the current YouTube video as .m4a or .webm.";

// ─── DataCollector ────────────────────────────────────────────────────────────

async function DataCollector(currentUrl, context) {
  if (!currentUrl.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video page first.");
  }

  const urlVideoId = new URLSearchParams(currentUrl.split("?")[1] || "").get("v");
  const pr = window.ytInitialPlayerResponse;
  if (!pr) throw new Error("YouTube player data not found. Try refreshing the page.");

  const prVideoId = pr.videoDetails?.videoId;
  if (urlVideoId && prVideoId && urlVideoId !== prVideoId) {
    throw new Error("Player data is stale. Please refresh the page.");
  }

  const { videoDetails, streamingData } = pr;
  if (!streamingData) {
    throw new Error("No streaming data available. Video may be unavailable or restricted.");
  }

  const title = (videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "")
    .trim()
    .slice(0, 100);

  // ── 1. Pick best format ───────────────────────────────────────────────────────
  // Audio-only adaptive preferred; combined MP4 as last resort.
  const adaptiveFormats = streamingData.adaptiveFormats || [];
  const regularFormats  = streamingData.formats || [];

  const audioFormat =
    [141, 140, 251, 250, 249]
      .map((itag) => adaptiveFormats.find((f) => f.itag === itag))
      .find(Boolean) ||
    adaptiveFormats.find((f) => (f.mimeType || "").startsWith("audio/")) ||
    regularFormats.find((f) => f.itag === 18) ||
    regularFormats.find((f) => f.mimeType);

  if (!audioFormat) throw new Error("No downloadable stream found for this video.");

  const isCombined = !(audioFormat.mimeType || "").startsWith("audio/");

  // ── 2. Load base.js (cached per player build) ─────────────────────────────────
  const playerSrc = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src)
    .find((src) => src.includes("base.js"));
  if (!playerSrc) throw new Error("Cannot find YouTube player script.");

  let js;
  if (window.__cdYtJs && window.__cdYtJsSrc === playerSrc) {
    js = window.__cdYtJs;
  } else {
    js = await fetch(playerSrc).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch player script (${r.status})`);
      return r.text();
    });
    window.__cdYtJs    = js;
    window.__cdYtJsSrc = playerSrc;
  }

  // ── 3. Resolve raw stream URL ─────────────────────────────────────────────────
  let audioUrl;

  if (audioFormat.url) {
    audioUrl = audioFormat.url;

  } else if (audioFormat.signatureCipher) {
    const p = new URLSearchParams(audioFormat.signatureCipher);
    const encSig  = p.get("s");
    const sigParam = p.get("sp") || "sig";
    const baseUrl  = p.get("url");
    if (!encSig || !baseUrl) throw new Error("Malformed signatureCipher in stream data.");

    const fnNameMatch = js.match(
      /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/
    );
    if (!fnNameMatch) throw new Error("Cannot locate signature cipher function in player script.");
    const fnName = fnNameMatch[1];

    const esc = fnName.replace(/[$]/g, "\\$");
    const fnMatch = js.match(new RegExp(esc + "\\s*=\\s*function\\([a-z]\\)\\{([^}]+)\\}"));
    if (!fnMatch) throw new Error("Cannot extract cipher function body.");
    const fnBody = fnMatch[1];

    const helperName = (fnBody.match(/([a-zA-Z0-9$]{2,})\./) || [])[1];
    if (!helperName) throw new Error("Cannot find cipher helper object name.");

    const escH = helperName.replace(/[$]/g, "\\$");
    const helperMatch = js.match(new RegExp("var\\s+" + escH + "\\s*=\\s*\\{[\\s\\S]*?\\};"));
    if (!helperMatch) throw new Error("Cannot extract cipher helper object.");

    const decSig = new Function(
      helperMatch[0] +
      "function " + fnName + "(a){" + fnBody + "}" +
      "return " + fnName + "(" + JSON.stringify(encSig) + ");"
    )();

    audioUrl = baseUrl + "&" + sigParam + "=" + encodeURIComponent(decSig);

  } else {
    throw new Error("Unexpected stream format: no url or signatureCipher found.");
  }

  const urlObj = new URL(audioUrl);

  // ── 4. Descramble n parameter ─────────────────────────────────────────────────
  // The CDN returns 403 for any URL whose `n` param hasn't been run through
  // YouTube's descrambling function from base.js.
  let _n = "no n param";
  const nRaw = urlObj.searchParams.get("n");
  if (nRaw) {
    try {
      const nOut = descrambleN(js, nRaw);
      if (nOut !== nRaw) {
        urlObj.searchParams.set("n", nOut);
        _n = "ok";
      } else {
        _n = "warn: same value returned";
      }
    } catch (e) {
      _n = "FAILED: " + e.message;
    }
  }

  // ── 5. Attach proof-of-origin token (pot) if available ───────────────────────
  // Some streams require a pot to authenticate the download.
  // YouTube stores it in the player response or page config.
  let _pot = "none";
  try {
    const pot =
      streamingData.serviceIntegrityDimensions?.poToken ||
      pr.playerConfig?.mediaCommonConfig?.dynamicReadaheadConfig?.poToken ||
      window.ytcfg?.data_?.INNERTUBE_CONTEXT?.client?.screenDensityFloat && // guard
        undefined; // ytcfg doesn't carry pot directly; keep for future

    if (pot) {
      urlObj.searchParams.set("pot", pot);
      _pot = "attached";
    }
  } catch (_) {}

  audioUrl = urlObj.toString();

  // ── 6. Validate the URL ───────────────────────────────────────────────────────
  // Fetch with HEAD so we know the URL works before handing it to the downloader.
  // Runs in page context so YouTube session cookies are included automatically.
  let _valid = "unchecked";
  try {
    const check = await fetch(audioUrl, { method: "HEAD" });
    if (check.ok || check.status === 206) {
      _valid = "ok (" + check.status + ")";
    } else {
      _valid = "FAILED (" + check.status + ")";
      throw new Error(
        "CDN rejected URL (" + check.status + "). n=" + _n + " pot=" + _pot +
        ". Try refreshing the page and running Get Data again."
      );
    }
  } catch (e) {
    if (e.message.includes("CDN rejected")) throw e;
    // fetch itself failed (network error, CORS) — proceed and let the download try
    _valid = "fetch error: " + e.message;
  }

  const mimeType = audioFormat.mimeType || "";
  const ext = isCombined ? "mp4" : mimeType.includes("webm") ? "webm" : "m4a";

  return {
    title,
    audioUrl,
    filename: `${title}.${ext}`,
    itag: audioFormat.itag,
    mimeType,
    isCombined,
    _n,
    _pot,
    _valid,
  };
}

// ─── descrambleN ─────────────────────────────────────────────────────────────

function descrambleN(js, nRaw) {
  // Pattern 1: .get("n"))&&(b=Ref(b)   — most common
  // Pattern 2: (b=Ref(b),x.set("n",b)  — minified variant
  // Pattern 3: b=Ref(b);x.set("n",b)   — statement variant
  const refMatch =
    js.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$[\].]+)\(b\)/) ||
    js.match(/\(b=([a-zA-Z0-9$[\].]+)\(b\)[,;][a-z]\.set\("n",b\)/) ||
    js.match(/\bb=([a-zA-Z0-9$[\].]+)\(b\);[a-zA-Z]\.set\("n",b\)/);

  if (!refMatch) throw new Error("n-descrambler reference not found in player script");

  const ref        = refMatch[1];
  const arrayMatch = ref.match(/^([a-zA-Z0-9$]+)\[(\d+)\]$/);
  let fnArg, fnBody;

  if (arrayMatch) {
    // e.g. Nw[0] — find: var Nw=[function(a){...}]
    const arrName = arrayMatch[1];
    const esc     = arrName.replace(/[$]/g, "\\$");

    const startRe    = new RegExp("var\\s+" + esc + "\\s*=\\s*\\[function\\(([^)]+)\\)\\{");
    const startMatch = js.match(startRe);
    if (!startMatch) throw new Error("array var '" + arrName + "' not found as [function(");

    fnArg = startMatch[1];
    const bodyStart = js.indexOf("{", startMatch.index + startMatch[0].length - 1);
    fnBody = extractBody(js, bodyStart);
    if (!fnBody) throw new Error("body extraction failed for array fn '" + arrName + "'");

  } else {
    // e.g. descramble — find: var descramble=function(a){...}
    const esc        = ref.replace(/[$]/g, "\\$");
    const startRe    = new RegExp("(?:var\\s+)?" + esc + "\\s*=\\s*function\\(([^)]+)\\)\\s*\\{");
    const startMatch = js.match(startRe);
    if (!startMatch) throw new Error("fn '" + ref + "' not found as function(");

    fnArg = startMatch[1];
    const bodyStart = js.indexOf("{", startMatch.index + startMatch[0].length - 1);
    fnBody = extractBody(js, bodyStart);
    if (!fnBody) throw new Error("body extraction failed for fn '" + ref + "'");
  }

  return new Function(fnArg, fnBody)(nRaw);
}

// Brace-depth scan to extract a JS function body (content between outer { }).
function extractBody(src, openBrace) {
  if (src[openBrace] !== "{") return null;
  let depth = 0;
  let inStr = null;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === inStr && src[i - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openBrace + 1, i);
    }
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
