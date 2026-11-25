/* Development aid: rips one audio track (plus a margin of sectors on each side) with
 * libcdio-paranoia to raw 16-bit little-endian stereo PCM, and prints the paranoia event counts.
 * The margin lets offset calibration shift the window without leaving the data we read.
 *
 * usage: riptrack <device> <track> <margin-sectors> <output.raw> [mode]
 *   mode: full (default, secure, never skips), relaxed (may skip), fast, none (no paranoia checks)
 * Read-only on the drive. Not shipped. Build and run via tools/run-riptrack.ps1. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <cdio/cdio.h>
#include <cdio/paranoia/cdda.h>
#include <cdio/paranoia/paranoia.h>

static long counts[32];

static void on_event(long inpos, paranoia_cb_mode_t function) {
    (void)inpos;
    if (function >= 0 && function < 32) counts[function]++;
}

static const char *event_name(int f) {
    switch (f) {
    case PARANOIA_CB_READ: return "read";
    case PARANOIA_CB_VERIFY: return "verify";
    case PARANOIA_CB_FIXUP_EDGE: return "fixup_edge";
    case PARANOIA_CB_FIXUP_ATOM: return "fixup_atom";
    case PARANOIA_CB_SCRATCH: return "scratch";
    case PARANOIA_CB_REPAIR: return "repair";
    case PARANOIA_CB_SKIP: return "skip";
    case PARANOIA_CB_DRIFT: return "drift";
    case PARANOIA_CB_BACKOFF: return "backoff";
    case PARANOIA_CB_OVERLAP: return "overlap";
    case PARANOIA_CB_FIXUP_DROPPED: return "fixup_dropped";
    case PARANOIA_CB_FIXUP_DUPED: return "fixup_duped";
    case PARANOIA_CB_READERR: return "read_error";
    default: return "other";
    }
}

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: riptrack <device> <track> <margin-sectors> <output.raw> [full|fast|none]\n");
        return 2;
    }
    const char *device = argv[1];
    int track = atoi(argv[2]);
    long margin = atol(argv[3]);
    const char *out_path = argv[4];
    const char *mode_name = argc > 5 ? argv[5] : "full";

    cdrom_drive_t *drive = cdio_cddap_identify(device, CDDA_MESSAGE_PRINTIT, NULL);
    if (!drive) { fprintf(stderr, "could not identify drive %s\n", device); return 1; }
    if (cdio_cddap_open(drive) != 0) { fprintf(stderr, "could not open drive\n"); return 1; }

    lsn_t first = cdio_cddap_track_firstsector(drive, track);
    lsn_t last = cdio_cddap_track_lastsector(drive, track);
    if (first < 0 || last < 0) { fprintf(stderr, "track %d has no audio sectors\n", track); return 1; }
    lsn_t from = first - margin, to = last + margin;
    if (from < 0) from = 0;
    fprintf(stderr, "track %d: sectors %d..%d (margin %ld) -> reading %d..%d, mode=%s\n", track,
            first, last, margin, from, to, mode_name);

    cdrom_paranoia_t *paranoia = cdio_paranoia_init(drive);
    int mode = PARANOIA_MODE_FULL; /* includes NEVERSKIP: never silently skip an unreadable sector */
    if (strcmp(mode_name, "relaxed") == 0) mode = PARANOIA_MODE_FULL ^ PARANOIA_MODE_NEVERSKIP;
    else if (strcmp(mode_name, "fast") == 0) mode = PARANOIA_MODE_OVERLAP;
    else if (strcmp(mode_name, "none") == 0) mode = PARANOIA_MODE_DISABLE;
    cdio_paranoia_modeset(paranoia, mode);
    cdio_paranoia_seek(paranoia, from, SEEK_SET);

    FILE *out = fopen(out_path, "wb");
    if (!out) { fprintf(stderr, "cannot write %s\n", out_path); return 1; }

    long sectors = 0;
    for (lsn_t lsn = from; lsn <= to; lsn++) {
        int16_t *samples = cdio_paranoia_read(paranoia, on_event);
        char *err = cdio_cddap_errors(drive);
        if (err) { fprintf(stderr, "drive error: %s\n", err); cdio_cddap_free_messages(err); }
        if (!samples) { fprintf(stderr, "read failed at sector %d\n", lsn); fclose(out); return 1; }
        fwrite(samples, 1, CDIO_CD_FRAMESIZE_RAW, out);
        if (++sectors % 2000 == 0) fprintf(stderr, "  %ld sectors...\n", sectors);
    }
    fclose(out);

    fprintf(stderr, "done: %ld sectors, paranoia events:", sectors);
    for (int f = 0; f < 32; f++)
        if (counts[f]) fprintf(stderr, " %s=%ld", event_name(f), counts[f]);
    fprintf(stderr, "\n");
    cdio_paranoia_free(paranoia);
    cdio_cddap_close(drive);
    return 0;
}

