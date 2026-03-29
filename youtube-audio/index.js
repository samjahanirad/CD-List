// ─── DataCollector ────────────────────────────────────────────────────────────
// Runs in page MAIN world. Returns a Promise (async is supported by the core).

async function DataCollector(currentUrl, context) {
  if (!currentUrl.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video page first.");
  }

  const videoId = new URLSearchParams(currentUrl.split("?")[1] || "").get("v");
  if (!videoId) throw new Error("Cannot find video ID in the URL.");

  const pr = window.ytInitialPlayerResponse;
  if (pr?.videoDetails?.videoId !== videoId) {
    throw new Error("Player data is for a different video. Please hard-refresh (Cmd+Shift+R).");
  }

  const title = (pr.videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 100);

  const sd = pr.streamingData;
  if (!sd) throw new Error("No streamingData in player response.");

  // ── 1. Try audio-only adaptive formats ───────────────────────────────────────
  let audioFormat = pickAudioFormat(sd.adaptiveFormats || []);
  let isCombined  = false;

  if (audioFormat && !hasUrl(audioFormat)) {
    audioFormat = null; // SABR: metadata present but no URL
  }

  // ── 2. Fall back to combined audio+video MP4s (legacy, still have URLs) ──────
  if (!audioFormat) {
    const fmt = [22, 18]
      .map((itag) => (sd.formats || []).find((f) => f.itag === itag))
      .find((f) => f && hasUrl(f));
    if (fmt) { audioFormat = fmt; isCombined = true; }
  }

  if (!audioFormat) {
    throw new Error(`No downloadable stream. streamingData keys: ${Object.keys(sd).join(", ")}`);
  }

  // ── 3. Fetch base.js once — needed for both cipher and n-param transform ─────
  const playerSrc = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src).find((src) => src.includes("base.js"));
  if (!playerSrc) throw new Error("Cannot find YouTube player script (base.js).");

  const js = await fetch(playerSrc).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch player script (${r.status})`);
    return r.text();
  });

  // ── 4. Resolve stream URL (decrypt signatureCipher if needed) ────────────────
  let audioUrl = await resolveStreamUrl(audioFormat, js);

  // ── 5. Transform n-parameter — without this YouTube CDN returns 403 ──────────
  audioUrl = transformNParam(audioUrl, js);

  const mimeType = audioFormat.mimeType || "";
  const ext = isCombined ? "mp4" : (mimeType.includes("webm") ? "webm" : "m4a");

  return { title, audioUrl, filename: `${title}.${ext}`, itag: audioFormat.itag, mimeType, isCombined };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pickAudioFormat(formats) {
  return (
    [141, 140, 251, 250, 249].map((itag) => formats.find((f) => f.itag === itag)).find(Boolean) ||
    formats.find((f) => (f.mimeType || "").startsWith("audio/"))
  );
}

function hasUrl(fmt) {
  return !!(fmt.url || fmt.signatureCipher || fmt.cipher);
}

// ── Bracket-matching extractor ────────────────────────────────────────────────
// Finds the body of a named function in minified JS by counting { and }.
// Handles any nesting depth — regex alternatives always break on inner braces.

function bracketExtract(js, fnName) {
  const esc = fnName.replace(/[$]/g, "\\$");
  const re = new RegExp(
    `(?:${esc}\\s*=\\s*function\\s*\\([a-zA-Z,\\s]*\\)|function\\s+${esc}\\s*\\([a-zA-Z,\\s]*\\))\\s*\\{`
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

// ── Signature cipher ──────────────────────────────────────────────────────────

function cipherFnName(js) {
  const patterns = [
    /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/,
    /\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(/,
    /([a-zA-Z0-9$]{2,})\s*=\s*function\([a-zA-Z]\)\s*\{\s*[a-zA-Z]\s*=\s*[a-zA-Z]\.split\(["']["']\)/,
    /\bfunction\s+([a-zA-Z0-9$]{2,})\s*\([a-zA-Z]\)\s*\{\s*[a-zA-Z]\s*=\s*[a-zA-Z]\.split\(["']["']\)/,
  ];
  for (const p of patterns) {
    const m = js.match(p);
    if (m) return m[1];
  }
  return null;
}

async function resolveStreamUrl(audioFormat, js) {
  if (audioFormat.url) return audioFormat.url;

  const cipherStr = audioFormat.signatureCipher || audioFormat.cipher;
  const p = new URLSearchParams(cipherStr);
  const encSig  = p.get("s");
  const sigParam = p.get("sp") || "sig";
  const baseUrl  = p.get("url");
  if (!encSig || !baseUrl) throw new Error("Malformed cipher in stream data.");

  const fnName = cipherFnName(js);
  if (!fnName) {
    const snippets = [];
    const re = /.{0,80}split\(.{0,80}/g;
    let m;
    while ((m = re.exec(js)) !== null && snippets.length < 3) snippets.push(m[0]);
    throw new Error("Cipher fn not found. split() contexts: " + snippets.join(" ||| "));
  }

  const fnBody = bracketExtract(js, fnName);
  if (!fnBody) throw new Error("Cannot extract cipher function body.");

  const helperNameMatch = fnBody.match(/([a-zA-Z0-9$]{2,})\./);
  if (!helperNameMatch) throw new Error("Cannot find cipher helper object name.");

  const helperSrc = helperExtract(js, helperNameMatch[1]);
  if (!helperSrc) throw new Error("Cannot extract cipher helper object.");

  const decSig = new Function(
    helperSrc + "function " + fnName + "(a){" + fnBody + "}" +
    "return " + fnName + "(" + JSON.stringify(encSig) + ");"
  )();

  return baseUrl + "&" + sigParam + "=" + encodeURIComponent(decSig);
}

// ── N-parameter transform ─────────────────────────────────────────────────────
// The n-param in every YouTube stream URL must be transformed by a function
// in base.js before the CDN will serve the file. Without this it returns 403.

function nFunctionName(js) {
  // Pattern 1: nArr[0](b) — array-wrapped function (most common in recent players)
  const arrMatch = js.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)\[(\d+)\]\([a-zA-Z0-9$]+\)/);
  if (arrMatch) {
    const listMatch = js.match(
      new RegExp(`var\\s+${arrMatch[1].replace(/[$]/g, "\\$")}\\s*=\\s*\\[([a-zA-Z0-9$]+)`)
    );
    if (listMatch) return listMatch[1];
  }
  // Pattern 2: direct call nFunc(b)
  const direct = js.match(/\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]+)\([a-zA-Z0-9$]+\)/);
  if (direct) return direct[1];

  return null;
}

function transformNParam(url, js) {
  const nMatch = url.match(/[?&]n=([^&]+)/);
  if (!nMatch) return url;

  const nVal = decodeURIComponent(nMatch[1]);
  const fnName = nFunctionName(js);
  if (!fnName) return url; // can't find function — return as-is, may still 403

  const fnBody = bracketExtract(js, fnName);
  if (!fnBody) return url;

  try {
    const transformed = new Function(
      "function " + fnName + "(a){" + fnBody + "}" +
      "return " + fnName + "(" + JSON.stringify(nVal) + ");"
    )();
    if (typeof transformed === "string" && transformed !== nVal) {
      return url.replace(/([?&]n=)[^&]+/, "$1" + encodeURIComponent(transformed));
    }
  } catch (_) {}

  return url;
}

// ─── Run ──────────────────────────────────────────────────────────────────────
// Fetches from the page context (youtube.com) — correct Referer + cookies.

async function Run(data) {
  const res = await fetch(data.audioUrl);
  if (!res.ok) throw new Error(`CDN returned ${res.status} — try Get Data again.`);

  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = data.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

  return {
    message: data.isCombined
      ? `Downloading: ${data.filename} (video+audio MP4 — no audio-only available)`
      : `Downloading: ${data.filename}`,
  };
}
