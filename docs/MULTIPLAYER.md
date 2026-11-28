# Apex Drive multiplayer

[Open the public game](https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/) in a WebGL 2 browser. The Cloudflare Worker serves the frontend and relay from the same origin over HTTPS and WSS.

## Play with friends

1. Open the same pilot URL on two to six computers. In the garage, select **Multiplayer**.
2. Enter an optional driver name. One driver selects **Create Room** and shares the private code. Up to five additional drivers enter the code and select **Join Room**. Any driver can choose a Ferrari F40 or Nissan GT-R R35.
3. The host selects **Alpine Proving Ground** or **Pineglass Run 2.0**, then **Free Drive** or the course's **Best Lap / Best Stage Challenge**. Each player presses **Ready** after the course and cars load. To change vehicles after readying, select **Unready** first. Once at least two drivers are connected and everyone is ready, the host selects **Start Session**.
4. Wait for the shared lights to go out. The engine starts automatically. Use **WASD** or the arrow keys to drive and **C** or the camera buttons to change views. Color-coded minimap markers track each remote driver. Vehicle collisions with the circuit remain active. Remote players are rendered as shared exterior instances in your scene.
5. **R** resets your car to its own grid lane. On Pineglass, **Recover Vehicle** returns your car to the last verified point on the road. The host can select **End session** to bring all players back to the room. In Challenge mode, forward-cross the start line to begin a timed run. Complete as many valid attempts as you can in ten minutes. The results rank all drivers by best valid time and show splits, independent sector bests and theoretical bests. Any driver can select **Return to Lobby** when the results appear.
6. Use **Leave Room** when done. A connected driver takes over if the host leaves or disconnects. Keep your tab open for automatic reconnection. The server reserves the seat for 45 seconds after detecting the drop. After that, join again with a valid invite if the host has returned to the lobby.

Timing and HUD use the existing checkpoint and sector rules. Online times are client-validated and kept in the room. The challenge clock follows the room schedule while the car is in a menu, reconnecting or in a suspended tab. An interrupted timed lap is invalidated. Rooms expire after 75 minutes.

## Independent-network checks

- Use two devices and independent networks, such as home broadband and another carrier’s cellular connection. For mainland China, repeat on each intended carrier pair and in both directions.
- Resolve `apex-drive-network-poc.tigerzhang0215.workers.dev` with `nslookup`. Request `/api/health` over HTTPS and open `/play/` on both networks. Confirm the models finish loading, the invite works and both drivers see moving opponents.
- Play for at least 30 minutes and note the RTT shown on both screens, any stale opponent, disconnections, jitter and whether a brief connection interruption recovers the same seat. Test at least one short challenge as well as Free Drive. Run ten create/join attempts per required network pair when evaluating reliability. Useful starting targets are nine successes in ten attempts, p95 RTT below 250 ms and under 1% stale receipt time.
- The [relay diagnostic page](https://apex-drive-network-poc.tigerzhang0215.workers.dev/) still supports 10, 15 and 20 Hz and exports RTT and interval statistics. Diagnostic invite codes are separate from game invite codes.

## Cloudflare release candidate

Run `npm ci` and `npm run assets:fetch` in the repo root. The fetcher verifies assets from this edition's Cloudflare site against the project's checksums. Then build and check the paired frontend and relay from `multiplayer-poc/`.

```sh
npm ci
npm run build:pilot
./node_modules/.bin/cf deploy --prebuilt --no-provision --dry-run
```

The Worker bundle stages the game under `/play/` and retains the diagnostic page at the root. Use the same build output for an owner-approved release. Reload both clients and create a fresh room after an incompatible game version change. Separately hosted frontends can set `VITE_MULTIPLAYER_URL` and the relay can allow the matching `APEX_FRONTEND_ORIGIN`.

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

On the host computer, prepare the Worker bundle using the release candidate build above. From `multiplayer-poc/`, run `./node_modules/.bin/vite preview --host <host-lan-ip> --port 4185 --strictPort`. Players on the same network open `http://<host-lan-ip>:4185/play/`. The preview runs the local Worker and serves the bundled assets. Plain HTTP LAN play is playable without engine audio because browsers require a secure context for AudioWorklet.

## Limits

Remote snapshots are visual state at 15 Hz. Each peer uses a bounded cubic Hermite interpolation buffer with adaptive jitter delay and per-sender backpressure acknowledgments. Each browser simulates its own car at 120 Hz. Other cars are visual, with separate controls, checkpoint progress, and recovery. Exterior templates share GPU geometry and textures. Remote shadow proxies are culled beyond 68 m and mirror reflections beyond 150 m.

Each game room supports two to six drivers, and each diagnostic room supports two. The backend allows three concurrent rooms, 120 room creations per rolling day, and five reserved room-hours per rolling day. Six drivers sending poses, pings, and timing updates use about 89,100 Durable Object request equivalents over five hours, before admission and storage work. Poses and timing updates do not write to SQLite. The directory releases unused room time after the last player leaves. Results use locally checked, client-reported times. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
