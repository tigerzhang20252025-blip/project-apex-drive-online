import { DurableObject } from 'cloudflare:workers';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const dayMs = 24 * 60 * 60 * 1000;
// Five hours at six drivers sending poses, timing and pings is about
// 89,100 Durable Object request equivalents before admission traffic.
const roomBudgetMs = 5 * 60 * 60 * 1000;
const maxRooms = 3;
const maxCreations = 120;
export const roomLifetimeMs = 75 * 60 * 1000;

type Usage = { start: number; end: number };
type Lease = Usage & { code: string; id: string };
type LedgerEntry = Usage | Lease;

export class Directory extends DurableObject {
  reserve(id: string, lifetime: number): Lease | null {
    const now = Date.now();
    const leases = this.recent(now);
    const active = leases.filter(lease => lease.end > now);
    const reserved = leases.reduce((total, lease) => total + lease.end - Math.max(lease.start, now - dayMs), 0);
    if (active.length >= maxRooms || leases.length >= maxCreations || reserved + lifetime > roomBudgetMs) return null;

    let code: string;
    do {
      code = Array.from(crypto.getRandomValues(new Uint8Array(8)), value => alphabet[value % alphabet.length]).join('');
    } while (leases.some(lease => 'code' in lease && lease.code === code));

    const lease = { code, id, start: now, end: now + lifetime };
    const ledger = leases.map(entry => entry.end <= now ? { start: entry.start, end: entry.end } : entry);
    this.ctx.storage.kv.put('leases', [...ledger, lease]);
    return lease;
  }

  lookup(code: string): string | undefined {
    const now = Date.now();
    for (const lease of this.recent(now)) {
      if ('code' in lease && lease.code === code && lease.end > now) return lease.id;
    }
  }

  permits(id: string): boolean {
    const now = Date.now();
    return this.recent(now).some(lease => 'id' in lease && lease.id === id && lease.end > now);
  }

  release(id: string): void {
    const now = Date.now();
    const leases = this.recent(now);
    const index = leases.findIndex(item => 'id' in item && item.id === id);
    if (index >= 0) {
      const lease = leases[index];
      leases[index] = { start: lease.start, end: Math.min(lease.end, now) };
      this.ctx.storage.kv.put('leases', leases);
    }
  }

  private recent(now: number): LedgerEntry[] {
    return (this.ctx.storage.kv.get<LedgerEntry[]>('leases') ?? [])
      .filter(lease => lease.end > now - dayMs);
  }
}
