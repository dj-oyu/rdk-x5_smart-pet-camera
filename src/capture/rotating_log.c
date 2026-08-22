/**
 * rotating_log.c - Date-rotated diagnostic log files with bounded retention
 */

#include "rotating_log.h"

#include "logger.h"

#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define VERIFY_INTERVAL_SEC     60 // How often to re-stat the open file
#define OPEN_RETRY_INTERVAL_SEC 60 // Backoff after a failed open

/**
 * Create dir and its parents. Only the leaf is normally missing; the parent
 * is a mount point in the expected deployment.
 */
static int make_dirs(const char* path) {
    char tmp[ROTATING_LOG_DIR_MAX];
    size_t len = strlen(path);
    if (len == 0 || len >= sizeof(tmp)) {
        return -1;
    }
    memcpy(tmp, path, len + 1);
    while (len > 1 && tmp[len - 1] == '/') {
        tmp[--len] = '\0';
    }

    for (char* p = tmp + 1; *p; p++) {
        if (*p != '/') {
            continue;
        }
        *p = '\0';
        if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
            return -1;
        }
        *p = '/';
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
        return -1;
    }
    return 0;
}

/** Days since the epoch for a local date, used for retention comparisons. */
static long days_from_civil(int year, int month, int day) {
    // Howard Hinnant's civil_from_days inverse; valid for the Gregorian calendar.
    year -= month <= 2;
    const long era = (year >= 0 ? year : year - 399) / 400;
    const unsigned yoe = (unsigned)(year - era * 400);
    const unsigned doy = (unsigned)((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1);
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (long)doe - 719468;
}

/** Delete <prefix>-YYYYMMDD.log files older than the retention window. */
static void purge_expired(const rotating_log_t* rl, const struct tm* now) {
    DIR* dir = opendir(rl->dir);
    if (!dir) {
        return;
    }

    const long today = days_from_civil(now->tm_year + 1900, now->tm_mon + 1, now->tm_mday);
    const size_t prefix_len = strlen(rl->prefix);
    struct dirent* ent;

    while ((ent = readdir(dir)) != NULL) {
        // Expect exactly "<prefix>-YYYYMMDD.log"
        if (strncmp(ent->d_name, rl->prefix, prefix_len) != 0 || ent->d_name[prefix_len] != '-') {
            continue;
        }
        const char* stamp = ent->d_name + prefix_len + 1;
        if (strlen(stamp) != 12 || strcmp(stamp + 8, ".log") != 0) {
            continue;
        }
        char buf[9];
        memcpy(buf, stamp, 8);
        buf[8] = '\0';
        for (int i = 0; i < 8; i++) {
            if (buf[i] < '0' || buf[i] > '9') {
                goto next;
            }
        }
        {
            const long stamped = atol(buf);
            const int y = (int)(stamped / 10000);
            const int m = (int)((stamped / 100) % 100);
            const int d = (int)(stamped % 100);
            if (m < 1 || m > 12 || d < 1 || d > 31) {
                goto next;
            }
            // Keep exactly retention_days worth of files, today included.
            if (today - days_from_civil(y, m, d) < (long)rl->retention_days) {
                goto next;
            }
            char path[ROTATING_LOG_DIR_MAX + ROTATING_LOG_PREFIX_MAX + 32];
            snprintf(path, sizeof(path), "%s/%s", rl->dir, ent->d_name);
            if (unlink(path) == 0) {
                LOG_INFO("RotLog", "Removed expired log: %s", ent->d_name);
            }
        }
    next:;
    }
    closedir(dir);
}

/**
 * Ensure a file for the given local date is open. Caller holds rl->mu.
 * Returns true if rl->fp is usable.
 */
static bool ensure_open(rotating_log_t* rl, const struct tm* now, time_t now_sec) {
    const bool date_changed = (rl->open_year != now->tm_year || rl->open_yday != now->tm_yday);

    if (rl->fp && !date_changed) {
        // Periodically confirm the path still refers to our open inode. The
        // daemon previously kept writing into an unlinked inode for weeks:
        // the bytes went nowhere reachable and the space was never reclaimed.
        if (now_sec < rl->next_verify) {
            return true;
        }
        rl->next_verify = now_sec + VERIFY_INTERVAL_SEC;

        char path[ROTATING_LOG_DIR_MAX + ROTATING_LOG_PREFIX_MAX + 32];
        snprintf(path, sizeof(path), "%s/%s-%04d%02d%02d.log", rl->dir, rl->prefix,
                 now->tm_year + 1900, now->tm_mon + 1, now->tm_mday);
        struct stat st;
        if (stat(path, &st) == 0 && st.st_ino == rl->open_ino) {
            return true;
        }
        LOG_WARN("RotLog", "%s vanished or was replaced; re-opening", path);
        fclose(rl->fp);
        rl->fp = NULL;
    }

    if (rl->fp) {
        fclose(rl->fp);
        rl->fp = NULL;
    }

    if (now_sec < rl->next_open_retry) {
        return false;
    }

    if (make_dirs(rl->dir) != 0) {
        LOG_ERROR("RotLog", "mkdir %s failed: %s", rl->dir, strerror(errno));
        rl->next_open_retry = now_sec + OPEN_RETRY_INTERVAL_SEC;
        return false;
    }

    char path[ROTATING_LOG_DIR_MAX + ROTATING_LOG_PREFIX_MAX + 32];
    snprintf(path, sizeof(path), "%s/%s-%04d%02d%02d.log", rl->dir, rl->prefix, now->tm_year + 1900,
             now->tm_mon + 1, now->tm_mday);

    FILE* fp = fopen(path, "a");
    if (!fp) {
        LOG_ERROR("RotLog", "fopen %s failed: %s", path, strerror(errno));
        rl->next_open_retry = now_sec + OPEN_RETRY_INTERVAL_SEC;
        return false;
    }
    setvbuf(fp, NULL, _IOLBF, 0);

    struct stat st;
    rl->open_ino = (fstat(fileno(fp), &st) == 0) ? st.st_ino : 0;
    rl->fp = fp;
    rl->open_year = now->tm_year;
    rl->open_yday = now->tm_yday;
    rl->next_verify = now_sec + VERIFY_INTERVAL_SEC;
    rl->next_open_retry = 0;

    purge_expired(rl, now);
    return true;
}

void rotating_log_configure(rotating_log_t* rl, const char* prefix, int retention_days) {
    if (!rl || !prefix) {
        return;
    }
    pthread_mutex_lock(&rl->mu);
    if (!rl->configured) {
        const char* dir = getenv("PET_CAMERA_LOG_DIR");
        if (!dir || dir[0] == '\0') {
            dir = ROTATING_LOG_DEFAULT_DIR;
        }
        snprintf(rl->dir, sizeof(rl->dir), "%s", dir);
        snprintf(rl->prefix, sizeof(rl->prefix), "%s", prefix);
        rl->retention_days = (retention_days > 0) ? retention_days : 1;
        rl->configured = true;
    }
    pthread_mutex_unlock(&rl->mu);
}

void rotating_log_vprintf(rotating_log_t* rl, const char* fmt, va_list args) {
    if (!rl || !fmt || !rl->configured) {
        return;
    }

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm now;
    localtime_r(&ts.tv_sec, &now);

    pthread_mutex_lock(&rl->mu);
    if (ensure_open(rl, &now, ts.tv_sec)) {
        if (vfprintf(rl->fp, fmt, args) < 0) {
            // ENOSPC and friends used to be invisible here.
            LOG_ERROR("RotLog", "write to %s failed: %s", rl->prefix, strerror(errno));
            fclose(rl->fp);
            rl->fp = NULL;
            rl->next_open_retry = ts.tv_sec + OPEN_RETRY_INTERVAL_SEC;
        }
    }
    pthread_mutex_unlock(&rl->mu);
}

void rotating_log_printf(rotating_log_t* rl, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    rotating_log_vprintf(rl, fmt, args);
    va_end(args);
}

void rotating_log_close(rotating_log_t* rl) {
    if (!rl) {
        return;
    }
    pthread_mutex_lock(&rl->mu);
    if (rl->fp) {
        fclose(rl->fp);
        rl->fp = NULL;
    }
    rl->open_year = -1;
    rl->open_yday = -1;
    pthread_mutex_unlock(&rl->mu);
}
