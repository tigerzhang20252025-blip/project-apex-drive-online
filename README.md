# Project Apex Drive Online

An open-source 3D racing and driving simulator built with Three.js, TypeScript and Rapier. Drive a Ferrari F40 or the fictional Nissan GT-R R35 Rally Edition on Alpine Proving Ground or Pineglass Run 2.0. Both courses are available in single player and 2–6 player multiplayer.

[Play Project Apex Drive Online](https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/)

[Multiplayer setup](docs/MULTIPLAYER.md) · [Pineglass Run 2.0](docs/PINEGLASS_RUN.md) · [Asset credits](THIRD_PARTY_NOTICES.md)

## Play in your browser

- **Single player.** Choose a car and course in the garage, then select **Drive**. Use **WASD** or the arrow keys to drive. Pineglass Run 2.0 records stage and sector times and offers vehicle recovery.
- **Multiplayer.** Open **Multiplayer**, select **Create Room**, and share the invite code with up to five friends. Each friend enters the code and selects **Join Room**. Everyone chooses a car independently. The host picks the course and **Free Drive** or the timed challenge, then selects **Start Session** when everyone is ready.
- **Room limits.** Public rooms last up to 75 minutes. The relay allows three active rooms and five reserved room-hours per rolling day. Keep the tab open to reconnect to a reserved seat within 45 seconds of a detected disconnect. Online times are client-validated, and other cars do not collide with yours. [LAN play and multiplayer limits](docs/MULTIPLAYER.md)

## Screenshots

| Ferrari F40 | Nissan GT-R Rally Edition |
| --- | --- |
| ![F40 exterior](docs/screenshots/f40.jpg) | ![GT-R exterior](docs/screenshots/r35.jpg) |
| ![F40 cockpit](docs/screenshots/f40-cockpit.jpg) | ![GT-R cockpit](docs/screenshots/r35-cockpit.jpg) |
| ![Vehicle showroom](docs/screenshots/showroom.jpg) | ![Alpine mountain circuit](docs/screenshots/circuit.jpg) |

## Features

- Both cars have interactive cockpit instruments, animated controls, real-time mirrors and synthesized engine audio. Cockpit, chase, hood and orbit cameras are available.
- The F40 models rear-wheel drive and a five-speed gearbox. The GT-R models all-wheel drive and a six-speed gearbox. Both support manual and automatic operation.
- The showroom supports vehicle selection, orbit, zoom and close-up views. The track records lap times and renders dynamic tire marks.
- In-game Help and Settings explain the controls and support keyboard remapping, cockpit tutorials and independently saved driver-arm visibility.

## Getting started

Install [Node.js 26](https://nodejs.org/) and Git. The browser needs WebGL 2. Run these commands in a terminal.

```sh
git clone https://github.com/tigerzhang20252025-blip/project-apex-drive-online.git
cd project-apex-drive-online
npm ci
npm run assets:fetch
npm run dev
```

Open [http://127.0.0.1:4177/](http://127.0.0.1:4177/). The asset command fetches checksum-verified vehicle GLBs. Attribution, licensing and manual setup are in [Third-party notices](THIRD_PARTY_NOTICES.md).

```sh
npm run build
npm test
npm run preview -- --port 4194
```

To run a headless end-to-end check with the preview running, use `node scripts/production-smoke.mjs http://127.0.0.1:4194/ test-evidence/production r35`. Replace `r35` with `f40` for the F40. On macOS the tests detect Google Chrome. Elsewhere run `npx playwright-core install chromium`, or set `CHROME_PATH` to a local Chrome binary.

## Start a local multiplayer room

Keep the game development server running. In a second terminal, start the relay.

```sh
cd multiplayer-poc
npm ci
npm run dev
```

Open the game in two to six browser sessions, choose **Multiplayer**, and share the room code. The host selects Alpine or Pineglass and chooses Free Drive or the timed challenge. The production bundle serves the game and matching relay from the same Worker. See [multiplayer setup](docs/MULTIPLAYER.md) for LAN play, verification, and release preparation.

## Default controls

| Keys | Action |
| --- | --- |
| W / S, A / D, arrow keys | Throttle, brake, steer. Hold brake after stopping for automatic reverse. |
| Space, R, Esc | Handbrake, reset car, pause |
| C, O, G, V, F2 | Cycle cameras, orbit, gear-gate view, recenter, telemetry |
| T, Q, E | Switch automatic/manual while stopped, downshift, upshift |
| M, N | Traction control, ABS (GT-R) |
| L, B, I | Headlights, wiper mode, ignition |
| F, P | Driver arms, pop-up lamps or auxiliary lamps |
| Z, X, H, K | Left signal, right signal, hazards, parking brake (F40) |

Right-drag to look around the cockpit. Open **Help → Controls** to see current bindings and **Settings → Keyboard bindings** to change them.

## Stack and layout

Three.js renders through WebGL. TypeScript implements the game, Rapier 3D supplies dynamics, Vite builds the app, and Web Audio synthesizes vehicle sound. Cloudflare serves the online edition and relay.

| Path | Purpose |
| --- | --- |
| `src/main.ts`, `src/style.css`, `index.html` | Game loop, UI and Settings |
| `src/vehicle.ts`, `src/vehicle-spec.ts`, `src/rally-dynamics.ts` | Vehicle physics, specifications and AWD |
| `src/car-visual.ts`, `src/rally-visual.ts`, `src/*cabin.ts` | Vehicle rendering and cockpit |
| `src/chase-camera.ts`, `src/mirrors.ts`, `src/showroom.ts` | Cameras, mirrors and showroom |
| `src/track.ts`, `src/environment.ts`, `src/lap-timing.ts` | Circuit, environment and lap timing |
| `src/engine-audio.ts`, `public/assets/` | Audio synthesis and game assets |
| `scripts/`, `.github/` | Asset setup, tests and collaboration checks |

## Roadmap

Proposed work includes additional vehicles and rally circuits, AI opponents, weather and time of day, more detailed tire physics and browser performance improvements.

## Contributing and license

The online edition releases from its own `main` branch. The offline edition and the upstream collaboration fork have independent workflows. [Repository strategy](docs/REPOSITORY_STRATEGY.md) · [Online release and rollback](docs/MULTIPLAYER.md#cloudflare-release) · [Changelog](CHANGELOG.md)

This edition builds on Project Apex Drive by jinyuze2028-source and the original project contributors. Source code is licensed under MIT, and third-party assets retain their own license terms. [Original project](https://github.com/jinyuze2028-source/project-apex-drive) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
