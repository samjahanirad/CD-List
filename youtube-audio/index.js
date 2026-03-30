// CD Metadata
const CD_ID = "youtube-audio";
const CD_NAME = "YouTube Audio Downloader";
const CD_VERSION = "4.1.0";
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
  if (!streamingData) throw new Error("No streaming data available.");

  const title = (videoDetails?.title || "youtube-audio")
    .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 100);

  // ── 1. Pick best format with a usable URL ─────────────────────────────────────
  const adaptiveFormats = streamingData.adaptiveFormats || [];
  const regularFormats  = streamingData.formats || [];
  const hasUrl = (f) => !!(f.url || f.signatureCipher || f.cipher);

  const audioFormat =
    [141, 140, 251, 250, 249]
      .map((itag) => adaptiveFormats.find((f) => f.itag === itag && hasUrl(f)))
      .find(Boolean) ||
    adaptiveFormats.find((f) => (f.mimeType || "").startsWith("audio/") && hasUrl(f)) ||
    regularFormats.find((f) => f.itag === 18 && hasUrl(f)) ||
    regularFormats.find((f) => f.mimeType && hasUrl(f));

  if (!audioFormat) throw new Error("No downloadable stream found for this video.");

  const isCombined = !(audioFormat.mimeType || "").startsWith("audio/");

  // ── 2. Load base.js (cached per player build) ─────────────────────────────────
  const playerSrc = Array.from(document.querySelectorAll("script[src]"))
    .map((s) => s.src).find((src) => src.includes("base.js"));
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

  } else if (audioFormat.signatureCipher || audioFormat.cipher) {
    const p       = new URLSearchParams(audioFormat.signatureCipher || audioFormat.cipher);
    const encSig  = p.get("s");
    const sigParam = p.get("sp") || "sig";
    const baseUrl  = p.get("url");
    if (!encSig || !baseUrl) throw new Error("Malformed signatureCipher in stream data.");

    const fnNameMatch = js.match(
      /\bc\s*&&\s*d\.set\([^,]+,\s*encodeURIComponent\(\s*([a-zA-Z0-9$]+)\(/
    );
    if (!fnNameMatch) throw new Error("Cannot locate cipher function in player script.");
    const fnName = fnNameMatch[1];

    const esc      = fnName.replace(/[$]/g, "\\$");
    const fnMatch  = js.match(new RegExp(esc + "\\s*=\\s*function\\([a-z]\\)\\{([^}]+)\\}"));
    if (!fnMatch) throw new Error("Cannot extract cipher function body.");
    const fnBody   = fnMatch[1];

    const helperName = (fnBody.match(/([a-zA-Z0-9$]{2,})\./) || [])[1];
    if (!helperName) throw new Error("Cannot find cipher helper name.");
    const escH       = helperName.replace(/[$]/g, "\\$");
    const helperMatch = js.match(new RegExp("var\\s+" + escH + "\\s*=\\s*\\{[\\s\\S]*?\\};"));
    if (!helperMatch) throw new Error("Cannot extract cipher helper object.");

    const decSig = new Function(
      helperMatch[0] +
      "function " + fnName + "(a){" + fnBody + "}" +
      "return " + fnName + "(" + JSON.stringify(encSig) + ");"
    )();

    audioUrl = baseUrl + "&" + sigParam + "=" + encodeURIComponent(decSig);

  } else {
    const keys = Object.keys(audioFormat).join(", ");
    throw new Error("Unexpected stream format (itag " + audioFormat.itag + "). Keys: " + keys);
  }

  // ── 4. Descramble n parameter ─────────────────────────────────────────────────
  const urlObj = new URL(audioUrl);
  const nRaw   = urlObj.searchParams.get("n");
  let _n = "no n param";

  if (nRaw) {
    try {
      const nOut = descrambleN(js, nRaw);
      if (nOut !== nRaw) {
        urlObj.searchParams.set("n", nOut);
        _n = "ok: " + nRaw + " → " + nOut;
      } else {
        _n = "warn: same value returned";
      }
    } catch (e) {
      _n = "FAILED: " + e.message;
    }
  }

  // ── 5. Attach pot token if available ─────────────────────────────────────────
  let _pot = "none";
  try {
    const pot = streamingData.serviceIntegrityDimensions?.poToken ||
                pr.playerConfig?.mediaCommonConfig?.dynamicReadaheadConfig?.poToken;
    if (pot) { urlObj.searchParams.set("pot", pot); _pot = "attached"; }
  } catch (_) {}

  audioUrl = urlObj.toString();

  // ── 6. Validate URL before returning ─────────────────────────────────────────
  let _valid = "unchecked";
  try {
    const check = await fetch(audioUrl, { method: "HEAD", credentials: "include" });
    if (check.ok || check.status === 206) {
      _valid = "ok (" + check.status + ")";
    } else {
      _valid = "FAILED (" + check.status + ")";
      throw new Error(
        "CDN rejected URL (" + check.status + ")  n=" + _n + "  pot=" + _pot
      );
    }
  } catch (e) {
    if (e.message.startsWith("CDN rejected")) throw e;
    _valid = "fetch-error: " + e.message;
  }

  const mimeType = audioFormat.mimeType || "";
  const ext = isCombined ? "mp4" : mimeType.includes("webm") ? "webm" : "m4a";

  return { title, audioUrl, filename: `${title}.${ext}`,
           itag: audioFormat.itag, mimeType, isCombined, _n, _pot, _valid };
}

// ─── descrambleN ─────────────────────────────────────────────────────────────
// Finds and executes YouTube's n-parameter descrambling function from base.js.
// Throws a descriptive error at each step so _n in the output shows exactly what broke.

function descrambleN(js, nRaw) {
  // YouTube obfuscates the n-descrambler reference in many forms.
  // All patterns capture: [1]=variable letter, [2]=function reference (e.g. "Nqa[0]")
  // \1 backreference ensures the same variable is used throughout.
  // \s* handles any whitespace that may be present after minification.
  const PATTERNS = [
    // .get("n"))&&(V=REF(V)   — most common in 2024-2025 players
    /\.get\("n"\)\)\s*&&\s*\(\s*([a-zA-Z])\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)/,
    // V&&(V=REF(V)            — split-statement form
    /\b([a-zA-Z])\s*&&\s*\(\s*\1\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)/,
    // V=REF(V),...set("n",V)  — comma-chain form
    /\b([a-zA-Z])\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)\s*,\s*[a-zA-Z.[\]]+\.set\(\s*"n"\s*,\s*\1\s*\)/,
    // set("n",REF(V))         — inline form
    /\.set\(\s*"n"\s*,\s*([a-zA-Z0-9$[\].]+)\(\s*([a-zA-Z])\s*\)\s*\)/,
    // V=REF(V);...set("n"     — semicolon-statement form
    /\b([a-zA-Z])\s*=\s*([a-zA-Z0-9$[\].]+)\(\s*\1\s*\)\s*;\s*[a-zA-Z.[\]]+\.set\(\s*"n"/,
  ];

  let ref = null;
  for (const pat of PATTERNS) {
    const m = js.match(pat);
    if (m) {
      // Pattern 4 captures (ref, var); all others capture (var, ref)
      ref = (pat === PATTERNS[3]) ? m[1] : m[2];
      break;
    }
  }
  if (!ref) throw new Error("n-descrambler reference not found in player script");

  const arrayMatch = ref.match(/^([a-zA-Z0-9$]+)\[(\d+)\]$/);

  // Build an invocation expression, then run it with auto dependency injection.
  // Both the array and direct-function paths end up as a single code string so
  // any ReferenceError (like "bs is not defined") triggers an automatic retry
  // where we find and prepend that variable's definition from base.js.

  let invocation;

  if (arrayMatch) {
    const [, arrName, idxStr] = arrayMatch;
    const idx = parseInt(idxStr, 10);
    const esc = arrName.replace(/[$]/g, "\\$");

    const startRe    = new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\[");
    const startMatch = js.match(startRe);
    if (!startMatch) throw new Error("array '" + arrName + "' declaration not found");

    const bracketPos = startMatch.index + startMatch[0].length - 1;
    const arrLiteral = extractBrackets(js, bracketPos);
    if (!arrLiteral) throw new Error("could not extract array '" + arrName + "' literal");

    invocation = "return (" + arrLiteral + ")[" + idx + "](" + JSON.stringify(nRaw) + ");";

  } else {
    const esc        = ref.replace(/[$]/g, "\\$");
    const startRe    = new RegExp("(?:(?:var|let|const)\\s+)?" + esc + "\\s*=\\s*function\\(([^)]+)\\)\\s*\\{");
    const startMatch = js.match(startRe);
    if (!startMatch) throw new Error("function '" + ref + "' definition not found");

    const arg       = startMatch[1];
    const bodyStart = js.indexOf("{", startMatch.index + startMatch[0].length - 1);
    const body      = extractBody(js, bodyStart);
    if (!body) throw new Error("could not extract body of '" + ref + "'");

    invocation = "return (function(" + arg + "){" + body + "})(" + JSON.stringify(nRaw) + ");";
  }

  return runWithDeps(js, invocation);
}

// Executes `code` via new Function(code)(), retrying up to 5 times.
// On each ReferenceError it finds the missing variable's definition in the
// player JS and prepends it, so closured helpers like `bs` resolve correctly.
function runWithDeps(js, code, depth) {
  depth = depth || 0;
  if (depth > 5) throw new Error("too many dependency resolution attempts");
  try {
    return new Function(code)();
  } catch (e) {
    if (!(e instanceof ReferenceError)) throw e;
    const missing = (e.message.match(/^([a-zA-Z$_][a-zA-Z0-9$_]*)\s+is not defined/) || [])[1];
    if (!missing) throw e;
    const dep = findDefinition(js, missing);
    if (!dep) throw new Error("dependency '" + missing + "' not found in player script");
    return runWithDeps(js, dep + "\n" + code, depth + 1);
  }
}

// Finds and returns a var/let/const definition for `name` from base.js.
// Handles array literals [...] and object literals {...}.
function findDefinition(js, name) {
  const esc = name.replace(/[$]/g, "\\$");

  // Try array: var NAME=[...]
  const arrMatch = js.match(new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\["));
  if (arrMatch) {
    const pos     = arrMatch.index + arrMatch[0].length - 1;
    const content = extractBrackets(js, pos);
    if (content) return "var " + name + "=" + content + ";";
  }

  // Try object: var NAME={...}
  const objMatch = js.match(new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*\\{"));
  if (objMatch) {
    const pos     = js.indexOf("{", objMatch.index + objMatch[0].length - 1);
    const content = extractBody(js, pos);
    if (content) return "var " + name + "={" + content + "};";
  }

  // Try function: var NAME=function(...){...}
  const fnMatch = js.match(new RegExp("(?:var|let|const)\\s+" + esc + "\\s*=\\s*function\\([^)]*\\)\\s*\\{"));
  if (fnMatch) {
    const pos     = js.indexOf("{", fnMatch.index + fnMatch[0].length - 1);
    const content = extractBody(js, pos);
    if (content) return fnMatch[0].replace(/^(?:var|let|const)\s+/, "var ") + content + "};";
  }

  return null;
}

// Extracts a balanced [...] block starting at openBracket.
// Handles string literals so braces/brackets inside strings don't confuse the counter.
function extractBrackets(src, openBracket) {
  if (src[openBracket] !== "[") return null;
  let depth = 0, inStr = null;
  for (let i = openBracket; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "[") { depth++; }
    else if (c === "]") { if (--depth === 0) return src.slice(openBracket, i + 1); }
  }
  return null;
}

// Extracts a balanced {...} body starting at openBrace.
function extractBody(src, openBrace) {
  if (src[openBrace] !== "{") return null;
  let depth = 0, inStr = null;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "{") { depth++; }
    else if (c === "}") { if (--depth === 0) return src.slice(openBrace + 1, i); }
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
