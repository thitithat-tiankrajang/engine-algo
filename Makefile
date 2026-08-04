CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra
EMCC ?= emcc

SRC = src/rules.cpp src/movegen.cpp src/eval.cpp src/engine.cpp
HDR = $(wildcard src/*.hpp)

build:
	mkdir -p build

test: build $(SRC) $(HDR) tests/test_engine.cpp
	$(CXX) $(CXXFLAGS) -o build/test_engine tests/test_engine.cpp src/rules.cpp src/movegen.cpp
	./build/test_engine

test-bot: build $(SRC) $(HDR) tests/test_bot.cpp
	$(CXX) $(CXXFLAGS) -o build/test_bot tests/test_bot.cpp $(SRC)
	./build/test_bot

cli: build $(SRC) $(HDR) src/cli.cpp
	$(CXX) $(CXXFLAGS) -o build/amath_cli src/cli.cpp $(SRC)

# WASM build: single-file ES module, no threads, deterministic and easy to
# bundle from Vite (import in a Web Worker).
wasm: build $(SRC) $(HDR) src/wasm_api.cpp
	$(EMCC) -std=c++20 -O3 -o build/amath_engine.mjs src/wasm_api.cpp $(SRC) \
		-s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 \
		-s ENVIRONMENT=worker,web -s ALLOW_MEMORY_GROWTH=1 \
		-s EXPORTED_FUNCTIONS=_engine_handle,_engine_alloc,_engine_free \
		-s EXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8 \
		-s STACK_SIZE=4MB

.PHONY: build test test-bot cli wasm
