# Multi-User Authentication Design

## 1. Overview

Vocab Quest currently uses a single shared password (`AUTH_PASSWORD` env var) to
gate access. All data — books, illustrations, vocabulary progress — lives in a
flat `data/` directory with no per-user separation. This design adds:

- **Individual user accounts** so each family member (or friend) gets their own
  isolated experience — as if they had their very own copy of the app.
- **Server-wide API keys** — all users share the server owner's Anthropic
  (claude-agent-sdk OAuth) and Gemini credentials. The data model reserves
  fields for future per-user API keys (see §6.2), but no per-user key
  routing is implemented yet.
- **Admin and member roles** with a first-run setup flow and an in-app admin
  panel for managing accounts.
- **Backwards compatibility** — deployments without `users.json` continue to
  work exactly as they do today (single-password mode).

---

## 2. Current Architecture (Before)

```
Browser (React SPA)
  │
  ├─ POST /api/claude       →  claude-agent-sdk (OAuth credentials)
  ├─ POST /api/gemini/:model →  Google Generative Language API (server-wide key)
  ├─ GET/PUT/DELETE /api/kv/:key  →  data/{key}.json  (global, shared)
  └─ DELETE /api/books/:hash      →  bulk file cleanup

Auth: single password → HMAC token in vq_session cookie
Data: flat JSON files in data/ — no namespacing
```

**Key files:**

| File | Role |
|------|------|
| `server.js` | Express backend — auth, API proxies, KV store, book deletion |
| `src/App.jsx` | React SPA — all UI phases (upload, game, review, results) |
| `src/wordRecords.js` | Client-side spaced repetition engine (SM-2 algorithm) |
| `data/*.json` | All persistent state — books, vocab progress, illustrations |

---

## 3. User Model

### 3.1 Storage: `data/users.json`

A single JSON file mapping user IDs to profiles. Writes use the same atomic
pattern as the KV store (write to `.tmp`, then `renameSync`) to prevent
corruption if the server crashes mid-write:

```js
function saveUsers(users) {
  const file = join(DATA_DIR, 'users.json');
  const tmp  = join(DATA_DIR, 'users.tmp');
  writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  renameSync(tmp, file);
}
```

Schema:

```json
{
  "dad_example.com": {
    "email": "dad@example.com",
    "displayName": "Dad",
    "passwordHash": "a1b2c3...",
    "salt": "f9e8d7...",
    "role": "admin",
    "passwordVersion": 1,
    "anthropicApiKey": null,
    "geminiApiKey": null,
    "createdAt": "2026-03-28T10:00:00.000Z"
  },
  "emma_example.com": {
    "email": "emma@example.com",
    "displayName": "Emma",
    "passwordHash": "d4e5f6...",
    "salt": "c6b5a4...",
    "role": "member",
    "passwordVersion": 1,
    "anthropicApiKey": null,
    "geminiApiKey": null,
    "createdAt": "2026-03-28T10:05:00.000Z"
  }
}
```

User IDs are derived from the email via `sanitizeKey(email.toLowerCase())` — e.g.,
`dad@example.com` → `dad_example.com`. The email is stored separately so the
original address is preserved for login matching and password reset emails.

### 3.2 Roles

| Role | Capabilities |
|------|-------------|
| `admin` | Create and delete user accounts. Full app access. |
| `member` | Use the app (upload books, play games, manage own API keys). Cannot manage other users. |

The first account created during setup is automatically `admin`.

### 3.3 Password Hashing

```js
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
```

Uses `scryptSync` (Node built-in, no new dependencies). Scrypt is a
memory-hard key derivation function — resistant to GPU/ASIC brute-force
attacks, unlike plain SHA-256 which can be cracked at billions of attempts
per second. Each user gets a random 16-byte salt stored alongside their hash.
This decouples the hash from the user's email, so email changes don't require
re-hashing the password.

Passwords must be at least 8 characters. Password hash comparisons use
`crypto.timingSafeEqual` to prevent timing attacks.

### 3.4 API Key Storage

