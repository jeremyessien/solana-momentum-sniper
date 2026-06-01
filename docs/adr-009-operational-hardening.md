# ADR 009: Operational Hardening from the First Deployment

## Status

Accepted, 26 May 2026. This ADR follows the first production deployment of the bot to Hetzner — the deployment gated by ADR-008 — and records an operational failure that deployment surfaced together with the change made in response. It extends ADR-008 (Operational Security) on the specific point of how Litestream failures reach the operator. ADR-008 is left unedited as the historical record, per its own convention that changes made after a deployment depends on it are captured in superseding ADRs rather than in-place edits.

## Context

ADR-008 specified the production environment and gated the first deployment. That deployment is now live: the bot and Litestream run as sibling systemd units on a Hetzner CPX21, with the SQLite data store replicated to S3.

The first days of operation surfaced a failure the original design did not defend against. The IAM policy on the `moonscout-litestream` user had been created by hand in the AWS console, and its bucket-level grant (`s3:ListBucket`) referenced a stale bucket name while the object-level grant referenced the correct one. Litestream could therefore write WAL frames (`s3:PutObject` succeeded) but could not list the bucket, so its compaction and retention passes failed continuously. The misconfiguration was corrected in place once found — the policy now matches the document in ADR-008 — but it had persisted, unnoticed, for several days.

It went unnoticed for an instructive reason. ADR-008 gave the Litestream unit no `Restart=` directive, with the stated intent that "failures must surface to the operator." That intent was only half-built. The design surfaces a Litestream *crash* — the process dies and the absence is noticed. It does not surface a process that is *alive but failing*. The unit reported `active` throughout, `systemctl is-active` returned success, and the bot's `Requires=moonscout-litestream.service` dependency was satisfied at the process level. The errors were written to journald, but nothing read journald, so "surface to the operator" did not actually occur. The only backup of the data store that ADR-005 names as the system's single point of failure degraded in silence.

The lesson that matters is the general one: process liveness is not function health. A unit can be `active`, and a dependency on it can be satisfied, while the work the unit exists to do is failing. An operational safety system needs an active check of whether it is doing its job, not merely whether its process is up.

## Decision

A replication-health check alerts the operator when Litestream is failing, independent of whether the bot is running. A systemd timer (`moonscout-litestream-healthcheck.timer`) fires hourly and runs a oneshot service that executes a small script. The script asks journald whether the Litestream unit logged any `level=ERROR` lines in the recent window; if so, it sends the operator a Telegram message with the error count and the journal command to investigate. This completes the "failures must surface to the operator" intent ADR-008 stated: it surfaces degraded-but-alive operation, not only crashes.

The check runs deliberately outside the bot process. An in-process alerter cannot warn the operator when the bot itself is down, which is exactly when the warning matters most. The bot's existing outbound Telegram interface is therefore not reused; the check is operational infrastructure that must remain trustworthy when the rest of the system has failed.

Two choices follow from treating this as security infrastructure. The check runs as a dedicated unprivileged user, `healthcheck`, added to the `systemd-journal` group so it can read system-unit logs — rather than running as root or granting the `moonscout` user extra groups, which would erode the unprivileged-user posture ADR-008 establishes. And it loads its Telegram credentials from a dedicated `/etc/moonscout/healthcheck.env` containing only the bot token and the operator chat id — not the bot's `bot.env`, which holds (in Phase 2) the wallet private key. A script that reaches the public internet must not have the signing key in its environment; the blast radius of the health-check credential is bounded to sending Telegram messages.

The deploy runbook also gains a verification step: after any change to the Litestream IAM policy, the operator confirms from a credentialed machine that `aws s3 ls s3://<BUCKET>` succeeds and that the Litestream journal shows no `AccessDenied`. This is the cheap check that would have caught the original drift at deploy time.

## Consequences

The backup's health is now actively monitored rather than assumed. A recurrence of silent replication failure — from IAM drift, credential expiry, a bucket-policy change, or any cause that produces Litestream errors — reaches the operator within an hour instead of staying invisible until a restore is attempted in a crisis.

