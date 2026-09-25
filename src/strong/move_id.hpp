// STRONG's content-addressed action identity, matching core/move.ts.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "../rules.hpp"

namespace amath::strong {

inline void appendAscii(std::u16string& out, const std::string& text) {
  for (unsigned char c : text) out.push_back(static_cast<char16_t>(c));
}

inline std::u16string canonicalMove(const Move& move) {
  std::u16string out;
  if (move.type == MoveType::Pass) return u"pass";
  if (move.type == MoveType::Exchange) {
    out = u"exchange:";
    std::vector<std::string> kinds;
    for (uint8_t kind : move.exchangeKinds) kinds.push_back(tileKindToString(kind));
    std::sort(kinds.begin(), kinds.end());
    for (size_t i = 0; i < kinds.size(); ++i) {
      if (i) out.push_back(u',');
      appendAscii(out, kinds[i]);
    }
    return out;
  }
  out = u"place:";
  std::vector<Placement> placements = move.placements;
  std::sort(placements.begin(), placements.end(), [](const Placement& a, const Placement& b) {
    return Board::idx(a.row, a.col) < Board::idx(b.row, b.col);
  });
  for (size_t i = 0; i < placements.size(); ++i) {
    const Placement& p = placements[i];
    if (i) out.push_back(u'|');
    appendAscii(out, std::to_string(Board::idx(p.row, p.col)));
    out.push_back(u':');
    appendAscii(out, tileKindToString(p.kind));
    out.push_back(u':');
    if (p.token <= T_NUM20) appendAscii(out, std::to_string(p.token));
    else if (p.token == T_ADD) out.push_back(u'+');
    else if (p.token == T_SUB) out.push_back(u'-');
    else if (p.token == T_MUL) out.push_back(u'×');
    else if (p.token == T_DIV) out.push_back(u'÷');
    else if (p.token == T_EQ) out.push_back(u'=');
  }
  return out;
}

inline std::string moveId(const Move& move) {
  uint64_t hash = 0xcbf29ce484222325ull;
  for (char16_t code : canonicalMove(move))
    hash = (hash ^ static_cast<uint64_t>(code)) * 0x100000001b3ull;
  char result[17];
  std::snprintf(result, sizeof(result), "%016llx", static_cast<unsigned long long>(hash));
  return result;
}

}  // namespace amath::strong
