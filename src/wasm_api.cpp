// Emscripten entry points. The engine is called from a Web Worker; progress
// reports are forwarded to JS through a global hook the worker installs:
//   globalThis.__amathProgress = (jsonString) => { ... }
#include <cstdlib>
#include <cstring>

#include <emscripten/emscripten.h>

#include "engine.hpp"

EM_JS(void, amath_emit_progress, (const char* json), {
  if (typeof globalThis.__amathProgress === "function") {
    globalThis.__amathProgress(UTF8ToString(json));
  }
});

namespace {

void progressBridge(const char* json) { amath_emit_progress(json); }

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
char* engine_handle(const char* requestJson) {
  amath::setProgressCallback(progressBridge);
  const std::string out = amath::handleRequest(requestJson ? requestJson : "");
  char* buf = static_cast<char*>(std::malloc(out.size() + 1));
  std::memcpy(buf, out.c_str(), out.size() + 1);
  return buf;
}

EMSCRIPTEN_KEEPALIVE
char* engine_alloc(int size) { return static_cast<char*>(std::malloc(size)); }

EMSCRIPTEN_KEEPALIVE
void engine_free(char* ptr) { std::free(ptr); }

}  // extern "C"
