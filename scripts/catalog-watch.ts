/**
 * 🔴 HAS THE CATALOGUE CHANGED? — the change signal, computed server-side.
 *
 * Written 2026-09-07 (CLAUDE.md §2.20, and the plan in this session). Rom
 * re-orders a category in WordPress and expects the app to show it. Phase A made
 * that true for a phone that NAVIGATES — entering a category page re-asks for the
 * order within two minutes. This is the other half: a phone that is sitting still
 * on one screen has nothing to trigger it. So something outside the app has to
 * notice the change and say so.
 *
 * It publishes a tiny document — two hashes and a timestamp — which every client
 * polls on the gate's existing 60s tick. A changed hash means "re-read the real
 * feed"; an unchanged one costs the client ~200 bytes.
 *
 *     npx tsx scripts/catalog-watch.ts --out catalog.json
 *     npx tsx scripts/catalog-watch.ts --compare catalog.json   # exit 0 = changed
 *
 * 🔴 IT RUNS IN `romazeus/noy-hasade-status`, AS A BYTE-IDENTICAL COPY (2026-10-07). From the
 * app repo it needed a personal token to write there; the token was never created, so all 49
 * runs failed from the first one and the signal never existed. In the status repo the built-in
 * token writes to its own repo, and a public repo's Actions minutes are free. This file stays
 * the original because its tests are here: change it HERE, then copy it there byte for byte.
 * `npm run check:catalog-watch` fails while the two differ.
 *
 * ── WHY THE HASH IS A PROJECTION AND NOT THE BYTES ────────────────────────────
 *
 * 🔴 MEASURED 2026-09-06, AND IT WOULD HAVE BORN BROKEN OTHERWISE. Two
 * back-to-back reads of `/products` are byte-identical, and across windows of 2,
 * 5, 6 and 9 minutes NOTHING moved — but across one 8-minute window that crossed
 * the top of the hour, 193 of 1699 products differed, in `recommendedProducts`
 * and in NO other field. The server rotates that list on its own clock.
 *
 * Hashing the raw bytes would therefore fire on every rotation and pull 610 KB
 * onto every phone for a change no merchandiser made — the "wrong oracle is worse
 * than none" failure that `check-catalog-weights` already paid for once.
 *
 * ── WHY A DENY-LIST AND NOT AN ALLOW-LIST ─────────────────────────────────────
 *
 * 🔴 THE RISK IS ASYMMETRIC. An allow-list that forgets a field means a real
 * change is INVISIBLE — silent, and exactly the class this whole feature exists
 * to kill. A deny-list that is too small means a spurious refresh — noisy, cheap,
 * and self-announcing. So everything is hashed by default, a new server field is
 * covered the day it appears, and every exclusion has to earn its line below.
 *
 * ⚠️ `recommendedProducts` IS read by the app's own `catalogSignature`
 * (`state/productCatalog.ts`), so excluding it here is a DELIBERATE divergence:
 * this signal does not fire when recommendations rotate. That is the intent —
 * they are server-rotated noise, not a merchandising edit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = 'https://api.noyhasade.co.il/api';

/**
 * Product fields excluded from the signal. EVERY entry needs a measurement and a
 * date — an exclusion is a promise that a change here is not worth waking phones
 * for, and a wrong one hides a real edit forever.
 */
const VOLATILE_PRODUCT_FIELDS = new Set([
  // Rotated by the backend on a wall-clock boundary. 193/1699 products changed
  // across one 8-minute window; zero across 2, 5, 6 and 9-minute windows that
  // crossed no boundary. Measured 2026-09-06.
  'recommendedProducts',
]);

/** Deterministic JSON: keys sorted at every level, so a server that reorders its
 *  own output cannot read as a change. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function getJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  const json = await res.json();
  if (json?.status && json.status !== 'success') throw new Error(`${path} → ${json.status}`);
  return json;
}

export function projectProducts(products: any[]): { hash: string; count: number } {
  const rows = products
    .map((p) => {
      const kept: Record<string, unknown> = {};
      for (const k of Object.keys(p)) if (!VOLATILE_PRODUCT_FIELDS.has(k)) kept[k] = p[k];
      return kept;
    })
    // Sorted by id: the feed's own row order is not a merchandising signal —
    // `/productsorder` is — so a reordered response must not read as a change.
    .sort((a, b) => Number(a.id) - Number(b.id));
  return { hash: sha1(canonical(rows)), count: rows.length };
}

export function projectOrder(order: Record<string, number[]>): { hash: string; count: number } {
  return { hash: sha1(canonical(order)), count: Object.keys(order).length };
}

/** Which products differ, and in which fields — so a spurious signal names its
 *  own cause on the first run instead of quietly costing everyone 610 KB. */
