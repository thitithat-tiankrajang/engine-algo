CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra
EMCC ?= emcc

SRC = src/rules.cpp src/movegen.cpp src/eval.cpp src/decision_search.cpp \
	src/opponent_search.cpp src/paired_race.cpp src/reply_index.cpp src/root_catalogue.cpp src/state_transition.cpp \
	src/world_deck.cpp src/engine.cpp
HDR = $(wildcard src/*.hpp)

build:
	mkdir -p build

test: build $(SRC) $(HDR) tests/test_engine.cpp
	$(CXX) $(CXXFLAGS) -o build/test_engine tests/test_engine.cpp src/rules.cpp src/movegen.cpp
	./build/test_engine

test-bot: build $(SRC) $(HDR) tests/test_bot.cpp
	$(CXX) $(CXXFLAGS) -o build/test_bot tests/test_bot.cpp $(SRC)
	./build/test_bot

# Phase 2: incremental board state — make/unmake vs full-rebuild equality + bench.
test-inc: build $(SRC) $(HDR) tests/test_inc_board.cpp
	$(CXX) $(CXXFLAGS) -o build/test_inc_board tests/test_inc_board.cpp $(SRC)
	./build/test_inc_board

# Level-1 static path: generation-call bound, determinism, legality, endgame
# precedence, root-generation completeness.
test-static: build $(SRC) $(HDR) tests/test_static_l1.cpp
	$(CXX) $(CXXFLAGS) -o build/test_static_l1 tests/test_static_l1.cpp $(SRC)
	./build/test_static_l1

# The parallel sample loop's whole contract: same decision at every thread count.
test-parallel-sim: build $(SRC) $(HDR) tests/test_parallel_sim.cpp
	$(CXX) $(CXXFLAGS) -o build/test_parallel_sim tests/test_parallel_sim.cpp $(SRC)
	./build/test_parallel_sim

# Revision 2 request-local work accounting.
test-work-ledger: build $(SRC) $(HDR) tests/test_work_ledger.cpp
	$(CXX) $(CXXFLAGS) -o build/test_work_ledger tests/test_work_ledger.cpp
	./build/test_work_ledger

# Revision 2 production-rule state transitions and rollback.
test-transition: build $(SRC) $(HDR) tests/test_state_transition.cpp
	$(CXX) $(CXXFLAGS) -o build/test_state_transition tests/test_state_transition.cpp \
		src/rules.cpp src/state_transition.cpp
	./build/test_state_transition

# Revision 2 immutable, assignment-aware root catalogue.
test-root-catalogue: build $(SRC) $(HDR) tests/test_root_catalogue.cpp
	$(CXX) $(CXXFLAGS) -o build/test_root_catalogue tests/test_root_catalogue.cpp \
		src/rules.cpp src/movegen.cpp src/root_catalogue.cpp
	./build/test_root_catalogue

# Revision 2 deterministic shared hidden-world schedule.
test-world-deck: build $(SRC) $(HDR) tests/test_world_deck.cpp
	$(CXX) $(CXXFLAGS) -o build/test_world_deck tests/test_world_deck.cpp src/world_deck.cpp
	./build/test_world_deck

# Revision 2 symmetric endpoint and non-clairvoyant opponent policy.
test-opponent-search: build $(SRC) $(HDR) tests/test_opponent_search.cpp
	$(CXX) $(CXXFLAGS) -o build/test_opponent_search tests/test_opponent_search.cpp \
		src/rules.cpp src/movegen.cpp src/eval.cpp src/root_catalogue.cpp \
		src/state_transition.cpp src/opponent_search.cpp
	./build/test_opponent_search

# Revision 2 benchmark reference composed through the DecisionSearch seam.
test-decision-search: build $(SRC) $(HDR) tests/test_decision_search.cpp
	$(CXX) $(CXXFLAGS) -o build/test_decision_search tests/test_decision_search.cpp \
		src/rules.cpp src/movegen.cpp src/eval.cpp src/root_catalogue.cpp \
		src/state_transition.cpp src/world_deck.cpp src/opponent_search.cpp src/paired_race.cpp src/reply_index.cpp \
		src/decision_search.cpp
	./build/test_decision_search

# Revision 2 exact base reply index plus candidate-local delta generation.
test-reply-index: build $(SRC) $(HDR) tests/test_reply_index.cpp
	$(CXX) $(CXXFLAGS) -o build/test_reply_index tests/test_reply_index.cpp \
		src/rules.cpp src/movegen.cpp src/eval.cpp src/root_catalogue.cpp src/reply_index.cpp \
		src/state_transition.cpp src/opponent_search.cpp
	./build/test_reply_index

# Long G5 exactness gate. Kept separate from the fast suite so local iteration
# stays cheap; CI/release qualification runs the required 10,000 triples.
verify-reply-index: build $(SRC) $(HDR) tests/test_reply_index.cpp
	$(CXX) $(CXXFLAGS) -o build/test_reply_index tests/test_reply_index.cpp \
		src/rules.cpp src/movegen.cpp src/eval.cpp src/root_catalogue.cpp src/reply_index.cpp \
		src/state_transition.cpp src/opponent_search.cpp
	./build/test_reply_index 10000 20260813

# Revision 2 common-world paired elimination.
test-paired-race: build $(SRC) $(HDR) tests/test_paired_race.cpp
	$(CXX) $(CXXFLAGS) -o build/test_paired_race tests/test_paired_race.cpp src/paired_race.cpp
	./build/test_paired_race

test-v2: test-work-ledger test-transition test-root-catalogue test-world-deck \
	test-opponent-search test-decision-search test-reply-index test-paired-race \
	test-parallel-sim

# Measurement-only translation unit: linked into the CLI, deliberately kept out
# of SRC so it never reaches the WASM bundle or the test binaries.
BENCH = src/deep_bench.cpp

cli: build $(SRC) $(HDR) src/cli.cpp $(BENCH)
	$(CXX) $(CXXFLAGS) -o build/amath_cli src/cli.cpp $(BENCH) $(SRC)

# Deep/Max compute-allocation experiments. Long-running measurement, not tests:
# each prints a table and none of them can change production routing.
# Results and interpretation live in docs/deep-compute-allocation-report.md.
deep-bench: cli
	./build/amath_cli deep-bench 24

deep-credit-curve: cli
	./build/amath_cli deep-credit-curve 12

# G6 admission recall/regret and G7 uniform-vs-paired at equal credits.
gate6: cli
	./build/amath_cli g6 24

gate7: cli
	./build/amath_cli g7 16

# WASM build: single-file ES module, no threads, deterministic and easy to
# bundle from Vite (import in a Web Worker).
# -DNDEBUG selects the fast incremental cross/contact path (Phase 3); the
# per-node equality asserts are a dev/test-only correctness gate.
wasm: build $(SRC) $(HDR) src/wasm_api.cpp
	$(EMCC) -std=c++20 -O3 -DNDEBUG -o build/amath_engine.mjs src/wasm_api.cpp $(SRC) \
		-s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 \
		-s ENVIRONMENT=worker,web -s ALLOW_MEMORY_GROWTH=1 \
		-s EXPORTED_FUNCTIONS=_engine_handle,_engine_alloc,_engine_free \
		-s EXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8 \
		-s STACK_SIZE=4MB

# WASM build, threaded. Same engine, same schedule, same move — the sample loop
# just runs on more than one core (docs/parallel-sample-loop.md).
#
# This is a SECOND artifact rather than a replacement, because a -pthread module
# cannot instantiate at all without SharedArrayBuffer, and that needs the page to
# be cross-origin isolated (COOP/COEP). The client checks `crossOriginIsolated`
# and imports whichever module the page can actually run, so a site that has not
# set the headers keeps working on the single-threaded one.
#
# PTHREAD_POOL_SIZE is a JS expression evaluated at startup, not a build-time
# constant: every pooled worker costs ~13.5 MB resident the moment the module
# comes up, whether or not it is ever used. Baking in 8 would charge a two-core
# phone ~97 MB for six workers it will never schedule. `__amathThreads` is set by
# the host worker just before instantiation, and the same number is sent as the
# request's `threads`, so the pool and the search can never disagree.
#
# POOL_SIZE_STRICT=2 is a guard against asking for more threads than the pool
# holds. That case should be unreachable — superWorker.ts derives the pool size
# and the request's `threads` from ONE number — because the browser behaviour of
# overflowing the pool is the bad kind of unknown: pthread_create needs the host
# worker's event loop to spawn a Worker, and that loop is blocked inside
# _engine_handle for the whole search. Node happens to satisfy the overflow and
# return the right answer, which proves nothing about a browser; the strict flag
# is there to turn a possible hang into a possible abort, and an abort at least
# surfaces as worker `onerror` and falls back to the backend engine.
wasm-mt: build $(SRC) $(HDR) src/wasm_api.cpp
	$(EMCC) -std=c++20 -O3 -DNDEBUG -o build/amath_engine_mt.mjs src/wasm_api.cpp $(SRC) \
		-s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 \
		-s ENVIRONMENT=worker,web -s ALLOW_MEMORY_GROWTH=1 \
		-s EXPORTED_FUNCTIONS=_engine_handle,_engine_alloc,_engine_free \
		-s EXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8 \
		-s STACK_SIZE=4MB \
		-pthread -s PTHREAD_POOL_SIZE='globalThis.__amathThreads||1' \
		-s PTHREAD_POOL_SIZE_STRICT=2

.PHONY: build test test-bot test-inc test-static test-parallel-sim test-work-ledger test-transition test-root-catalogue test-world-deck test-opponent-search test-decision-search test-reply-index verify-reply-index test-paired-race test-v2 cli deep-bench deep-credit-curve gate6 gate7 wasm wasm-mt deploy-ui

# The browser build is production again: the Super bot runs on the player's
# device, so this artifact ships. It lands inside EQ-Lab's bundled source tree
# (src/bot/engine/) rather than in tools/, because Vite has to resolve it —
# and it is reached ONLY through a dynamic import inside a Web Worker, so it
# stays a lazily fetched chunk rather than part of the app's first load.
# tests/engine-in-browser.test.ts is what holds that line.
# Both artifacts ship: the client picks between them at runtime on
# `crossOriginIsolated`, so the single-threaded one is the floor that always
# works and the threaded one is the upgrade a cross-origin-isolated page gets.
deploy-ui: wasm wasm-mt
	cp build/amath_engine.mjs ../EQ-Lab/src/bot/engine/amath_engine.mjs
	cp build/amath_engine_mt.mjs ../EQ-Lab/src/bot/engine/amath_engine_mt.mjs
