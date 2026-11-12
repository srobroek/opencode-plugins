# Bad tests and their fixes

Read when you write, review or prune tests and need a concrete example of a test to
refuse. Each entry shows a bad test, the reason it fails, and the fix. The examples use
TypeScript with Vitest; the patterns hold in every language. Framework pitfalls are in
the `lang-<language>-testing` skill's `references/practice.md`.

## Checks that code is gone

```ts
test("legacy export is gone", async () => {
  const mod = await import("./billing")
  expect("legacyTotal" in mod).toBe(false)
})
```

The build and the deleted call sites already prove the removal. The test protects no
behavior and stays in the suite forever. Delete it together with `legacyTotal` and the
tests of `legacyTotal`. When the removal is a requirement, test the outcome:

```ts
test("the retired v1 endpoint answers 410 Gone", async () => {
  const res = await app.request("/v1/invoices")
  expect(res.status).toBe(410)
})
```

## Expected value copied from the code

```ts
test("adds VAT", () => {
  const net = 100
  expect(withVat(net)).toBe(net + net * VAT_RATE)
})
```

The test repeats the formula, so a wrong rate or a wrong formula passes. Write the value
that the requirement gives:

```ts
test("adds 21% VAT to a net amount", () => {
  expect(withVat(100)).toBe(121)
})
```

## Mocked collaborators and call checks

```ts
test("checkout", async () => {
  const repo = { load: vi.fn().mockResolvedValue(cart), save: vi.fn() }
  await checkout(repo, "c1")
  expect(repo.load).toHaveBeenCalledWith("c1")
  expect(repo.save).toHaveBeenCalledTimes(1)
})
```

The test checks the call graph, which callers never see. A cache in front of `load`
breaks it, and a `save` of the wrong state passes it. Use a fake and check the state that
callers see:

```ts
test("checkout marks the cart paid", async () => {
  const repo = new InMemoryCarts([cart])
  await checkout(repo, "c1")
  expect((await repo.load("c1")).status).toBe("paid")
})
```

## Checks around the interface

```ts
test("create stores the user", async () => {
  await users.create({ email: "a@example.com" })
  const rows = await db.query("SELECT email FROM users")
  expect(rows).toEqual([{ email: "a@example.com" }])
})
```

The test depends on the table layout although `users.findByEmail` exists. Check through
the read operation:

```ts
test("a created user can be found by email", async () => {
  await users.create({ email: "a@example.com" })
  expect(await users.findByEmail("a@example.com")).toMatchObject({ email: "a@example.com" })
})
```

## Copies instead of parameters

```ts
test("slug of an empty string", () => expect(slug("")).toBe(""))
test("slug of one word", () => expect(slug("Hello")).toBe("hello"))
test("slug of two words", () => expect(slug("Hello World")).toBe("hello-world"))
```

The three tests differ only in data. Use one parametrized test with readable case names:

```ts
test.each([
  { input: "", expected: "" },
  { input: "Hello", expected: "hello" },
  { input: "Hello World", expected: "hello-world" },
])("slug($input) is $expected", ({ input, expected }) => {
  expect(slug(input)).toBe(expected)
})
```

## Logic in the test

```ts
test.each(sampleOrders)("discount for %o", (order) => {
  if (order.total > 100) expect(discount(order)).toBe(10)
  else expect(discount(order)).toBe(0)
})
```

The test re-implements the rule, and the case list hides which boundary it checks.
State each case and its expected value:

```ts
test.each([
  { total: 100, expected: 0 },
  { total: 101, expected: 10 },
])("a $total total gets a $expected discount", ({ total, expected }) => {
  expect(discount(anOrder({ total }))).toBe(expected)
})
```

## Sleeps

```ts
test("debounced save runs once", async () => {
  editor.type("a")
  editor.type("b")
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(store.saves).toBe(1)
})
```

The test is slow, and it fails on a loaded machine. Control the clock:

```ts
test("debounced save runs once", async () => {
  vi.useFakeTimers() // afterEach(() => vi.useRealTimers()) restores the clock
  editor.type("a")
  editor.type("b")
  await vi.advanceTimersByTimeAsync(500)
  expect(store.saves).toBe(1)
})
```

## No assertion

```ts
test("parses the config", () => {
  parseConfig(readFixture("config.toml"))
})
```

The test passes for any result that does not throw. Assert the outcome:

```ts
test("parses the port and the host", () => {
  expect(parseConfig('port = 8080\nhost = "localhost"')).toEqual({ port: 8080, host: "localhost" })
})
```

## Several behaviors in one test

```ts
test("cart", () => {
  const cart = new Cart()
  cart.add(apple)
  expect(cart.total()).toBe(1.5)
  cart.remove(apple)
  expect(cart.isEmpty()).toBe(true)
  expect(() => cart.remove(apple)).toThrow(NotInCart)
})
```

A failure does not say which behavior broke, and later checks depend on earlier steps.
Write one test for each behavior:

```ts
test("adding an item adds its price to the total", () => { /* ... */ })
test("removing the last item empties the cart", () => { /* ... */ })
test("removing an item that is not in the cart throws NotInCart", () => { /* ... */ })
```

## Hidden test data

```ts
test("rejects an overdrawn account", async () => {
  const account = await accounts.load("acct-42") // seeded by a global fixture
  expect(() => account.withdraw(50)).toThrow(Overdrawn)
})
```

The outcome depends on a balance that the test does not show. Build the data in the
test:

```ts
test("rejects a withdrawal larger than the balance", () => {
  const account = anAccount({ balance: 20 })
  expect(() => account.withdraw(50)).toThrow(Overdrawn)
})
```

## Checks that the type checker already makes

```ts
test("an invoice has a string id", () => {
  const invoice: Invoice = makeInvoice()
  expect(typeof invoice.id).toBe("string")
})
```

`tsc` already proves the type. Delete the test. Test runtime validation of untrusted
input instead:

```ts
test("rejects a payload without an id", () => {
  expect(InvoiceSchema.safeParse({ total: 10 }).success).toBe(false)
})
```

## Tampering

```diff
-  expect(roundTotal(10.005)).toBe(10.01)
+  expect(roundTotal(10.005)).toBe(10)
-  expect(parse(input).count).toBe(3)
+  expect(parse(input).count).toBeDefined()
```

The first change edits the expected value to match new output. The second one loosens
the assertion so that any count passes. Without a requirement that changed the
behavior, keep the assertions and fix the code. When the requirement did change, name
it in the pull request and keep an exact expected value.

## Snapshot of a whole object

```ts
test("renders the invoice", () => {
  expect(buildInvoice(order)).toMatchSnapshot()
})
```

The snapshot holds hundreds of lines, timestamps and ids. Reviewers accept each update
without reading it. Assert the part that the behavior is about:

```ts
test("the invoice lists each line with its total", () => {
  const invoice = buildInvoice(anOrder({ lines: [{ sku: "A", qty: 2, price: 3 }] }))
  expect(invoice.lines).toEqual([{ sku: "A", total: 6 }])
})
```
