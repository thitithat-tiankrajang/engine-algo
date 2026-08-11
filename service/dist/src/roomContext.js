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
import { parseCanonical } from "./canonical.js";
import { isBotTier } from "./levels.js";
export class RoomAccessError extends Error {
    status;
    name = "RoomAccessError";
    constructor(message, status = 403) {
        super(message);
        this.status = status;
    }
}
export function createSupabaseSource(supabaseUrl, publishableKey) {
    const clientFor = (token) => createClient(supabaseUrl, publishableKey, {
        accessToken: async () => token,
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return {
        async loadContext(gameId, token) {
            const { data, error } = await clientFor(token)
                .rpc("get_live_game_engine_context", { target_game_id: gameId })
                .maybeSingle();
            if (error) {
                if (/get_live_game_engine_context/i.test(error.message)) {
                    throw new RoomAccessError("The engine context function is missing. Run supabase/engine_service_migration.sql.", 404);
                }
                throw new RoomAccessError(error.message);
            }
            // The function is a SELECT gated on `can_read_live_game`, so a caller who
            // may not read this game gets zero rows — indistinguishable, deliberately,
            // from a game that does not exist. Neither answer confirms the room.
            if (!data) {
                throw new RoomAccessError("No such game, or it is not yours to read.", 404);
            }
            const row = data;
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
            if (error)
                throw new RoomAccessError(error.message);
            const rows = (data ?? []);
            return rows
                .slice()
                .sort((first, second) => first.revision - second.revision)
                .map((row) => ({ kind: String(row.command?.kind ?? "") }));
        },
    };
}
//# sourceMappingURL=roomContext.js.map