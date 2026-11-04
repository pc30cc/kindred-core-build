#!/usr/bin/env python3
"""WebYar's Iran relay: check it the way a caller's phone uses it (README.md next to this).

It allocates on the relay with a time-limited credential minted the way the
backend mints them (coturn's use-auth-secret, RFC 7635 style, as
server/services/calls/turnAuth.ts does), asks for permission to LiveKit, sends
STUN Binding requests to LiveKit through the relay and reads the answers, then
checks that a peer that is not LiveKit is refused, so nobody can use the relay
as an open one.

    TURN_SECRET_FILE=/root/webyar-turn-ir/secret python3 turn_probe.py 185.213.167.216 3478 udp
    TURN_SECRET_FILE=/root/webyar-turn-ir/secret python3 turn_probe.py 185.213.167.216 3478 tcp

Settings (environment):
  TURN_SECRET_FILE  file holding the relay's shared secret (required). It is
                    read, never printed; neither is the password made from it.
  PEER_IP           the peer the relay must reach (default 5.39.70.213, LiveKit)
  PEER_PORT         where on it a plain STUN Binding is answered (default 3478,
                    LiveKit's own TURN). LiveKit's media ports (50000-50100)
                    answer STUN only inside a call's ICE session, and a TURN
                    permission is for the address, not the port, so this
                    proves the path, not LiveKit's firewall for that range.
  DENIED_PEER       a peer the relay must refuse (default 1.1.1.1)
  PINGS             Binding requests sent through the relay (default 5)

Exit status 0 when every check passes, 1 when one fails, 2 on bad usage.
Standard library only, so it runs as it is on any of the servers.
"""
import base64
import hashlib
import hmac
import os
import secrets
import socket
import statistics
import struct
import sys
import time
import zlib

MAGIC = 0x2112A442

# Methods (RFC 5389, RFC 5766).
BINDING = 0x001
ALLOCATE = 0x003
REFRESH = 0x004
SEND = 0x006
DATA = 0x007
CREATE_PERMISSION = 0x008

# Classes.
REQUEST, INDICATION, SUCCESS, ERROR = 0, 1, 2, 3

# Attributes.
MAPPED_ADDRESS = 0x0001
USERNAME = 0x0006
MESSAGE_INTEGRITY = 0x0008
ERROR_CODE = 0x0009
LIFETIME = 0x000D
XOR_PEER_ADDRESS = 0x0012
DATA_ATTR = 0x0013
REALM = 0x0014
NONCE = 0x0015
XOR_RELAYED_ADDRESS = 0x0016
REQUESTED_TRANSPORT = 0x0019
XOR_MAPPED_ADDRESS = 0x0020
FINGERPRINT = 0x8028

UDP_PROTOCOL = 17
CREDENTIAL_TTL_SECONDS = 600


class ProbeError(Exception):
    pass


def msg_type(method, cls):
    return ((method & 0xF80) << 2) | ((method & 0x070) << 1) | (method & 0x00F) \
        | ((cls & 0x2) << 7) | ((cls & 0x1) << 4)


def split_type(t):
    method = (t & 0x000F) | ((t >> 1) & 0x0070) | ((t >> 2) & 0x0F80)
    cls = ((t >> 4) & 0x1) | ((t >> 7) & 0x2)
    return method, cls


def attr(kind, value):
    return struct.pack('!HH', kind, len(value)) + value + b'\0' * ((-len(value)) % 4)


def build(method, cls, txid, attrs, key=None):
    """A STUN message; MESSAGE-INTEGRITY when a key is given, FINGERPRINT always."""
    t = msg_type(method, cls)
    body = b''.join(attrs)
    if key is not None:
        # The length in the header covers the message up to and including
        # MESSAGE-INTEGRITY while it is computed (RFC 5389 §15.4).
        head = struct.pack('!HHI', t, len(body) + 24, MAGIC) + txid
        body += attr(MESSAGE_INTEGRITY, hmac.new(key, head + body, hashlib.sha1).digest())
    head = struct.pack('!HHI', t, len(body) + 8, MAGIC) + txid
    crc = (zlib.crc32(head + body) ^ 0x5354554E) & 0xFFFFFFFF
    body += attr(FINGERPRINT, struct.pack('!I', crc))
    return struct.pack('!HHI', t, len(body), MAGIC) + txid + body


class Message:
    def __init__(self, method, cls, txid, attrs):
        self.method = method
        self.cls = cls
        self.txid = txid
        self.attrs = attrs

    def error(self):
        """(code, reason) of an error response, else None."""
        value = self.attrs.get(ERROR_CODE)
        if self.cls != ERROR or value is None or len(value) < 4:
            return None
        return (value[2] & 0x7) * 100 + value[3], value[4:].decode('utf-8', 'replace').strip()


