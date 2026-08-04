// Tile definitions — must stay in lockstep with EQ-Lab's
// src/constants/tileDefinitions.ts (the distribution, points and types there
// are the published rule set this engine implements).
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

namespace amath {

// ── Assigned tokens: the value a cell actually shows / evaluates as ──────────
// 0..20  : the number of that value
// 21..25 : + - × ÷ =
enum AssignedToken : uint8_t {
  T_NUM0 = 0,   // codes 0..20 are the numbers themselves
  T_NUM20 = 20,
  T_ADD = 21,
  T_SUB = 22,
  T_MUL = 23,
  T_DIV = 24,
  T_EQ = 25,
  ASSIGNED_COUNT = 26,
  T_NONE = 255,
};

inline bool isNumberTok(uint8_t t) { return t <= T_NUM20; }
inline bool isUnitTok(uint8_t t) { return t <= 9; }
inline bool isTensTok(uint8_t t) { return t >= 10 && t <= T_NUM20; }
inline bool isOperatorTok(uint8_t t) { return t >= T_ADD && t <= T_EQ; }  // = included, as in EVALUATOR_MARKS

// ── Physical tile kinds: what sits in the bag / rack ─────────────────────────
// 0..20 number tiles, then operators, choice tiles, equals, blank.
enum TileKind : uint8_t {
  K_NUM0 = 0,
  K_NUM20 = 20,
  K_ADD = 21,
  K_SUB = 22,
  K_MUL = 23,
  K_DIV = 24,
  K_PM = 25,     // "+/-"  assigns to + or -
  K_MD = 26,     // "x/÷"  assigns to × or ÷
  K_EQUALS = 27, // "="
  K_BLANK = 28,  // "?"    assigns to any of the 26 assigned tokens
  KIND_COUNT = 29,
  K_NONE = 255,
};

constexpr std::array<uint8_t, KIND_COUNT> TILE_COUNTS = {
    // 0..9
    5, 6, 6, 5, 5, 4, 4, 4, 4, 4,
    // 10..20
    2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1,
    // + - × ÷
    4, 4, 4, 4,
    // +/-  x/÷  =  ?
    5, 4, 11, 4};

constexpr std::array<uint8_t, KIND_COUNT> TILE_POINTS = {
    // 0..9
    1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    // 10..20
    3, 4, 3, 6, 4, 4, 4, 6, 4, 7, 5,
    // + - × ÷
    2, 2, 2, 2,
    // +/-  x/÷  =  ?
    1, 1, 1, 0};

constexpr int TOTAL_TILES = 100;  // sum of TILE_COUNTS
constexpr int RACK_SIZE = 8;
constexpr int BINGO_BONUS = 40;
constexpr int EXCHANGE_MIN_RESERVE = 5;
constexpr int NO_SCORE_STREAK_LENGTH = 6;  // versus: 3 per side

// Whether a physical tile needs an assignment before evaluating.
inline bool kindNeedsAssignment(uint8_t k) {
  return k == K_PM || k == K_MD || k == K_BLANK;
}

// Fixed assignment of non-choice tiles (K_NUM* -> number, K_ADD -> +, ...).
inline uint8_t kindFixedToken(uint8_t k) {
  if (k <= K_NUM20) return k;
  switch (k) {
    case K_ADD: return T_ADD;
    case K_SUB: return T_SUB;
    case K_MUL: return T_MUL;
    case K_DIV: return T_DIV;
    case K_EQUALS: return T_EQ;
    default: return T_NONE;
  }
}

// Assignment domain per kind, as a 26-bit mask over AssignedToken.
inline uint32_t kindAssignMask(uint8_t k) {
  if (k == K_BLANK) return (1u << ASSIGNED_COUNT) - 1;
  if (k == K_PM) return (1u << T_ADD) | (1u << T_SUB);
  if (k == K_MD) return (1u << T_MUL) | (1u << T_DIV);
  uint8_t t = kindFixedToken(k);
  return t == T_NONE ? 0 : (1u << t);
}

// ── String mapping (matching EQ-Lab display tokens) ──────────────────────────

inline std::string assignedTokenToString(uint8_t t) {
  if (isNumberTok(t)) return std::to_string(static_cast<int>(t));
  switch (t) {
    case T_ADD: return "+";
    case T_SUB: return "-";
    case T_MUL: return "×";
    case T_DIV: return "÷";
    case T_EQ: return "=";
    default: return "?";
  }
}

inline int assignedTokenFromString(std::string_view s) {
  if (s == "+") return T_ADD;
  if (s == "-") return T_SUB;
  if (s == "×" || s == "*" || s == "x") return T_MUL;
  if (s == "÷" || s == "/") return T_DIV;
  if (s == "=") return T_EQ;
  // numbers "0".."20"
  if (s.empty() || s.size() > 2) return -1;
  int v = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return -1;
    v = v * 10 + (c - '0');
  }
  return v <= 20 ? v : -1;
}

// EQ-Lab AmathToken keys: "0".."20", "+", "-", "x", "/", "+/-", "x//", "=", "?"
inline int tileKindFromString(std::string_view s) {
  if (s == "+") return K_ADD;
  if (s == "-") return K_SUB;
  if (s == "x" || s == "×") return K_MUL;
  if (s == "/" || s == "÷") return K_DIV;
  if (s == "+/-") return K_PM;
  if (s == "x//" || s == "x/÷" || s == "×/÷") return K_MD;
  if (s == "=") return K_EQUALS;
  if (s == "?") return K_BLANK;
  if (s.empty() || s.size() > 2) return -1;
  int v = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return -1;
    v = v * 10 + (c - '0');
  }
  return v <= 20 ? v : -1;
}

inline std::string tileKindToString(uint8_t k) {
  if (k <= K_NUM20) return std::to_string(static_cast<int>(k));
  switch (k) {
    case K_ADD: return "+";
    case K_SUB: return "-";
    case K_MUL: return "x";
    case K_DIV: return "/";
    case K_PM: return "+/-";
    case K_MD: return "x//";
    case K_EQUALS: return "=";
    case K_BLANK: return "?";
    default: return "?";
  }
}

}  // namespace amath
