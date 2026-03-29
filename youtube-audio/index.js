// ─── DataCollector ────────────────────────────────────────────────────────────
// Runs in page MAIN world. Returns a Promise (async is supported by the core).

async function DataCollector(currentUrl, context) {
  if (!currentUrl.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video page first.");
  }

  const videoId = new URLSearchParams(currentUrl.split("?")[1] || "").get("v");
  if (!videoId) throw new Error("Cannot find video ID in the URL.");

  // ytInitialPlayerResponse is only valid when it matches the current URL video.
  // YouTube SPA navigation changes the URL but not this global.
  const pr = window.ytInitialPlayerResponse;
  const prMatchesCurrent = pr?.videoDetails?.videoId === videoId;

  if (!prMatchesCurrent) {
    throw new Error(
      "Player data is for a different video. Please do a full page refresh (Cmd+Shift+R / Ctrl+Shift+R) on this video."
    );
  }

  const title = (pr.videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 100);

  const sd = pr.streamingData;
  if (!sd) throw new Error("No streamingData in player response. Video may be unavailable.");

  // ── 1. Try audio-only adaptive formats (best: no video, smaller file) ───────
  let audioFormat = pickAudioFormat(sd.adaptiveFormats || []);
  let isCombined  = false;

  if (audioFormat && !hasUrl(audioFormat)) {
    // YouTube SABR protocol: adaptive formats have metadata but no URLs.
    // Fall through to combined formats below.
    audioFormat = null;
  }

  // ── 2. Fall back to combined audio+video streams (legacy MP4s) ───────────────
  // YouTube still serves these as direct URLs for backward compatibility.
  // itag 22 = 720p MP4 (H.264 + AAC ~192kbps), itag 18 = 360p MP4 (AAC ~96kbps)
  if (!audioFormat) {
    const combined = sd.formats || [];
    const combinedFormat = [22, 18]
      .map((itag) => combined.find((f) => f.itag === itag))
      .find((f) => f && hasUrl(f));

    if (combinedFormat) {
      audioFormat = combinedFormat;
      isCombined  = true;
    }
  }

  if (!audioFormat) {
    const sdKeys = Object.keys(sd).join(", ");
    throw new Error(
      `No downloadable stream found. YouTube is using SABR streaming for all formats. ` +
      `streamingData keys: ${sdKeys}`
    );
  }

  const audioUrl = await resolveStreamUrl(audioFormat);

  // Combined streams are MP4 (video+audio). Audio-only adaptive are m4a/webm.
  const mimeType = audioFormat.mimeType || "";
  const ext = isCombined ? "mp4" : (mimeType.includes("webm") ? "webm" : "m4a");

  return {
    title,
    audioUrl,
    filename: `${title}.${ext}`,
    itag: audioFormat.itag,
    mimeType,
    isCombined,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickAudioFormat(formats) {
  // 141 = AAC 256kbps (.m4a), 140 = AAC 128kbps (.m4a), 251/250/249 = Opus (.webm)
  return (
    [141, 140, 251, 250, 249]
      .map((itag) => formats.find((f) => f.itag === itag))
      .find(Boolean) ||
    formats.find((f) => (f.mimeType || "").startsWith("audio/"))
  );
}

function hasUrl(format) {
  return !!(format.url || format.signatureCipher || format.cipher);
}

// Find the cipher function name in base.js.
// Patterns only match the function's opening line — nested braces don't matter.
function cipherFnName(js) {
  const patterns = [
    // Call-site: encodeURIComponent(FnName(
    /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/,
    /\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(/,
    // Structural: assignment form — NAME=function(a){a=a.split(
    /([a-zA-Z0-9$]{2,})\s*=\s*function\([a-zA-Z]\)\s*\{\s*[a-zA-Z]\s*=\s*[a-zA-Z]\.split\(["']["']\)/,
    // Structural: declaration form — function NAME(a){a=a.split(
    /\bfunction\s+([a-zA-Z0-9$]{2,})\s*\([a-zA-Z]\)\s*\{\s*[a-zA-Z]\s*=\s*[a-zA-Z]\.split\(["']["']\)/,
  ];
  for (const p of patterns) {
    const m = js.match(p);
    if (m) return m[1];
  }
  return null;
}

// Extract a function body using bracket-matching (handles any nested braces).
function bracketExtract(js, fnName) {
  const esc = fnName.replace(/[$]/g, "\\$");
  const re = new RegExp(
    `(?:${esc}\\s*=\\s*function\\s*\\([a-zA-Z]\\)|function\\s+${esc}\\s*\\([a-zA-Z]\\))\\s*\\{`
  );
  const m = re.exec(js);
  if (!m) return null;
  let depth = 0, i = m.index + m[0].length - 1, start = i + 1;
  while (i < js.length) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") { if (--depth === 0) break; }
    i++;
  }
  return js.slice(start, i);
}

// Extract the helper object definition using bracket-matching.
function helperExtract(js, helperName) {
  const esc = helperName.replace(/[$]/g, "\\$");
  const re = new RegExp(`(?:var|let|const)\\s+${esc}\\s*=\\s*\\{|(?:^|[;,])\\s*${esc}\\s*=\\s*\\{`, "m");
  const m = re.exec(js);
  if (!m) return null;
  const brace = js.indexOf("{", m.index + m[0].length - 1);
  let depth = 0, i = brace;
  while (i < js.length) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") { if (--depth === 0) break; }
    i++;
  }
  return js.slice(m.index, i + 1);
}

// Resolve a format entry to a usable URL, decrypting signatureCipher if present.
async function resolveStreamUrl(audioFormat) {
  if (audioFormat.url) return audioFormat.url;

  const cipherStr = audioFormat.signatureCipher || audioFormat.cipher;
  const p = new URLSearchParams(cipherStr);
  const encSig   = p.get("s");
  const sigParam  = p.get("sp") || "sig";
  const baseUrl   = p.get("url");
  if (!encSig || !baseUrl) throw new Error("Malformed cipher in stream data.");

  const playerSrc = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src)
    .find((src) => src.includes("base.js"));
  if (!playerSrc) throw new Error("Cannot find YouTube player script to decrypt signature.");

  const js = await fetch(playerSrc).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch player script (${r.status})`);
    return r.text();
  });

  // Find cipher function name. Patterns only match the START of the function
  // so nested braces in the body don't break the match.
  const fnName = cipherFnName(js);
  if (!fnName) throw new Error("Cannot locate cipher function in player script.");

  // Extract body using bracket-matching — handles any nested braces.
  const fnBody = bracketExtract(js, fnName);
  if (!fnBody) throw new Error("Cannot extract cipher function body.");

  const helperNameMatch = fnBody.match(/([a-zA-Z0-9$]{2,})\./);
  if (!helperNameMatch) throw new Error("Cannot find cipher helper object name.");
  const helperName = helperNameMatch[1];

  // Extract helper object using bracket-matching too.
  const helperSrc = helperExtract(js, helperName);
  if (!helperSrc) throw new Error("Cannot extract cipher helper object.");

  const decSig = new Function(
    helperSrc +
    "function " + fnName + "(a){" + fnBody + "}" +
    "return " + fnName + "(" + JSON.stringify(encSig) + ");"
  )();

  return baseUrl + "&" + sigParam + "=" + encodeURIComponent(decSig);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

function Run(data) {
  return {
    action: "download",
    download: {
      url: data.audioUrl,
      filename: data.filename,
    },
    message: data.isCombined
      ? `Downloading: ${data.filename} (audio+video — SABR stream, no audio-only available)`
      : `Downloading: ${data.filename}`,
  };
}
