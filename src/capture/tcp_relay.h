#ifndef TCP_RELAY_H
#define TCP_RELAY_H

#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    int listen_fd;
    int client_fd; // single client (ai-pyramid)
    pthread_mutex_t mu;
    bool active;
    pthread_t accept_thread;
} TcpRelay;

// Create relay server (bind + listen, non-blocking accept)
TcpRelay* tcp_relay_create(int port);

// Destroy relay server
void tcp_relay_destroy(TcpRelay* r);

// Send frame data to connected client (non-blocking)
// Called from encoder_thread worker — must not block encoding
void tcp_relay_send(TcpRelay* r, const void* data, uint32_t size);

#endif // TCP_RELAY_H
