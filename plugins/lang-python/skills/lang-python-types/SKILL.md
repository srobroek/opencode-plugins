---
name: lang-python-types
description: Use for Python typing (mypy or pyright strict, Protocol, TypedDict, pydantic v2 boundary models, datamodel-codegen).
metadata:
  opencode/autoinvoke: false
---

# Python Types

Sources: [mypy configuration](https://mypy.readthedocs.io/en/stable/config_file.html), [pyright configuration](https://microsoft.github.io/pyright/#/configuration), [typing spec](https://typing.python.org/), [pydantic aliases and config](https://docs.pydantic.dev/latest/concepts/alias/) (2.14), [datamodel-code-generator](https://koxudaxi.github.io/datamodel-code-generator/). Examples checked with Python 3.13, mypy strict, pyright strict and pydantic 2.14.

`NewType` IDs, `Annotated` validators and `RootModel` parsing are in the
`quality-code-design` skill's `python.md` reference. This skill is the checker setup,
typing idioms and boundary models. Run the checker as in `lang-python-quality`.

## Strict checker config

```toml
[tool.mypy]
strict = true
plugins = ["pydantic.mypy"]           # when the project uses pydantic

[tool.pyright]
typeCheckingMode = "strict"
```

- Use the checker the project already runs; do not add the second one.
- Adopting strict on an existing codebase: enable it globally and relax per legacy
  module (`[[tool.mypy.overrides]] module = ["shop.legacy.*"]` with
  `disallow_untyped_defs = false`), so new code starts strict.
- Silence a single line with the error code, never bare:
  `# type: ignore[arg-type]` (mypy) or `# pyright: ignore[reportArgumentType]`. mypy's
  strict `warn_unused_ignores` then flags ignores that are no longer needed.
- Untyped third-party packages: install the `types-…` stub package or set
  `ignore_missing_imports` for that module only, not globally.

## Idioms

```python
from typing import Literal, Protocol, TypedDict, assert_never, override

type Status = Literal["pending", "paid", "refunded"]     # 3.12+ alias syntax

def label(status: Status) -> str:
    match status:
        case "pending": return "waiting"
        case "paid": return "done"
        case "refunded": return "returned"
        case _: assert_never(status)                       # a new literal is a type error here

class Clock(Protocol):                                     # structural: no inheritance needed
    def now(self) -> datetime: ...

class Headers(TypedDict, total=False):                     # typed dict shape at a JSON-ish edge
    authorization: str
    x_request_id: str
```

- Generics use 3.12 syntax when the project's minimum allows it:
  `def first[T](items: Sequence[T]) -> T`.
- Accept abstract types (`Sequence`, `Mapping`, `Iterable`), return concrete ones.
- Mark overrides with `@override` (3.12+, or `typing_extensions`) so renaming the base
  method breaks the subclass at check time.
- `Any` turns checking off for everything it touches. At a boundary use `object` and
  narrow, or parse into a model.

## Boundary models with pydantic v2

```python
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

class Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,       # sku_code <-> "skuCode" on the wire
        validate_by_name=True,          # Python code may still pass sku_code=...
        serialize_by_alias=True,        # model_dump() emits camelCase (2.11+)
        extra="forbid",                 # unknown keys are an error, not silently dropped
        frozen=True,
    )

class LineItem(Wire):
    sku_code: str
    quantity: Annotated[int, Field(gt=0)]

items = TypeAdapter(list[LineItem]).validate_json(body)
```

- One base model per wire convention sets the casing once; do not rename fields one by
  one (see the `quality-code-design` skill's `contracts.md` reference).
- Parse with `model_validate_json` / `TypeAdapter.validate_json` (faster than
  `json.loads` then validate, and errors carry the JSON path). `TypeAdapter` handles
  lists, unions and `TypedDict`s without a wrapper model.
- Before 2.11 the same config is `populate_by_name=True`, with `by_alias=True` passed
  to every `model_dump` / `model_dump_json`.
- Keep pydantic at the edges. Domain code takes the parsed model or plain dataclasses,
  not raw dicts, and does not re-validate.

## Generating models from a schema

```sh
uv run datamodel-codegen --input openapi.yaml --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel --output src/shop/_api_models.py
```

Commit the output and regenerate in CI with a `git diff --exit-code` drift check. Never
hand-edit the generated file; subclass or wrap it.
