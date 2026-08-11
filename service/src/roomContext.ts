// ── Reading authoritative game state, as the caller ──────────────────────────
//
// The service holds no service-role key and grants itself nothing. It calls
// Postgres with the CALLER'S access token, so `auth.uid()` inside the database
// is the person who made the request and every existing policy —
// `can_read_live_game`, `can_write_live_game`, region scoping, approval status —
// applies with no help from this process.
//
// That is the point. The room rules already exist and are already tested; a
// second copy of them in TypeScript would be a second opinion to keep in sync,
// and the two would eventually disagree about who may do what.

import { createClient } from "@supabase/supabase-js";

import { type CanonicalState, parseCanonical } from "./canonical.js";
import { type BotTier, isBotTier } from "./levels.js";

export type EngineRoomContext = {
  gameId: string;
  revision: number;
  status: string;
  gameMode: string;
  modeKey: string | null;
  botSide: "A" | "B" | null;
  botDifficulty: BotTier | null;
  activeSide: "A" | "B";
  turnNumber: number;
  phase: string;
  canonical: CanonicalState;
  /** Whether the caller controls the side currently on move. The database's
   *  answer, from `controls_live_game_side`. */
  callerControlsActiveSide: boolean;
  activeSideIsBot: boolean;
};

export class RoomAccessError extends Error {
  override readonly name = "RoomAccessError";
  constructor(message: string, readonly status: 403 | 404 = 403) {
    super(message);
  }
}

export type CommittedCommandRow = { revision: number; command: { kind?: string } };

export interface GameStateSource {
  loadContext(gameId: string, token: string): Promise<EngineRoomContext>;
  /** The tail of the committed command log, ending at `revision`. */
  loadRecentCommands(
    gameId: string,
    token: string,
    revision: number,
    count: number,
  ): Promise<Array<{ kind: string }>>;
}

/**
 * The two reads a compute request needs, issued CONCURRENTLY.
 *
 * They were sequential because the command window is derived from the
 * authoritative revision, and that arrives with the context. But the caller
 * already states the revision it believes the game is at, and that claim is
 * checked against the database anyway — a request whose claim is wrong is
 * refused before either result is used. So the claim is safe to use as a WINDOW
 * HINT: right, the window is right; wrong, the request is already dead.
 *
 * This is a pure latency change. Both queries still run as the caller under RLS,
 * neither accepts a position, and the authoritative revision still comes only
 * from the context read.
 */
export async function loadContextAndCommands(
  source: GameStateSource,
  gameId: string,
  token: string,
  claimedRevision: number,
  count: number,
): Promise<{ context: EngineRoomContext; events: Array<{ kind: string }> }> {
  const contextPromise = source.loadContext(gameId, token);
  // A rejection here must not become an unhandled rejection while the context
  // read is still in flight; it is re-thrown below, after the context settles.
  const eventsPromise = source
    .loadRecentCommands(gameId, token, claimedRevision, count)
    .then(
      (events) => ({ ok: true as const, events }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  const context = await contextPromise;
  const events = await eventsPromise;
  if (!events.ok) throw events.error;
  // The speculative window was opened at the claimed revision. If the database
  // disagrees the caller is about to be refused, but re-read rather than reason
  // about which of the two is right.
  if (context.revision !== claimedRevision) {
    return { context, events: await source.loadRecentCommands(gameId, token, context.revision, count) };
  }
  return { context, events: events.events };
}

export function createSupabaseSource(
  supabaseUrl: string,
  publishableKey: string,
): GameStateSource {
  // One client per access token instead of one per query. The client is a thin,
  // stateless wrapper here — no session persistence, no refresh, no auth state
  // — so two concurrent requests with the same token can share it safely, and
  // sharing is what lets the underlying HTTP agent keep a connection warm
  // instead of negotiating TLS on every read.
  //
  // Bounded and evicted least-recently-used: tokens rotate, and a map keyed by
  // JWT would otherwise grow for the life of the process.
  const create = (token: string) =>
    createClient(supabaseUrl, publishableKey, {
      accessToken: async () => token,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  const clients = new Map<string, ReturnType<typeof create>>();
  const MAX_CLIENTS = 64;

  const clientFor = (token: string) => {
    const existing = clients.get(token);
    if (existing) {
      // Re-insert to move to the end of the LRU order.
      clients.delete(token);
      clients.set(token, existing);
      return existing;
    }
    const client = create(token);
    clients.set(token, client);
    while (clients.size > MAX_CLIENTS) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
    return client;
  };

  return {
    async loadContext(gameId, token) {
      const { data, error } = await clientFor(token)
        .rpc("get_live_game_engine_context", { target_game_id: gameId })
        .maybeSingle();

      if (error) {
        if (/get_live_game_engine_context/i.test(error.message)) {
          throw new RoomAccessError(
            "The engine context function is missing. Run supabase/engine_service_migration.sql.",
            404,
          );
        }
        throw new RoomAccessError(error.message);
      }
      // The function is a SELECT gated on `can_read_live_game`, so a caller who
      // may not read this game gets zero rows — indistinguishable, deliberately,
      // from a game that does not exist. Neither answer confirms the room.
      if (!data) {
        throw new RoomAccessError("No such game, or it is not yours to read.", 404);
      }

      const row = data as Record<string, unknown>;
      const canonical = parseCanonical(row.canonical);
      const activeSide = row.active_side === "B" ? "B" : "A";

      return {
        gameId,
        revision: Number(row.revision ?? 0),
        status: String(row.status ?? ""),
        gameMode: String(row.game_mode ?? "versus"),
        modeKey: row.mode_key == null ? null : String(row.mode_key),
        botSide: row.bot_side === "A" || row.bot_side === "B" ? row.bot_side : null,
        botDifficulty: isBotTier(row.bot_difficulty) ? row.bot_difficulty : null,
        activeSide,
        turnNumber: Number(row.turn_number ?? canonical.turnNumber),
        phase: String(row.phase ?? canonical.phase),
        canonical,
        callerControlsActiveSide: row.caller_controls_active_side === true,
        activeSideIsBot: row.active_side_is_bot === true,
      };
    },

    async loadRecentCommands(gameId, token, revision, count) {
      // The scoreless-turn streak only needs the tail of the log. That RPC
      // returns the FIRST rows after a revision, so the window has to be opened
      // near the head — asking from revision 0 would return the opening moves of
      // a long game and report a streak from the wrong end of it.
      const since = Math.max(0, revision - count);
      const { data, error } = await clientFor(token).rpc("list_live_game_events", {
        target_game_id: gameId,
        target_since_revision: since,
        target_limit: count,
      });
      if (error) throw new RoomAccessError(error.message);
      const rows = (data ?? []) as CommittedCommandRow[];
      return rows
        .slice()
        .sort((first, second) => first.revision - second.revision)
        .map((row) => ({ kind: String(row.command?.kind ?? "") }));
    },
  };
}
