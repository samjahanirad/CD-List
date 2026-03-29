// ─── DataCollector ────────────────────────────────────────────────────────────
// Runs in page MAIN world. Returns a Promise (async is supported by the core).

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

  const videoId = prVideoId || urlVideoId;
  if (!videoId) throw new Error("Cannot determine video ID.");

  const title = (pr.videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "")
    .trim()
    .slice(0, 100);

  // ── Try ytInitialPlayerResponse first ──────────────────────────────────────
  let audioFormat = pickAudioFormat(pr.streamingData?.adaptiveFormats || []);

  // If the format has no resolvable URL, YouTube withheld stream URLs from the
  // initial page payload. Fall back to a fresh InnerTube API call.
  if (!audioFormat || !hasUrl(audioFormat)) {
    const fresh = await fetchInnerTubePlayer(videoId);
    // Diagnostic: log the full response structure so we can debug
    const sd = fresh.streamingData;
    const status = fresh.playabilityStatus?.status || "unknown";
    const reason = fresh.playabilityStatus?.reason || "";
    const adaptiveCount = sd?.adaptiveFormats?.length ?? "missing";
    const formatsCount = sd?.formats?.length ?? "missing";
    const sdKeys = sd ? Object.keys(sd).join(", ") : "streamingData missing";

    audioFormat = pickAudioFormat(sd?.adaptiveFormats || [])
               || pickAudioFormat(sd?.formats || []);

    if (!audioFormat) {
      throw new Error(
        `No audio stream found. playabilityStatus=${status}${reason ? " ("+reason+")" : ""}. ` +
        `adaptiveFormats=${adaptiveCount}, formats=${formatsCount}. ` +
        `streamingData keys: ${sdKeys}`
      );
    }
    if (!hasUrl(audioFormat)) {
      const keys = Object.keys(audioFormat).join(", ");
      throw new Error(`Stream URL still missing after InnerTube refresh. Keys: ${keys}`);
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
  // Prefer high-quality AAC (.m4a), fall back to Opus (.webm)
  // 141 = AAC 256kbps, 140 = AAC 128kbps, 251/250/249 = Opus
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
// Cookies are included automatically — same as any fetch() on youtube.com.
async function fetchInnerTubePlayer(videoId) {
  const cfg = window.yt?.config_ || {};
  const apiKey = cfg.INNERTUBE_API_KEY || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

  const res = await fetch(
    `/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: cfg.INNERTUBE_CLIENT_NAME || "WEB",
            clientVersion: cfg.INNERTUBE_CLIENT_VERSION || "2.20240101",
            hl: cfg.HL || "en",
            gl: cfg.GL || "US",
          },
        },
      }),
    }
  );

  if (!res.ok) throw new Error(`InnerTube player API failed (${res.status})`);
  return res.json();
}

// Resolve a format entry to a plain URL, decrypting signatureCipher if needed.
async function resolveStreamUrl(audioFormat) {
  if (audioFormat.url) return audioFormat.url;

  const cipherStr = audioFormat.signatureCipher || audioFormat.cipher;
  const p = new URLSearchParams(cipherStr);
  const encSig  = p.get("s");
  const sigParam = p.get("sp") || "sig";
  const baseUrl  = p.get("url");
  if (!encSig || !baseUrl) throw new Error("Malformed cipher in stream data.");

  // Find base.js already loaded by the page
  const playerSrc = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src)
    .find((src) => src.includes("base.js"));
  if (!playerSrc) throw new Error("Cannot find YouTube player script to decrypt signature.");

  // Fetch base.js — browser sends YouTube cookies automatically
  const js = await fetch(playerSrc).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch player script (${r.status})`);
    return r.text();
  });

  // Find cipher function name
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
