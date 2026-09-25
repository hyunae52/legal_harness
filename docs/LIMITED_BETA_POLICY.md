# Limited beta policy

Status: limited developer beta after the release checklist below passes. This
is not a production tax-advice service and must not be the sole basis for a
filing, appeal, payment, deadline, or client communication.

## Allowed beta use

- Use public, synthetic, or irreversibly redacted examples.
- Verify every material conclusion against the linked current law and original
  source document.
- Treat `structurally_complete` as completion of the registered research plan,
  not proof that every legally relevant party, law, issue, or exception was
  discovered.
- Treat search results and duplicate-document candidates as retrieval aids, not
  legal conclusions.

## Data that must not be submitted

Do not submit names, resident or business registration numbers, addresses,
phone numbers, email addresses, account information, credentials, unpublished
client facts, privileged communications, or documents that identify a client.
The public endpoint is not a confidential client workspace.

Lookup terms are sent to the selected public legal-data provider. Anonymous
rate grouping uses a keyed hash of the validated network peer. Research state
is held in process memory for up to 30 minutes and is lost on restart.
Confirmed correction proposals may become public GitHub content; proposals must
therefore contain only public or synthetic material.

## Source data

The MIT license covers repository code, not third-party legal or tax data.
Source ownership, attribution, and original-site conditions remain in force.
The service performs bounded on-demand retrieval and is not a bulk data export.
Do not redistribute cached bodies or test fixtures as a dataset. Distribution
artifacts must exclude fixtures unless their redistribution basis has been
reviewed and recorded.

## Release checklist

Before expanding the beta audience:

1. Runtime dependency audit has no moderate-or-higher finding in the deployed
   dependency set.
2. Full reachable Git history and release artifacts pass the secret-pattern
   scan, with any real credential revoked and removed from active use.
3. The deployed commit, package versions, provider fork commit, and public
   documentation agree.
4. Public health, tool catalog, one Korean Law lookup, one Taxlaw lookup, and
   duplicate-document behavior pass after deployment.
5. Monitoring, emergency stop, rollback owner, and support boundary are named
   for the beta period.

## What beta must measure

The beta is the evidence-gathering stage for installation success, provider
failures, concurrency and resource use, rollback behavior, legal-issue
omissions, false completion, and actual support load. Those results determine
whether a later production claim is justified.
