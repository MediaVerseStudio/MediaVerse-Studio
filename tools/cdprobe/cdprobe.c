/* Read-only hardware probe for the pinned libcdio build. Lists optical drives, shows drive
 * identity and capabilities, prints the audio TOC, and reads 75 sectors (1 second) of the first
 * audio track twice to check that repeated reads agree. It never writes to the drive or disc.
 * Build and run: tools/run-cdprobe.ps1. Not shipped; a development aid for the ripper adapter. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <cdio/cdio.h>
#include <cdio/audio.h>
#include <cdio/device.h>
#include <cdio/disc.h>
#include <cdio/track.h>

#define SECTORS 75
/* Windows SPTI passes often cap one transfer near 64 KB (27 sectors); read in small chunks. */
#define CHUNK 16

static uint32_t crc32_bytes(const unsigned char *data, size_t length) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < length; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

static void print_capabilities(CdIo_t *cdio) {
    cdio_drive_read_cap_t read_cap;
    cdio_drive_write_cap_t write_cap;
    cdio_drive_misc_cap_t misc_cap;
    cdio_get_drive_cap(cdio, &read_cap, &write_cap, &misc_cap);
    printf("  reads CD-DA audio: %s\n", (read_cap & CDIO_DRIVE_CAP_READ_AUDIO) ? "yes" : "no");
    printf("  reads CD-DA via MMC: %s\n", (read_cap & CDIO_DRIVE_CAP_READ_CD_DA) ? "yes" : "no");
    printf("  reads CD-R/CD-RW media: %s / %s\n",
           (read_cap & CDIO_DRIVE_CAP_READ_CD_R) ? "yes" : "no",
           (read_cap & CDIO_DRIVE_CAP_READ_CD_RW) ? "yes" : "no");
    printf("  reports media changes: %s\n",
           (misc_cap & CDIO_DRIVE_CAP_MISC_MEDIA_CHANGED) ? "yes" : "no");
}

static int probe_disc(CdIo_t *cdio) {
    discmode_t mode = cdio_get_discmode(cdio);
    printf("  disc mode: %s\n", discmode2str[mode]);
    track_t first = cdio_get_first_track_num(cdio);
    track_t count = cdio_get_num_tracks(cdio);
    if (first == CDIO_INVALID_TRACK || count == 0) {
        printf("  no readable table of contents (no disc, or not an audio disc)\n");
        return 1;
    }
    printf("  tracks: %d (first %d), leadout LSN %d\n", count, first,
           cdio_get_track_lsn(cdio, CDIO_CDROM_LEADOUT_TRACK));
    track_t first_audio = CDIO_INVALID_TRACK;
    for (track_t t = first; t < first + count; t++) {
        lsn_t start = cdio_get_track_lsn(cdio, t);
        lsn_t end = cdio_get_track_last_lsn(cdio, t);
        int audio = cdio_get_track_format(cdio, t) == TRACK_FORMAT_AUDIO;
        printf("    track %2d  %-5s  LSN %6d - %6d  (%d sectors, %d:%02d)\n", t,
               audio ? "audio" : "data", start, end, end - start + 1,
               (end - start + 1) / 75 / 60, ((end - start + 1) / 75) % 60);
        if (audio && first_audio == CDIO_INVALID_TRACK) first_audio = t;
    }
    if (first_audio == CDIO_INVALID_TRACK) return 0;

    lsn_t start = cdio_get_track_lsn(cdio, first_audio);
    size_t bytes = (size_t)SECTORS * CDIO_CD_FRAMESIZE_RAW;
    unsigned char *a = malloc(bytes), *b = malloc(bytes);
    if (!a || !b) return 1;
    driver_return_code_t ra = DRIVER_OP_SUCCESS, rb = DRIVER_OP_SUCCESS;
    for (int done = 0; done < SECTORS && ra == DRIVER_OP_SUCCESS; done += CHUNK) {
        int n = SECTORS - done < CHUNK ? SECTORS - done : CHUNK;
        ra = cdio_read_audio_sectors(cdio, a + (size_t)done * CDIO_CD_FRAMESIZE_RAW, start + done, n);
    }
    for (int done = 0; done < SECTORS && rb == DRIVER_OP_SUCCESS; done += CHUNK) {
        int n = SECTORS - done < CHUNK ? SECTORS - done : CHUNK;
        rb = cdio_read_audio_sectors(cdio, b + (size_t)done * CDIO_CD_FRAMESIZE_RAW, start + done, n);
    }
    printf("  read %d sectors of track %d at LSN %d in chunks of %d: first=%s second=%s\n", SECTORS,
           first_audio, start, CHUNK, cdio_driver_errmsg(ra), cdio_driver_errmsg(rb));
    if (ra == DRIVER_OP_SUCCESS && rb == DRIVER_OP_SUCCESS) {
        size_t nonzero = 0;
        for (size_t i = 0; i < bytes; i++) nonzero += a[i] != 0;
        printf("  CRC32 first=%08X second=%08X  %s; non-zero bytes: %zu of %zu\n",
               crc32_bytes(a, bytes), crc32_bytes(b, bytes),
               memcmp(a, b, bytes) == 0 ? "reads AGREE" : "reads DIFFER", nonzero, bytes);
    }
    free(a);
    free(b);
    return 0;
}

int main(void) {
    char **devices = cdio_get_devices(DRIVER_DEVICE);
    if (!devices || !devices[0]) {
        printf("No optical drives found.\n");
        return 1;
    }
    int status = 0;
    for (char **device = devices; *device; device++) {
        printf("Drive %s\n", *device);
        CdIo_t *cdio = cdio_open(*device, DRIVER_DEVICE);
        if (!cdio) {
            printf("  could not open\n");
            status = 1;
            continue;
        }
        cdio_hwinfo_t hw;
        if (cdio_get_hwinfo(cdio, &hw))
            printf("  vendor '%s'  model '%s'  revision '%s'\n", hw.psz_vendor, hw.psz_model,
                   hw.psz_revision);
        else
            printf("  hardware info unavailable\n");
        print_capabilities(cdio);
        status |= probe_disc(cdio);
        cdio_destroy(cdio);
    }
    cdio_free_device_list(devices);
    return status;
}