API keys are stored in `users.json` alongside the user profile. They are
**never sent to the frontend** — the `GET /api/me` endpoint returns only
boolean flags (`hasAnthropicKey`, `hasGeminiKey`) so the UI knows whether to
show the settings prompt.

---

## 4. Session Management

### 4.1 Cookie Format

The current single-token cookie is replaced with a structured format:

```
userId:timestamp:passwordVersion:hmac
```

Where:
- `userId` — the account identifier (e.g., `emma_example.com`)
- `timestamp` — Unix epoch in seconds when the session was created
- `passwordVersion` — integer that increments on password change/reset
- `hmac` — `HMAC-SHA256(SESSION_SECRET, userId + ":" + timestamp + ":" + passwordVersion)`

The cookie attributes remain the same: `HttpOnly`, `SameSite=Strict`,
`Secure` (in production), `Max-Age=30 days`, `Path=/`.

**Session invalidation:** When a user changes or resets their password,
`passwordVersion` is incremented on the user record. The auth middleware
compares the version in the token to the stored version — mismatches are
rejected, automatically logging out all other sessions.

**Server-side expiry:** `verifySessionToken` checks the embedded timestamp
against `SESSION_MAX_AGE` (30 days). Expired tokens are rejected even if the
browser still has the cookie.

### 4.2 Session Secret

```
SESSION_SECRET env var
  → falls back to AUTH_PASSWORD
  → falls back to data/.session-secret (auto-generated, persisted)
```

Resolution order:

1. `SESSION_SECRET` env var (explicit, highest priority).
2. `AUTH_PASSWORD` env var (for backwards compatibility).
3. `data/.session-secret` — a random 64-byte hex string generated once on
   first startup and written to the data directory. Since `data/` is on a
   persistent volume (Railway mount or Codespaces /workspaces), this file
   survives redeploys. Sessions remain valid across restarts without
   requiring any env var configuration.

```js
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.AUTH_PASSWORD) return process.env.AUTH_PASSWORD;
  const secretFile = join(DATA_DIR, '.session-secret');
  try {
    return readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(64).toString('hex');
    writeFileSync(secretFile, secret, 'utf8');
    return secret;
  }
}
```

### 4.3 Authentication Middleware

The `requireAuth` middleware:

1. Parses the `vq_session` cookie.
2. Splits on `:` to extract `userId`, `timestamp`, `passwordVersion`, and `hmac`.
3. Recomputes the HMAC and compares using `timingSafeEqual`.
4. Checks server-side timestamp expiry.
5. Looks up the user in `users.json` and verifies `passwordVersion` matches.
6. Sets `req.user = { id, displayName, role }` on the request object.

If `users.json` doesn't exist and no `AUTH_PASSWORD` is set, the middleware
redirects to `/setup` so the admin can create the first account. If
`AUTH_PASSWORD` is set without `users.json`, it falls back to legacy
single-password mode and sets `req.user = null`.

---

## 5. Data Isolation

### 5.1 KV Key Namespacing

Every KV key is transparently prefixed with the user ID on the server side:

```js
function resolveKey(req, key) {
  // Legacy mode (no users.json): no prefix
  if (!req.user) return key;
  return `u_${req.user.id}_${key}`;
}
```

This is applied in the three KV route handlers and the book deletion endpoint.
**The frontend is completely unaware of namespacing** — it continues to request
`vocab-quest-data`, `vocab-books-index`, etc., and the server silently maps
them to user-scoped files.

### 5.2 File Layout Example

```
data/
  users.json                              ← shared user registry
  u_dad_vocab-quest-data.json             ← Dad's vocabulary progress
  u_dad_vocab-books-index.json            ← Dad's book list
  u_dad_vocab-book-8764d340.json          ← Dad's uploaded book
  u_dad_storybible-8764d340.json          ← Dad's story bible
  u_dad_wordlist-abc123.json              ← Dad's word list cache
  u_dad_illust-abc123-languidly.json      ← Dad's illustration cache
  u_emma_vocab-quest-data.json            ← Emma's vocabulary progress
  u_emma_vocab-books-index.json           ← Emma's book list (different books!)
  ...
```

### 5.3 What's Isolated

