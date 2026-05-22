# CI Conclusion

GitHub Actions workflow run conclusion types.

## CI_CONCLUSION Constant

```js
import { CI_CONCLUSION } from "@gitwire/core";
```

## All Conclusions

| Conclusion | Constant | Triggers Healing? |
|-----------|----------|-------------------|
| `success` | `CI_CONCLUSION.SUCCESS` | No |
| `failure` | `CI_CONCLUSION.FAILURE` | **Yes** |
| `cancelled` | `CI_CONCLUSION.CANCELLED` | No |
| `neutral` | `CI_CONCLUSION.NEUTRAL` | No |
| `timed_out` | `CI_CONCLUSION.TIMED_OUT` | No |
| `action_required` | `CI_CONCLUSION.ACTION_REQUIRED` | No |

## When Healing Triggers

Only `workflow_run` webhooks with `conclusion: "failure"` trigger the CI healing pipeline.

→ [Guides](/guides/first-triage)