export function diffProducts(before: any[], after: any[]): Record<string, number> {
  const b = new Map(before.map((p) => [String(p.id), p]));
  const fields: Record<string, number> = {};
  for (const p of after) {
    const prev = b.get(String(p.id));
    if (!prev) {
      fields['(new product)'] = (fields['(new product)'] ?? 0) + 1;
      continue;
    }
    for (const k of new Set([...Object.keys(prev), ...Object.keys(p)])) {
      if (VOLATILE_PRODUCT_FIELDS.has(k)) continue;
      if (canonical(prev[k]) !== canonical(p[k])) fields[k] = (fields[k] ?? 0) + 1;
    }
  }
  return fields;
}

/**
 * Read `--flag value` from an argv list.
 *
 * 🔴 EXPORTED FOR ITS TEST BECAUSE THE NAIVE FORM ALREADY SHIPPED A BUG HERE:
 * `argv[argv.indexOf(f) + 1]` reads argv[0] when the flag is ABSENT, because
 * indexOf returns -1. It stamped the published document's timestamp with the
 * literal string "--out" and nothing failed — the hashes were correct, and `at`
 * is only ever read by a human. Found 2026-09-07 by looking at the output.
 */
export function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  // A flag followed by nothing, or by another flag, has no value.
  return v === undefined || v.startsWith('--') ? null : v;
}

async function main() {
  const argv = process.argv.slice(2);
  const outPath = flag(argv, '--out');
  const cmpPath = flag(argv, '--compare');
  const stampedAt = flag(argv, '--at') ?? new Date().toISOString();

  const [productsJson, orderJson] = await Promise.all([
    getJson('/products?origin=web', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
    getJson('/productsorder?origin=web'),
  ]);

  const products = Array.isArray(productsJson?.products) ? productsJson.products : null;
  const order = orderJson?.order && typeof orderJson.order === 'object' ? orderJson.order : null;
  // 🔴 NEVER PUBLISH A HASH OF A BROKEN READ. A malformed feed hashed as-is would
  // look like a huge change and stampede every client onto a backend that is
  // already unwell. Exit non-zero and publish nothing.
  if (!products?.length || !order) throw new Error('a feed came back unusable — publishing nothing');

  const p = projectProducts(products);
  const o = projectOrder(order);
  const next = {
    products: { hash: p.hash, count: p.count },
    order: { hash: o.hash, count: o.count },
    // 🔴 `at` IS THE LIVENESS MARKER, AND IT IS WHY THE DOCUMENT IS REPUBLISHED
    // EVEN WHEN NOTHING CHANGED — see `--out` below. Without it a watcher that
    // has DIED (an exhausted Actions allowance, a revoked token, a disabled
    // schedule) publishes exactly what a quiet catalogue publishes: nothing. The
    // client cannot tell those apart and neither can a person. A moving
    // timestamp makes a dead channel visible to anyone who opens the file.
    at: stampedAt,
  };

  let changed = true;
  if (cmpPath && fs.existsSync(cmpPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(cmpPath, 'utf8'));
      changed = prev?.products?.hash !== next.products.hash || prev?.order?.hash !== next.order.hash;
      if (changed) {
        console.log(
          `changed: products ${prev?.products?.hash ?? '—'} → ${next.products.hash} · ` +
            `order ${prev?.order?.hash ?? '—'} → ${next.order.hash}`,
        );
      } else {
        console.log(`unchanged: products ${next.products.hash} · order ${next.order.hash}`);
      }
    } catch {
      // An unreadable previous document is not evidence of a change; it is
      // evidence of a broken file. Republish rather than guess.
      console.log('previous document unreadable — republishing');
    }
  }

  // The document is written whenever an output path is given, changed or not:
  // the hashes carry the change and `at` carries the liveness. The workflow
  // decides whether to COMMIT — it publishes on a real change, and skips an
  // at-only bump on the quiet runs so the status repo does not gain a commit
  // every quarter hour. A heartbeat that costs a commit per run is a different
  // trade, and it is Rom's to make.
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(next, null, 2) + '\n');
  if (!outPath) console.log(JSON.stringify(next, null, 2));
  console.log(`  ${p.count} products · ${o.count} ordered categories`);
  process.exitCode = changed ? 0 : 100; // 100 = nothing to publish
}

if (process.argv[1] && process.argv[1].endsWith('catalog-watch.ts')) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exitCode = 2;
  });
}
