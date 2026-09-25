// Test-only complete move dump for Authur rules parity. Not linked into the product or WASM.
// Reads an engine-style JSON request on stdin and emits one canonical placement + score/line.
#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

#include "../src/json.hpp"
#include "../src/movegen.hpp"
#include "../src/strong/move_id.hpp"

int main() {
  const std::string input((std::istreambuf_iterator<char>(std::cin)),
                          std::istreambuf_iterator<char>());
  const auto request = amath::json::parse(input);
  if (!request || !request->get("board") || !request->get("rack")) return 1;
  amath::Board board;
  amath::TileCounts rack;
  for (const auto& cell : request->get("board")->arr) {
    const int row = static_cast<int>(cell->get("r")->asInt(-1));
    const int col = static_cast<int>(cell->get("c")->asInt(-1));
    const int kind = amath::tileKindFromString(cell->get("kind")->asString());
    const int token = amath::assignedTokenFromString(cell->get("token")->asString());
    if (!amath::inBounds(row, col) || kind < 0 || token < 0) return 1;
    board.place(row, col, static_cast<uint8_t>(kind), static_cast<uint8_t>(token));
  }
  for (const auto& tile : request->get("rack")->arr) {
    const int kind = amath::tileKindFromString(tile->asString());
    if (kind < 0) return 1;
    rack.add(static_cast<uint8_t>(kind));
  }
  std::vector<amath::Move> moves;
  amath::GenStats stats;
  amath::generatePlaceMoves(board, rack, moves, &stats);  // default: complete, no dedup
  if (stats.truncated) return 2;
  for (const amath::Move& move : moves) {
    std::vector<std::string> parts;
    parts.reserve(move.placements.size());
    for (const amath::Placement& p : move.placements) {
      parts.push_back(std::to_string(amath::Board::idx(p.row, p.col)) + ":" +
                      amath::tileKindToString(p.kind) + ":" +
                      amath::assignedTokenToString(p.token));
    }
    std::sort(parts.begin(), parts.end());
    for (size_t i = 0; i < parts.size(); ++i)
      std::cout << (i ? "|" : "") << parts[i];
    std::cout << '\t' << move.score << '\t' << amath::strong::moveId(move) << '\n';
  }
}
