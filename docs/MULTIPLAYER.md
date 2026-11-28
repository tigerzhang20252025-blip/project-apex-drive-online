# Apex Drive multiplayer

[Open the public game](https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/) in a WebGL 2 browser. The Cloudflare Worker serves the frontend and relay from the same origin over HTTPS and WSS.

## Play with friends

1. Open the public game on two to six computers. In the garage, select **Multiplayer**.
2. Enter an optional driver name. One driver selects **Create Room** and shares the private code. Up to five additional drivers enter the code and select **Join Room**. Any driver can choose a Ferrari F40 or Nissan GT-R R35.
3. The host selects **Alpine Proving Ground** or **Pineglass Run 2.0**, then **Free Drive** or the course's **Best Lap / Best Stage Challenge**. Each player presses **Ready** after the course and cars load. **Preparing race…** indicates that the browser is preparing the grid graphics. To change vehicles after readying, select **Unready** first. Once at least two drivers are connected and everyone is ready, the host selects **Start Session**.
4. Wait for the shared lights to go out. The engine starts automatically. Use **WASD** or the arrow keys to drive and **C** or the camera buttons to change views. Color-coded minimap markers track each remote driver. Vehicle collisions with the circuit remain active. Remote players are rendered as shared exterior instances in your scene.
5. **R** resets your car to its own grid lane. On Pineglass, **Recover Vehicle** returns your car to the last verified point on the road. The host can select **End session** to bring all players back to the room. In Challenge mode, forward-cross the start line to begin a timed run. Complete as many valid attempts as you can in ten minutes. The results rank all drivers by best valid time and show splits, independent sector bests and theoretical bests. Any driver can select **Return to Lobby** when the results appear.
6. Use **Leave Room** when done. A connected driver takes over if the host leaves or disconnects. Keep your tab open for automatic reconnection. The server reserves the seat for 45 seconds after detecting the drop. After that, join again with a valid invite if the host has returned to the lobby.

Timing and HUD use the existing checkpoint and sector rules. Online times are client-validated and kept in the room. The challenge clock follows the room schedule while the car is in a menu, reconnecting or in a suspended tab. An interrupted timed lap is invalidated. Rooms expire after 75 minutes.

## Independent-network checks

