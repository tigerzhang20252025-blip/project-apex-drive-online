import type { Rate, Relay } from '../../shared/protocol.ts';
import { rates } from '../../shared/protocol.ts';

const round = (value: number) => Math.round(value * 100) / 100;

class Distribution {
  private bins = new Map<number, number>();
  count = 0;

  add(ms: number) {
    const bucket = Math.round(Math.min(ms, 120_000));
    this.bins.set(bucket, (this.bins.get(bucket) ?? 0) + 1);
    this.count++;
  }

  summary() {
    const bins = [...this.bins].sort(([a], [b]) => a - b);
    const quantile = (fraction: number) => {
      if (this.count === 0) return null;
      let remaining = Math.ceil(this.count * fraction);
      for (const [value, count] of bins) {
        remaining -= count;
        if (remaining <= 0) return value;
      }
      return null;
    };
    return { samples: this.count, p50Ms: quantile(0.5), p95Ms: quantile(0.95) };
  }
}

type RateSamples = {
  received: number;
  missing: number;
  gaps: number;
  interval: Distribution;
  jitter: Distribution;
  span: number;
  stale: number;
};

export class Measurements {
  private started = performance.now();
  private rtt = new Distribution();
  private peers = new Map<Rate, RateSamples>();
  private events: { atMs: number; event: string; detail?: number }[] = [];
  private last: { snapshot: Relay; seen: number } | undefined;
  private offlineSince: number | undefined;
  private offlineMs = 0;
  sent = 0;
  skipped = 0;

  event(event: string, detail?: number) {
    if (this.events.length === 150) this.events.shift();
    this.events.push({ atMs: round(performance.now() - this.started), event, detail });
  }

  disconnected() {
    this.offlineSince ??= performance.now();
    this.noPeer();
  }

  connected() {
    if (this.offlineSince !== undefined) this.offlineMs += performance.now() - this.offlineSince;
    this.offlineSince = undefined;
  }

  noPeer() {
    if (!this.last) return;
    const now = performance.now();
    const rate = this.last.snapshot.rate;
    const span = now - this.last.seen;
    const data = this.peers.get(rate)!;
    data.span += span;
    data.stale += Math.max(0, span - 3000 / rate);
    this.last = undefined;
  }

  pong(ms: number) {
    this.rtt.add(ms);
  }

  receive(snapshot: Relay, seen: number) {
    let data = this.peers.get(snapshot.rate);
    if (!data) {
      data = { received: 0, missing: 0, gaps: 0, interval: new Distribution(), jitter: new Distribution(), span: 0, stale: 0 };
      this.peers.set(snapshot.rate, data);
    }
    data.received++;
    const last = this.last;
    if (last?.snapshot.generation === snapshot.generation && last.snapshot.rate === snapshot.rate) {
      const interval = seen - last.seen;
      const nominal = 1000 / snapshot.rate;
      data.interval.add(interval);
      data.jitter.add(Math.abs(interval - nominal));
      data.missing += Math.max(0, snapshot.seq - last.snapshot.seq - 1);
      data.span += interval;
      if (interval > 3 * nominal) {
        data.gaps++;
        data.stale += interval - 3 * nominal;
      }
    }
    this.last = { snapshot, seen };
  }

  summary(now = performance.now()) {
    const offline = this.offlineMs + (this.offlineSince === undefined ? 0 : now - this.offlineSince);
    return {
      elapsedMs: round(now - this.started), offlineMs: round(offline),
      rtt: this.rtt.summary(), sent: this.sent, skipped: this.skipped,
      byPeerRate: rates.map(rate => {
        const data = this.peers.get(rate);
        const tail = this.last?.snapshot.rate === rate ? now - this.last.seen : 0;
        const span = (data?.span ?? 0) + tail;
        const stale = (data?.stale ?? 0) + Math.max(0, tail - 3000 / rate);
        return {
          rate, received: data?.received ?? 0, missing: data?.missing ?? 0, gaps: data?.gaps ?? 0,
          interval: data?.interval.summary(), jitter: data?.jitter.summary(),
          observedMs: round(span), staleMs: round(stale),
          stalePercent: span ? round(100 * stale / span) : null,
        };
      }),
      events: [...this.events],
    };
  }
}
