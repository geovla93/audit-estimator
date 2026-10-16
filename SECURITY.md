# Security policy

Audit Estimator is a local analysis tool, not a vulnerability scanner or security assurance product. Its output can contain project-relative paths, names and bounded source-derived evidence. Review output before sharing it.

## Reporting a vulnerability

**PENDING OWNER DECISION:** no security reporting contact or confidential channel has been approved for this repository. Do not send sensitive reports to an invented address or assume private handling is available. A maintainer must add and verify an owner-approved reporting route before public release.

Confidential reporting must wait until a verified owner-approved channel exists. Until then, do not send exploit details, secrets, private source or personal information through an unverified channel. This notice is not a promise of confidential handling or response time.

## Local analysis boundary

The analyzer treats target repositories as data. It does not intentionally run target scripts, package hooks, compilers or network operations. This boundary is not an operating-system sandbox. Use ordinary isolation and least privilege when analyzing untrusted projects, and avoid processing material you are not authorized to inspect.

The project has no approved public license grant or published release. See [release readiness](docs/release-readiness.md) for the gates that remain pending.
