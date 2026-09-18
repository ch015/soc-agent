# SOC investigation evidence-review method

1. Read only `01_soc_investigation_snapshot.json` from the exact host allow-list.
2. Check exact tenant/time scope, query IDs, pagination/coverage, subjects, directions, and locators.
3. Record gaps and contradictions before any candidate analysis exists.
4. Do not import fixed thresholds, timezone assumptions, business-hour rules, or service-account exclusions.
5. Return only the investigation evidence-review schema.
