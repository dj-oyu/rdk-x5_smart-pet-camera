#include "tcp_relay.h"
#include "logger.h"
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

TcpRelay* tcp_relay_create(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return NULL;
    }

    int opt = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(port),
        .sin_addr.s_addr = INADDR_ANY,
    };

    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0 || listen(fd, 1) < 0) {
        close(fd);
        return NULL;
    }

    // Non-blocking accept
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);

    TcpRelay* r = calloc(1, sizeof(TcpRelay));
    r->listen_fd = fd;
    r->client_fd = -1;
    pthread_mutex_init(&r->mu, NULL);
    r->active = true;

    LOG_INFO("TcpRelay", "Listening on port %d", port);
    return r;
}

void tcp_relay_destroy(TcpRelay* r) {
    if (!r) {
        return;
    }
    r->active = false;
    if (r->client_fd >= 0) {
        close(r->client_fd);
    }
    if (r->listen_fd >= 0) {
        close(r->listen_fd);
    }
    pthread_mutex_destroy(&r->mu);
    free(r);
}

void tcp_relay_send(TcpRelay* r, const void* data, uint32_t size) {
    if (!r || !r->active || !data || size == 0) {
        return;
    }

    pthread_mutex_lock(&r->mu);

    // Try non-blocking accept on each send
    if (r->client_fd < 0) {
        int cfd = accept(r->listen_fd, NULL, NULL);
        if (cfd >= 0) {
            // Disable Nagle for low latency
            int opt = 1;
            setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt));
            // Non-blocking write: drop frame on EAGAIN rather than blocking encoder
            fcntl(cfd, F_SETFL, fcntl(cfd, F_GETFL) | O_NONBLOCK);
            r->client_fd = cfd;
            LOG_INFO("TcpRelay", "Client connected (fd=%d)", cfd);
        }
    }

    if (r->client_fd >= 0) {
        // Non-blocking write — drop frame on EAGAIN/EWOULDBLOCK
        ssize_t written = write(r->client_fd, data, size);
        if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            LOG_INFO("TcpRelay", "Client disconnected: %s", strerror(errno));
            close(r->client_fd);
            r->client_fd = -1;
        }
    }

    pthread_mutex_unlock(&r->mu);
}
