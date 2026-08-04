// Minimal JSON parser/serializer — just enough for the engine protocol.
// Supports objects, arrays, strings (with \u escapes), numbers (int64/double),
// booleans and null. No external dependencies.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace amath::json {

struct Value;
using ValuePtr = std::shared_ptr<Value>;

struct Value {
  enum class Type { Null, Bool, Int, Double, String, Array, Object } type = Type::Null;
  bool b = false;
  int64_t i = 0;
  double d = 0;
  std::string s;
  std::vector<ValuePtr> arr;
  std::map<std::string, ValuePtr> obj;

  bool isNumber() const { return type == Type::Int || type == Type::Double; }
  int64_t asInt(int64_t fallback = 0) const {
    if (type == Type::Int) return i;
    if (type == Type::Double) return static_cast<int64_t>(d);
    return fallback;
  }
  double asDouble(double fallback = 0) const {
    if (type == Type::Double) return d;
    if (type == Type::Int) return static_cast<double>(i);
    return fallback;
  }
  bool asBool(bool fallback = false) const { return type == Type::Bool ? b : fallback; }
  const std::string& asString() const {
    static const std::string empty;
    return type == Type::String ? s : empty;
  }
  ValuePtr get(const std::string& key) const {
    auto it = obj.find(key);
    return it == obj.end() ? nullptr : it->second;
  }
};

inline ValuePtr makeInt(int64_t v) {
  auto p = std::make_shared<Value>();
  p->type = Value::Type::Int;
  p->i = v;
  return p;
}
inline ValuePtr makeDouble(double v) {
  auto p = std::make_shared<Value>();
  p->type = Value::Type::Double;
  p->d = v;
  return p;
}
inline ValuePtr makeBool(bool v) {
  auto p = std::make_shared<Value>();
  p->type = Value::Type::Bool;
  p->b = v;
  return p;
}
inline ValuePtr makeString(std::string v) {
  auto p = std::make_shared<Value>();
  p->type = Value::Type::String;
  p->s = std::move(v);
  return p;
}
inline ValuePtr makeArray() {
  auto p = std::make_shared<Value>();
  p->type = Value::Type::Array;
  return p;
}
inline ValuePtr makeObject() {
  auto p = std::make_shared<Value>();
  p->type = Value::Type::Object;
  return p;
}

// ── parsing ──────────────────────────────────────────────────────────────────

class Parser {
 public:
  explicit Parser(const std::string& text) : text_(text) {}

  ValuePtr parse() {
    skipWs();
    ValuePtr v = parseValue();
    return v;
  }

 private:
  const std::string& text_;
  size_t pos_ = 0;

  char peek() const { return pos_ < text_.size() ? text_[pos_] : '\0'; }
  char next() { return pos_ < text_.size() ? text_[pos_++] : '\0'; }
  void skipWs() {
    while (pos_ < text_.size() &&
           (text_[pos_] == ' ' || text_[pos_] == '\t' || text_[pos_] == '\n' || text_[pos_] == '\r'))
      pos_++;
  }

  ValuePtr parseValue() {
    switch (peek()) {
      case '{': return parseObject();
      case '[': return parseArray();
      case '"': return makeString(parseString());
      case 't': pos_ += 4; return makeBool(true);
      case 'f': pos_ += 5; return makeBool(false);
      case 'n': pos_ += 4; return std::make_shared<Value>();
      default: return parseNumber();
    }
  }

  ValuePtr parseObject() {
    auto v = makeObject();
    next();  // {
    skipWs();
    if (peek() == '}') {
      next();
      return v;
    }
    while (true) {
      skipWs();
      std::string key = parseString();
      skipWs();
      next();  // :
      skipWs();
      v->obj[key] = parseValue();
      skipWs();
      if (peek() == ',') {
        next();
        continue;
      }
      next();  // }
      break;
    }
    return v;
  }

  ValuePtr parseArray() {
    auto v = makeArray();
    next();  // [
    skipWs();
    if (peek() == ']') {
      next();
      return v;
    }
    while (true) {
      skipWs();
      v->arr.push_back(parseValue());
      skipWs();
      if (peek() == ',') {
        next();
        continue;
      }
      next();  // ]
      break;
    }
    return v;
  }

  std::string parseString() {
    std::string out;
    next();  // "
    while (pos_ < text_.size()) {
      char c = next();
      if (c == '"') break;
      if (c == '\\') {
        char e = next();
        switch (e) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'u': {
            unsigned code = 0;
            for (int k = 0; k < 4; k++) {
              char h = next();
              code <<= 4;
              if (h >= '0' && h <= '9') code |= h - '0';
              else if (h >= 'a' && h <= 'f') code |= h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') code |= h - 'A' + 10;
            }
            // UTF-8 encode (BMP only; enough for our tokens like ×, ÷).
            if (code < 0x80) {
              out += static_cast<char>(code);
            } else if (code < 0x800) {
              out += static_cast<char>(0xC0 | (code >> 6));
              out += static_cast<char>(0x80 | (code & 0x3F));
            } else {
              out += static_cast<char>(0xE0 | (code >> 12));
              out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
              out += static_cast<char>(0x80 | (code & 0x3F));
            }
            break;
          }
          default: out += e; break;
        }
      } else {
        out += c;
      }
    }
    return out;
  }

  ValuePtr parseNumber() {
    size_t start = pos_;
    bool isDouble = false;
    if (peek() == '-') next();
    while (pos_ < text_.size()) {
      char c = peek();
      if ((c >= '0' && c <= '9')) {
        next();
      } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
        isDouble = true;
        next();
      } else {
        break;
      }
    }
    const std::string num = text_.substr(start, pos_ - start);
    if (isDouble) return makeDouble(std::stod(num));
    return makeInt(std::stoll(num));
  }
};

inline ValuePtr parse(const std::string& text) { return Parser(text).parse(); }

// ── serialization ────────────────────────────────────────────────────────────

inline void serialize(const ValuePtr& v, std::ostringstream& out) {
  if (!v || v->type == Value::Type::Null) {
    out << "null";
    return;
  }
  switch (v->type) {
    case Value::Type::Bool: out << (v->b ? "true" : "false"); break;
    case Value::Type::Int: out << v->i; break;
    case Value::Type::Double: out << v->d; break;
    case Value::Type::String: {
      out << '"';
      for (char c : v->s) {
        switch (c) {
          case '"': out << "\\\""; break;
          case '\\': out << "\\\\"; break;
          case '\n': out << "\\n"; break;
          case '\t': out << "\\t"; break;
          case '\r': out << "\\r"; break;
          default:
            if (static_cast<unsigned char>(c) < 0x20) {
              char buf[8];
              std::snprintf(buf, sizeof(buf), "\\u%04x", c);
              out << buf;
            } else {
              out << c;  // UTF-8 bytes pass through
            }
        }
      }
      out << '"';
      break;
    }
    case Value::Type::Array: {
      out << '[';
      for (size_t i = 0; i < v->arr.size(); i++) {
        if (i) out << ',';
        serialize(v->arr[i], out);
      }
      out << ']';
      break;
    }
    case Value::Type::Object: {
      out << '{';
      bool first = true;
      for (const auto& [k, val] : v->obj) {
        if (!first) out << ',';
        first = false;
        out << '"' << k << "\":";
        serialize(val, out);
      }
      out << '}';
      break;
    }
    default: out << "null";
  }
}

inline std::string stringify(const ValuePtr& v) {
  std::ostringstream out;
  serialize(v, out);
  return out.str();
}

}  // namespace amath::json