def parse(data):
    """A STUN message, or None for anything else (ChannelData, noise)."""
    if len(data) < 20:
        return None
    t, length, magic = struct.unpack('!HHI', data[:8])
    if magic != MAGIC or t & 0xC000 or len(data) < 20 + length:
        return None
    method, cls = split_type(t)
    txid = data[8:20]
    attrs = {}
    i, end = 20, 20 + length
    while i + 4 <= end:
        kind, size = struct.unpack('!HH', data[i:i + 4])
        attrs.setdefault(kind, data[i + 4:i + 4 + size])
        i += 4 + size + ((-size) % 4)
    return Message(method, cls, txid, attrs)


def xor_address(ip, port, txid):
    try:
        raw, family = socket.inet_pton(socket.AF_INET, ip), 1
        mask = struct.pack('!I', MAGIC)
    except OSError:
        raw, family = socket.inet_pton(socket.AF_INET6, ip), 2
        mask = struct.pack('!I', MAGIC) + txid
    xored = bytes(a ^ b for a, b in zip(raw, mask))
    return struct.pack('!BBH', 0, family, port ^ (MAGIC >> 16)) + xored


def read_xor_address(value, txid):
    if value is None or len(value) < 8:
        return None
    family = value[1]
    port = struct.unpack('!H', value[2:4])[0] ^ (MAGIC >> 16)
    if family == 1:
        raw = bytes(a ^ b for a, b in zip(value[4:8], struct.pack('!I', MAGIC)))
        return socket.inet_ntop(socket.AF_INET, raw), port
    if family == 2 and len(value) >= 20:
        raw = bytes(a ^ b for a, b in zip(value[4:20], struct.pack('!I', MAGIC) + txid))
        return socket.inet_ntop(socket.AF_INET6, raw), port
    return None


def read_plain_address(value):
    if value is None or len(value) < 8:
        return None
    port = struct.unpack('!H', value[2:4])[0]
    if value[1] == 1:
        return socket.inet_ntop(socket.AF_INET, value[4:8]), port
    if value[1] == 2 and len(value) >= 20:
        return socket.inet_ntop(socket.AF_INET6, value[4:20]), port
    return None


def show(address):
    ip, port = address
    return ('[%s]:%d' if ':' in ip else '%s:%d') % (ip, port)


