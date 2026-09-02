/**
 * USSD session store.
 *
 * A USSD session is short-lived and stateful. The USSD Gateway sends you a
 * keypress and a `sessionId`; it does not tell you where in the menu the
 * subscriber is. That state is yours to keep.
 *
 * ⚠️  THIS IN-MEMORY IMPLEMENTATION IS FOR DEVELOPMENT ONLY.
 *
 * It breaks the moment you run more than one process — a keypress routed to
 * instance B cannot see a session created on instance A, and the subscriber's
 * menu dies mid-flow. It also loses every live session on deploy. Use the Redis
 * implementation at the bottom of this file in production.
 */

export interface UssdSession {
  /** Where in your menu tree the subscriber currently is. */
  node: string;
  /** Subscriber address, as received (possibly masked). */
  sourceAddress: string;
  /** Arbitrary per-session scratch data. Keep it small and non-sensitive. */
  data?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Sessions must expire. USSD sessions that are never closed with `mt-fin`
 * would otherwise accumulate forever.
 */
const SESSION_TTL_MS = 2 * 60_000; // 2 minutes

const sessions = new Map<string, UssdSession & { expiresAt: number }>();

export function getSession(sessionId: string): UssdSession | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return entry;
}

export function setSession(sessionId: string, session: UssdSession): void {
  const now = Date.now();
  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    ...session,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
}

/** Call this whenever you send `mt-fin`. */
export function endSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function activeSessionCount(): number {
  sweep();
  return sessions.size;
}

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now > entry.expiresAt) sessions.delete(id);
  }
}

// Periodic sweep so abandoned sessions do not leak between requests.
const timer = setInterval(sweep, 30_000);
timer.unref?.();

/* ─────────────────────────────────────────────────────────────────────────
 * Production: Redis
 *
 * Same interface, works across instances, survives deploys, and gets TTL
 * eviction for free.
 *
 *   import { createClient } from "redis";
 *   const redis = createClient({ url: process.env.REDIS_URL });
 *   await redis.connect();
 *
 *   const key = (id: string) => `ussd:session:${id}`;
 *
 *   export async function getSession(sessionId: string) {
 *     const raw = await redis.get(key(sessionId));
 *     return raw ? (JSON.parse(raw) as UssdSession) : null;
 *   }
 *
 *   export async function setSession(sessionId: string, session: UssdSession) {
 *     await redis.set(key(sessionId), JSON.stringify(session), { PX: SESSION_TTL_MS });
 *   }
 *
 *   export async function endSession(sessionId: string) {
 *     await redis.del(key(sessionId));
 *   }
 *
 * Notes:
 *   - Make the callers `await` — the handlers in callbacks-nextjs.ts already
 *     run out of band, so this costs nothing user-visible.
 *   - Do not store the raw MSISDN longer than the session needs it.
 *   - Keep session payloads small; USSD flows should not accumulate state.
 * ───────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────
 * Menu tree
 *
 * A declarative tree keeps screens under the length limit and makes the
 * mt-cont / mt-fin decision structural rather than something you remember to
 * get right at each branch.
 * ───────────────────────────────────────────────────────────────────────── */

export interface MenuOption {
  key: string;
  label: string;
  /** "menu" keeps the session open (mt-cont); "end" closes it (mt-fin). */
  type: "menu" | "end";
  next?: string;
  /** For "end": the final screen text, or a resolver. */
  message?: string | ((session: UssdSession) => Promise<string> | string);
}

export interface MenuNode {
  id: string;
  header: string;
  options: MenuOption[];
}

export type MenuTree = Record<string, MenuNode>;

/** Render a node as a USSD screen. Plain ASCII, one option per line. */
export function renderMenu(node: MenuNode): string {
  const screen = [
    node.header,
    ...node.options.map((o) => `${o.key}. ${o.label}`),
  ].join("\n");
  return sanitiseUssd(screen);
}

/**
 * USSD is plain ASCII (encoding 440), and the GSM standard caps a message at
 * 182 septets. Strip anything else and truncate at a safe 160 — a screen that
 * silently fails to render tells the subscriber nothing.
 */
export function sanitiseUssd(text: string, maxLength = 160): string {
  const ascii = text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\n]/g, "") // drop emoji, Sinhala/Tamil, control chars
    .replace(/\t/g, " ");
  // Hard truncate — no ellipsis, since "…" is itself non-ASCII.
  return ascii.length <= maxLength ? ascii : ascii.slice(0, maxLength);
}

export const EXAMPLE_MENU: MenuTree = {
  root: {
    id: "root",
    header: "Welcome to Acme",
    options: [
      { key: "1", label: "Balance", type: "end", message: "Your balance is Rs. 300.00" },
      { key: "2", label: "Support", type: "menu", next: "support" },
      { key: "0", label: "Exit", type: "end", message: "Thank you." },
    ],
  },
  support: {
    id: "support",
    header: "Support",
    options: [
      { key: "1", label: "Call us", type: "end", message: "Call our support line" },
      { key: "2", label: "SMS us", type: "end", message: "SMS HELP to our short code" },
      { key: "0", label: "Exit", type: "end", message: "Thank you." },
    ],
  },
};
