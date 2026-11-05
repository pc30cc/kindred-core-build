# WebYar's Iran relay (TURN)

Since 2026-11-04 (owner), WebYar's calls from Iran can carry their audio and
video through a TURN relay on a server inside Iran. WebYar only: RESPOK never
lists it. Only callers in Iran are given it; everyone else keeps LiveKit's own
TURN.

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
  The drop-in `10-webyar-ready.conf` (this folder), installed as
  `/etc/systemd/system/coturn.service.d/10-webyar-ready.conf` before the
  package, keeps the stock unit from starting until `/etc/webyar-turn/ready`
  exists, so it never runs with the package's default config (the package
  enables and starts it at install).
- Config: `/etc/turnserver.conf`, written only by `configure.sh` (this
  folder; a copy is in `/root/webyar-turn/` on the server):

  ```sh
  PUBLIC_IP=185.213.167.216 PUBLIC_IP6=2a05:ab80:300:167::bd PEER_IPS="5.39.70.213" /root/webyar-turn/configure.sh
  ```

  It listens on 3478 (UDP and TCP), relays on 49160-49999, uses time-limited
  credentials (`use-auth-secret`), and may send only to `PEER_IPS`: every
  other peer is denied, so nobody can use it as an open relay. No TLS (no
  domain yet). 1 MB/s per session each way, 3000 allocations in total (the
  840 relay ports run out first) and 32 per username, that is per call token:
  a credential valid for hours, an anonymous widget visitor's included, can
  then never hold the whole port range, and 32 still leaves room for a phone
  that changes network several times in 10 minutes, the longest an
  allocation nobody refreshes is kept (`max-allocate-lifetime`; `configure.sh`
  says why).
- Shared secret: `/etc/webyar-turn/secret` (root, 0600), 48 characters. The
  same value is saved in WebYar's Super Admin (below), which stores it
  encrypted. It was made on host.respok.app (`/root/webyar-turn-ir/secret`,
  0600) and sent to the relay encrypted to a one-time RSA key made on the
  relay, so it was never shown in clear; the one-time key was deleted. Never
  write it in the repo, the knowledge base or the database by hand.
- Logs: `journalctl -u coturn` (simple log, no secrets; a username is
  `<expiry>:r<random>`, nothing about the call or the member).

A new server, in this order: the drop-in, `apt-get install coturn`, the
secret in `/etc/webyar-turn/secret` (directory 0700, file 0600),
`configure.sh` with its own `PUBLIC_IP`, the firewall (below), the probe,
then the URLs in Super Admin.

## How a call uses it

WebYar's backend reads `app_runtime_config.call_rtc_endpoints.turn`, which
Super Admin → Voice & Video → Channels and recording → RTC and TURN endpoints
writes (`saveRtcEndpoints`, `server/services/calls/rtcResolver.ts`). WebYar's
values (2026-11-04; the TCP URL since 2026-11-05):

- **TURN URLs**: `turn:185.213.167.216:3478?transport=udp` and
  `turn:185.213.167.216:3478?transport=tcp`. The phone tries both and keeps
  UDP when it can. TCP is the way through for a network that lets no UDP
  out: on 2026-11-05 19:02 UTC a phone in Iran on mobile data found no path
  at all (not even its public address) with only the UDP URL listed, though
  the same phone had used the relay on Wi-Fi that morning (knowledge base,
  `05-reports/2026-11-05-mojtaba-mahmod-call.md`). The relay already listens
  on TCP 3478 and the probe checks both. Never LiveKit's
  own TURN (`turn.webyar.ai`): LiveKit gives each participant credentials for
  it over signalling, and a URL here would have none.
- **Shared secret**: the relay's. Stored encrypted under
  `PLUGIN_SECRETS_MASTER_KEY` (`turn.shared_secret_enc`); it never reaches a
  browser or a token body, and the page shows only whether one is set and its
  fingerprint (the first 12 hex digits of its SHA-256).
- **Relay countries**: `IR`. Empty (or `*`) would be everyone, but for the
  call-centre widget and its operator console, which carry the relay only to
  the countries listed by name (below).
- **Credential lifetime**: 6 hours (10 minutes to 24 hours).