class Transport:
    """One connection to the relay: a connected UDP socket, or TCP with STUN framing."""

    def __init__(self, host, port, proto):
        self.tcp = proto == 'tcp'
        kind = socket.SOCK_STREAM if self.tcp else socket.SOCK_DGRAM
        try:
            family, _, _, _, address = socket.getaddrinfo(host, port, 0, kind)[0]
            self.sock = socket.socket(family, kind)
            self.sock.settimeout(8)
            self.sock.connect(address)
        except OSError as err:
            raise ProbeError('cannot reach %s:%d over %s: %s' % (host, port, proto, err))
        self.buf = b''

    def send(self, data):
        try:
            self.sock.sendall(data)
        except OSError as err:
            raise ProbeError('send failed: %s' % err)

    def recv(self, deadline):
        """The next STUN message from the relay, or None once the deadline passes."""
        while True:
            if self.tcp:
                framed = self._next_frame()
                if framed is not None:
                    msg = parse(framed)
                    if msg is not None:
                        return msg
                    continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.sock.settimeout(remaining)
            try:
                data = self.sock.recv(65536)
            except socket.timeout:
                return None
            except ConnectionRefusedError:
                # A connected UDP socket reports the ICMP "port unreachable" here.
                raise ProbeError('the relay refused the connection (nothing listens on that port, or a firewall rejects it)')
            except OSError as err:
                raise ProbeError('receive failed: %s' % err)
            if self.tcp:
                if not data:
                    raise ProbeError('the relay closed the TCP connection')
                self.buf += data
                continue
            msg = parse(data)
            if msg is not None:
                return msg

    def _next_frame(self):
        if len(self.buf) < 4:
            return None
        length = struct.unpack('!H', self.buf[2:4])[0]
        if 0x40 <= self.buf[0] <= 0x7F:
            # ChannelData: padded to 4 bytes over TCP (RFC 5766 §11.5). Not
            # used here (no channel is bound), but it must not break framing.
            size = 4 + length + ((-length) % 4)
        else:
            size = 20 + length
        if len(self.buf) < size:
            return None
        frame, self.buf = self.buf[:size], self.buf[size:]
        return frame

    def transact(self, method, attrs, key=None):
        """A request and its answer (matched by transaction id), or None when none came."""
        txid = os.urandom(12)
        data = build(method, REQUEST, txid, attrs, key)
        # UDP retransmits with a doubling wait (RFC 5389 §7.2.1); TCP sends once.
        waits = (8.0,) if self.tcp else (0.5, 1.0, 2.0, 4.0)
        for wait in waits:
            self.send(data)
            deadline = time.monotonic() + wait
            while True:
                msg = self.recv(deadline)
                if msg is None:
                    break
                if msg.txid == txid and msg.cls in (SUCCESS, ERROR):
                    return msg
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Session:
    """An allocation on the relay under one minted credential."""

    def __init__(self, transport, secret):
        self.t = transport
        # Minted as turnAuth.ts does: `<expiry>:<sub>`, password the base64
        # HMAC-SHA1 of it under the shared secret. The sub names the probe in
        # the relay's log, as nothing about a call or a member names a token.
        expiry = int(time.time()) + CREDENTIAL_TTL_SECONDS
        self.username = ('%d:probe%s' % (expiry, secrets.token_hex(4))).encode()
        self.password = base64.b64encode(hmac.new(secret, self.username, hashlib.sha1).digest())
        self.realm = None
        self.nonce = None
        self.key = None

    def _auth_attrs(self):
        return [attr(USERNAME, self.username), attr(REALM, self.realm), attr(NONCE, self.nonce)]

    def request(self, method, attrs):
        """An authenticated request; a stale nonce (438) is renewed once."""
        msg = None
        for _ in range(2):
            msg = self.t.transact(method, attrs + self._auth_attrs(), self.key)
            if msg is None:
                return None
            err = msg.error()
            if err and err[0] == 438 and NONCE in msg.attrs:
                self.nonce = msg.attrs[NONCE]
                continue
            return msg
        return msg

    def allocate(self):
        transport = [attr(REQUESTED_TRANSPORT, struct.pack('!B3x', UDP_PROTOCOL))]
        first = self.t.transact(ALLOCATE, transport)
        if first is None:
            raise ProbeError('allocate: no answer from the relay')
        if first.cls == SUCCESS:
            raise ProbeError('allocate: accepted WITHOUT credentials, the relay is open (use-auth-secret missing)')
        err = first.error()
        if not err or err[0] != 401 or REALM not in first.attrs or NONCE not in first.attrs:
            raise ProbeError('allocate: unexpected answer %s' % (err,))
        self.realm = first.attrs[REALM]
        self.nonce = first.attrs[NONCE]
        # Long-term credential key (RFC 5389 §15.4): MD5(username:realm:password).
        self.key = hashlib.md5(self.username + b':' + self.realm + b':' + self.password).digest()
        msg = self.request(ALLOCATE, transport)
        if msg is None:
            raise ProbeError('allocate: no answer to the signed request')
        err = msg.error()
        if err:
            hint = ''
            if err[0] == 401:
                hint = ' (the secret is not the relay\'s, or this clock and the relay\'s are far apart)'
            elif err[0] == 486:
                hint = ' (the relay\'s total-quota, or user-quota for this username, is reached)'
            elif err[0] == 508:
                hint = ' (the relay has no relay port left)'
            raise ProbeError('allocate FAILED: %d %s%s' % (err[0], err[1], hint))
        relayed = read_xor_address(msg.attrs.get(XOR_RELAYED_ADDRESS), msg.txid)
        mapped = read_xor_address(msg.attrs.get(XOR_MAPPED_ADDRESS), msg.txid)
        lifetime = msg.attrs.get(LIFETIME)
        if relayed is None:
            raise ProbeError('allocate: the answer has no relayed address')
        return relayed, mapped, struct.unpack('!I', lifetime)[0] if lifetime and len(lifetime) == 4 else None

    def permission(self, ip):
        """None when granted, else the error (code, reason)."""
        # IPv4 only: an IPv6 XOR-PEER-ADDRESS is masked with the request's own
        # transaction id, which transact() makes, and LiveKit's node is IPv4.
        if ':' in ip:
            raise ProbeError('only IPv4 peers are checked (%s)' % ip)
        msg = self.request(CREATE_PERMISSION, [attr(XOR_PEER_ADDRESS, xor_address(ip, 0, b''))])
        if msg is None:
            return (0, 'no answer')
        return msg.error()

    def ping(self, ip, port, wait=2.0):
        """A STUN Binding to the peer through the relay: (rtt seconds, address it saw) or None."""
        inner_txid = os.urandom(12)
        inner = build(BINDING, REQUEST, inner_txid, [])
        send_txid = os.urandom(12)
        # A Send indication carries no credentials (RFC 5766 §10): the
        # permission is what lets it out.
        self.t.send(build(SEND, INDICATION, send_txid, [
            attr(XOR_PEER_ADDRESS, xor_address(ip, port, send_txid)),
            attr(DATA_ATTR, inner),
        ]))
        started = time.monotonic()
        deadline = started + wait
        while True:
            msg = self.t.recv(deadline)
            if msg is None:
                return None
            if msg.method != DATA or msg.cls != INDICATION:
                continue
            peer = read_xor_address(msg.attrs.get(XOR_PEER_ADDRESS), msg.txid)
            answer = parse(msg.attrs.get(DATA_ATTR) or b'')
            if peer is None or peer[0] != ip or answer is None or answer.txid != inner_txid:
                continue
            rtt = time.monotonic() - started
            seen = read_xor_address(answer.attrs.get(XOR_MAPPED_ADDRESS), answer.txid) \
                or read_plain_address(answer.attrs.get(MAPPED_ADDRESS))
            return rtt, seen

    def release(self):
        # Best effort: a lifetime of 0 frees the allocation now rather than
        # after its lifetime, so probes do not eat into the relay's quota.
        try:
            self.request(REFRESH, [attr(LIFETIME, struct.pack('!I', 0))])
        except ProbeError:
            pass