**Everything.** Each user has their own:
- Uploaded books and book index
- Story bibles (AI visual guides)
- Word lists and vocabulary progress
- Spaced repetition state and session history
- Cached illustrations

One user uploading a book or generating illustrations has zero visibility to
any other user.

### 5.4 Book Deletion

The `DELETE /api/books/:hash` endpoint currently reads book data and computes
chapter hashes to find related files. This logic is updated to prefix all
file paths with `u_{userId}_`, so deletion only touches the requesting user's
files.

---

## 5.5 Password Reset Flow

Users can reset their password via email using Resend as the transactional
email provider. The flow:

1. **`GET /forgot-password`** — renders an email input form.
2. **`POST /api/forgot-password`** — generates a random 32-byte token, stores
   its SHA-256 hash and a 1-hour expiry on the user record (`resetTokenHash`,
   `resetTokenExpiry`), and sends the raw token in a link via Resend.
3. **`GET /reset-password?token=xxx&email=yyy`** — renders the new password form.
4. **`POST /api/reset-password`** — verifies the token hash using
   `timingSafeEqual`, checks expiry, updates the password with a new random
   salt, increments `passwordVersion` (invalidating all sessions), and clears
   the token fields (single-use).

Security measures:
- **Token stored as hash** — if `users.json` is compromised, raw tokens can't
  be recovered.
- **Same response for all emails** — `POST /api/forgot-password` always shows
  "check your email" regardless of whether the email exists (prevents
  enumeration).
- **5-minute cooldown** — only one reset email per address per 5 minutes,
  regardless of how many IPs request it (prevents email flooding).
- **Rate limited** — the `authLimiter` (5 req / 15 min per IP) is applied to
  both forgot-password and reset-password endpoints.
- **XSS protection** — query params in the reset form are HTML-escaped.

Environment variables:
- `RESEND_API_KEY` — API key from resend.com (required in production).
- `APP_URL` — public URL for reset links (e.g., `https://vocabquest.app`).
- `EMAIL_FROM` — sender address (must be verified in Resend).

In dev mode (no `RESEND_API_KEY`), the reset URL is logged to the console.

---

## 6. API Keys

### 6.1 Current Scope — Server-Wide Keys (No Changes)

All API calls continue to use the server owner's credentials:

- **Anthropic**: `claude-agent-sdk` with OAuth credentials (`claude login` /
  `CLAUDE_CODE_OAUTH_TOKEN`). Unchanged.
- **Gemini**: Server-wide `GEMINI_API_KEY` env var. Unchanged.
- **`/api/gemini-available`**: Unchanged — checks server env var.
- **`/api/claude`**: Unchanged — uses `claude-agent-sdk` `query()`.

All users share the server owner's API keys. No per-user key routing,
settings UI, or dual-path backend is implemented in this phase.

### 6.2 Future: Per-User API Keys (Deferred)

The `users.json` schema includes `anthropicApiKey` and `geminiApiKey` fields
to support per-user keys in a future iteration. These fields are **not read
or used by any server logic** in this implementation.

When this feature is built, the design would be:

- Users enter their own keys in a settings panel (`PUT /api/me/keys`)
- `/api/claude`: user has key → direct Anthropic Messages API; no key →
  fall back to `claude-agent-sdk` OAuth
- `/api/gemini/:model`: user has key → use it; no key → fall back to
  server-wide `GEMINI_API_KEY`
- Settings UI labels: Anthropic = required for exercises; Gemini = optional
  for illustrations

**This is explicitly out of scope for now.** Do not implement per-user API
key behavior without confirming with the project owner first.

---

## 7. API Routes

### 7.1 New Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/me` | Any user | Returns the current user's profile. Response: `{ id, displayName, role }` |
| `GET` | `/api/users` | Admin only | Lists all users. Response: `[{ id, displayName, role, createdAt }]` (no password hashes, no API keys). |
| `POST` | `/api/users` | Admin only | Creates a new user. Body: `{ id, displayName, password }`. Returns `{ ok: true }`. |
| `DELETE` | `/api/users/:id` | Admin only | Deletes a user and all their `u_{id}_*.json` data files. Cannot delete yourself. |
| `GET` | `/setup` | None | First-time setup page. Only accessible when `users.json` doesn't exist. Redirects to `/login` otherwise. |
| `POST` | `/api/setup` | None | Creates the initial admin account. Body: `{ id, displayName, password }`. Only works when `users.json` doesn't exist. |