The check is coarse in this first version. It alerts on the presence of any `ERROR` line in the window and re-alerts each hour until the errors clear, so a persistent fault produces hourly reminders. This is the correct failure direction for a backup: a nagging alert beats silence. De-duplication can be added if the noise proves bothersome.

The check has blind spots, named here so they are not later mistaken for oversights. It infers health from log contents, so a failure that produces no error line would not trigger it. It assumes it can read journald; if that access breaks, the check simply fails to run, and its own failure is not itself alerted — the watcher is not watched. A more robust design (querying replication position directly, or a dead-man's-switch that alerts on the absence of an expected heartbeat) is a candidate for a later iteration if operational experience justifies the added complexity.

The `healthcheck` user and its credentials file add a small amount of deploy setup and one more credential to track, which is the ordinary cost of least privilege and is consistent with the IAM-user separation ADR-008 already accepted for the same reason.

## Alternatives Considered

We considered routing the alert through the bot's existing Telegram interface instead of a separate unit. We rejected this because that interface lives inside the bot process, and the failure we most need warning about — the bot or host being down — is exactly when an in-process alerter cannot fire.

We considered managing the Litestream IAM policy as infrastructure-as-code with Terraform or CloudFormation. The industry-standard form of "IAM policy as code" is in fact a tool of this kind, which wraps the policy in validation, drift detection, and a review pipeline. We rejected it here because that tooling and state-management burden is disproportionate for a single IAM user and one bucket on a single-operator system; the day the project has enough cloud surface to justify Terraform is a different project. The policy remains documented in ADR-008 and was corrected directly in the console.

We considered the middle path of committing the raw policy JSON to the repository and applying it by hand with `aws iam`. We rejected it because it delivers none of the guarantees that make IAM-as-code worthwhile — no validation gate, no drift detection, and still a manual apply — while duplicating the policy already documented inline in ADR-008 and creating a second source of truth that can itself drift. The verification step above addresses the same drift risk at a fraction of the cost.

We considered running the check as root to avoid creating a user. We rejected it because the check makes outbound `curl` calls, and a root process doing so is a larger attack surface than a dedicated unprivileged user in the journal-reading group.

We considered reusing `bot.env` for the Telegram credentials. We rejected it because `bot.env` holds the wallet private key per ADR-001, and granting an internet-facing script access to the signing key violates the wallet-isolation model the system's security rests on.

## Implementation Notes

The artifacts live in the repository at `deploy/systemd/moonscout-litestream-healthcheck.service`, `deploy/systemd/moonscout-litestream-healthcheck.timer`, and `deploy/scripts/litestream-healthcheck.sh`.

On the server the script is installed to `/usr/local/bin/moonscout-litestream-healthcheck` (`root:root`, mode `0755`) so its location does not depend on where the bot bundle is unpacked. The two unit files go in `/etc/systemd/system/`. The `healthcheck` system user is created without a login shell and added to the journal group: `useradd --system --no-create-home --shell /usr/sbin/nologin healthcheck`, then `usermod -aG systemd-journal healthcheck`. The credentials file `/etc/moonscout/healthcheck.env` is created `root:healthcheck` mode `0640` with `TELEGRAM_BOT_TOKEN=` and `TELEGRAM_ALERT_CHAT_ID=` (the operator populates the values; they are the bot's own token and the operator's chat id). The timer is enabled with `systemctl enable --now moonscout-litestream-healthcheck.timer`.

The window the script scans defaults to 65 minutes — slightly longer than the hourly timer interval so consecutive runs overlap and no error window is missed — and is overridable via `HEALTHCHECK_WINDOW` in the credentials file.

The check is verified at deploy time by triggering it manually with no Litestream errors present (`systemctl start moonscout-litestream-healthcheck.service` — no alert should arrive), then again after simulating an error, confirming an alert arrives. The IAM verification step is `aws s3 ls s3://<BUCKET>` succeeding and `journalctl -u moonscout-litestream.service --since "-5min"` showing no `AccessDenied`.