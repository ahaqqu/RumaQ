# Scraper pipeline verification (post URL migration)

A self-contained verification prompt for a fresh agent session. Run it after the
canonical production URL work (`https://rumaq.ahaqqu.com`) has landed and DNS has
settled. Paste the block below verbatim into the new session.

No real hostnames-of-the-box, credentials, or secret values live in this document:
the box host/user resolve at run time from the repo's `VPS_HOST` / `VPS_USER`
variables, and the ingest secret is probed from its local stash without ever being
printed.

---

## Verification prompt

```
You are verifying the RumaQ scraper pipeline after the production URL migration
(canonical URL: https://rumaq.ahaqqu.com). Repo: /home/ahaqqu/Projects/RumaQ —
start from a clean checkout of main.

Binding repo rules (AGENTS.md): greet with "Ryōkai Mas-sama"; never read or
display .env contents or any secret VALUE (probing with a secret is fine,
printing it is not); never commit or push to main; if the user must run
something, only ever scripts under scripts/.

Scope guard — do NOT touch: routing, wrangler/cloudflare config, the deploy
workflow, or any URL-related code (owned by a separate work stream), and do NOT
enable the scraper timer (go-live is a separate owner decision). You verify and,
where a check says so, refresh the box env — nothing else.

Run the checks in order and report PASS/FAIL per check:

1. Production URL serves:
     curl -s -o /dev/null -w '%{http_code}' https://rumaq.ahaqqu.com/api/health
   Expect 200. Also RECORD (don't fix) the status of
   https://api.rumaq.workers.dev/api/health — that route may stay disabled by
   design while the custom domain is configured; 404/1042 there is worth noting
   but not a failure of this check.

2. The ingest secret is live on the Worker (deployed by the deploy job's
   put-secrets step):
     curl -s -o /tmp/ingest-body -w '%{http_code}' -X POST \
       https://rumaq.ahaqqu.com/api/internal/ingest/prices \
       -H "Authorization: Bearer $(cat ~/.config/rumaq/ingest-secret)" \
       -H 'Content-Type: application/json' --data '{}' --max-time 15
   Expect NOT 401 — a 400/422 from payload validation means the secret was
   accepted. Control probe with an obviously wrong bearer must return 401.
   If ~/.config/rumaq/ingest-secret does not exist on this machine, report this
   check as SKIP (the stash lives only on the owner's main machine). Never
   echo the secret or the response headers.

3. The scraper box is healthy. Resolve the target from the repo config:
     HOST=$(gh variable get VPS_HOST -R ahaqqu/RumaQ)
     VUSER=$(gh variable get VPS_USER -R ahaqqu/RumaQ)
     ssh -i ~/.ssh/rumaq-vps-deploy -o IdentitiesOnly=yes -o BatchMode=yes \
       "$VUSER@$HOST" '
         systemctl is-failed rumaq-scraper-selfcheck.service || true
         systemctl is-enabled rumaq-scraper.timer 2>/dev/null || true
         stat -c "%a %n" /srv/rumaq-scraper /srv/rumaq-scraper/browsers
       '
   Expect: selfcheck "inactive" (not "failed"), timer "disabled" (intentional
   until go-live), and 755 on both directories (the service user must be able
   to traverse the tree — 700s here means the deploy mode bug is back).

4. The box env points at the canonical ingest URL. /etc/rumaq-scraper/env may
   still hold the pre-migration workers.dev URL — the nightly publish would 404
   against it. The env file is root-only: NEVER cat it. Instead ask the user to
   run the idempotent refresh (one sudo password + Gemini key prompt):
     ./scripts/provision-vps.sh
   It re-fills RUMAQ_INGEST_URL=https://rumaq.ahaqqu.com/api/internal/ingest/prices
   (and GEMINI_API_KEY / RUMAQ_INGEST_SECRET), re-applies apply.sh, ships the
   current tree, and re-proves the box with the self-check — its own output is
   the evidence for this check. If the user prefers a targeted root edit over
   the full re-run, the one line that must hold in /etc/rumaq-scraper/env is
   exactly:
     RUMAQ_INGEST_URL=https://rumaq.ahaqqu.com/api/internal/ingest/prices
   (no trailing slash); a root sed is acceptable, reading the other lines is not.

5. Deploy pipeline health:
     gh run list -R ahaqqu/RumaQ --workflow=deploy.yml --limit=3
   Report each run's conclusion and, for the newest, the per-job outcomes
   (ci / deploy / deploy-vps).

Finish with a one-paragraph verdict: checks passed, anything you changed
(ideally nothing), and whether the box is READY for go-live — noting that
go-live itself (apply.sh --enable-timer + RUMAQ_PUBLISH=true) is NOT part of
this verification.
```

---

Owner context (not part of the prompt): provisioning was completed 2026-10-26
via `scripts/provision-vps.sh`; the commit-based `deploy-vps` job is proven
green end-to-end; the timer is installed but deliberately disabled until the
go-live milestone. The ingest secret's local stash and the GitHub secret
`HAQITA_INGEST_SECRET` (Worker side) hold the same generated value.
