# Online development

Use Node.js 26, Git, and a browser with WebGL 2. Three.js renders the game, Rapier supplies the physics, and Vite builds the frontend.

```sh
npm ci
npm run assets:fetch
npm run dev
```

Open `http://127.0.0.1:4177/`. The asset command downloads checksum-verified vehicle models. Start the local room relay in a second terminal.

```sh
cd multiplayer-poc
npm ci
npm run dev
```

Run the following from the repository root to verify a frontend build locally.

```sh
npm run build
npm test
npm run preview -- --port 4194
```

Run `node scripts/production-smoke.mjs http://127.0.0.1:4194/ test-evidence/production r35` against the preview. Use `f40` for the Ferrari. The headless runner uses Chrome on macOS or Chromium from `npx playwright-core install chromium`. Set `CHROME_PATH` to use another locally installed Chrome binary.

[Multiplayer, LAN, and Cloudflare deployment](MULTIPLAYER.md) · [Pineglass course verification](PINEGLASS_RUN.md) · [Repository strategy](REPOSITORY_STRATEGY.md) · [Asset setup and credits](../THIRD_PARTY_NOTICES.md)
