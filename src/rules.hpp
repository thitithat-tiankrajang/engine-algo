// Shared Constraint Core: the single source of truth for A-Math legality and
// scoring. Semantics mirror EQ-Lab src/game.ts (validateMove/detectEquations/
// validateEquationTokens/conditionReason/safeEvalFlat/scoreEquationCells),
// with one deliberate upgrade: equation balance is decided with EXACT rational
// arithmetic instead of float-epsilon comparison.
#pragma once

#include <array>
#include <cassert>
#include <string>
#include <vector>

#include "board.hpp"
#include "prof.hpp"
#include "rational.hpp"
#include "tiles.hpp"

namespace amath {

// ── Line (single equation run) validation ────────────────────────────────────

enum class LineError : uint8_t {
  None = 0,
  MissingEquals,
  StartsWithOperator,
  EndsWithOperator,
  AdjacentOperators,
  TensAdjacency,
  DivideByZeroLiteral,
  NegativeZero,
  NumberTooLong,
  LeadingZero,
  CannotEvaluate,
  NotBalanced,
};

struct LineResult {
  bool valid = false;
  LineError error = LineError::None;
  Rational value;  // common value when valid
};

// Incremental structural state, usable token-by-token during generation.
struct LineState {
  uint8_t lastToken = T_NONE;
  uint8_t unitRunLen = 0;        // consecutive unit-digit tokens
  bool unitRunLeadsZero = false; // first digit of the current unit run is 0
  bool lastSubWasUnary = false;  // last token is '-' at start or right after '='
  uint8_t equalsCount = 0;
  uint8_t length = 0;

  // Try to append `token`; returns false when the prefix becomes structurally
  // illegal (the caller must treat the state as unchanged on failure).
  bool advance(uint8_t token) {
    const uint8_t prev = lastToken;
    const bool prevIsOp = prev != T_NONE && isOperatorTok(prev);
    if (length == 0) {
      if (isOperatorTok(token) && token != T_SUB) return false;
    }
    if (prevIsOp && isOperatorTok(token)) {
      if (!(prev == T_EQ && token == T_SUB)) return false;
    }
    if (prev != T_NONE && isNumberTok(prev) && isNumberTok(token)) {
      if (isTensTok(prev) || isTensTok(token)) return false;  // 10-20 adjacency
    }
    if (prev == T_DIV && token == 0) return false;                    // "/0"
    if (prev == T_SUB && lastSubWasUnary && token == 0) return false; // "-0"

    if (isUnitTok(token)) {
      const bool continuing = prev != T_NONE && isUnitTok(prev);
      const uint8_t runLen = continuing ? static_cast<uint8_t>(unitRunLen + 1) : 1;
      const bool leadsZero = continuing ? unitRunLeadsZero : token == 0;
      if (runLen > 3) return false;               // numbers cannot exceed 3 digits
      if (runLen >= 2 && leadsZero) return false; // leading zero
      unitRunLen = runLen;
      unitRunLeadsZero = leadsZero;
    } else {
      unitRunLen = 0;
      unitRunLeadsZero = false;
    }
    lastSubWasUnary = token == T_SUB && (length == 0 || prev == T_EQ);
    if (token == T_EQ) equalsCount++;
    lastToken = token;
    length++;
    return true;
  }