Every call token is built by `buildTokenNetworkBundle`
(`server/services/calls/participantToken.ts`): colleague calls, members'
calls, the chat widget's visitor calls and invitations, the call-centre
widget's visitor and its operator console. A caller whose country is listed
gets `turn` with the relay's URLs and a credential minted for that token
(`server/services/calls/turnAuth.ts`): username `<expiry>:r<16 random hex>`,
password `base64(HMAC-SHA1(secret, username))`. Every other caller gets
`turn.urls` empty. The country is the one Cloudflare saw
(`getClientCountry`, `server/utils/clientIp.ts`, believed only from a
Cloudflare hop); an unknown country is not on the list.

The call-centre widget's join token and the operator's accept had no `turn`
before the relay. They carry one only when the countries list names countries
(`IR`; not empty, not `*`), and then only to a caller in them; otherwise they
carry none, which the clients read as `turn.urls` empty. Their callers are
anywhere, and a relay for all of them would take LiveKit's own TURN, its TLS
port among it, from every one (`countryLimited`,
`server/services/calls/participantToken.ts`).

Why the countries: every client that reads `turn` (web panel, Android,
iPhone, the Mac and Windows apps' conversation calls, both widgets) hands a
non-empty `turn.urls` to LiveKit as its ICE servers, and that replaces the
ones LiveKit offers, its own TURN among them; an empty list leaves them
alone. A caller in Turkey given the relay would lose LiveKit's TURN for a
relay that only reaches LiveKit anyway. A caller in Iran cannot reach
LiveKit's TURN, so loses nothing.

The Mac and Windows apps do not read the relay on the call-centre desk yet:
they join a call accepted there with LiveKit's own ICE servers only (their
`CallAccept` has no `turn`; `macos/Webyar/Features/Calls/LiveCall.swift`,
`windows-native/src/Webyar.App/Views/LiveCall.cs`), so an operator in Iran on
a filtered network takes desk calls in the web panel until their next release
reads `turn` from the accept (at the top or in `connect`), as their
conversation calls already do from `POST /api/calls/:id/token`.

Why 6 hours, and not the LiveKit token's lifetime: the clients take the ICE
servers once, when the call starts, and reuse them on every reconnect for the
rest of the call, and coturn refuses a new allocation once the username's
expiry has passed. Until 2026-11-04 the credential followed the token (10
minutes for most tokens, at most an hour), so a call that changed network
after that could not get back through the relay. A call longer than the
lifetime has the same limit, which is why the lifetime is a setting.

ICE still picks the path (`ice_policy` stays `all`): a phone in Iran that can
reach LiveKit directly keeps doing so, and only one that cannot is relayed.
Signalling is unchanged: `ws_url` stays `wss://rt.webyar.ai`.

RESPOK has its own database, and its `call_rtc_endpoints` lists no relay, so
its tokens carry none. A row without the countries gives its URLs to everyone
on the calls that had them before the setting existed (not the call centre's
two answers, above); one without a lifetime mints for 6 hours.

## Changing it

Super Admin → Voice & Video → Channels and recording → RTC and TURN endpoints
is the only place to change the address, the secret, the countries and the
lifetime. Never write `call_rtc_endpoints` by hand: a secret written there is
plain text in the row and in every backup (the generic runtime-config route
refuses the key). Each save is in the audit log with the fields it changed,
never a value. The next call uses it (the backend caches the setting for
15 s).

- **The address** (a new IP, a domain, another port, another server): change
  the URLs. On a new server, set it up as above first and run the probe
  against it.
