// Decides which files the player may read. The page asks for audio through the `mediaverse-media`
// scheme; only audio files inside the user's music library folder are served, and links, junctions and
// `..` tricks that lead outside it are refused.

const fs = require("node:fs");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus"]);

const MIME_TYPES = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
};

function samePlace(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Returns the real path of an allowed audio file, or throws an Error saying why not. */
function resolveAllowedAudio(requestedPath, libraryRoot) {
  if (typeof requestedPath !== "string" || requestedPath === "" || !path.isAbsolute(requestedPath)) {
    throw new Error("The file path is not valid.");
  }
  if (typeof libraryRoot !== "string" || libraryRoot === "") {
    throw new Error("No music library folder is chosen.");
  }
  const extension = path.extname(requestedPath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    throw new Error("Only audio files can be played.");
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(libraryRoot);
  } catch {
    throw new Error("The file or the library folder could not be found.");
  }
  let realFile = null;
  try {
    realFile = fs.realpathSync(requestedPath);
  } catch {
    // maybe a path from before the library moved: tried below
  }
  const fold = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  if (realFile !== null && samePlace(fold(realRoot), fold(realFile))) return realFile;
  const moved = relocate(requestedPath, realRoot, fold);
  if (moved !== null) return moved;
  if (realFile === null) throw new Error("The file or the library folder could not be found.");
  throw new Error("The file is outside your music library.");
}

/**
 * A path kept from before the library moved (`C:\Users\X\Music\Band\Album\song.mp3` when the library is now `M:\`): the same song under the
 * current folder, found by the last parts of the path (the longest that matches, five down to two). Null when there is none. The file found must
 * itself be inside the library, so links out of it are still refused.
 */
function relocate(requestedPath, realRoot, fold) {
  const parts = requestedPath.split(/[\\/]+/).filter((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"));
  for (let count = Math.min(5, parts.length); count >= 2; count -= 1) {
    try {
      const candidate = fs.realpathSync(path.join(realRoot, ...parts.slice(parts.length - count)));
      if (fs.statSync(candidate).isFile() && samePlace(fold(realRoot), fold(candidate))) return candidate;
    } catch {
      // not there: a shorter ending is tried
    }
  }
  return null;
}

function mimeTypeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

module.exports = { resolveAllowedAudio, mimeTypeFor, AUDIO_EXTENSIONS };
