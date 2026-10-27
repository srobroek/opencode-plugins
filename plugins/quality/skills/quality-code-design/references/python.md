# Python: conditional language guidance

Load only when the task designs, investigates, changes, or reviews Python code. Format, lint, type-check and test commands live in the language plugin's skills when installed.

## Functions, dataclasses, protocols

**Do:** use functions for transformations, dataclasses for records, classes for owned behavior, and protocols where a typed consumer boundary helps.
**Do not:** add abstract base classes for every helper, mutate global clients from domain functions, or assume underscore-prefixed fields enforce runtime privacy.

Bad: `ReportServiceFactory` creates a stateless `ReportService` just to format three fields.
Good: `format_report(record)` is a function.

Good at a real delivery boundary:

```python
from typing import Protocol

class ReportSender(Protocol):
    def send(self, report: str) -> None: ...

def publish(report: str, sender: ReportSender) -> None:
    sender.send(report)
```

Why: structural typing documents the capability without forcing an inheritance hierarchy. Duck typing or a callable can be sufficient for a small local collaboration.

**Exception:** an ABC is useful when runtime enforcement or shared lifecycle behavior is actually required. A frozen dataclass is only shallowly immutable; validate and protect nested mutable data when invariants depend on it.

## Exceptions: one hierarchy per module, chained

**Do:** give a module or package one base exception and specific subclasses for failures callers handle differently. Chain the underlying error with `raise … from err`.
**Do not:** raise bare `Exception`, catch `Exception` and continue as if nothing happened, or re-raise without `from` so the original traceback reads as "during handling another exception occurred".

```python
class BillingError(Exception): ...
class CardDeclined(BillingError): ...

try:
    response = client.charge(order.total)
except httpx.HTTPStatusError as err:
    raise CardDeclined(order.id) from err
```

Why: callers catch `BillingError` without knowing the HTTP client, and the traceback keeps the cause.

## Validated values: NewType and Annotated

**Do:** use `NewType` for IDs the type checker should keep apart, and `Annotated` validators (pydantic) for values with a runtime invariant. Construct them in one place.
**Do not:** pass bare `str` for user IDs, order IDs, and emails interchangeably.

```python
from typing import Annotated, NewType
from pydantic import AfterValidator

UserId = NewType("UserId", str)

def _positive(value: int) -> int:
    if value <= 0:
        raise ValueError("must be positive")
    return value

Quantity = Annotated[int, AfterValidator(_positive)]
```

`NewType` is erased at runtime; it guards static checks only. Use a validator when the invariant must hold for data from outside.

## Parse at the boundary with pydantic

**Do:** parse untrusted input (HTTP bodies, config, queue messages, files) into pydantic models at the edge, using `RootModel` for top-level lists or scalars, and pass the typed model inward.
**Do not:** thread raw `dict[str, Any]` through domain code, or re-validate already-parsed models at every layer.

```python
from pydantic import BaseModel, RootModel

class LineItem(BaseModel):
    sku: str
    quantity: Quantity

Order = RootModel[list[LineItem]]
order = Order.model_validate_json(body)
```

**Exception:** a short script reading its own trusted file can use plain dicts; adopt pydantic when input crosses a trust boundary or the shape is shared.
