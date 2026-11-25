// "Add this album to MusicBrainz" (D107): MusicBrainz's release editor can be filled in by a form POST
// (https://musicbrainz.org/doc/Development/Release_Editor_Seeding). The person's browser opens a small local page that
// posts the details to musicbrainz.org/release/add; they log in there, check everything and press Enter edit themselves.
// Nothing is sent from this program, and the details come only from what the person confirmed on the Rip page.

const MAX_TEXT = 300;
const MAX_TRACKS = 99;

const text = (value) => (typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_TEXT) : "");
const escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The form fields for a release, or throws with the reason when there is not enough to start from. */
function seedFields(release) {
  const name = text(release?.album);
  const artist = text(release?.artist);
  if (!name || !artist) throw new Error("The album title and the artist are needed.");
  const tracks = Array.isArray(release.tracks) ? release.tracks.slice(0, MAX_TRACKS) : [];
  if (tracks.length === 0 || tracks.some((t) => !text(t?.title))) throw new Error("Every track needs a title.");

  const fields = [
    ["name", name],
    ["artist_credit.names.0.name", artist],
    ["artist_credit.names.0.artist.name", artist],
    ["status", "official"],
    ["mediums.0.format", "CD"],
  ];
  const date = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text(release.date) || (release.year ? String(release.year) : ""));
  if (date) {
    fields.push(["events.0.date.year", date[1]]);
    if (date[2]) fields.push(["events.0.date.month", String(Number(date[2]))]);
    if (date[3]) fields.push(["events.0.date.day", String(Number(date[3]))]);
  }
  const country = text(release.country).toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) fields.push(["events.0.country", country]);
  if (text(release.label)) fields.push(["labels.0.name", text(release.label)]);
  if (text(release.catalog_number)) fields.push(["labels.0.catalog_number", text(release.catalog_number)]);
  const barcode = text(release.barcode).replace(/\s+/g, "");
  if (/^\d{8,14}$/.test(barcode)) fields.push(["barcode", barcode]);
  tracks.forEach((track, index) => {
    fields.push([`mediums.0.track.${index}.name`, text(track.title)]);
    fields.push([`mediums.0.track.${index}.number`, String(index + 1)]);
    const length = Number(track.length_ms);
    if (Number.isFinite(length) && length > 0) fields.push([`mediums.0.track.${index}.length`, String(Math.round(length))]);
    const own = text(track.artist);
    if (own && own !== artist) {
      fields.push([`mediums.0.track.${index}.artist_credit.names.0.name`, own]);
      fields.push([`mediums.0.track.${index}.artist_credit.names.0.artist.name`, own]);
    }
  });
  fields.push(["edit_note", text(release.note) || "Added from a CD I own, using MediaVerse Studio. Track lengths are from the disc's table of contents."]);
  return fields;
}

/** A page that posts the fields to MusicBrainz's Add Release form at once (with a button in case scripts are off). */
function seedPage(release) {
  const inputs = seedFields(release).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Add to MusicBrainz</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action https://musicbrainz.org">
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style></head>
<body><h1>Add this album to MusicBrainz</h1>
<p>Your details are being sent to musicbrainz.org to fill in its Add Release form. Log in there if asked, check everything, and press <strong>Enter edit</strong> yourself. Nothing is saved until you do.</p>
<form id="seed" method="post" action="https://musicbrainz.org/release/add">
${inputs}
<button type="submit">Continue to MusicBrainz</button>
</form>
<script>document.getElementById("seed").submit();</script>
</body></html>
`;
}

module.exports = { seedFields, seedPage, escapeHtml };
