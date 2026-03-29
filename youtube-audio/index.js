// ─── DataCollector ────────────────────────────────────────────────────────────
// Runs in page MAIN world. Returns a Promise — async is supported by the core.
// No explicit cookie handling needed: fetch() here runs on the YouTube page,
// so the browser includes YouTube session cookies automatically.

async function DataCollector(currentUrl, context) {
  if (!currentUrl.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video page first.");
  }

  // Guard against SPA stale data: check video ID matches the URL
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

  // Sanitize title for use as filename
  const title = (videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "")
    .trim()
    .slice(0, 100);

  const formats = streamingData.adaptiveFormats || [];

  // Pick best audio-only stream:
  //   141 = AAC 256kbps (.m4a)  <- best quality, broadest compatibility
  //   140 = AAC 128kbps (.m4a)
  //   251 = Opus 128kbps (.webm)
  //   250 = Opus 70kbps  (.webm)
  //   249 = Opus 50kbps  (.webm)
  const audioFormat =
    [141, 140, 251, 250, 249]
      .map((itag) => formats.find((f) => f.itag === itag))
      .find(Boolean) ||
    formats.find((f) => (f.mimeType || "").startsWith("audio/"));

  if (!audioFormat) throw new Error("No audio-only stream found for this video.");

  // ── Resolve the stream URL ──────────────────────────────────────────────────

  let audioUrl;

  if (audioFormat.url) {
    // Direct URL — most public videos, already authenticated for this session
    audioUrl = audioFormat.url;

  } else if (audioFormat.signatureCipher) {
    // Protected video: signature must be decrypted using YouTube's own player JS.
    // fetch(base.js) sends YouTube cookies automatically (page context).

    const p = new URLSearchParams(audioFormat.signatureCipher);
    const encSig  = p.get("s");
    const sigParam = p.get("sp") || "sig";
    const baseUrl  = p.get("url");
    if (!encSig || !baseUrl) throw new Error("Malformed signatureCipher in stream data.");

    // Find the player base.js URL already loaded in the page
    const playerSrc = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => s.src)
      .find((src) => src.includes("base.js"));
    if (!playerSrc) throw new Error("Cannot find YouTube player script to decrypt signature.");

    // Fetch base.js — cookies included automatically by the browser
    const js = await fetch(playerSrc).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch player script (${r.status})`);
      return r.text();
    });

    // Find the cipher function name
    // YouTube calls it like: encodeURIComponent(Xxa(decodeURIComponent(...)))
    const fnNameMatch = js.match(
      /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/
    );
    if (!fnNameMatch) throw new Error("Cannot locate signature cipher function in player script.");
    const fnName = fnNameMatch[1];

    // Extract the cipher function body: fnName=function(a){...}
    const escaped = fnName.replace(/[$]/g, "\\$");
    const fnMatch = js.match(
      new RegExp(escaped + "\\s*=\\s*function\\([a-z]\\)\\{([^}]+)\\}")
    );
    if (!fnMatch) throw new Error("Cannot extract cipher function body.");
    const fnBody = fnMatch[1];

    // The function body calls a helper object for swap/slice/reverse ops
    const helperNameMatch = fnBody.match(/([a-zA-Z0-9$]{2,})\./);
    if (!helperNameMatch) throw new Error("Cannot find cipher helper object name.");
    const helperName = helperNameMatch[1];

    const escapedHelper = helperName.replace(/[$]/g, "\\$");
    const helperMatch = js.match(
      new RegExp("var\\s+" + escapedHelper + "\\s*=\\s*\\{[\\s\\S]*?\\};")
    );
    if (!helperMatch) throw new Error("Cannot extract cipher helper object.");

    // Execute the cipher to decrypt the signature
    const decSig = new Function(
      helperMatch[0] +
      "function " + fnName + "(a){" + fnBody + "}" +
      "return " + fnName + "(" + JSON.stringify(encSig) + ");"
    )();

    audioUrl = baseUrl + "&" + sigParam + "=" + encodeURIComponent(decSig);

  } else if (audioFormat.cipher) {
    // Older YouTube player versions used "cipher" instead of "signatureCipher"
    const p = new URLSearchParams(audioFormat.cipher);
    const encSig  = p.get("s");
    const sigParam = p.get("sp") || "sig";
    const baseUrl  = p.get("url");
    if (!encSig || !baseUrl) throw new Error("Malformed cipher in stream data.");

    const playerSrc = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => s.src)
      .find((src) => src.includes("base.js"));
    if (!playerSrc) throw new Error("Cannot find YouTube player script to decrypt signature.");

    const js = await fetch(playerSrc).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch player script (${r.status})`);
      return r.text();
    });

    const fnNameMatch = js.match(
      /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/
    );
    if (!fnNameMatch) throw new Error("Cannot locate cipher function in player script.");
    const fnName = fnNameMatch[1];

    const escaped = fnName.replace(/[$]/g, "\\$");
    const fnMatch = js.match(
      new RegExp(escaped + "\\s*=\\s*function\\([a-z]\\)\\{([^}]+)\\}")
    );
    if (!fnMatch) throw new Error("Cannot extract cipher function body.");
    const fnBody = fnMatch[1];

    const helperNameMatch = fnBody.match(/([a-zA-Z0-9$]{2,})\./);
    if (!helperNameMatch) throw new Error("Cannot find cipher helper object name.");
    const helperName = helperNameMatch[1];

    const escapedHelper = helperName.replace(/[$]/g, "\\$");
    const helperMatch = js.match(
      new RegExp("var\\s+" + escapedHelper + "\\s*=\\s*\\{[\\s\\S]*?\\};")
    );
    if (!helperMatch) throw new Error("Cannot extract cipher helper object.");

    const decSig = new Function(
      helperMatch[0] +
      "function " + fnName + "(a){" + fnBody + "}" +
      "return " + fnName + "(" + JSON.stringify(encSig) + ");"
    )();

    audioUrl = baseUrl + "&" + sigParam + "=" + encodeURIComponent(decSig);

  } else {
    // Diagnostic: show what keys are actually present to help debug
    const keys = Object.keys(audioFormat).join(", ");
    throw new Error(`Unexpected stream format. Keys present: ${keys}`);
  }

  const mimeType = audioFormat.mimeType || "";
  const ext = mimeType.includes("webm") ? "webm" : "m4a";

  return {
    title,
    audioUrl,
    filename: `${title}.${ext}`,
    itag: audioFormat.itag,
    mimeType,
  };
}

// ─── Run ──────────────────────────────────────────────────────────────────────
// Receives DataCollector output. Triggers a browser download via the extension.

function Run(data) {
  return {
    action: "download",
    download: {
      url: data.audioUrl,
      filename: data.filename,
    },
    message: `Downloading: ${data.filename}`,
  };
}
