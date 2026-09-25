# Family member lifecycle

## Task brief

Allow a family administrator to permanently delete or archive a person, including
people without linked accounts, and restore archived people. Introduce a universal
Nobody assignment with a default black color configurable in household settings.

Acceptance criteria:

- Nobody can be selected as responsible; an empty beneficiary selection means Nobody.
- Permanent deletion replaces the person's financial references with Nobody while
  retaining amounts, allocations, refunds, immutable authorship and audit history.
- Archiving preserves historical attribution and chart colors, removes the person
  from active selectors, and offers continuing sole-beneficiary obligations for
  Nobody or stopping future charges and automatic payment records.
- A small archive link in the family view exposes archived people and restoration.
- Restoration offers reassignment of eligible Nobody benefits, without overwriting
  subsequent manual choices or silently restarting stopped obligations.
- Removing a linked person atomically revokes their family access and invitations.
  The head must transfer authority first. Restoration does not restore account access.
- Server authorization, family isolation, revision checks, operation receipts and
  transactional rollback cover all lifecycle commands.
- Domain, API and browser regression tests cover the new behavior and risky paths.

Scope includes domain types/validation/lifecycle/reporting, transactional Family API
commands and access cleanup, family/forms/settings UI, tests and product documentation.
No new AWS resources, provider calls, bank transactions or account deletion are needed.

## Agreed behavior and contracts

Nobody is a reserved virtual person reference, never a membership or editable person
record. Its UUID is `00000000-0000-5000-a000-000000000000`. Existing references and
serialized beneficiary groups remain compatible. A group can contain Nobody beside
real people; duplicate Nobody references collapse to one. Missing legacy responsible
assignments remain valid.

The command envelope carries one of `DeletePerson`, `ArchivePerson`, or `RestorePerson`
as a standalone operation. Archive requires `soleBeneficiaryPolicy` (`keep_nobody` or
`end_at_last_accrual`); restore requires `restoreBeneficiaries`. All use the existing
operation ID, actor-bound request hash, expected revision and generation. Receipt,
snapshot, membership removal, invitation revocation and session revocation commit
together. An identical retry returns the receipt; a different payload with the same
ID fails. No external delivery is part of the transaction.

External archive/restore commands also require `expectedDate`, the household date
used for the confirmation preview. The server rejects a different or missing date
with `MEMBER_PREVIEW_EXPIRED` before writing. A draft saved before midnight therefore
requires a fresh confirmation; an already committed receipt remains replayable on
later dates. Internal domain callers may omit this expectation when no human preview
is involved. The expected revision binds all other financial inputs to the preview.
Unsent or rejected lifecycle drafts cannot be rebased and submitted from the generic
draft list; the administrator must reopen the member and confirm a fresh preview.
Identical retries of ambiguous requests keep their original envelope and receipt.

Archiving saves dated attribution on affected obligations through the current
household accounting date, then changes current assignments to Nobody. Charts and
reports resolve attribution by charge due date, including subsequently generated
backdated charges. Same-day changes preserve the first historical assignment for
that date. Permanent deletion rewrites historical attribution as well as current
references, payers and entitlements. Financial authorship and security audit records
remain immutable; deleting a person does not delete a Google account or its authorship.

For stopping sole-beneficiary obligations, the cutoff is the exclusive end of the
last billing interval whose charge is due on or before today. If no charge has fallen
due, the obligation is cancelled before commencement. Future periods with allocations
(including reversed allocations), waivers, confirmed zero amounts or completed automatic runs remain visible;
only unprotected future periods are removed. Payments, refunds and automatic run
receipts are retained. Automatic schedules on stopped obligations are disabled.
The confirmation preview identifies retained future records.

Restoration only changes the person and optionally eligible beneficiary assignments.
It never restores Google access, responsibility, automatic payers, stopped schedules
or obligation terms. A new invitation is required for account access. Internal
beneficiary provenance tracks archive replacements; any explicit beneficiary edit
clears that provenance. Restoring a person without reassignment discards their pending
link. A pre-existing Nobody share, or one left by permanent deletion, stays Nobody.

No new SQL tables or AWS resources are required. Snapshot additions are optional;
deploy the updated API/domain readers before the updated client. Older application
versions with strict snapshot validators cannot safely read new lifecycle metadata.
