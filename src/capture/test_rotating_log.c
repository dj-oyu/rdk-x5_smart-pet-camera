/**
 * test_rotating_log.c - Unit tests for date rotation and retention
 *
 * Exercises the file-deleting paths against a scratch directory, so the
 * retention window is verified without waiting days or touching the real
 * log directory.
 *
 * Build & run: make test
 */

#include "rotating_log.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                         \
    do {                                                                    \
        g_checks++;                                                         \
        if (!(cond)) {                                                      \
            g_failures++;                                                   \
            fprintf(stderr, "FAIL %s:%d: %s\n", __func__, __LINE__, #cond); \
        }                                                                   \
    } while (0)

#define TEST_DIR "/tmp/rotating_log_test"
#define PREFIX   "probe_test"

static void name_for_age(char* out, size_t n, int days_ago) {
    time_t t = time(NULL) - (time_t)days_ago * 86400;
    struct tm tm;
    localtime_r(&t, &tm);
    snprintf(out, n, TEST_DIR "/" PREFIX "-%04d%02d%02d.log", tm.tm_year + 1900, tm.tm_mon + 1,
             tm.tm_mday);
}

static bool exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0;
}

static void touch(const char* path) {
    FILE* f = fopen(path, "w");
    if (f) {
        fputs("stale\n", f);
        fclose(f);
    }
}

static void cleanup_dir(void) {
    DIR* d = opendir(TEST_DIR);
    if (!d) {
        return;
    }
    struct dirent* e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.') {
            continue;
        }
        char p[512];
        snprintf(p, sizeof(p), TEST_DIR "/%s", e->d_name);
        unlink(p);
    }
    closedir(d);
}

static void test_rotation_creates_dated_file(void) {
    cleanup_dir();
    rotating_log_t rl = ROTATING_LOG_INITIALIZER;
    rotating_log_configure(&rl, PREFIX, 14);
    rotating_log_printf(&rl, "hello %d\n", 42);
    rotating_log_close(&rl);

    char today[512];
    name_for_age(today, sizeof(today), 0);
    CHECK(exists(today));

    FILE* f = fopen(today, "r");
    char line[64] = {0};
    if (f) {
        CHECK(fgets(line, sizeof(line), f) != NULL);
        fclose(f);
    }
    CHECK(strcmp(line, "hello 42\n") == 0);
}

static void test_retention_deletes_only_expired(void) {
    cleanup_dir();

    char expired[512], boundary[512], keep[512], recent[512];
    name_for_age(expired, sizeof(expired), 20);
    name_for_age(boundary, sizeof(boundary), 14); // exactly at the window edge
    name_for_age(keep, sizeof(keep), 13);
    name_for_age(recent, sizeof(recent), 1);
    touch(expired);
    touch(boundary);
    touch(keep);
    touch(recent);

    rotating_log_t rl = ROTATING_LOG_INITIALIZER;
    rotating_log_configure(&rl, PREFIX, 14);
    rotating_log_printf(&rl, "trigger purge\n");
    rotating_log_close(&rl);

    CHECK(!exists(expired));  // 20 days old: gone
    CHECK(!exists(boundary)); // 14 days old: outside a 14-day window
    CHECK(exists(keep));      // 13 days old: retained
    CHECK(exists(recent));    // yesterday: retained
}

static void test_retention_ignores_foreign_files(void) {
    cleanup_dir();

    const char* foreign[] = {
        TEST_DIR "/unrelated.log",           // no prefix
        TEST_DIR "/" PREFIX "-notadate.log", // prefix but unparsable stamp
        TEST_DIR "/" PREFIX "-19700101.txt", // wrong extension
        TEST_DIR "/" PREFIX "-19701301.log", // month 13: not a real date
    };
    for (size_t i = 0; i < sizeof(foreign) / sizeof(foreign[0]); i++) {
        touch(foreign[i]);
    }

    rotating_log_t rl = ROTATING_LOG_INITIALIZER;
    rotating_log_configure(&rl, PREFIX, 14);
    rotating_log_printf(&rl, "trigger purge\n");
    rotating_log_close(&rl);

    for (size_t i = 0; i < sizeof(foreign) / sizeof(foreign[0]); i++) {
        CHECK(exists(foreign[i]));
    }
}

static void test_reopens_after_external_unlink(void) {
    cleanup_dir();
    rotating_log_t rl = ROTATING_LOG_INITIALIZER;
    rotating_log_configure(&rl, PREFIX, 14);
    rotating_log_printf(&rl, "first\n");

    char today[512];
    name_for_age(today, sizeof(today), 0);
    unlink(today); // what happened on the real device, only faster

    // rotating_log_close drops the handle; the next write must recreate the
    // file rather than pour bytes into an unreachable inode.
    rotating_log_close(&rl);
    rotating_log_printf(&rl, "second\n");
    rotating_log_close(&rl);

    CHECK(exists(today));
    FILE* f = fopen(today, "r");
    char line[64] = {0};
    if (f) {
        CHECK(fgets(line, sizeof(line), f) != NULL);
        fclose(f);
    }
    CHECK(strcmp(line, "second\n") == 0);
}

int main(void) {
    setenv("PET_CAMERA_LOG_DIR", TEST_DIR, 1);

    test_rotation_creates_dated_file();
    test_retention_deletes_only_expired();
    test_retention_ignores_foreign_files();
    test_reopens_after_external_unlink();

    cleanup_dir();
    rmdir(TEST_DIR);

    printf("rotating_log tests: %d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
