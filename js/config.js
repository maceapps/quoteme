// ============================================================================
//  QuoteMe — configuration
//  Edit the values in this file. Nothing else here needs changing day to day.
// ============================================================================

// --- 1. Google OAuth Client ID --------------------------------------------
//  Paste the Client ID from Google Cloud Console here (see setup guide).
//  It looks like: 1234567890-abcdefg.apps.googleusercontent.com
export const GOOGLE_CLIENT_ID = "776867477364-l5qu3f1gik5e8p95r1iv5ln8h18gtjhj.apps.googleusercontent.com";

// --- 2. Google API scopes --------------------------------------------------
//  drive.file  = the app can only see/manage files IT creates (no verification
//                headaches, and it never touches the rest of your Drive).
//  spreadsheets = read/write the register sheet the app creates.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",   // send invoices/quotes from your Gmail
].join(" ");

// --- 3. Your company details -----------------------------------------------
//  These are NOT stored in this file. They live in the "Business Details" tab
//  of the register spreadsheet in your Google Drive, so nothing business-
//  specific sits in the code. Edit them there any time (Dashboard → "Business
//  details" opens the sheet).

// --- 4. Tax / money --------------------------------------------------------
export const GST_RATE = 0.10;            // 10% GST
export const CURRENCY = "AUD";
export const QUOTE_VALID_DAYS = 30;      // default "valid until" = issue + 30 days
export const INVOICE_DUE_DAYS = 14;      // default "due date"   = issue + 14 days

// --- 5. Drive / Sheet names the app will create ---------------------------
export const DRIVE_FOLDER_NAME = "QuoteMe — Documents";
export const REGISTER_SHEET_NAME = "QuoteMe — Register";

// --- 6. Document numbering -------------------------------------------------
export const QUOTE_PREFIX = "QTE-";
export const INVOICE_PREFIX = "INV-";
export const NUMBER_PAD = 4;             // QTE-0001