### 7.2 Modified Routes

| Method | Path | Change |
|--------|------|--------|
| `GET` | `/login` | Adds a username field above the password field. If no `users.json` exists, renders the old single-password form. |
| `POST` | `/api/login` | Accepts `{ username, password }`, looks up user, verifies hash, sets user-scoped session cookie. Falls back to old behavior without `users.json`. |
| `GET/PUT/DELETE` | `/api/kv/:key` | Key is passed through `resolveKey(req, key)` to add user prefix. |
| `DELETE` | `/api/books/:hash` | All file paths prefixed with user namespace. |
| `POST` | `/api/claude` | Unchanged — uses `claude-agent-sdk` with server owner's OAuth credentials. |
| `POST` | `/api/gemini/:model` | Unchanged — uses server-wide `GEMINI_API_KEY`. |
| `GET` | `/api/gemini-available` | Unchanged — checks server env var. |

---

## 8. Frontend Changes

All changes are in `src/App.jsx`. No changes to `src/wordRecords.js` or
storage helpers.

### 8.1 User State

On mount, fetch `GET /api/me` and store the result:

```js
const [currentUser, setCurrentUser] = useState(null);

useEffect(() => {
  fetch('/api/me').then(r => r.json()).then(setCurrentUser);
}, []);
```

### 8.2 Header Bar

Display the user's name and a logout link in the header area:

```
Hi, Emma  ·  Log out          [Vocab Quest]
```

### 8.3 Admin Panel

Visible only when `currentUser.role === 'admin'`:

- List of all user accounts (fetched from `GET /api/users`)
- "Add User" form: username, display name, password
- "Delete" button per user (with confirmation)

### 8.4 API Key Settings (Deferred)

A settings panel for per-user API key entry is **not included in this
implementation**. It will be added in a future iteration when per-user API
key routing is built. See §6.2.

---

## 9. Login Flow

### 9.1 Multi-User Login Page

```
┌─────────────────────────┐
│      Vocab Quest        │
│                         │
│  [Username           ]  │
│  [Password           ]  │
│  [      Enter        ]  │
│                         │
│  Incorrect password     │
└─────────────────────────┘
```

### 9.2 First-Time Setup Page (`/setup`)

Shown only when `users.json` does not exist:

```
┌─────────────────────────────────┐
│   Welcome to Vocab Quest        │
│   Create your admin account     │
│                                 │
│   Username:     [dad          ] │
│   Display Name: [Dad          ] │
│   Password:     [••••••••     ] │
│   [    Create Account         ] │
└─────────────────────────────────┘
```

After submission:
1. `users.json` is created with the admin account.
2. Any existing data files are migrated (see §10).
3. The user is logged in and redirected to `/`.

---

## 10. Migration Path

For existing deployments that already have data:

| Step | What happens |
|------|-------------|
| 1 | New code deploys. No `users.json` exists → **legacy mode** (single-password, no key prefix). Everything works as before. |
| 2 | Admin visits `/setup` and creates the first account. |
| 3 | The `POST /api/setup` handler migrates existing data using a **copy-then-delete** strategy (see below). |
| 4 | The admin's existing books, progress, illustrations — everything — are now under their namespace. |
| 5 | Server-wide env var keys (`GEMINI_API_KEY`, Claude OAuth) continue to work for all users. |
| 6 | New users created via the admin panel start with an empty app. |

### 10.1 Safe Migration Strategy

The migration uses **copy-first, verify, then delete** to avoid data loss
from partial failures:

```
Phase A — Copy:
  For each *.json file in data/ (excluding users.json, .session-secret):
    Copy  vocab-quest-data.json  →  u_dad_vocab-quest-data.json
    Log: "Copied vocab-quest-data.json → u_dad_vocab-quest-data.json"

Phase B — Verify:
  For each copied file:
    Verify the destination file exists and has the same byte length
  If any verification fails → abort, log error, leave originals intact

Phase C — Clean up:
  For each verified original:
    Delete the original unprefixed file
    Log: "Removed original vocab-quest-data.json"
```

