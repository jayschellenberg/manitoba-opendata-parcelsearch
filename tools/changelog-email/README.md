# Monthly "What's new in Parcel Search" email

One email a month to the appraisers who use the Manitoba and Winnipeg Parcel
Search apps, summarising what changed and how it helps on an assignment.
Sections: **Property Search**, **Sales Search**, **Data updates**; each item
tagged Manitoba / Winnipeg / Both apps.

## How it runs

1. **1st of the month, 07:00** - task `ParcelSearch Monthly Update Email` runs
   `build-draft.ps1`: pulls every PR merged into both repos since the last
   *sent* issue (`gh pr list`), feeds the PR descriptions plus `prompt.md` to
   `claude -p` (no tools), saves `drafts\YYYY-MM-DD.html` + `.json`, and emails
   Jason a **[DRAFT]** copy with a banner showing who it would go to.
2. **Jason reviews.** Edit `drafts\YYYY-MM-DD.html` directly if needed (it is
   what gets sent; the banner is not in it).
3. **Send:** `powershell -ExecutionPolicy Bypass -File send-draft.ps1`
   (`-WhatIf` to preview). Sends the newest unsent draft To: Jason, BCC: every
   address in `recipients.local.txt`, then records the window end so next
   month starts there. An unsent draft's PRs roll into the next month.

If nothing user-visible merged, the task emails a one-line "nothing to send"
note and advances the window. Failures email an alert via `alert-lib.ps1`.

## Local files (gitignored - the repos are public)

| File | Holds |
|---|---|
| `recipients.local.txt` | one address per line |
| `claude-token.local.txt` | output of `claude setup-token` (one line). The normal CLI login expires; an unattended task can't re-login |
| `drafts\`, `state\`, `logs\` | drafts, last-sent window, transcripts |

SMTP comes from `..\..\alert-email.local.txt` (same Gmail app password as the alerts).

## Changing what it writes

Edit `prompt.md` - audience, section rules, what to leave out, tone. Test with
`build-draft.ps1 -NoEmail` (writes the draft, sends nothing).
