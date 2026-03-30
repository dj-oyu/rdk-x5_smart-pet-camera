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

// Check if current client has sent FIN (CLOSE-WAIT). Must be called with mu held.
static void check_client_alive(TcpRelay* r) {
    if (r->client_fd < 0) {
        return;
    }
    struct pollfd pfd = {.fd = r->client_fd, .events = POLLIN | POLLHUP};
    if (poll(&pfd, 1, 0) > 0 && (pfd.revents & (POLLIN | POLLHUP))) {
        char buf[1];
        ssize_t n = recv(r->client_fd, buf, sizeof(buf), MSG_DONTWAIT);
        if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
            LOG_INFO("TcpRelay", "Client closed connection (CLOSE-WAIT cleared)");
            close(r->client_fd);
            r->client_fd = -1;
        }
    }
}

// Background thread: accept new connections and clean up stale ones.
// Runs independently of the encoder so connections are accepted even when
// the night camera is not encoding (day mode, startup, etc.).
static void* accept_thread_fn(void* arg) {
    TcpRelay* r = (TcpRelay*)arg;
    while (r->active) {
        // Poll listen_fd for an incoming connection (100 ms timeout)
        struct pollfd pfd = {.fd = r->listen_fd, .events = POLLIN};
        int ret = poll(&pfd, 1, 100);

        pthread_mutex_lock(&r->mu);

        // Clean up stale CLOSE-WAIT on current client
        check_client_alive(r);

        if (ret > 0 && (pfd.revents & POLLIN)) {
            int cfd = accept(r->listen_fd, NULL, NULL);
            if (cfd >= 0) {
                if (r->client_fd >= 0) {
                    // Already have a client; reject the new one
                    LOG_INFO("TcpRelay", "Rejecting extra client (fd=%d, already have fd=%d)",
                             cfd, r->client_fd);
                    close(cfd);
                } else {
                    int opt = 1;
                    setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt));
                    fcntl(cfd, F_SETFL, fcntl(cfd, F_GETFL) | O_NONBLOCK);
                    r->client_fd = cfd;
                    LOG_INFO("TcpRelay", "Client connected (fd=%d)", cfd);
                }
            }
        }

        pthread_mutex_unlock(&r->mu);
    }
    return NULL;
}

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

    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0 || listen(fd, 4) < 0) {
        close(fd);
        return NULL;
    }

    TcpRelay* r = calloc(1, sizeof(TcpRelay));
    r->listen_fd = fd;
    r->client_fd = -1;
    pthread_mutex_init(&r->mu, NULL);
    r->active = true;

    pthread_create(&r->accept_thread, NULL, accept_thread_fn, r);

    LOG_INFO("TcpRelay", "Listening on port %d", port);
    return r;
}

void tcp_relay_destroy(TcpRelay* r) {
    if (!r) {
        return;
    }
    r->active = false;
    // Wake up the accept thread's poll() by closing listen_fd first
    if (r->listen_fd >= 0) {
        close(r->listen_fd);
        r->listen_fd = -1;
    }
    pthread_join(r->accept_thread, NULL);
    if (r->client_fd >= 0) {
        close(r->client_fd);
    }
    pthread_mutex_destroy(&r->mu);
    free(r);
}

void tcp_relay_send(TcpRelay* r, const void* data, uint32_t size) {
    if (!r || !r->active || !data || size == 0) {
        return;
    }

    pthread_mutex_lock(&r->mu);

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
