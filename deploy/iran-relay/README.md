# WebYar's Iran relay (TURN)

Since 2026-11-04 (owner), WebYar's calls can carry their audio and video
through a TURN relay on a server inside Iran. WebYar only: RESPOK never lists
it.

## Why

On 2026-11-04 Iranian mobile data (MCI, seen from a Xiaomi on cellular) let
the call's signalling through (it goes through Cloudflare, `wss://rt.webyar.ai`,
`deploy/livekit/README.md` §4.1) but not one media packet to LiveKit abroad:
LiveKit sent 8 ICE checks to the phone and got none back, and nothing from the
phone ever reached it, over UDP or TCP 7881. The phone could not even learn its
public address (no STUN answer), and LiveKit's own TURN (`turn.webyar.ai`, same
IP) was not reachable either. The day before, the same phone on the same SIM
sent UDP straight to LiveKit; with a VPN on it still did. The full trace is in
the knowledge base, `05-reports/2026-11-04-team-calls-media-blocked.md`.

A phone in Iran reaches an Iranian data centre without that filter, and the
data centre reaches LiveKit over UDP (probed: STUN 5/5 answered, about
100 ms). So the relay sits in Iran and forwards to LiveKit:

```
phone (Iran) ──UDP/TCP 3478──▶ relay (Iran) ──UDP──▶ LiveKit 5.39.70.213 (50000-50100)
```

## The server

- Iranian VPS, Desktop Commander device `webyar`
  (`98a609d1-985f-4321-852c-c30fb76bb5e0`), public `185.213.167.216` and
  `2a05:ab80:300:167::bd`, Ubuntu 26.04. It also runs the owner's other
  services (the Enamad viewer, the RESPOK dashboards, domain details): leave
  them alone.
- coturn 4.6.1 from Ubuntu (`apt-get install coturn`), systemd unit `coturn`.
  A drop-in (`/etc/systemd/system/coturn.service.d/10-webyar-ready.conf`)
  keeps the stock unit from starting until `/etc/webyar-turn/ready` exists, so
  it never runs with the package's default config.
- Config: `/etc/turnserver.conf`, written only by `configure.sh` (this
  folder; a copy is in `/root/webyar-turn/` on the server):

  ```sh
  PUBLIC_IP=185.213.167.216 PUBLIC_IP6=2a05:ab80:300:167::bd PEER_IPS="5.39.70.213" /root/webyar-turn/configure.sh
  ```

  It listens on 3478 (UDP and TCP), relays on 49160-49999, uses time-limited
  credentials (`use-auth-secret`), and may send only to `PEER_IPS`: every
  other peer is denied, so nobody can use it as an open relay. No TLS (no
  domain yet). 1 MB/s per session each way, 600 allocations in total.
- Shared secret: `/etc/webyar-turn/secret` (root, 0600), 48 characters. The
  same value is saved in WebYar's Super Admin (below). It was made on
  host.respok.app (`/root/webyar-turn-ir/secret`, 0600) and sent to the relay
  encrypted to a one-time RSA key made on the relay, so it was never shown in
  clear; the one-time key was deleted. Never write it in the repo or the
  knowledge base.
- Logs: `journalctl -u coturn` (simple log, no secrets).

## How a call uses it

WebYar's backend reads `app_runtime_config.call_rtc_endpoints.turn` (Super
Admin → Voice & Video → network). When it holds the relay's URLs and the
shared secret, every call token carries `turn` with credentials minted for that
call (`server/services/calls/turnAuth.ts`: username `<expiry>:<sub>`, password
`base64(HMAC-SHA1(secret, username))`). The web panel, the Android app and the
iPhone app hand those to LiveKit as ICE servers. Phones that can reach LiveKit
directly keep doing so (ICE picks the best path); only a phone that cannot is
relayed.

RESPOK has its own database, so its `call_rtc_endpoints` is untouched.

## Changing it

- **The address** (a new IP, a domain, another port, another server): change
  the URLs in Super Admin. The next call uses them (the backend caches the
  setting for 15 s). On a new server, install coturn, copy the secret, run
  `configure.sh` with its own `PUBLIC_IP`.
- **The secret**: write a new one to `/etc/webyar-turn/secret`, run
  `configure.sh` again (coturn restarts; calls relayed at that moment drop),
  and save the same value in Super Admin.
- **LiveKit moved**: run `configure.sh` with the new `PEER_IPS`, or the relay
  refuses to forward (403).
- **Turn it off**: remove the relay's URLs in Super Admin (the apps then use
  LiveKit's own TURN again). `systemctl disable --now coturn` on the relay.

## Checking it

From host.respok.app (it holds the secret), `/root/webyar-turn-ir/turn_probe.py`
allocates on the relay like a phone would, asks it to send a STUN request to
LiveKit, and checks a denied peer is refused:

```sh
python3 /root/webyar-turn-ir/turn_probe.py 185.213.167.216 3478 udp
python3 /root/webyar-turn-ir/turn_probe.py 185.213.167.216 3478 tcp
```

Expected (2026-11-04): `allocate ok`, `permission to 5.39.70.213: ok`,
`5.39.70.213 answered ... saw us as 185.213.167.216`,
`permission to 1.1.1.1 (must be refused): REFUSED 403`.
