# Multi-file Debug Scenario

This scenario is designed to test coding-agent behavior with:
- multiple entry tasks
- cross-file dependency bugs
- requirement to read multiple files before one mutation

## Files

- `task_revenue.py`
- `task_incidents.py`
- `services/revenue.py`
- `services/incidents.py`
- `lib/date_span.py`  <-- root cause lives here

## Expected behavior (after fix)

- `python3 task_revenue.py` should print: `revenue/day: 1200.0`
- `python3 task_incidents.py` should print: `incidents/day: 7.0`

## Reproduce bug

```bash
cd task/multi_debug
python3 task_revenue.py
python3 task_incidents.py
```

Both currently fail with division by zero.
