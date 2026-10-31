// shared/invariants.qnt — reusable invariant predicates shared across specs.
//
// These are `def`s (functions), so the generator inlines them as helper defs; a
// consuming spec writes `val X: bool = nonNegative(cursor)`. A `val` in a
// shared module would be inlined as an invariant into every importer, so this
// module stays declarative and leaves the `val` to each spec.
//
// Pure defs only: import it with `import invariants.* from "../shared/invariants"`.
module invariants {
  def nonNegative(x: int): bool = x >= 0
  def nonPositive(x: int): bool = x <= 0
  def positive(x: int): bool = x > 0
  def inRange(x: int, low: int, high: int): bool = and(x >= low, x <= high)
  def monotone(after: int, previous: int): bool = after >= previous
  def implication(condition: bool, consequence: bool): bool =
    or(not(condition), consequence)
  def exclusive(a: bool, b: bool): bool = neq(a, b)
  def unchanged(after: str, previous: str): bool = after == previous
}
