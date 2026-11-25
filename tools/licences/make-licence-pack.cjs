/*
 * Builds the licences folder that ships beside the program (D88): every licence text and notice for what the
 * Windows build contains, the list of Rust libraries compiled into it, and how to get the source code.
 *
 *   node tools/licences/make-licence-pack.cjs <output-folder> <commit>
 *
 * Run through tools\make-licence-pack.ps1, which puts cargo on the path. Every text is copied from the component's
 * own source (archives in third_party/source, the MSYS2 toolchain's licence folder, the cargo registry), never
 * written by hand, so it is the text the component was released under.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const out = path.resolve(process.argv[2] || path.join(root, "dist-app", "licenses"));
const commit = process.argv[3] || "unknown";
const msys = process.env.MSYS2_ROOT || "C:\\msys64";
const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const problems = [];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "texts"), { recursive: true });

const write = (name, text) => fs.writeFileSync(path.join(out, name), text.replace(/\r?\n/g, "\r\n"));
function copyText(from, name) {
  if (!fs.existsSync(from)) { problems.push(`missing: ${from}`); return; }
  write(path.join("texts", name), fs.readFileSync(from, "utf8"));
}
/** One file out of a source archive, by its path inside the archive. */
function fromArchive(archive, inner, name) {
  const file = path.join(root, "third_party", "source", archive);
  if (!fs.existsSync(file)) { problems.push(`missing archive: ${file}`); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-licence-"));
  try {
    execFileSync(tar, ["-xf", file, "-C", temp, inner]);
    copyText(path.join(temp, ...inner.split("/")), name);
  } catch (error) {
    problems.push(`could not read ${inner} from ${archive}: ${error.message}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
/** The archive's top folder, read from the archive (GitHub names it after the repository, e.g. libcdio-C-<commit>). */
function topFolder(archive) {
  const list = execFileSync(tar, ["-tf", path.join(root, "third_party", "source", archive)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return list.split(/\r?\n/)[0].split("/")[0];
}

// ---- MediaVerse Studio itself and the summary of notices
copyText(path.join(root, "LICENSE"), "MediaVerse-Studio-GPL-3.0.txt");
copyText(path.join(root, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md");
copyText(path.join(root, "TRADEMARKS.md"), "TRADEMARKS.md");

// ---- Native components
const sources = fs.readdirSync(path.join(root, "third_party", "source"));
const cdio = sources.find((n) => /^libcdio-[0-9a-f]{40}\.tar\.gz$/.test(n));
const paranoia = sources.find((n) => /^libcdio-paranoia-[0-9a-f]{40}\.tar\.gz$/.test(n));
if (cdio) fromArchive(cdio, `${topFolder(cdio)}/COPYING`, "libcdio-COPYING.txt"); else problems.push("libcdio archive not found");
if (paranoia) fromArchive(paranoia, `${topFolder(paranoia)}/COPYING`, "libcdio-paranoia-COPYING.txt"); else problems.push("libcdio-paranoia archive not found");
fromArchive("lame-4.0.tar.gz", "lame-4.0/COPYING", "LAME-COPYING.txt");
fromArchive("lame-4.0.tar.gz", "lame-4.0/LICENSE", "LAME-LICENSE.txt");
copyText(path.join(msys, "ucrt64", "share", "licenses", "libiconv", "COPYING.LIB"), "libiconv-COPYING.LIB.txt");
copyText(path.join(msys, "ucrt64", "share", "licenses", "crt", "COPYING.MinGW-w64-runtime.txt"), "MinGW-w64-runtime.txt");
copyText(path.join(msys, "ucrt64", "share", "licenses", "winpthreads", "COPYING"), "winpthreads-COPYING.txt");
copyText(path.join(msys, "ucrt64", "share", "licenses", "gcc", "COPYING.RUNTIME"), "GCC-runtime-library-exception.txt");

// ---- The page's one bundled third-party snippet: Vite's module-preload helper.
const viteLicence = fs.readFileSync(path.join(root, "web", "app", "node_modules", "vite", "LICENSE.md"), "utf8");
write(path.join("texts", "Vite-MIT.txt"), viteLicence.split(/\n# Licenses of bundled dependencies/)[0]);

// ---- Rust libraries compiled into the shipped programs
const cargo = (args) => execFileSync("cargo", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const shipped = new Map(); // "name version" -> licence expression
for (const [pkg, target] of [["mediaverse_sidecar", "x86_64-pc-windows-msvc"], ["mediaverse_cd_helper", "x86_64-pc-windows-gnu"], ["mediaverse_setup_stub", "x86_64-pc-windows-msvc"]]) {
  const lines = cargo(["tree", "-p", pkg, "-e", "normal,no-proc-macro", "--prefix", "none", "-f", "{p}|{l}", "--target", target]).split(/\r?\n/);
  for (const line of lines) {
    const [id, licence] = line.replace(/ \(\*\)$/, "").split("|");
    if (!id) continue;
    // "name v1.2.3" or, for this project's own crates, "name v0.1.0 (C:\...)"; own crates are skipped below.
    const [name, version] = id.trim().split(" ");
    shipped.set(`${name} ${version}`, (licence || "").trim());
  }
}
const metadata = JSON.parse(cargo(["metadata", "--format-version", "1", "--locked"]));
const own = new Set(metadata.workspace_members);
const byKey = new Map(metadata.packages.map((p) => [`${p.name} v${p.version}`, p]));
const rows = [];
const texts = [];
let apacheText = null; // the Apache-2.0 text, taken from a library that ships it, for those that ship none
const apacheUsers = [];
for (const key of [...shipped.keys()].sort((a, b) => a.localeCompare(b))) {
  const pkg = byKey.get(key);
  if (!pkg) { problems.push(`no cargo metadata for ${key}`); continue; }
  if (own.has(pkg.id)) continue;
  const dir = path.dirname(pkg.manifest_path);
  let files = fs.readdirSync(dir).filter((n) => /^(licen[cs]e|copying|unlicense|notice|copyright)/i.test(n) && fs.statSync(path.join(dir, n)).isFile());
  // A library that ships no licence file but whose upstream notice has been saved, verbatim, in third_party/licence-extras/<name>/
  // (with a README saying where it came from) uses that.
  let textDir = dir;
  const extras = path.join(root, "third_party", "licence-extras", pkg.name);
  if (files.length === 0 && fs.existsSync(extras)) {
    textDir = extras;
    files = fs.readdirSync(extras).filter((n) => /^licen[cs]e/i.test(n) && fs.statSync(path.join(extras, n)).isFile());
  }
  const apacheFile = files.find((n) => /apache/i.test(n));
  if (!apacheText && apacheFile) apacheText = fs.readFileSync(path.join(textDir, apacheFile), "utf8").trim();
  if (files.length === 0) {
    // A library that publishes no licence file: if Apache-2.0 is one of its choices it is used under Apache-2.0,
    // whose text (identical for every project) is included once below. Anything else must be looked at by hand.
    if (/Apache-2\.0/.test(pkg.license || "")) apacheUsers.push(`${pkg.name} ${pkg.version}`);
    else problems.push(`no licence file in ${pkg.name} ${pkg.version} (${pkg.license}); add its text by hand`);
  }
  rows.push(`${pkg.name.padEnd(32)} ${pkg.version.padEnd(12)} ${pkg.license || pkg.license_file || "(see text)"}${files.length === 0 ? "  (used under Apache-2.0)" : ""}`);
  for (const file of files) texts.push(`==== ${pkg.name} ${pkg.version}: ${file} ====\n\n${fs.readFileSync(path.join(textDir, file), "utf8").trim()}\n`);
}
if (apacheUsers.length) {
  if (!apacheText) problems.push("no Apache-2.0 text found for: " + apacheUsers.join(", "));
  else texts.push(`==== Apache License 2.0, for ${apacheUsers.join(", ")} (they publish no licence file) ====\n\n${apacheText}\n`);
}
write("Rust-libraries.txt", [
  "Rust libraries compiled into mediaverse_sidecar.exe, mediaverse_cd_helper.exe and the setup program.",
  "MediaVerse Studio's own crates are GPL-3.0-or-later (texts\\MediaVerse-Studio-GPL-3.0.txt). The Rust standard",
  "library, built into every Rust program, is MIT OR Apache-2.0. rusqlite bundles SQLite, which is in the public domain.",
  "Where a library offers a choice (\"MIT OR Apache-2.0\"), MediaVerse Studio uses it under the licence compatible",
  "with the GPL. The full licence texts as published with each library follow the list.",
  "",
  `${"Library".padEnd(32)} ${"Version".padEnd(12)} Licence`,
  ...rows,
  "",
  ...texts,
].join("\n"));

// ---- The overview
write("README.txt", `MediaVerse Studio - licences and source code
=============================================

MediaVerse Studio is free software, licensed under the GNU General Public License, version 3 or (at your option)
any later version: texts\\MediaVerse-Studio-GPL-3.0.txt. It comes with NO WARRANTY. The name and logo are
trademarks of the project (texts\\TRADEMARKS.md).

This copy was built from source commit ${commit}.

What this program contains, and under which licence
---------------------------------------------------
  mediaverse_cd_helper.exe   libcdio, libcdio-paranoia (GPL-3.0-or-later)      texts\\libcdio-COPYING.txt,
                             libiconv (LGPL-2.1-or-later)                      texts\\libcdio-paranoia-COPYING.txt,
                             MinGW-w64 runtime and winpthreads (permissive),    texts\\libiconv-COPYING.LIB.txt,
                             GCC runtime (GPL with Runtime Library Exception)   texts\\MinGW-w64-runtime.txt, ...
  resources\\lame.exe         LAME 4.0 (LGPL-2.0-or-later), unmodified apart    texts\\LAME-COPYING.txt
                             from one build fix (in the source bundle)
  mediaverse_sidecar.exe     Rust libraries (MIT, Apache-2.0 and similar)       Rust-libraries.txt
  MediaVerse Studio.exe      Electron, Chromium, Node.js (MIT, BSD and others)  LICENSE and LICENSES.chromium.html
                                                                                in the program folder
  the program's page         Vite's module-preload helper (MIT)                 texts\\Vite-MIT.txt

texts\\THIRD_PARTY_NOTICES.md has the same list with more detail.

Getting the source code
-----------------------
The complete source code for this exact build - MediaVerse Studio's own code, the libcdio, libcdio-paranoia,
libiconv and LAME source archives it was built from, the one local patch and the build scripts - is in the file
MediaVerse-Studio-Source-${commit}.zip, which is shared in the same place as the installer.

If you received the program without that file, write to contact@mediaverse.studio and you will be given the
source for this build at no charge. This offer is valid for three years from when you received the program, and
for anyone who has a copy.

LAME and libiconv are under the LGPL: you may change them and use your own version with this program. LAME runs
as a separate program (resources\\lame.exe; replace it with your own build). libiconv is linked into
mediaverse_cd_helper.exe; the source bundle has everything needed to rebuild that program with your own libiconv
(see third_party\\README.md in the source).
`);

if (problems.length) {
  console.error("The licences folder is INCOMPLETE:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`Licences folder ready: ${out} (${rows.length} Rust libraries listed)`);