- **The secret**: at a quiet hour, in both places back to back. Calls relayed
  at that moment drop (coturn restarts), a call started before the change
  cannot reconnect through the relay (its credential is signed with the old
  secret), and a call started between the two steps gets a credential the
  relay refuses.
  1. Make the new one where the old was made and send it to the relay the
     same way (encrypted, never shown in clear); write it to
     `/etc/webyar-turn/secret` and to `/root/webyar-turn-ir/secret` on
     host.respok.app (the probe's copy).
  2. On the relay, run `configure.sh` again.
  3. Paste the same value into Super Admin's Shared secret and save.
  4. Compare the fingerprint Super Admin shows with the relay's:
     `printf %s "$(tr -d '\r\n' < /etc/webyar-turn/secret)" | sha256sum | cut -c1-12`.
  5. Run the probe.
- **Who gets it**: Relay countries. Add a country only when its callers cannot
  reach LiveKit's own TURN either. Emptying it gives the relay to every caller
  but the call centre's (whose two answers then carry none) and takes
  LiveKit's own TURN away from all of them.
- **The lifetime**: longer for calls that run longer, up to 24 hours. A
  credential that leaks is good for that long, but only to reach LiveKit (the
  peer rules), for at most 32 relay ports at once (`user-quota`), and it is
  one token's.
- **LiveKit moved**: run `configure.sh` with the new `PEER_IPS`, or the relay
  refuses to forward (403), and change the firewall rule for the relay ports.
- **Turn it off**: remove the URLs in Super Admin (every caller then uses
  LiveKit's own TURN again), and the secret with its Remove button.
  `systemctl disable --now coturn` on the relay.

## Firewall

On the relay:

- 3478 UDP and TCP inbound from anywhere, IPv4 and IPv6: the callers.
- 49160-49999 UDP inbound only from LiveKit's IP (`5.39.70.213`): LiveKit's
  answers to the relayed ports. coturn already drops what comes from a peer
  without a permission, and the firewall keeps the rest of the internet off
  those ports.
- Outbound UDP to LiveKit's 50000-50100 (the media) and 3478 (the probe's
  STUN check).
- Nothing else: no TLS (5349) until there is a domain, and no TCP relay
  (`no-tcp-relay`).

On host.respok.app, LiveKit's 50000-50100 UDP must be reachable from the
relay (`185.213.167.216`). It is open to everyone today
(`deploy/livekit/README.md`); a rule that narrows it must keep the relay.

## Checking it

`turn_probe.py` (this folder; a copy is in `/root/webyar-turn-ir/` on
host.respok.app, which holds the secret) allocates on the relay like a phone
would, with a credential minted the way the backend mints them, asks for
permission to LiveKit, sends STUN Binding requests to LiveKit through the
relay (to LiveKit's own TURN on 3478, which answers a plain Binding; its media
ports answer only inside a call), and checks a denied peer is refused. It
reads the secret from the file `TURN_SECRET_FILE` names and never prints it,
nor the password made from it:

```sh
TURN_SECRET_FILE=/root/webyar-turn-ir/secret python3 /root/webyar-turn-ir/turn_probe.py 185.213.167.216 3478 udp
TURN_SECRET_FILE=/root/webyar-turn-ir/secret python3 /root/webyar-turn-ir/turn_probe.py 185.213.167.216 3478 tcp
```

Expected (2026-11-04), exit status 0:

```
allocate ok: relayed address 185.213.167.216:<port>, the relay sees us as 5.39.70.213:<port>, lifetime 600 s
permission to 5.39.70.213: ok
5.39.70.213 answered 5/5 (median about 100 ms), saw us as 185.213.167.216:<port>
permission to 1.1.1.1 (must be refused): REFUSED 403
```

`allocate FAILED: 401` means the secret is not the relay's (or the two clocks
are far apart); `REFUSED 403` for LiveKit means `PEER_IPS` does not list it;
`ACCEPTED` for the denied peer means the relay is open. `PEER_IP`,
`PEER_PORT`, `DENIED_PEER` and `PINGS` change what it checks (the file's
header).

## Rollout (2026-11-04)

1. On the relay, at a quiet hour: the drop-in from this folder in place of
   the one there (the same condition), then `configure.sh` from this folder
   again, for the new quotas (coturn restarts). The firewall as above.
2. Merge; WebYar's backend (25) deploys. Until step 3 the calls that had the
   relay on 2026-11-04 (colleague, members' and the chat widget's) give it to
   every caller as they did then (the row has no countries yet), now with a
   6-hour credential; the call-centre widget and its console carry none, as
   then.
3. Super Admin → Voice & Video → Channels and recording → RTC and TURN
   endpoints: Relay countries `IR`, lifetime 6 hours, save. That save also
   encrypts the secret written into the row by hand on 2026-11-04 (the audit
   line names `turn.shared_secret_encrypted`). Compare the fingerprint with
   the relay's.
4. The probe, both transports. Then a colleague call from a phone in Iran on
   mobile data, and one from the web panel outside Iran, whose token answer
   (`POST /api/team-calls/:id/token`, in the browser's network panel) must
   have `turn.urls` empty.