def env_int(name, default):
    value = os.environ.get(name, '').strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        raise ProbeError('%s must be a number' % name)


def read_secret(path):
    if not path:
        raise ProbeError('set TURN_SECRET_FILE to the file holding the relay\'s shared secret')
    try:
        with open(path, 'rb') as handle:
            mode = os.fstat(handle.fileno()).st_mode
            raw = handle.read()
    except OSError as err:
        raise ProbeError('cannot read TURN_SECRET_FILE: %s' % err)
    if mode & 0o077:
        print('warning: %s can be read by more than its owner (chmod 600 it)' % path, file=sys.stderr)
    # configure.sh writes the file's content into coturn's config with CR and
    # LF removed; the same here, so both sides use the same bytes.
    secret = raw.replace(b'\r', b'').replace(b'\n', b'')
    if not secret:
        raise ProbeError('TURN_SECRET_FILE is empty')
    return secret


def main(argv):
    if len(argv) != 4 or argv[3] not in ('udp', 'tcp'):
        print('usage: TURN_SECRET_FILE=<file> %s <relay host> <port> udp|tcp' % os.path.basename(argv[0]), file=sys.stderr)
        return 2
    host, proto = argv[1], argv[3]
    try:
        port = int(argv[2])
    except ValueError:
        print('the port must be a number', file=sys.stderr)
        return 2

    ok = True
    transport = None
    try:
        secret = read_secret(os.environ.get('TURN_SECRET_FILE', '').strip())
        peer_ip = os.environ.get('PEER_IP', '').strip() or '5.39.70.213'
        peer_port = env_int('PEER_PORT', 3478)
        denied = os.environ.get('DENIED_PEER', '').strip() or '1.1.1.1'
        pings = max(1, env_int('PINGS', 5))

        transport = Transport(host, port, proto)
        session = Session(transport, secret)
        del secret

        relayed, mapped, lifetime = session.allocate()
        print('allocate ok: relayed address %s, the relay sees us as %s, lifetime %s s' % (
            show(relayed), show(mapped) if mapped else '?', lifetime if lifetime is not None else '?'))

        err = session.permission(peer_ip)
        if err:
            ok = False
            print('permission to %s: REFUSED %d %s (is it in configure.sh\'s PEER_IPS?)' % (peer_ip, err[0], err[1]))
        else:
            print('permission to %s: ok' % peer_ip)
            rtts, seen = [], None
            for _ in range(pings):
                got = session.ping(peer_ip, peer_port)
                if got:
                    rtts.append(got[0])
                    seen = got[1] or seen
            if rtts:
                print('%s answered %d/%d (median %d ms), saw us as %s' % (
                    peer_ip, len(rtts), pings, round(statistics.median(rtts) * 1000), show(seen) if seen else '?'))
            else:
                ok = False
                print('%s answered 0/%d on port %d: the relay cannot reach it over UDP' % (peer_ip, pings, peer_port))

        err = session.permission(denied)
        if err and err[0] == 403:
            print('permission to %s (must be refused): REFUSED 403' % denied)
        elif err:
            ok = False
            print('permission to %s (must be refused): unexpected answer %d %s' % (denied, err[0], err[1]))
        else:
            ok = False
            print('permission to %s (must be refused): ACCEPTED, the relay forwards to any peer (denied-peer-ip missing)' % denied)

        session.release()
    except ProbeError as err:
        ok = False
        print(str(err))
    finally:
        if transport is not None:
            transport.close()
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
