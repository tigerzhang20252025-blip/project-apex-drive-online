import { defaultTrack, isTrackId } from '../../shared/tracks.ts';
export { Directory } from './directory.ts';
export { Room } from './room.ts';
import { gameVersion, isCar } from '../../shared/game.ts';
import { roomLifetimeMs } from './directory.ts';
import { jsonObject, objectIdPattern, protocol, roomCodePattern, tokenPattern } from '../../shared/protocol.ts';

function loopback(host: string) {
  return host === '127.0.0.1' || host === 'localhost';
}

async function parseBody(request: Request) {
  if (!request.body || request.headers.get('Content-Type') !== 'application/json') return;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let content = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512) {
        await reader.cancel();
        return;
      }
      content += decoder.decode(value, { stream: true });
    }
    return jsonObject(content + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const local = loopback(url.hostname);
    const allowed = !!origin && (origin === url.origin || origin === env.GAME_FRONTEND_ORIGIN ||
      (local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)));
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin' });
    if (allowed) headers.set('Access-Control-Allow-Origin', origin);
    const reply = (data: object, status: number) => Response.json(data, { status, headers });
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return reply({ ok: true, protocol, gameVersion }, 200);
    }

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/') && allowed) {
      headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Access-Control-Max-Age', '3600');
      return new Response(null, { status: 204, headers });
    }
    const upgrade = request.method === 'GET' && url.pathname.startsWith('/socket/');
    const issue = request.method === 'POST' && ['/api/create', '/api/join', '/api/resume'].includes(url.pathname);
    if (!upgrade && !issue) return reply({ error: 'Endpoint not found.' }, 404);
    if (!allowed) return reply({ error: 'Origin rejected.' }, 403);

    try {
      const rooms = ctx.exports.Room;
      const directory = ctx.exports.Directory.getByName('phase-1-admission');
      const source = request.headers.get('CF-Connecting-IP') ?? 'local';
      const { success } = await env.ADMISSION_RATE.limit({ key: source });
      if (!success) return reply({ error: 'Too many connection requests. Try again in a minute.' }, 429);
      if (upgrade) {
        const id = url.pathname.slice('/socket/'.length);
        const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim());
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || !objectIdPattern.test(id) ||
            offered?.length !== 2 || offered[0] !== protocol || !offered[1].startsWith('ticket.') ||
            !tokenPattern.test(offered[1].slice('ticket.'.length))) {
          return reply({ error: 'Invalid WebSocket upgrade.' }, 400);
        }
        if (!await directory.permits(id)) return reply({ error: 'Room expired.' }, 404);
        return await rooms.get(rooms.idFromString(id)).fetch(request);
      }

      const body = await parseBody(request);
      if (!body) return reply({ error: 'Invalid request.' }, 400);
      if (url.pathname === '/api/resume') {
        if (typeof body.roomId !== 'string' || !objectIdPattern.test(body.roomId) ||
            typeof body.resume !== 'string' || !tokenPattern.test(body.resume)) {
          return reply({ error: 'Invalid reconnect request.' }, 400);
        }
        if (!await directory.permits(body.roomId)) return reply({ error: 'Reconnect window has closed.' }, 410);
        const result = await rooms.get(rooms.idFromString(body.roomId)).resume(body.resume);
        return reply(await result.json<object>(), result.status);
      }
      if (body.gameVersion !== undefined && body.gameVersion !== gameVersion) {
        return reply({ error: 'Game version mismatch. Reload the same build as your friend.' }, 409);
      }
      const profile = body.gameVersion === gameVersion
        ? { name: typeof body.name === 'string' ? body.name.slice(0, 40) : undefined, vehicle: isCar(body.vehicle) ? body.vehicle : undefined }
        : undefined;
      if (url.pathname === '/api/join') {
        const code = typeof body.code === 'string' ? body.code.toUpperCase().replaceAll('-', '').trim() : '';
        const id = roomCodePattern.test(code) ? await directory.lookup(code) : undefined;
        if (!id) return reply({ error: 'Invalid or expired room code.' }, 404);
        const result = await rooms.get(rooms.idFromString(id)).join(code, profile);
        return reply(await result.json<object>(), result.status);
      }
      const id = rooms.newUniqueId();
      const shortTest = env.LOCAL_EXPIRY_TEST === 'true' && url.hostname === '127.0.0.1';
      const lease = await directory.reserve(id.toString(), shortTest ? 12_000 : roomLifetimeMs);
      if (!lease) return reply({ error: 'Pilot room limit reached. Try again later.' }, 429);
      const grant = await rooms.get(id).initialize(lease.code, lease.end, profile, local && env.LOCAL_GAME_TEST === 'true', isTrackId(body.track) ? body.track : defaultTrack);
      return reply(grant, 201);
    } catch {
      return reply({ error: 'Relay temporarily unavailable.' }, 503);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
