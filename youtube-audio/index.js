// ─── DataCollector ────────────────────────────────────────────────────────────
// Runs in page MAIN world. Returns a Promise (async is supported by the core).

async function DataCollector(currentUrl, context) {
  if (!currentUrl.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video page first.");
  }

  // Always read video ID from the URL — ytInitialPlayerResponse can be stale
  // after SPA navigation (YouTube changes the URL without a full page reload).
  const videoId = new URLSearchParams(currentUrl.split("?")[1] || "").get("v");
  if (!videoId) throw new Error("Cannot find video ID in the URL.");

  // Try ytInitialPlayerResponse only when it matches the current video
  const pr = window.ytInitialPlayerResponse;
  const prMatchesCurrent = pr?.videoDetails?.videoId === videoId;

  let title = "youtube-audio";
  let audioFormat = null;

  if (prMatchesCurrent) {
    title = (pr.videoDetails?.title || title)
      .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 100);
    audioFormat = pickAudioFormat(pr.streamingData?.adaptiveFormats || []);
  }

  // If ytInitialPlayerResponse is stale, missing, or has no usable URL,
  // fetch fresh data from YouTube's own InnerTube API (cookies sent automatically).
  if (!audioFormat || !hasUrl(audioFormat)) {
    const fresh = await fetchInnerTubePlayer(videoId);
    const sd = fresh.streamingData;

    // Pull title from fresh response if we didn't get it above
    if (!prMatchesCurrent) {
      title = (fresh.videoDetails?.title || title)
        .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 100);
    }

    audioFormat = pickAudioFormat(sd?.adaptiveFormats || [])
               || pickAudioFormat(sd?.formats || []);

    if (!audioFormat) {
      const status = fresh.playabilityStatus?.status || "unknown";
      const reason = fresh.playabilityStatus?.reason || "";
      const adaptiveCount = sd?.adaptiveFormats?.length ?? "none";
      const sdKeys = sd ? Object.keys(sd).join(", ") : "streamingData absent";
      throw new Error(
        `No audio stream found. status=${status}${reason ? " ("+reason+")" : ""}` +
        `, adaptiveFormats=${adaptiveCount}, streamingData keys: ${sdKeys}`
      );
    }

    if (!hasUrl(audioFormat)) {
      throw new Error(
        `Stream URL still missing after InnerTube refresh. ` +
        `Format keys: ${Object.keys(audioFormat).join(", ")}`
      );
    }
  }

  const audioUrl = await resolveStreamUrl(audioFormat);
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

// Call YouTube's own InnerTube player API from the page context.
// Runs on youtube.com so the browser includes session cookies automatically.
async function fetchInnerTubePlayer(videoId) {
  const cfg = window.yt?.config_ || {};
  const apiKey = cfg.INNERTUBE_API_KEY || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const clientName    = cfg.INNERTUBE_CLIENT_NAME    || "WEB";
  const clientVersion = cfg.INNERTUBE_CLIENT_VERSION || "2.20240101";
  const visitorData   = cfg.VISITOR_DATA             || "";

  const res = await fetch(
    `/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name":    String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME || "1"),
        "X-YouTube-Client-Version": clientVersion,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName,
            clientVersion,
            hl:          cfg.HL          || "en",
            gl:          cfg.GL          || "US",
            visitorData,
          },
        },
      }),
    }
  );

  if (!res.ok) throw new Error(`InnerTube player API failed (${res.status})`);
  return res.json();
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

  const fnNameMatch = js.match(
    /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/
  );
  if (!fnNameMatch) throw new Error("Cannot locate cipher function in player script.");
  const fnName = fnNameMatch[1];

  const escaped = fnName.replace(/[$]/g, "\\$");
  const fnMatch = js.match(new RegExp(escaped + "\\s*=\\s*function\\([a-z]\\)\\{([^}]+)\\}"));
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
    message: `Downloading: ${data.filename}`,
  };
}
