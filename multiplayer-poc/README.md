# Apex Drive relay and diagnostic page

This Worker hosts the two-player relay diagnostic at the root and serves the game with two-to-six-player rooms at `/play/`. The diagnostic and game use separate room codes. See [multiplayer](../docs/MULTIPLAYER.md) for the independent game build and release workflow.

## Local verification

Use Node 26 and the repository's installed dependencies for the headless test runner. From this directory:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:8788/` to try a pair of clients. The Vite plugin runs Worker code and SQLite Durable Objects in a local workerd process. Local state is in-memory across the dev process lifetime. For the automated expiry fixture, start a second local process:

```sh
npm run dev -- --mode local-expiry --port 8789
```

With both dev processes listening:

```sh
npm run check
npm run build
npm test
./node_modules/.bin/cf deploy --dry-run
```

The test uses the repository's headless Playwright launcher. The main case runs for eight seconds at each rate by default. To run a 30-minute loopback soak, run `APEX_RELAY_SECONDS_PER_RATE=600 npm test`. Loopback verifies the software path. The field pilot below checks real links.

## Architecture and controls

The same-origin page uses HTTPS for create, join and resume, then opens WSS. The Worker forwards admission requests to a SQLite `Directory` object. Each admission gets a unique SQLite `Room` object. The Room enforces two seats, accepts hibernatable sockets and forwards validated JSON pose, quaternion, velocity and timestamp frames directly to the peer. Snapshots are transient. The Directory is used for admission and cleanup, outside the motion path.

The browser keeps the resume token in memory. A 30-second one-time WebSocket ticket travels in the subprotocol offer. The socket URL contains only the opaque room ID. The room code is shared privately. Reports exclude codes, socket tickets, tokens, room IDs and IP addresses. Reloading the page loses its resume token. The room reserves a disconnected seat for 45 seconds after detecting the connection loss. A dedicated alarm closes expired rooms, clears their state and releases their directory entries. The Directory retains a small rolling usage ledger for budgeting.

Admission requires a same-origin request and is limited at the edge to approximately 45 requests per source per minute per Cloudflare location. The Directory limits active rooms to three and caps admissions to 120 and reserved room time to five hours per rolling 24 hours. The hard room lifetime is 75 minutes. An unclaimed first seat expires after 30 seconds. A socket allows 20 pose messages per second with a bounded burst, one diagnostic control message per second, and 1,024 bytes per frame. The sender skips poses under local backpressure. The relay stops adding poses to a receiver after 32 deliveries await acknowledgment. Client reconnect attempts back off and stop after a finite window. The platform's shared Free limits remain the final cost boundary.

## Proposed Cloudflare resources

| Setting | Value |
|---|---|
| Worker | `apex-drive-network-poc` |
| URL | `https://apex-drive-network-poc.<existing-account-subdomain>.workers.dev/` |
| Plan | Workers Free |
| Durable Object exports | `Room` and `Directory`, both SQLite, same Worker |
| Directory object | `phase-1-admission` |
| Rate-limit binding | `ADMISSION_RATE`, namespace `27182501`, 45 requests per 60 seconds |
| Runtime | Compatibility date `2026-11-25`, default placement |
| Routes | workers.dev and bundled static files, previews disabled |
| Other resources | Worker observability disabled for the pilot. No app secrets, custom domains, cron, TURN, D1, KV or Netlify changes. |

The config is in `cloudflare.config.ts`. The local expiry binding is false in the normal build.

### Commands after explicit approval

