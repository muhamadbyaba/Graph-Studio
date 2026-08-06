# Security Policy

## Reporting a vulnerability

Please report security issues privately, through GitHub's **Report a vulnerability**
button on the Security tab of this repository. That opens a private advisory only
the maintainers can see.

Do not open a public issue for a suspected vulnerability.

A useful report includes the affected version or commit, the configuration you
were running (`BG_AUTH_MODE`, whether it was behind a proxy), what an attacker
gains, and the smallest reproduction you can manage.

You can expect an acknowledgement within three working days and an assessment
within ten. If a fix is warranted, the advisory is published together with the
patched release, crediting you unless you prefer otherwise.

## Supported versions

The project is pre-1.0. Only the `main` branch receives security fixes.

## Security model

Understanding what the system does and does not defend against is the fastest way
to judge whether a finding is a vulnerability.

### Trust boundaries

| Boundary | Enforced by |
| --- | --- |
| Anonymous → authenticated | A session cookie resolved before any handler runs (`src/app.ts`). Every route except `/api/health` and the sign-in endpoints requires one. |
| Authenticated → workspace | `AccountStore.access` checks ownership or explicit membership on every request. A workspace id in a header or query string is a claim, never a grant. |
| Client input → domain model | `src/model/validate-events.ts` accepts only known event shapes with in-range values. The model then enforces referential integrity, and the history rolls back anything that does not fold. |
| Server output → browser, spreadsheet | HTML escaping at every sink in the report and the UI; formula-injection defusing in the CSV export. |

### What is implemented

**Authentication.** Passwords are hashed with scrypt (N = 2¹⁵, r = 8, p = 1) using
a per-password salt, with the cost parameters stored alongside the digest so they
can be raised without invalidating credentials. Verification is constant-time. An
unknown username costs the same work as a wrong password, so the endpoint cannot
be used to enumerate accounts. Sign-in is rate limited per source address and per
username.

**Sessions.** The cookie holds a 256-bit random token and nothing else — no user
id, no claims. The server stores only the SHA-256 of that token, so reading the
session file off disk does not yield a usable cookie. Cookies are `HttpOnly`,
`SameSite=Strict`, `Path=/`, and `Secure` when the connection is (or is proxied
as) HTTPS. Changing a password invalidates every other session for that account.

**Authorisation.** A workspace has one owner and an explicit member list. Only the
owner can invite or remove. "Does not exist" and "exists but is not yours" both
return `404`, so ids cannot be probed. Removing a collaborator closes their live
stream immediately.

**Request forgery.** `SameSite=Strict` means a cross-site request arrives without
credentials at all. On top of that, state-changing requests carrying an `Origin`
or `Sec-Fetch-Site` that is not same-origin are rejected outright.

**Injection.** Identifiers, fixture types and product names are constrained to
conservative character sets on input, so markup cannot enter the model. Output is
escaped again independently at every sink. CSV cells beginning with `=`, `+`, `-`,
`@`, tab or carriage return are prefixed so a spreadsheet renders them as text
instead of evaluating them.

**Content Security Policy.** `default-src 'self'` with no `unsafe-inline` and no
`unsafe-eval` for scripts. The two inline scripts the app legitimately needs — the
import map and the report's print handler — are allowed by the SHA-256 of their
exact contents, computed from the served file at start-up. `object-src`,
`base-uri` and `frame-ancestors` are `'none'`.

**Path handling.** Static requests are percent-decoded before resolution, then
checked for containment by path relationship rather than string prefix. Dotfiles
are never served. Saved projects are stored under a hash of their name, so nothing
a user types can influence a file path.

**Resource limits.** Per-route body ceilings enforced while streaming; caps on
events per request and per document; a bounded number of resident documents with
least-recently-used eviction; a cap on live connections per workspace; rate limits
on sign-in, registration, the copilot and model import. HTTP header, request and
keep-alive timeouts are set explicitly.

**Failure handling.** Only `HttpError` messages reach a client. Anything else is
logged in full server-side and returned as a bare `500`, so file paths, stack
traces and upstream API responses cannot leak through an error.

### What is not implemented

These are known and deliberate at this stage. Reports about them are welcome as
issues, but they are not vulnerabilities.

- **No multi-factor authentication and no account recovery.** An operator with
  filesystem access is the recovery path.
- **No audit log of authentication events.** Design edits are fully audited; sign-ins
  are not.
- **Rate limiting is per process and in memory.** Behind more than one instance it
  must move to a shared store.
- **No conflict resolution between simultaneous editors.** Live collaboration is
  state broadcast over a shared event log; two people editing the same element
  resolve last-write-wins. Operational transforms or a CRDT would be needed for
  genuine concurrent editing.
- **The JSON stores are not encrypted at rest.** Use full-disk or volume
  encryption if the threat model calls for it.
- **`BG_AUTH_MODE=open` has no authentication at all.** It refuses to start on a
  non-loopback host and in production, and exists only so the project can be
  evaluated with one command.

### Deploying safely

- Set `BG_SESSION_SECRET` to 32+ random bytes. The server refuses to start in
  production without it.
- Terminate TLS in front and set `BG_BEHIND_TLS_PROXY=true` so cookies are issued
  with `Secure`.
- Set `NODE_ENV=production`, which closes registration by default. Open it
  deliberately with `BG_ALLOW_REGISTRATION=true`, or create accounts and close it
  again.
- Back up `BG_DATA_DIR`. It holds accounts, live documents and saved projects.
- Run as an unprivileged user. The data directory is created with `0700`.
