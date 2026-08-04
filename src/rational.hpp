// Exact rational arithmetic for A-Math equation evaluation.
//
// The engine is the single source of truth for equation equality, and equality
// is defined over exact rationals (no floating point anywhere). Values are
// normalized fractions num/den with den > 0 and gcd(|num|, den) == 1.
//
// Overflow policy: all products go through __int128. If a normalized result
// no longer fits in int64, the value becomes invalid() and every operation on
// an invalid value stays invalid — the surrounding equation is then rejected,
// which matches "cannot be evaluated". Board geometry (numbers <= 999, at most
// 15 tokens per line) keeps genuine equations far away from this bound.
#pragma once

#include <cstdint>
#include <numeric>

namespace amath {

struct Rational {
  int64_t num = 0;
  int64_t den = 1;  // den == 0 marks an invalid value

  static Rational invalid() { return Rational{0, 0}; }
  static Rational fromInt(int64_t v) { return Rational{v, 1}; }

  bool isValid() const { return den != 0; }
  bool isZero() const { return den != 0 && num == 0; }

  bool operator==(const Rational& o) const {
    // Invalid never equals anything, including another invalid.
    if (den == 0 || o.den == 0) return false;
    return num == o.num && den == o.den;  // both are normalized
  }
};

namespace detail {

inline bool fitsInt64(__int128 v) {
  return v >= static_cast<__int128>(INT64_MIN) && v <= static_cast<__int128>(INT64_MAX);
}

inline Rational normalize(__int128 num, __int128 den) {
  if (den == 0) return Rational::invalid();
  if (den < 0) {
    num = -num;
    den = -den;
  }
  __int128 a = num < 0 ? -num : num;
  __int128 b = den;
  while (b != 0) {
    __int128 t = a % b;
    a = b;
    b = t;
  }
  if (a > 1) {
    num /= a;
    den /= a;
  }
  if (!fitsInt64(num) || !fitsInt64(den)) return Rational::invalid();
  return Rational{static_cast<int64_t>(num), static_cast<int64_t>(den)};
}

}  // namespace detail

inline Rational operator+(const Rational& a, const Rational& b) {
  if (!a.isValid() || !b.isValid()) return Rational::invalid();
  return detail::normalize(
      static_cast<__int128>(a.num) * b.den + static_cast<__int128>(b.num) * a.den,
      static_cast<__int128>(a.den) * b.den);
}

inline Rational operator-(const Rational& a, const Rational& b) {
  if (!a.isValid() || !b.isValid()) return Rational::invalid();
  return detail::normalize(
      static_cast<__int128>(a.num) * b.den - static_cast<__int128>(b.num) * a.den,
      static_cast<__int128>(a.den) * b.den);
}

inline Rational operator*(const Rational& a, const Rational& b) {
  if (!a.isValid() || !b.isValid()) return Rational::invalid();
  return detail::normalize(static_cast<__int128>(a.num) * b.num,
                           static_cast<__int128>(a.den) * b.den);
}

inline Rational operator/(const Rational& a, const Rational& b) {
  if (!a.isValid() || !b.isValid() || b.num == 0) return Rational::invalid();
  return detail::normalize(static_cast<__int128>(a.num) * b.den,
                           static_cast<__int128>(a.den) * b.num);
}

}  // namespace amath
