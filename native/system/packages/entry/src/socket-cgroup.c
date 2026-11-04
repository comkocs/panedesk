/* Linux inet_diag reports the socket's cgroup, independent of PID ancestry. */
#ifdef __linux__
#include <arpa/inet.h>
#include <errno.h>
#include <linux/inet_diag.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/sock_diag.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static int64_t diag_milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int socket_cgroup_query(int family, const void *source, uint16_t source_port,
                              const void *destination, uint16_t destination_port,
                              uint64_t *id) {
  int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, NETLINK_SOCK_DIAG);
  if (fd < 0) return -1;
  struct {
    struct nlmsghdr header;
    struct inet_diag_req_v2 request;
  } message;
  memset(&message, 0, sizeof(message));
  message.header.nlmsg_len = sizeof(message);
  message.header.nlmsg_type = SOCK_DIAG_BY_FAMILY;
  message.header.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  message.header.nlmsg_seq = 1;
  message.request.sdiag_family = family;
  message.request.sdiag_protocol = IPPROTO_TCP;
  message.request.idiag_states = UINT32_MAX;
  message.request.id.idiag_sport = htons(source_port);
  message.request.id.idiag_dport = htons(destination_port);
  size_t address_size = family == AF_INET ? 4 : 16;
  memcpy(message.request.id.idiag_src, source, address_size);
  memcpy(message.request.id.idiag_dst, destination, address_size);
  message.request.id.idiag_cookie[0] = INET_DIAG_NOCOOKIE;
  message.request.id.idiag_cookie[1] = INET_DIAG_NOCOOKIE;
  struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
  int result = -1;
  if (sendto(fd, &message, sizeof(message), 0, (struct sockaddr *)&kernel, sizeof(kernel)) < 0) goto done;
  int64_t start = diag_milliseconds();
  if (start < 0) goto done;
  /* Bound synchronous admission work even when an unrelated socket table is large. */
  for (unsigned batch = 0; batch < 256; batch++) {
    int64_t remaining = start + 100 - diag_milliseconds();
    if (remaining <= 0 || remaining > 100) goto done;
    struct pollfd ready = { .fd = fd, .events = POLLIN };
    int polled = poll(&ready, 1, (int)remaining);
    if (polled < 0 && errno == EINTR) continue;
    if (polled <= 0) goto done;
    char buffer[32768];
    struct sockaddr_nl sender;
    struct iovec iov = { .iov_base = buffer, .iov_len = sizeof(buffer) };
    struct msghdr incoming = { .msg_name = &sender, .msg_namelen = sizeof(sender), .msg_iov = &iov, .msg_iovlen = 1 };
    ssize_t received = recvmsg(fd, &incoming, 0);
    if (received < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (received <= 0 || (incoming.msg_flags & MSG_TRUNC) || sender.nl_pid != 0) goto done;
    int length = (int)received;
    for (struct nlmsghdr *header = (struct nlmsghdr *)buffer; NLMSG_OK(header, length); header = NLMSG_NEXT(header, length)) {
      if (header->nlmsg_seq != 1 || (header->nlmsg_flags & NLM_F_DUMP_INTR)) goto done;
      if (header->nlmsg_type == NLMSG_ERROR || header->nlmsg_type == NLMSG_DONE) goto done;
      if (header->nlmsg_type != SOCK_DIAG_BY_FAMILY || header->nlmsg_len < NLMSG_LENGTH(sizeof(struct inet_diag_msg))) goto done;
      struct inet_diag_msg *entry = NLMSG_DATA(header);
      if (entry->idiag_family != family || entry->id.idiag_sport != htons(source_port)
          || entry->id.idiag_dport != htons(destination_port)
          || memcmp(entry->id.idiag_src, source, address_size)
          || memcmp(entry->id.idiag_dst, destination, address_size)) continue;
      int attributes = (int)header->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*entry));
      struct rtattr *attribute = (struct rtattr *)((char *)entry + NLMSG_ALIGN(sizeof(*entry)));
      for (; RTA_OK(attribute, attributes); attribute = RTA_NEXT(attribute, attributes)) {
        /* UAPI attribute 21 is beyond the eight request-extension bits. */
        if ((attribute->rta_type & NLA_TYPE_MASK) == INET_DIAG_CGROUP_ID && RTA_PAYLOAD(attribute) == sizeof(*id)) {
          memcpy(id, RTA_DATA(attribute), sizeof(*id));
          if (*id != 0) result = 0;
          goto done;
        }
      }
      goto done;
    }
  }
done:
  close(fd);
  return result;
}

static napi_value query_socket_cgroup(napi_env env, napi_callback_info info) {
  size_t argc = 4, size;
  napi_value argv[4], value;
  char source[INET6_ADDRSTRLEN], destination[INET6_ADDRSTRLEN];
  double source_port, destination_port;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4
      || napi_get_value_string_utf8(env, argv[0], source, sizeof(source), &size) != napi_ok || size >= sizeof(source)
      || napi_get_value_double(env, argv[1], &source_port) != napi_ok
      || napi_get_value_string_utf8(env, argv[2], destination, sizeof(destination), &size) != napi_ok || size >= sizeof(destination)
      || napi_get_value_double(env, argv[3], &destination_port) != napi_ok
      || !(source_port >= 1 && source_port <= 65535) || source_port != (int)source_port
      || !(destination_port >= 0 && destination_port <= 65535) || destination_port != (int)destination_port) {
    napi_throw_type_error(env, NULL, "Expected TCP source and destination addresses and ports");
    return NULL;
  }
  unsigned char src[16], dst[16];
  int family = strchr(source, ':') == NULL ? AF_INET : AF_INET6;
  uint64_t id;
  if (inet_pton(family, source, src) != 1 || inet_pton(family, destination, dst) != 1) {
    napi_throw_type_error(env, NULL, "Expected matching numeric address families");
    return NULL;
  }
  if (socket_cgroup_query(family, src, (uint16_t)source_port, dst, (uint16_t)destination_port, &id) != 0) {
    napi_throw_error(env, "ERR_SOCKET_CGROUP_QUERY", "TCP socket cgroup could not be queried");
    return NULL;
  }
  if (napi_create_bigint_uint64(env, id, &value) != napi_ok) return NULL;
  return value;
}

static napi_value probe_socket_cgroup(napi_env env, napi_callback_info info) {
  (void)info;
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  bool supported = false;
  if (fd >= 0) {
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    socklen_t length = sizeof(address);
    uint32_t destination = 0;
    uint64_t id;
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) == 0 && listen(fd, 1) == 0
        && getsockname(fd, (struct sockaddr *)&address, &length) == 0) {
      supported = socket_cgroup_query(AF_INET, &address.sin_addr, ntohs(address.sin_port), &destination, 0, &id) == 0;
    }
    close(fd);
  }
  napi_value value;
  if (napi_get_boolean(env, supported, &value) != napi_ok) return NULL;
  return value;
}
#endif