If the server crashes during Phase A, both the original and partial copies
exist — no data is lost, and re-running setup will retry. If it crashes
during Phase C, some originals remain alongside their copies — harmless,
since the app now reads from the prefixed versions.

**Rollback:** Delete `users.json` and rename `u_{id}_*` files back to their
original names (strip the `u_{id}_` prefix). The app reverts to
single-password mode.

---

## 11. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Password storage | `scryptSync` (memory-hard KDF) with userId as salt. Resistant to GPU/ASIC brute-force. |
| API key exposure | Keys stored server-side only. `GET /api/me` returns booleans, not key values. Keys never sent to browser. |
| Session hijacking | HttpOnly + SameSite=Strict + Secure (production) cookies. HMAC-signed tokens. |
| Brute force | Existing rate limiter: 5 login attempts per 15 min per IP. |
| Path traversal | Existing key sanitization (`[^a-zA-Z0-9._-]` → `_`) prevents user IDs from escaping the data directory. |
| Admin privilege escalation | Role is stored server-side in `users.json`. Frontend role check is cosmetic; all admin routes verify `req.user.role === 'admin'`. |
| Setup endpoint abuse | `POST /api/setup` only works when `users.json` doesn't exist. Once the first account is created, the endpoint returns 403. |
| Cross-user data access | KV namespacing is enforced server-side. The frontend cannot request another user's keys — the prefix is derived from the session, not from the request. |

---

## 12. Implementation Phases

### Phase 1: Server Auth Refactor (`server.js`)

- Add `loadUsers()` / `saveUsers()` helpers that read/write `data/users.json`
- Add `hashPassword(password, userId)` function
- Implement new session token format: `userId:timestamp:hmac`
- Update `requireAuth` middleware to parse new token and set `req.user`
- Add legacy fallback: if no `users.json`, use current single-password auth
- Update login page HTML to include a username field
- Add `GET /api/me` endpoint

### Phase 2: KV Namespacing (`server.js`)

- Add `resolveKey(req, key)` helper
- Apply in `GET /api/kv/:key` handler
- Apply in `PUT /api/kv/:key` handler
- Apply in `DELETE /api/kv/:key` handler
- Apply in `DELETE /api/books/:hash` (prefix all file paths)

### Phase 3: User Management (`server.js`)

- Add `GET /api/users` (admin only)
- Add `POST /api/users` (admin only)
- Add `DELETE /api/users/:id` (admin only, with data cleanup)
- Add `GET /setup` page (first-time only)
- Add `POST /api/setup` (first-time only, with data migration)

### Phase 4: Frontend (`src/App.jsx`)

- Fetch `/api/me` on mount, store user state
- Add user display + logout link in header
- Add admin panel for user management

---

## 13. Files Modified

| File | Changes |
|------|---------|
| `server.js` | Auth refactor, KV namespacing, user management routes, setup page, login page update |
| `src/App.jsx` | User state, header UI, admin panel |

No changes to `src/wordRecords.js`, `src/main.jsx`, `src/index.css`,
`package.json`, or `vite.config.js`.

---

## 14. Testing Checklist

1. **Setup flow**: Start fresh (no `users.json`), visit `/setup`, create admin account
2. **Migration**: Verify existing books + vocab progress moved to admin's namespace
3. **Admin login**: Login as admin, confirm all data is present
4. **Exercise generation**: Upload a book, generate exercises — confirm Claude and Gemini still work with server-wide credentials
5. **Create member**: Use admin panel to create a test member account
6. **Member isolation**: Login as member in incognito — should see empty app, no books
7. **Member experience**: Upload a book as member, play a game — uses server-wide API keys
8. **Cross-user isolation**: Switch back to admin — should NOT see member's book or progress
9. **Account deletion**: Delete test account, verify `u_{id}_*.json` files are removed
10. **Legacy mode**: Remove `users.json`, set `AUTH_PASSWORD` env var, confirm old single-password flow works
