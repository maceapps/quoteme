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

- Create, **edit**, and delete quotes and invoices
- Auto-numbering (`QTE-0001`, `INV-0001`, …)
- Live line items with automatic GST (10%) totals
- One-click **quote → invoice** conversion
- Dashboard: win rate, outstanding, totals
- Status tracking (Pending/Accepted, Unpaid/Paid) written back to the Sheet
- Each document saved as a Google Doc **and** a PDF in a Drive folder

## Setup

1. **Google Cloud** — create a project, enable the **Drive API** and **Sheets API**,
   configure the OAuth consent screen, and create an **OAuth client ID** (Web application)
   with your app's origin under *Authorized JavaScript origins*
   (e.g. `http://localhost:5500`).
2. Paste that Client ID into [`js/config.js`](js/config.js) (`GOOGLE_CLIENT_ID`).
3. **Run it** (any static server), e.g.:
   ```
   python3 -m http.server 5500
   ```
   then open <http://localhost:5500>.
4. **Sign in** with Google. On first run the app creates a Drive folder, a register
   spreadsheet, and a **Business Details** tab.
5. Open **Dashboard → Business details** and fill in your company/bank info once.
   It's read from there and stamped onto every document.

## Files

| File | Role |
|------|------|
| `index.html` | App shell |
| `js/config.js` | Client ID, GST rate, folder/sheet names (no business data) |
| `js/google.js` | Google sign-in, Drive, Sheets |
| `js/store.js` | Data layer: numbering, save/update/delete, business details |
| `js/documents.js` | Builds the quote/invoice HTML (→ Doc → PDF) |
| `js/forms.js` | Quote/invoice entry forms |
| `js/app.js` | Dashboard, register views, wiring |
| `preview.html` | Standalone preview of the document design (sample data) |

## Deploying

It's a static site — drag the folder onto Netlify/Vercel or serve from any host,
then add the deployed URL to your OAuth client's *Authorized JavaScript origins*.
