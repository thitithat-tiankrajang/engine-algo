#pragma once

#include <string>

namespace amath {

// Revision 2 Deep experiments. These are measurement entry points only: they
// call DecisionSearch::benchmark, never the product route, and they never
// change routing. Each prints a table and returns 0 on success.
int runDeepPolicyBench(int positions, const std::string& variantFilter);
int runDeepCreditCurve(int positions);
int runGate6(int positions);
int runGate7(int positions);

}  // namespace amath
