# Authur runtime audit — before behavior changes

Bases: web 4b6179d305287187d0633c793de8d87f8c19c5a4; engine origin/main dd9fb0e1d34baa4a6cd573675259cb3d14820ccb. Engine deploy SHA is not exposed; current public health agrees with this lineage's policy, but deployed SHA is unverified.

## Trace and root cause

create_bot_game locks the account, replays the creation request before charging, decides funding from catalog access tier, calls probot_charge once and creates the room in the same PostgreSQL transaction. Failure rolls back the charge. Authur is pro/server. Free has zero allowance, Credits can fund a room. Plus/Pro rules and regeneration remain authoritative in existing migrations. Bot/search routes read authoritative room context under the caller's token and do not call any economy mutation.

POST bot-move authenticates, reads canonical state/commands, validates revision, playable state, bot side and caller control. It then charges ComputeBudget BEFORE registry deduplication. Authur is charged super cost 36. This is an additional admission gate unrelated to room funding and can refuse even a cached duplicate before reaching deduplication.

The legacy meter is an in-memory per-instance map keyed by authenticated user ID (not IP/game/global). Despite 'sliding/rolling' comments it is a fixed window anchored at the first charge: default 300 cost units for 600000ms. Authur exhausts after eight successful unique searches (288 units); the ninth costs 36 and is refused. Weights are configured potential compute, not measured elapsed time. Rejects do not charge. Reused/cache jobs and engine/queue failures refund at most once; GET reconnect/jobs/read/cancel do not charge. A new window accepts its first cost unconditionally. The meter dates to August 27, before September's room allowance/Credit economy.

Room Analysis shares this meter only if ENGINE_ANALYSIS_BUDGETED=true (default false). Study always charges it. The narrow boundary is to exempt valid Authur gameplay only, preserving other budgets. Replace Authur's fairness protection with one outstanding expensive job per account (including queued work), and an independent high-volume request throttle; retain queue and runner bounds.

App's bot effect explicitly retries indefinitely with delays 1500/4000/8000ms, including budget/forbidden failures. Session failure translation drops retry detail. Waits above 60s fall back to short retries. Per-turn session dedup exists, but this does not bound repeated attempts.

CORS is already centralized with exact configured origins, GET/POST/OPTIONS, Authorization/Content-Type, no wildcard and no cookie credentials. It wraps all route/error handlers. Current production jobs OPTIONS returned 204 and ACAO https://eq-log.vercel.app. Public health: concurrency 1, queue 8, wait 120s, analysis slot 1, budget 300/600s. Historic missing-header responses cannot yet be attributed without status/body/request IDs from those responses. Retry-After is not exposed for browser reads; correct that centrally and prove representative errors.

analysis/cancel loads context then requireRevision: stale request returns 409 stale_revision with requested/current revisions. No active matching job returns 200 cancelled:false. Caller lacking turn control returns 403. Without original response body, the observed production 409 cannot be conclusively identified; do not change this contract.

## Experiment ledger

- Production jobs preflight: 204, correct explicit ACAO. Uniform origin rejection disproved.
- Production public health: policy above; matches legacy ration observed.
- Engine API reproducer: authorized Authur with exhausted shared budget → 429 budget_exhausted (red).
- Frontend session reproducer: queue_full with retryAfterMs 190289 → detail absent (red).

No production data writes, deployment, Storage & Sync edits or search/model changes.

## Final experiment ledger

- Authur budget reproducer passes after separation; legacy budget remains spent.
- Session timing reproducer passes; HTTP header/body and SSE timing survive.
- Central CORS baseline/application tests pass, including controlled 500 and new safety errors. Historic missing headers remain unconfirmed.
- Real native engine gate: 264/264 tests passed; lint/typecheck/build passed.
- Real local economy SQL smoke, adversarial and race gates passed.
- Real Chromium/Supabase/engine suite: 3/3 passed, latest 59.1s; four alternating Authur turns, reload/two tabs, legacy room without consumption, active/completed/stale analysis cancel, Stage5B read, independent budget, real Study-induced overload and one retry after >=10s.
- One local unchanged Authur sample: max RSS 238993408 bytes, peak footprint 212929408 bytes, wall 1.72s. No Render worst-case claim.
- Frontend focused 89/89 and ArchBot parity 101/101 pass; format/lint/typecheck/production build pass. Full suite: 1258 passed, 1 failed, 15 skipped. The unchanged wasm-mt sibling-source assertion fails against current engine lineage; it was initially treated as a blocker pending baseline proof.
- No search/model/algorithm files modified. No commits or deployment. See the web worktree's docs/authur-runtime-fix-report.md for the complete report and proposed release order.

## Continuation classification and final review

- Exact untouched web and engine bases reproduced the same wasm-mt assertion; built focused baseline: 13 passed/1 failed/no skips; full baseline: 1246 passed/1 failed/15 skipped. This is a PRE-EXISTING BASELINE / ENVIRONMENT FAILURE, not a patch regression. No target or assertion was changed.
- Final patch CI-policy full frontend: 1258 passed/1 baseline failure/15 skipped. All patch gates pass. One earlier intermittent untouched Ranked replay assertion is retained in the web evidence ledger; isolated/base/full CI checks passed, so no conclusive historical root cause is asserted.
- Repeated final engine native build, 264/264 service tests, lint/typecheck/build, focused frontend 89/89, parity 101/101, actual SQL economy/adversarial/race and real browser 3/3 (49.1s) passed. No behavior or search changes were needed in continuation.
- Fresh production preflights across all relevant families and synthetic unauthenticated reads retained CORS. HISTORICAL CORS FAILURE: UNREPRODUCED / ROOT CAUSE UNKNOWN.
- Public health/headers, tracked deployment source, GitHub metadata and available Render interfaces do not establish a deployed revision. DEPLOYED ENGINE SHA: UNVERIFIED. Main HEAD is not deployment evidence.
- Complete diff trace confirmed Authur-only meter bypass, independent job/volume admission, unchanged Analysis/Study and economy/search behavior, bounded retries and unchanged origin trust.
- The user explicitly accepts these classified limitations for narrow review readiness and authorizes separate local commits after patch-specific gates. Pushes withheld: automatic web preview deployment and unobservable engine deploy configuration cannot satisfy the no-deploy safety check. No merge or deployment.
- Full evidence and release plan: paired web docs/authur-runtime-baseline-validation.md and docs/authur-runtime-fix-report.md. Exact delivery commit SHAs are reported in the final response.
