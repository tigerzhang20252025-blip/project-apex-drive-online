import { bindings, defineConfig, exports } from 'cf/config';
import * as entrypoint from './src/worker.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'apex-drive-network-poc',
    compatibilityDate: '2026-11-25',
    entrypoint,
    workersDev: true,
    previewUrls: false,
    observability: { enabled: false },
    env: {
      ADMISSION_RATE: bindings.rateLimit({
        namespace: '27182501',
        simple: { limit: 45, period: 60 },
      }),
      GAME_FRONTEND_ORIGIN: bindings.text(process.env.APEX_FRONTEND_ORIGIN ?? ''),
      LOCAL_GAME_TEST: bindings.text(mode === 'local-game-test' ? 'true' : 'false'),
      LOCAL_EXPIRY_TEST: bindings.text(mode === 'local-expiry' ? 'true' : 'false'),
    },
    exports: {
      Directory: exports.durableObject({ storage: 'sqlite' }),
      Room: exports.durableObject({ storage: 'sqlite' }),
    },
  },
}));
