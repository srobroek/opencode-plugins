# Other language paradigms

Load only the section matching the code under discussion. TypeScript and JavaScript are in [typescript.md](typescript.md), Python in [python.md](python.md). These examples illustrate portable design principles, not required frameworks.

## Java and C#

**Do:** use cohesive classes, records/value objects, narrow interfaces at real boundaries, and ordinary constructor injection.
**Do not:** add an interface, factory, abstract factory, and service wrapper to each concrete class by convention alone.

Bad: a formatter with no state or variation is wrapped in five layers and resolved through a service locator.
Good: a direct static/pure method, or the project's ordinary formatter object if framework conventions make that simpler.

Bad: a mutable `Money` object permits changing its currency without converting its amount.
Good: an immutable value object validates currency/amount together and exposes deliberate operations.

**Exception:** framework interfaces, proxies, and lifecycle hooks can be necessary. Name the framework requirement and retain the smallest structure that fulfills it; do not remove it based only on one implementation.

## Functional languages and functional application code

**Do:** use pure transformations, algebraic data types, opaque modules, and explicit effects to express invariants and boundaries.
**Do not:** simulate OOP with records of setters or force all effects through a custom abstraction framework.

Bad: a pricing function fetches the exchange rate, reads the clock, and mutates a shared cache while appearing to calculate a value.
Good: the application boundary fetches inputs; `price(order, rate, now)` calculates the result. Keep an existing effect system when it already expresses these needs clearly.

Bad: `status: string` plus unrelated nullable payload fields.
Good: a sum type with one valid payload per state and exhaustive pattern matching.

Why: explicit inputs and effects permit local reasoning; composition and substitution do not require inheritance.

**Exception:** tightly coupled effectful operations can stay together when their transaction or resource lifetime is the responsibility being protected. Purity is a means, not a demand for needless layers.

## C and procedural modules

**Do:** use cohesive translation units, opaque structs where invariants matter, explicit context parameters, and documented ownership/error results.
**Do not:** expose every mutable struct field to every caller or add function-pointer vtables to all small helpers.

Bad: callers reach into queue internals to edit head/tail pointers independently.
Good: the header exposes an opaque `Queue` and operations such as `queue_push`/`queue_pop`; implementation owns the representation and consistency checks.

Bad: a trivial checksum helper gets a polymorphic plugin ABI without a plugin requirement.
Good: a direct function with a length-aware input and a clear result contract.

**Exception:** plain structs suit transparent value records and performance-critical data layouts. State who owns memory and which code is allowed to mutate it; do not hide representation when that is the API's legitimate purpose.