  // A structurally-complete line additionally needs '=' and a non-operator end.
  bool complete() const {
    return length >= 2 && equalsCount > 0 && !isOperatorTok(lastToken);
  }
};

// Evaluate a structurally valid line: split on '=', evaluate each side with
// standard precedence (× ÷ pass, then + - pass, both left-to-right; a leading
// '-' acts through an implicit 0), and require all side values to be equal.
inline PROF_NOINLINE LineResult evaluateLine(const uint8_t* tokens, int n) {
  LineResult res;
  Rational common;
  bool haveCommon = false;

  // Allocation-free temporaries. Bound proof (from game geometry, not a guess):
  // a line/run occupies distinct cells of a single row or column, so it holds at
  // most BOARD_SIZE tokens; every caller passes n <= BOARD_SIZE. A side (tokens
  // between '=' separators) is <= n tokens. Per side each of the four containers
  // is filled by at most one entry per consumed token plus at most one synthetic
  // leading-'-' entry, so each holds <= (side length)+1 <= BOARD_SIZE+1 entries.
  // CAP = BOARD_SIZE + 1 therefore can never be exceeded; indices past the live
  // count are never read. (Same values, order, and arithmetic as the previous
  // std::vector form — this only changes storage.)
  constexpr int CAP = BOARD_SIZE + 1;
  assert(n <= BOARD_SIZE && "evaluateLine: line exceeds board length");

  int i = 0;
  while (i <= n) {
    // one side: tokens[i..j) until '=' or end
    int j = i;
    while (j < n && tokens[j] != T_EQ) j++;
    if (j == i) {  // empty side
      res.error = LineError::CannotEvaluate;
      return res;
    }

    // Parse numbers/operators. A leading '-' becomes 0 - ....
    std::array<Rational, CAP> nums;
    std::array<uint8_t, CAP> ops;
    int numsN = 0, opsN = 0;
    int p = i;
    if (tokens[p] == T_SUB) {
      nums[numsN++] = Rational::fromInt(0);
      ops[opsN++] = T_SUB;
      p++;
    }
    while (p < j) {
      uint8_t t = tokens[p];
      if (isUnitTok(t)) {
        int64_t v = 0;
        while (p < j && isUnitTok(tokens[p])) {
          v = v * 10 + tokens[p];
          p++;
        }
        nums[numsN++] = Rational::fromInt(v);
      } else if (isTensTok(t)) {
        nums[numsN++] = Rational::fromInt(t);
        p++;
      } else {  // operator
        ops[opsN++] = t;
        p++;
      }
    }
    if (numsN != opsN + 1) {
      res.error = LineError::CannotEvaluate;
      return res;
    }

    // Pass 1: × and ÷.
    std::array<Rational, CAP> rn;
    std::array<uint8_t, CAP> ro;
    int rnN = 0, roN = 0;
    rn[rnN++] = nums[0];
    for (int k = 0; k < opsN; k++) {
      const Rational& right = nums[k + 1];
      if (ops[k] == T_MUL) {
        rn[rnN - 1] = rn[rnN - 1] * right;
      } else if (ops[k] == T_DIV) {
        rn[rnN - 1] = rn[rnN - 1] / right;
      } else {
        ro[roN++] = ops[k];
        rn[rnN++] = right;
      }
    }
    // Pass 2: + and -.
    Rational value = rn[0];
    for (int k = 0; k < roN; k++) {
      value = ro[k] == T_ADD ? value + rn[k + 1] : value - rn[k + 1];
    }
    if (!value.isValid()) {
      res.error = LineError::CannotEvaluate;
      return res;
    }
    if (!haveCommon) {
      common = value;
      haveCommon = true;
    } else if (!(common == value)) {
      res.error = LineError::NotBalanced;
      return res;
    }
    i = j + 1;  // skip '='
  }

  res.valid = true;
  res.value = common;
  return res;
}

// Full validation of one run of assigned tokens (structure + arithmetic).
inline PROF_NOINLINE LineResult validateLine(const uint8_t* tokens, int n) {
  LineResult res;
  LineState st;
  for (int i = 0; i < n; i++) {
    if (!st.advance(tokens[i])) {
      res.error = LineError::AdjacentOperators;  // generic structural failure
      return res;
    }
  }
  if (st.equalsCount == 0) {
    res.error = LineError::MissingEquals;
    return res;
  }
  if (isOperatorTok(tokens[n - 1])) {
    res.error = LineError::EndsWithOperator;
    return res;
  }
  return evaluateLine(tokens, n);
}

// ── Moves ────────────────────────────────────────────────────────────────────

struct Placement {
  uint8_t row = 0;
  uint8_t col = 0;
  uint8_t kind = K_NONE;   // physical tile used from the rack
  uint8_t token = T_NONE;  // resolved assigned token
};

enum class MoveType : uint8_t { Place = 0, Exchange = 1, Pass = 2 };

struct Move {
  MoveType type = MoveType::Pass;
  std::vector<Placement> placements;      // for Place
  std::vector<uint8_t> exchangeKinds;     // for Exchange
  int score = 0;                          // immediate score incl. bingo
};

struct MoveValidation {
  bool valid = false;
  int score = 0;
  int bingo = 0;
  int equationCount = 0;
  std::string error;
};

// Score one run [start..start+len) along `dir` (0 = horizontal, 1 = vertical)
// given a predicate for "new" cells. Premiums apply to new cells only.
struct RunScore {
  int score = 0;
};

// Full move validation against a board — mirrors game.ts validateMove.
// Placement tokens must already be resolved (kind + assigned token).
MoveValidation validatePlaceMove(const Board& board, const std::vector<Placement>& placements);

}  // namespace amath
