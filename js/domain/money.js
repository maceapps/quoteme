import { DomainError } from "./validation.js";

export function parseCents(value, field = "Amount", { allowBlank = false } = {}) {
  if ((value === "" || value == null) && allowBlank) return 0;
  const text = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new DomainError(`${field} must be a non-negative amount with no more than two decimal places.`, field);
  const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new DomainError(`${field} is too large.`, field);
  return cents;
}

export function centsFromDollars(value) {
  if (Number.isInteger(value)) return value * 100;
  const cleaned = String(value ?? "").replace(/[$,\s]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

export function dollarsFromCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new DomainError("Money must be stored as integer cents.", "cents");
  return cents / 100;
}

function parseQuantity(value, field = "Quantity") {
  const text = String(value ?? "").trim();
  if (!text) return { units: 0, scale: 1 };
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw new DomainError(`${field} must be a non-negative number with no more than four decimal places.`, field);
  const decimals = match[2] || "";
  const scale = 10 ** decimals.length;
  const units = Number(match[1]) * scale + Number(decimals || 0);
  if (!Number.isSafeInteger(units)) throw new DomainError(`${field} is too large.`, field);
  return { units, scale };
}

export function lineAmountCents(item, index = 0) {
  if (Number.isSafeInteger(item.amountCents)) return item.amountCents;
  if (item.amount !== "" && item.amount != null) {
    return parseCents(item.amount, `Line ${index + 1} amount`);
  }
  const rateCents = Number.isSafeInteger(item.rateCents)
    ? item.rateCents
    : parseCents(item.rate, `Line ${index + 1} rate`, { allowBlank: true });
  const quantity = parseQuantity(item.qty, `Line ${index + 1} quantity`);
  const product = quantity.units * rateCents;
  if (!Number.isSafeInteger(product)) {
    throw new DomainError(`Line ${index + 1} amount is too large.`, `lineItems.${index}`);
  }
  return Math.round(product / quantity.scale);
}

export function computeTotalsCents(lineItems, gstPercent = 10) {
  const subtotalCents = lineItems.reduce((sum, item, index) => {
    const next = sum + lineAmountCents(item, index);
    if (!Number.isSafeInteger(next)) throw new DomainError("Document total is too large.", "lineItems");
    return next;
  }, 0);
  const gstCents = Math.round((subtotalCents * gstPercent) / 100);
  return {
    subtotalCents,
    gstCents,
    totalCents: subtotalCents + gstCents,
  };
}

export function formatCents(cents) {
  const value = dollarsFromCents(cents);
  return "$" + value.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