- Use two devices and independent networks, such as home broadband and another carrier’s cellular connection. For mainland China, repeat on each intended carrier pair and in both directions.
- Resolve `apex-drive-network-poc.tigerzhang0215.workers.dev` with `nslookup`. Request `/api/health` over HTTPS and open `/play/` on both networks. Confirm the models finish loading, the invite works and both drivers see moving opponents.
- Play for at least 30 minutes and note the RTT shown on both screens, any stale opponent, disconnections, jitter and whether a brief connection interruption recovers the same seat. Test at least one short challenge as well as Free Drive. Run ten create/join attempts per required network pair when evaluating reliability. Useful starting targets are nine successes in ten attempts, p95 RTT below 250 ms and under 1% stale receipt time.
- The [relay diagnostic page](https://apex-drive-network-poc.tigerzhang0215.workers.dev/) still supports 10, 15 and 20 Hz and exports RTT and interval statistics. Diagnostic invite codes are separate from game invite codes.

## Cloudflare release

Run `npm ci`, `npm run assets:fetch` and `npm test` in the repo root. The fetcher verifies both vehicle models against the project's checksums. Then build and check the paired frontend and relay from `multiplayer-poc/`.

```sh
npm ci
npm run check
npm run build:pilot
./node_modules/.bin/cf deploy --prebuilt --no-provision --dry-run
```

The Worker bundle stages the game and vehicle assets under `/play/` and retains the diagnostic page at the root. Confirm that the selected Cloudflare account owns `apex-drive-network-poc` at the public hostname above. Before an owner-approved release, record the current version from the latest deployment. Deploy the same checked build output with the release tag.

```sh
./node_modules/.bin/cf workers get apex-drive-network-poc
./node_modules/.bin/cf workers deployments list --worker apex-drive-network-poc --per-page 1
./node_modules/.bin/cf deploy --prebuilt --no-provision --tag "$APEX_RELEASE_TAG"
```

After deployment, check `/api/health`, open `/play/` and drive in a room with two independent browser sessions. Reload both clients and create a fresh room after an incompatible game version change. The public game connects to its own origin without environment overrides. Separately hosted frontends can set `VITE_MULTIPLAYER_URL` and the relay can allow the matching `APEX_FRONTEND_ORIGIN`.

To roll back, route 100% of traffic to the previously recorded version in the Cloudflare dashboard under **Workers & Pages → apex-drive-network-poc → Deployments**, or set `APEX_PREVIOUS_WORKER_VERSION` and run the following from `multiplayer-poc/`. Verify `/api/health` and `/play/` again after switching.

```sh
./node_modules/.bin/cf workers deployments create --worker apex-drive-network-poc \
  --strategy percentage \
  --versions "[{\"version_id\":\"$APEX_PREVIOUS_WORKER_VERSION\",\"percentage\":100}]"
```

## Local verification

Run the app from the repo root and the Worker from `multiplayer-poc/`. Vite proxies the game's API and WebSocket paths to the local relay. The test mode shortens the challenge and keeps the same countdown as a normal build.

```sh
# Worktree root
npm run dev
# In a second terminal, from multiplayer-poc/
npm run dev -- --mode local-game-test
# In a third terminal, from the root after both servers are listening
node scripts/multiplayer-browser.mjs http://127.0.0.1:4177/
node scripts/multiplayer-room-matrix.mjs http://127.0.0.1:4177/
```

The browser checks use the isolated headless launcher. The two-client test covers all vehicle pairings and uses deterministic checkpoint paths for timing and results. The matrix exercises every room size from two to six and records rendering, traffic, host transfer, recovery, and reconnect measurements. Run it with `APEX_ROOM_SIZES=6 APEX_SOAK_SECONDS=900` for a six-driver endurance check. The release smoke test drives both maps over WebSockets and checks the normal challenge deadline.

```sh
node scripts/multiplayer-pilot.mjs https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/
```

## LAN play

On the host computer, prepare the Worker bundle using `npm run build:pilot` as shown above. From `multiplayer-poc/`, run `./node_modules/.bin/vite preview --host <host-lan-ip> --port 4185 --strictPort`. Players on the same network open `http://<host-lan-ip>:4185/play/`. The preview runs the local Worker and serves the bundled assets. Plain HTTP LAN play is playable without engine audio because browsers require a secure context for AudioWorklet.

## Limits

Remote snapshots are visual state at 15 Hz. Each peer uses a bounded cubic Hermite interpolation buffer with adaptive jitter delay and per-sender backpressure acknowledgments. Each browser simulates its own car at 120 Hz. Other cars are visual, with separate controls, checkpoint progress, and recovery. Exterior templates share GPU geometry and textures. Remote shadow proxies are culled beyond 68 m and mirror reflections beyond 150 m. In the Performance preset, rooms with four or more drivers use lower render resolution and a reduced shadow refresh rate.

Each game room supports two to six drivers, and each diagnostic room supports two. The backend allows three concurrent rooms, 120 room creations per rolling day, and five reserved room-hours per rolling day. Six drivers sending poses, pings, and timing updates use about 89,100 Durable Object request equivalents over five hours, before admission and storage work. Poses and timing updates do not write to SQLite. The directory releases unused room time after the last player leaves. Results use locally checked, client-reported times. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

Workers Free allows 100,000 Worker requests and 100,000 Durable Object request equivalents per day. Static asset delivery is free. The relay uses hibernatable SQLite Durable Objects and bounds each client's message rate and pending deliveries. The account shares these quotas across projects, so new rooms or relay operations can be unavailable when the room budget or account quotas are reached. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
