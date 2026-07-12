# Google setup guide

QuoteMe has **no backend** — it talks directly to your own Google account from the
browser. To run it you need a free Google Cloud project that provides an **OAuth
Client ID** and has the right **APIs enabled**. This is a one-time, ~10-minute setup.

Everything below is **free** — no billing account or credit card is required, and
the API usage for one business stays far inside Google's free quotas. Generated
files count against your normal Google Drive storage (15 GB free), not Cloud billing.

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com>.
2. Top-left project dropdown → **New Project**. Name it e.g. **QuoteMe** → **Create**.
3. Make sure the new project is selected before continuing.

## 2. Enable the required APIs

**APIs & Services → Enabled APIs & services → + Enable APIs and services**, then
search for and enable each of these:

| API | Why it's needed |
|-----|-----------------|
| **Google Drive API** | Create the documents folder, save the Google Docs and PDFs, move/trash files |
| **Google Sheets API** | Create and update the register spreadsheet (Quotes / Invoices / Business Details tabs) |
| **Gmail API** | Send a document's PDF as an email attachment from your Gmail (the "Email PDF" action) |

> Even though the app only asks for the `drive.file` permission (see below), the
> **Sheets API** must still be *enabled* on the project for the Sheets calls to work.

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen** (newer console: **Google Auth Platform →
Branding / Audience**):

1. User type: **External** → **Create**.
2. Fill in the app name (e.g. *QuoteMe*), your support email, and developer email.
   You can leave logo/links blank. **Save and continue**.
3. **Scopes** step: you don't have to add scopes here — the app requests them at
   sign-in. **Save and continue**.
4. **Test users** step: click **+ Add users** and add **your own Google email**
   (and any colleague who will sign in). **Save**.

### Testing vs Production
- In **Testing** mode, Google **expires your approval every 7 days**, so you'd have to
  re-approve weekly.
- To avoid that, come back later and click **Publish app** (Testing → In production).
  You'll still see a one-time "unverified app" warning (see FAQ), but the approval
  then persists.

## 4. Create the OAuth Client ID

**APIs & Services → Credentials → + Create credentials → OAuth client ID**:

1. Application type: **Web application**.
2. Name: anything, e.g. *QuoteMe web*.
3. **Authorized JavaScript origins → + Add URI** — add every URL you'll open the app
   from. Google treats each exactly, so add the ones you use:
   - `http://localhost:5500` (local testing)
   - `http://127.0.0.1:5500` (localhost and 127.0.0.1 are different origins to Google)
   - **`https://maceapps.github.io`** (the GitHub Pages deployment — use just the
     scheme + host, **no** `/quoteme` path; the origin is the same regardless of path)
4. **Create**, then copy the **Client ID** (looks like
   `1234567890-abcdefg.apps.googleusercontent.com`).
5. Paste it into [`js/config.js`](js/config.js) as `GOOGLE_CLIENT_ID`.

> No "Authorized redirect URIs" are needed — QuoteMe uses the token flow, not redirects.

---

## Permissions the app requests

At sign-in Google shows an approval screen for exactly these permissions
(defined in [`js/config.js`](js/config.js) → `GOOGLE_SCOPES`):

| Scope | What it allows | What it does **not** allow |
|-------|----------------|-----------------------------|
| `https://www.googleapis.com/auth/drive.file` | See and manage **only the files this app creates** — the *QuoteMe — Documents* folder, the *QuoteMe — Register* sheet, and the Docs/PDFs it generates | Cannot see or touch any of your other Drive files |
| `https://www.googleapis.com/auth/gmail.send` | **Send** email (to email a quote/invoice PDF) on your behalf | Cannot read, search, or delete any of your email |

Notes:
- `drive.file` is a **non-sensitive** scope and also authorises the Sheets API for the
  spreadsheet the app itself created — which is why no broad "see all your spreadsheets"
  permission is requested.
- `gmail.send` is a **restricted** scope. For your own single-business use as a test
  user (or after publishing to production) it works fine; it's only relevant to formal
  verification if you distribute the app to other organisations.

---

## FAQ

**"Google hasn't verified this app" — how do I get rid of it?**
It appears because the app is unverified and uses the restricted `gmail.send` scope.
For personal/single-business use, click **Advanced → Go to QuoteMe (unsafe)** — you
only see it **once** per grant (not every load). Removing it entirely requires Google's
OAuth verification, which for the Gmail scope includes a paid annual security
assessment — not worth it for internal use.

**Does it ask for approval every time I open the app?**
No. After the first approval the app silently reuses your session, so reloads don't
prompt. (If your consent screen is still in *Testing* mode, the grant expires weekly —
publish to production to stop that.)

**Do I need to pay Google?**
No. Project, OAuth, and the Drive/Sheets/Gmail APIs are free at this usage level.

**I get a `redirect_uri_mismatch` / origin error when signing in.**
The URL you opened the app from isn't in **Authorized JavaScript origins**. Add the
exact origin (mind `localhost` vs `127.0.0.1`, and `http` vs `https`) and retry.

**Gmail send fails with a permission error.**
Either the **Gmail API** isn't enabled (step 2), or you granted access before the email
feature existed — **sign out and sign in again** to grant `gmail.send`.
