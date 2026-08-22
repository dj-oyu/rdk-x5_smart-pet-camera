/**
 * rotating_log.h - Date-rotated diagnostic log files with bounded retention
 *
 * Infrastructure layer. Diagnostic logs (switch-signal probe, ISP lowlight)
 * are long-lived append streams that used to grow without bound: a single
 * probe log reached 893 MB over ~2.5 months and exhausted the 2 GB /tmp
 * tmpfs. This module gives those streams a daily file and a retention
 * window, and re-opens the file if it is unlinked underneath us.
 *
 * File naming: <dir>/<prefix>-YYYYMMDD.log
 * Retention:   files older than retention_days are removed on each rotation.
 *
 * All entry points are thread-safe.
 */

#ifndef ROTATING_LOG_H
#define ROTATING_LOG_H

#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <sys/types.h>

#define ROTATING_LOG_DIR_MAX    256
#define ROTATING_LOG_PREFIX_MAX 64

/**
 * Default directory for diagnostic logs. Persistent storage, not tmpfs:
 * a retention window measured in days is meaningless on a filesystem that
 * is wiped on reboot, and tmpfs is shared with every other process.
 * Override with the PET_CAMERA_LOG_DIR environment variable.
 */
#define ROTATING_LOG_DEFAULT_DIR "/mnt/petcam-data/logs"

typedef struct {
    char dir[ROTATING_LOG_DIR_MAX];
    char prefix[ROTATING_LOG_PREFIX_MAX];
    int retention_days;

    FILE* fp;
    ino_t open_ino;         // inode of the open file, to detect external unlink
    int open_year;          // tm_year of the open file's date stamp
    int open_yday;          // tm_yday of the open file's date stamp
    time_t next_verify;     // next CLOCK_REALTIME second at which to re-stat
    time_t next_open_retry; // suppress reopen storms while the dir is unusable
    bool configured;
    pthread_mutex_t mu;
} rotating_log_t;

#define ROTATING_LOG_INITIALIZER                                                   \
    {                                                                              \
        .dir = {0}, .prefix = {0}, .retention_days = 0, .fp = NULL, .open_ino = 0, \
        .open_year = -1, .open_yday = -1, .next_verify = 0, .next_open_retry = 0,  \
        .configured = false, .mu = PTHREAD_MUTEX_INITIALIZER                       \
    }

/**
 * Configure a rotating log. Safe to call more than once; the first call wins.
 *
 * @param rl             Log handle (statically initialized with ROTATING_LOG_INITIALIZER)
 * @param prefix         Base file name, e.g. "isp_exposure_probe"
 * @param retention_days Files older than this many days are deleted on rotation
 *
 * The directory comes from $PET_CAMERA_LOG_DIR, falling back to
 * ROTATING_LOG_DEFAULT_DIR. It is created if missing.
 */
void rotating_log_configure(rotating_log_t* rl, const char* prefix, int retention_days);

/** Append one formatted line. A trailing newline is the caller's business. */
void rotating_log_printf(rotating_log_t* rl, const char* fmt, ...)
    __attribute__((format(printf, 2, 3)));

/** va_list variant, for wrapping in a caller's own varargs helper. */
void rotating_log_vprintf(rotating_log_t* rl, const char* fmt, va_list args);

/** Close the current file. The next write re-opens it. */
void rotating_log_close(rotating_log_t* rl);

#endif // ROTATING_LOG_H
