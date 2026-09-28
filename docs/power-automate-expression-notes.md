# Power Automate expression notes

Learned the hard way building `QAACCESS_READ_URL` — worth checking before building the remaining six flows (episodes, rooms, sessions read/write).

## 1. Two box types, two different rules

- **Popup box** — clicking it opens a floating panel with **Function** / **Dynamic content** tabs. Type the formula **without** a leading `@`. After confirming, it turns into a colored pill/token — that's your visual proof it registered as a real formula, not text.
  - Example: `length(body('Filter_array'))`
- **Plain box** — no popup appears; either a literal value typed directly (`0`, `True`), or a full expression entered via **"Edit in advanced mode"**.
  - Literal value → just type it, no `@`, no function wrapper.
  - Real formula in this box type → needs `@` at the very start, or it gets stored as inert literal text.
  - Example: `@equals(first(body('Filter_array'))?['active'], 'True')`

**When unsure which type a box is:** click it and see if a popup with those two tabs appears. If yes → no `@`. If no popup → and it's a formula, not a plain value → needs `@`.

## 2. `body(...)` vs `outputs(...)`

Always reach for **`body('StepName')`** to get the actual data (the array, the row object). `outputs('StepName')` returns the *entire* wrapped response — status code, headers, body — and passing that whole object into something like `length()` or `first()` throws a type error ("expects array or string, got Object").

## 3. Step names with spaces become underscores

"Filter array" (the display name) → `Filter_array` in any expression referencing it. Same pattern for any step name with spaces.

## 4. Don't trust Excel's displayed type

A column showing `TRUE`/`FALSE` in Excel's UI can still come through the API as the literal text string `"True"`, not a real boolean. Comparing against the boolean `true` when the actual value is the string `"True"` fails silently (no error, just always evaluates false) — it has to match the actual underlying type.

## 5. When unsure what a value actually is, don't guess — check it

Add a throwaway **Compose** action right after the step in question, give it the expression you're unsure about, save, run a test, then check that Compose step's **Outputs** in run history. That's ground truth — faster than iterating on theories.

## 6. Testing a flow from PowerShell

```powershell
$body = @{ email = "someone@centific.com" } | ConvertTo-Json
Invoke-RestMethod -Uri "<the trigger's HTTP URL, including &sig=...>" -Method Post -ContentType "application/json" -Body $body
```

- The trigger's **"Who can trigger the flow?"** setting must be **"Anyone"**, not "Any user in my tenant" — the latter requires an OAuth token PowerShell isn't sending, and fails with `DirectApiAuthorizationRequired`.
- The working URL always ends in `&sig=...` — if it doesn't, the auth setting is still wrong.
- If a step fails, check **run history** (flow's detail page → click the run → click the red-X step) before changing anything — it shows the exact evaluated inputs, not just pass/fail.
