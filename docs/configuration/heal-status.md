# Heal Status

Status values for CI run healing.

## HEAL_STATUS Constant

```js
import { HEAL_STATUS } from "@gitwire/core";
```

## All Statuses

| Status | Constant | Description |
|--------|----------|-------------|
| `pending` | `HEAL_STATUS.PENDING` | Newly detected, not yet processed |
| `attempted` | `HEAL_STATUS.ATTEMPTED` | Healing in progress |
| `healed` | `HEAL_STATUS.HEALED` | Successfully healed (PR opened) |
| `failed` | `HEAL_STATUS.FAILED` | Healing attempted but failed |
| `skipped` | `HEAL_STATUS.SKIPPED` | Failure type not auto-healable |

## Lifecycle

```
pending → attempted → healed
pending → attempted → failed
pending → skipped
```

→ [Failure Types](/configuration/failure-types)
