# Contributing to Domovoy

Start with the [local development guide](docs/local-development.md) and the
[architecture](docs/architecture.md). For a substantial change, open an issue
describing the problem and proposed behavior before implementing it.

## Development workflow

1. Create a branch from the repository's default branch.
2. Install the Node.js version in `.nvmrc`, then run `npm ci`.
3. Make a focused change. Keep financial rules in `src/domain`, authorization and
   transactions in `src/aws`, and presentation in `src/client`.
4. Add or adjust regression tests when behavior changes.
5. Run `npm run format`, `npm run build`, and `npm run test:quick`.
6. Run the relevant browser, scale, PostgreSQL or infrastructure checks described
   in [verification](docs/verification.md).
7. Open a pull request explaining the problem, resulting behavior and evidence.

Documentation, code comments, commit messages and pull requests should be in
English. Product copy and UI assertions retain their supported Russian and
English text. Use descriptive commits, for example
`fix: preserve credit when archiving an obligation`.

## Invariants to preserve

- Store money as integer minor units; keep original currencies and exchange-rate provenance.
- Enforce family membership, record authorship and permissions on the server.
- Commit each command batch, revision and idempotency receipt atomically.
- Keep retries safe and retain drafts when a revision conflict needs user review.
- Keep authentication fixtures inside tests; never add a development login bypass.
- Treat existing database names, storage keys and serialized formats as compatibility contracts.

Never commit `.env.local`, deployment parameter files, tokens, database dumps or
real household data. Use the checked-in examples and fictional test fixtures.
Report security issues through the process in [SECURITY.md](SECURITY.md).

Contributions are made under the repository's [Apache 2.0 license](LICENSE).
