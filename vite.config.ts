import type { ClientRequest, IncomingMessage } from 'node:http';
import { defineConfig, type ProxyOptions } from 'vite';

const localRelay = 'http://127.0.0.1:8788';
const relayProxy: ProxyOptions = {
  target: localRelay,
  changeOrigin: true,
  configure(proxy) {
    function forwardOrigin(outgoing: ClientRequest, incoming: IncomingMessage) {
      const scheme = 'encrypted' in incoming.socket && incoming.socket.encrypted ? 'https' : 'http';
      const expected = scheme + '://' + incoming.headers.host;
      // The local Worker sees its loopback address after proxying.
      // Preserve the same-origin check before translating to that address.
      if (incoming.headers.origin === expected) outgoing.setHeader('Origin', localRelay);
      else outgoing.removeHeader('Origin');
    }
    proxy.on('proxyReq', forwardOrigin);
    proxy.on('proxyReqWs', forwardOrigin);
  },
};

export default defineConfig({
  base: './',
  css: { postcss: { plugins: [] } },
  server: {
    proxy: {
      '/api/': relayProxy,
      '/socket/': { ...relayProxy, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 2900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/@dimforge/')) return 'physics';
          if (id.includes('/node_modules/three/')) return 'render';
        },
      },
    },
  },
});
