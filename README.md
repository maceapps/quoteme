# QuoteMe

A no-backend web app for creating **quotes** and **tax invoices**, saving them to
**Google Drive** (as Google Docs *and* PDFs), and tracking them in a Google Sheet —
all from the browser, signed in with your own Google account.

- **No server, no database.** Your Google Drive holds the files; a Google Sheet is the register.
- **No build step.** Plain HTML + JavaScript modules. Host it anywhere static.
- **Nothing business-specific in this repo.** Your company details (name, address,
  licence, ABN, bank) live in a *Business Details* tab of the register spreadsheet in
  your Drive, not in the code.

## Features

- Create, **edit**, and soft-**delete** quotes and invoices (deleted items are kept,
  hidden, and restorable from **Settings → Deleted documents**)
- Auto-numbering (`QTE-0001`, `INV-0001`, …)
- Live line items with automatic GST (10%) totals
- One-click **quote → invoice** conversion
- **Email** a document's PDF straight from your Gmail, or **download** it
- Dashboard: job counts, outstanding, and invoice totals
- Status tracking (Pending/Accepted, Unpaid/Paid) written back to the Sheet
- Each document saved as a Google Doc **and** a PDF in a Drive folder

## Google setup (required)

The app needs a free Google Cloud project (OAuth Client ID) with the **Drive**,
**Sheets**, and **Gmail** APIs enabled, and the **Client ID** pasted into
[`js/config.js`](js/config.js).

**➡️ Full step-by-step instructions and a plain-English explanation of every
permission the app requests are in [GOOGLE_SETUP.md](GOOGLE_SETUP.md).**

In short:
1. Follow [GOOGLE_SETUP.md](GOOGLE_SETUP.md) to create the project, enable the APIs,
   configure the consent screen, and create the OAuth Client ID.
2. Paste the Client ID into [`js/config.js`](js/config.js) (`GOOGLE_CLIENT_ID`).
3. **Run it** (any static server), e.g. `python3 -m http.server 5500`, then open
   <http://localhost:5500>.
4. **Sign in** with Google. On first run the app creates the Drive folder, the register
   spreadsheet, and a **Business Details** tab.
5. Open **Settings ⚙ → Business details** and fill in your company/bank info once —
   it's read from there and stamped onto every document.

### Permissions requested (summary)

| Scope | Purpose |
|-------|---------|
| `drive.file` | Manage **only the files the app creates** (folder, register sheet, Docs, PDFs) — nothing else in your Drive |
| `gmail.send` | Send a document PDF from your Gmail; cannot read your mail |

See [GOOGLE_SETUP.md](GOOGLE_SETUP.md) for the full explanation, the "unverified app"
warning, and troubleshooting.

## Files

| File | Role |
|------|------|
| `index.html` | App shell |
| `js/config.js` | Client ID, scopes, GST rate, folder/sheet names (no business data) |
| `js/google.js` | Google sign-in + session, Drive, Sheets, Gmail |
| `js/store.js` | Data layer: numbering, save/update/soft-delete, business details |
| `js/documents.js` | Builds the quote/invoice HTML (→ Doc → PDF) |
| `js/domain/` | Pure validation, dates, money, durations, statuses, and workflow contracts |
| `js/forms.js` | Quote/invoice entry forms |
| `js/app.js` | Dashboard, register views, deleted/business pages, wiring |
| `js/ui.js` | Shared loading overlay |
| `preview.html` | Standalone preview of the document design (sample data) |
| `GOOGLE_SETUP.md` | Full Google Cloud setup + permissions guide |
| `RECOVERY.md` | Backup, reconciliation, and restore baseline |

## Testing

The production app remains dependency-free. Tests and static checks use Node 22:

```sh
npm run ci
```

This validates module syntax/imports and runs the pure domain and failure-path tests.
GitHub Actions runs the same command on every push and pull request.

## Deploying

It's a static site — host it anywhere (GitHub Pages, Netlify, Vercel, …). Whichever
host you use, its origin **must** be added to your OAuth client's *Authorized
JavaScript origins* or sign-in will fail.

This project is deployed via **GitHub Pages**, so the origin to allow is:

```
https://maceapps.github.io
```

Use just the scheme + host (no `/quoteme` path) — the origin is the same regardless
of the path the app is served from. See [GOOGLE_SETUP.md](GOOGLE_SETUP.md) for details.
