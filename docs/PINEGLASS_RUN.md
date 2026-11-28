# Pineglass Run 2.0

Pineglass Run 2.0 is a 6.554 km point-to-point gravel stage. It runs through the Quarry Hook hairpin, across the Glass Gorge viaduct and down into the valley. Both the Ferrari F40 and the Nissan GT-R R35 Rally Edition can run the stage in solo driving and rooms for two to six drivers.

## Driving and timing

Choose **Pineglass Run 2.0** in the garage, select **Drive** and start the engine. The stage has three sectors, ordered timing gates and a flying finish. Press **R** to restart from the grid. If the car gets stranded, stage recovery returns it to a safe point on the route and invalidates the current run. Stage records are stored per vehicle and route revision.

## Multiplayer

Select **Multiplayer** and create or join a room. The host selects **Pineglass Run 2.0** and chooses **Free Drive** or **Best Stage Challenge**. Every driver must load the room's course revision and press **Ready** before the host can start.

Best Stage Challenge ranks each driver's fastest valid finish during the ten-minute session. Recovery returns only the affected car to a safe point and invalidates that driver's current attempt. **R** restarts that driver's attempt from their own grid lane.

## Local verification

Install the pinned dependencies with `npm ci`, run `npm run assets:fetch`, and then start the frontend with `npm run dev -- --port 4181`.

```sh
npm run build
npm test
node scripts/pineglass-drive.mjs both
node scripts/pineglass-browser.mjs http://127.0.0.1:4181/ test-evidence/pineglass play
node scripts/pineglass-browser.mjs http://127.0.0.1:4181/ test-evidence/pineglass performance
```

For the accelerated room tests, run `npm run dev -- --mode local-game-test` in `multiplayer-poc/`. From the worktree root, run the following commands.

```sh
node scripts/multiplayer-browser.mjs http://127.0.0.1:4181/ test-evidence/pineglass-multiplayer pineglass-run-v2
node scripts/multiplayer-browser.mjs http://127.0.0.1:4181/ test-evidence/alpine-multiplayer
```

For the full-distance room test, start the relay with `npm run dev` and run `node scripts/pineglass-multiplayer-drive.mjs http://127.0.0.1:4181/` from the worktree root. The two browsers use the normal controls and simulation clock for the entire stage.
