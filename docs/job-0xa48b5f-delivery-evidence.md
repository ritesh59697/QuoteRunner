# ASP 4814 — Delivery Evidence Log

**Job:** `0xa48b5f042b22dbd65a432598eb30ca65ed2a717a430302c2567ae5618f7f14bc`
**Title:** Compare quotes for logo work (MoonRoast Coffee)
**Provider (ASP):** 4814 · **Buyer:** 1757 · **Negotiated fee:** 0.01 USDT
**All times:** IST (UTC+5:30), 2026-07-17. Source: `~/.onchainos/audit.jsonl` + daemon `listener.log`.

Raw filtered log lines for this job are also at `job_0xa48b5f_export_logs.txt` (repo root). This file is the synthesized read of those lines, cross-referenced with the audit trail, for David Shui's retest thread.

## Timeline (provider side)

| Time | Event | On-chain / message proof |
|---|---|---|
| 18:39:07.811 | Invite received (`job_asp_selected`) over XMTP | daemon bound job → provider hermes |
| 18:40:10.476 | **Apply** submitted on-chain | txHash `0xeed31910…b32410a` |
| 18:44:07.579 | `provider_applied` received | — |
| 18:44:07.582 | `job_accepted` received (buyer funded escrow) | — |
| 18:45:16.110 | Deliverable encrypted + uploaded to gateway | fileKey `0xa48b5f…-cd8d0827-…-ca303471b7d0` |
| 18:45:19.110 | `message-eligible` check → `{"eligible":true}` | provider→client, group `a1c9c7c3…` |
| **18:45:19.961** | **XMTP `[intent:deliver]` sent to buyer 1757** | messageId `outbound-a0dab633-fa2c-48ee-981a-146527bcdbb4` |
| 18:45:20.760 | On-chain `submit` posted | — |
| 18:45:21.242 | **Deliver** confirmed on-chain | txHash `0x436af98a…37e551b` |
| 19:02:32.914 | Re-fetched the delivered file from gateway by fileKey → success (401ms) | encrypted blob retrievable at rest |

## Two things this pins down

**1. Send ordering is deliver-first, not submit-first.**
The XMTP `[intent:deliver]` message went out at **18:45:19.961** — **~0.8s BEFORE** the on-chain `submit` POST at 18:45:20.760. So on the provider side the deliverable payload is transmitted before the status flips to `submitted`. If the buyer agent observed `submitted` before the XMTP message finished indexing, that gap is on the receive/index path — our transmit order already puts the deliverable first.

**2. The deliverable exists and is retrievable.**
- Full plaintext ranking was produced and passed to `agent deliver` (7 providers evaluated, 2 in-scope, top pick "Font Pairing + NFT" — full content available on request).
- It was encrypted, uploaded (fileKey above), and the encrypted blob is still retrievable from the gateway by fileKey (re-verified at 19:02:32). It is stored **encrypted at rest by design**; decryption happens buyer-side using the `secret` carried inside the XMTP `[intent:deliver]` payload sent at 18:45:19.961.

## XMTP `[intent:deliver]` payload (as sent to 1757)

```
jobId:          0xa48b5f042b22dbd65a432598eb30ca65ed2a717a430302c2567ae5618f7f14bc
deliverableType: file
fileKey:        0xa48b5f…7f14bc/0xa48b5f…7f14bc-cd8d0827-abdc-4421-9d31-ca303471b7d0
digest:         552c3121bdbfa1bd2503b9581bbde6152887bfb65af26d9661aace180faffd9f
filename:       deliverable_0xa48b5f042b22dbd65a432598eb30ca65ed2a717a430302c2567ae5618f7f14bc.md
salt/nonce/secret: [redacted — decryption keys; already delivered to buyer 1757 in the live payload]
[intent:deliver]
```

## Note on the "~7 min applied late" reading

From **our** side, apply landed **63 seconds** after we received the invite (invite 18:39:07 → apply 18:40:10). We can't see the buyer-side publish timestamp, so if the ~7 min is measured from task publish, most of that window is publish→invite-delivery over XMTP (before our daemon ever saw it), not provider processing time.

## Known, separate issue observed in this same delivery

The relevance judge's per-candidate "why it's out of scope" reasons were scrambled in this run's ranking output (e.g. row "Crypto Project Directory" labeled "localizes documents, not design" — a reason that belongs to a different candidate). Cosmetic to this delivery-timing question, not sent to David as part of this evidence log, but worth fixing in `lib/relevance.js` — see chat history 2026-07-17 for the first occurrence (job `0xf55431…`) and this second one.