Use an existing Workers Free account with an existing account workers.dev subdomain. Use an account identity already authorized to create and delete Workers, or an existing API token scoped to the chosen account with **Workers Scripts Write**. The Workers product-level **Admin** role includes creation and deletion if the account uses the newer scoped roles. There is no separate Durable Objects role for this deployment. No zone permissions are needed. If sign-in is needed, the maintainer completes it in their own terminal, and credentials stay there. [Cloudflare CLI authentication](https://developers.cloudflare.com/cf/get-started/), [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/), [Durable Objects authorization](https://developers.cloudflare.com/workers/authorization/durable-objects/)

Set `CLOUDFLARE_ACCOUNT_ID` to the chosen account in that terminal. These commands use the installed, pinned cf CLI:

```sh
./node_modules/.bin/cf auth login --no-browser --scopes account:read workers:write
./node_modules/.bin/cf workers get apex-drive-network-poc
./node_modules/.bin/cf deploy --dry-run
./node_modules/.bin/cf deploy
```

Use the login line only if an existing credential is unavailable. Proceed after the Worker lookup confirms the name is unused. Stop on a name collision, ambiguous lookup, a missing account subdomain or a paid-plan prompt. Use the URL printed by deployment and confirm that `/api/health` returns HTTP 200 and protocol `apex-poc.v1`. [Cloudflare deployment documentation](https://developers.cloudflare.com/cf/projects/#deploy)

For teardown after the pilot, leave the test rooms and preview deletion before deleting the named Worker and its owned deployment and Durable Object resources. Check that the endpoint has gone and that the two namespaces no longer appear. Keep the account-level subdomain. If the API reports unexpected references, stop before forcing deletion. [Cloudflare Worker delete API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/delete/)

```sh
./node_modules/.bin/cf workers delete apex-drive-network-poc --dry-run
./node_modules/.bin/cf workers delete apex-drive-network-poc
./node_modules/.bin/cf durable-objects namespaces list
```

### Estimated usage

Two active clients send `2 × rate × 3,600` snapshots per hour. Each is relayed once. Budget 256 bytes per client upload and 272 per peer delivery for these synthetic JSON frames before transport overhead.

| Send rate | Inbound and outbound frames, each | DO snapshot request equivalents | Egress payload per room-hour |
|---:|---:|---:|---:|
| 10 Hz | 72,000 | 3,600 | 19.6 MB |
| 15 Hz | 108,000 | 5,400 | 29.4 MB |
| 20 Hz | 144,000 | 7,200 | 39.2 MB |

Allow roughly 180 additional request equivalents per room-hour for two browser pings every two seconds, plus nonstreaming traffic for upgrades, admission and alarms. Five room-hours at 20 Hz for two diagnostic clients use about 36,900 request equivalents including pings. Five hours with six game clients at 15 Hz use about 89,100 equivalents including pings and timing updates, before HTTP/RPC and alarm traffic. Five continuously active hours at 128 MB use about 2,304 GB-s. Cloudflare Free allows 100,000 DO request equivalents, 13,000 GB-s, 5 million row reads and 100,000 row writes per day. The Worker has a separate 100,000 daily request limit. Clean room lifecycles add roughly tens of storage operations and no snapshot writes. Actual billing, overhead and hibernation behavior must be measured in the deployed pilot. A platform quota error can interrupt the pilot, especially if usage is shared with other Workers. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Cross-network field pilot

1. Use two separate devices on independent connections. Start with mainland fixed broadband and a cellular ISP, with no shared Wi-Fi. Repeat mainland-to-mainland across carriers and mainland-to-overseas if both are intended use cases. Record the country/region, provider, connection type, browser and local testing time. Do not include public IP addresses in the shared report.
2. On both devices, resolve the deployed hostname with `nslookup <hostname>` and note success, failure or timeout. Check HTTPS with the browser's **Check HTTPS** button or run the following command. On Windows use `curl.exe` and replace `/dev/null` with `NUL`. Record HTTPS and WebSocket failures separately. Independently check the existing game and its two car assets on the same networks if you are evaluating the eventual frontend path.

   ```sh
   curl -sS --max-time 10 -o /dev/null -w 'HTTP %{http_code} DNS %{time_namelookup}s TLS %{time_appconnect}s total %{time_total}s\n' https://<hostname>/api/health
   ```
3. Open the identical Worker URL. A clicks **Create room** and sends the invite code privately. B enters it and clicks **Join room**. Both pages must show **2 online** and updating peer position, orientation and velocity. Run ten create/join attempts per required pairing, five with each device as creator. Both players click **Leave room** before the next attempt. Keep trying slowly enough to avoid the admission limiter. Record each success or failure, including trials where the page itself did not load.
4. In a fresh room, click **Reset measurements** on both devices. Keep the test page foregrounded on both and disable device sleep temporarily. Set both clients to **15 Hz for 10 minutes**, then **10 Hz for 10 minutes**, then **20 Hz for 10 minutes**, all over the same sockets. Keep the pages open for at least 30 minutes of exchange, and note any unexpected interruptions. Each page records how it receives the other client's stream.
5. After the uninterrupted test, click **Test reconnect** on A and confirm the same player slot and resumed data on both pages. Then turn off B's connection for about ten seconds and restore it without reloading. Confirm the same seat is recovered and snapshots resume. Download JSON from both devices. Share the aggregate reports with the network notes, using the hostnames and ISP labels only.
6. Preliminary pilot targets are at least **9 of 10 successful joins per required pair**, **p95 RTT below 250 ms** and **less than 1% stale receipt time** during the steady portions. The local metric treats time after three nominal intervals without a snapshot as stale. Reconnect downtime is reported separately, so account for it when reviewing stability. Review p50 and p95 intervals, p95 jitter, gap counts, missing sequences and reconnect time. The previous countdown-skew target is a later gameplay milestone.

Browser timing and TCP head-of-line blocking can affect delivery under load. The synthetic test measures the relay and browser scheduling path. Vehicle rendering, synchronized race starts and mainland reachability require their own experiments.
