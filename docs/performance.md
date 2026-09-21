# Performance and capacity

The scale suite is a domain regression test. It builds 500 monthly obligations
over 20 years: 120,000 billing periods, payments and allocations of each kind.
It validates money invariants, queries a month, applies a command, exports the
state and checks a cold JSON restore with integrity verification.

```sh
npm run test:scale
```

The suite prints `AC35_DOMAIN_MEASUREMENTS` with per-stage durations, total time
and serialized bytes. Record the Node version, hardware and concurrent workload
when comparing results. Its broad timing guards catch accidental quadratic
behavior; they are not a product latency guarantee. Peak memory is not measured.

## Current hosted limits

| Boundary                                        | Limit                                              |
| ----------------------------------------------- | -------------------------------------------------- |
| Command body                                    | 1 MiB                                              |
| Incoming JSON / financial family snapshot       | 4 MiB                                              |
| Outgoing JSON                                   | 5 MiB                                              |
| Main API Lambda                                 | 512 MiB, 28-second timeout, reserved concurrency 2 |
| PostgreSQL pool per Lambda environment          | 2 connections                                      |
| Runtime database login                          | 6 connections                                      |
| SQL lock / statement / idle transaction timeout | 5 / 20 / 25 seconds                                |

The large fixture serializes to tens of MiB and exceeds the API snapshot limit.
It establishes in-memory correctness, not end-to-end RDS/Lambda capacity, recovery
readiness or operating cost.

SQL transactions provide atomicity but do not eliminate full-state loading,
copying and validation. Scaling requires measured changes to data access,
normalization, validation granularity and backup streaming. Keep those concerns
separate from the domain regression fixture.
