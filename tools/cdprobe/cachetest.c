/* Development aid: estimates the drive's audio read cache size by timing.
 *
 * Method: read a target sector B (after seeking far away, so it is a cold read), read N further
 * sectors sequentially to push data through the drive's cache, then re-read B and time it. A
 * re-read served from the drive cache returns far faster than a cold read that must wait for the
 * disc. The largest N for which B is still fast approximates the cache size in sectors.
 * libcdio-paranoia assumes 1200 sectors by default; this shows whether that assumption holds.
 *
 * usage: cachetest <device> <base-lsn> <far-lsn-a> <far-lsn-b>
 * Read-only on the drive. Not shipped. Build and run via tools/run-cachetest.ps1. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <windows.h>
#include <cdio/cdio.h>
#include <cdio/audio.h>
#include <cdio/device.h>

#define CHUNK 16
#define TRIALS 3

static double now_ms(void) {
    static LARGE_INTEGER frequency;
    LARGE_INTEGER counter;
    if (!frequency.QuadPart) QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&counter);
    return 1000.0 * (double)counter.QuadPart / (double)frequency.QuadPart;
}

static unsigned char buffer[CHUNK * CDIO_CD_FRAMESIZE_RAW];

static int read_sectors(CdIo_t *cdio, lsn_t lsn, int count) {
    while (count > 0) {
        int n = count < CHUNK ? count : CHUNK;
        if (cdio_read_audio_sectors(cdio, buffer, lsn, n) != DRIVER_OP_SUCCESS) return -1;
        lsn += n;
        count -= n;
    }
    return 0;
}

/* Times a single-sector read. Returns milliseconds, or -1 on error. */
static double timed_read(CdIo_t *cdio, lsn_t lsn) {
    double start = now_ms();
    if (read_sectors(cdio, lsn, 1) != 0) return -1;
    return now_ms() - start;
}

static int cmp_double(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: cachetest <device> <base-lsn> <far-lsn-a> <far-lsn-b>\n");
        return 2;
    }
    CdIo_t *cdio = cdio_open(argv[1], DRIVER_DEVICE);
    if (!cdio) { fprintf(stderr, "could not open %s\n", argv[1]); return 1; }
    lsn_t base = atoi(argv[2]), far_a = atoi(argv[3]), far_b = atoi(argv[4]);

    /* Baseline: cold reads of sectors never touched, each after a long seek away. */
    double cold[8];
    for (int i = 0; i < 8; i++) {
        if (read_sectors(cdio, (i % 2) ? far_a : far_b, 1) != 0) return 1;
        cold[i] = timed_read(cdio, base + 30000 + i * 97);
        if (cold[i] < 0) return 1;
    }
    qsort(cold, 8, sizeof(double), cmp_double);
    double cold_median = cold[4];
    printf("cold read (after a long seek): median %.2f ms, range %.2f-%.2f ms\n", cold_median,
           cold[0], cold[7]);

    /* A cache hit returns in well under a millisecond. Even a short seek back costs several ms, so
       use a small absolute limit (capped by a quarter of the cold median for very fast drives). */
    double threshold = cold_median * 0.25 < 2.0 ? cold_median * 0.25 : 2.0;
    printf("cached threshold: < %.2f ms\n\n", threshold);
    printf("%8s  %10s  %10s  %10s  verdict\n", "between", "trial 1", "trial 2", "trial 3");

    int sizes[] = {0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 96, 128, 256, 1200};
    int last_cached = -1, first_uncached = -1;
    for (size_t s = 0; s < sizeof(sizes) / sizeof(sizes[0]); s++) {
        int between = sizes[s];
        double times[TRIALS];
        int cached = 0;
        for (int t = 0; t < TRIALS; t++) {
            lsn_t target = base + t * 7919; /* different target each trial */
            if (read_sectors(cdio, (t % 2) ? far_a : far_b, 1) != 0) return 1;
            if (read_sectors(cdio, target, 1) != 0) return 1;       /* cold read of B */
            if (between > 0 && read_sectors(cdio, target + 1, between) != 0) return 1;
            times[t] = timed_read(cdio, target);                    /* re-read B */
            if (times[t] < 0) return 1;
            if (times[t] < threshold) cached++;
        }
        const char *verdict = cached >= 2 ? "CACHED" : "not cached";
        printf("%8d  %8.2f ms  %8.2f ms  %8.2f ms  %s\n", between, times[0], times[1], times[2], verdict);
        if (cached >= 2) last_cached = between;
        else if (first_uncached < 0) first_uncached = between;
    }

    printf("\n");
    if (last_cached < 0)
        printf("Result: re-reads were never faster than cold reads; no audio cache detected.\n");
    else if (first_uncached < 0)
        printf("Result: still cached after the largest test (%d sectors); the cache is larger than tested.\n", last_cached);
    else
        printf("Result: cached through %d sectors, not cached at %d sectors. Estimated cache between %d and %d sectors (about %.2f-%.2f MB).\n",
               last_cached, first_uncached, last_cached, first_uncached,
               last_cached * 2352.0 / 1048576.0, first_uncached * 2352.0 / 1048576.0);
    printf("libcdio-paranoia assumes 1200 sectors (about 2.7 MB).\n");
    cdio_destroy(cdio);
    return 0;
}

