import {
  compareLocalDates, parseLocalDate, localDateISO,
} from "./local-date.js";
import {
  dollarsFromCents, lineAmountCents, parseCents,
} from "./money.js";
import {
  DomainError, identifier, oneOf, optionalText, requiredText,
} from "./validation.js";

export const DOCUMENT_TYPES = Object.freeze(["quote", "invoice"]);
export const QUOTE_STATUSES = Object.freeze(["Pending", "Accepted", "Declined"]);
export const INVOICE_STATUSES = Object.freeze(["Unpaid", "Paid", "Overdue"]);

export const STATUS_TRANSITIONS = Object.freeze({
  quote: Object.freeze({
    Pending: QUOTE_STATUSES,
    Accepted: QUOTE_STATUSES,
    Declined: QUOTE_STATUSES,
  }),
  invoice: Object.freeze({
    Unpaid: INVOICE_STATUSES,
    Paid: INVOICE_STATUSES,
    Overdue: INVOICE_STATUSES,
  }),
});

function documentNumber(value, field) {
  const number = requiredText(value, field, { max: 100 });
  if (/[\u0000-\u001f\u007f]/.test(number)) {
    throw new DomainError(`${field} contains unsupported characters.`, field);
  }
  return number;
}

function documentDate(value, field) {
  return localDateISO(parseLocalDate(value, field));
}

function validateLineItems(items) {
  if (!Array.isArray(items)) throw new DomainError("Line items are required.", "lineItems");
  const populated = items.filter((item) =>
    [item?.description, item?.qty, item?.unit, item?.rate, item?.amount]
      .some((value) => String(value ?? "").trim()));
  if (!populated.length) throw new DomainError("Add at least one line item.", "lineItems");
  return populated.map((item, index) => {
    const description = requiredText(item.description, `Line ${index + 1} description`, { max: 1000 });
    const amountCents = lineAmountCents(item, index);
    const rateCents = item.rate === "" || item.rate == null
      ? 0
      : parseCents(item.rate, `Line ${index + 1} rate`);
    return {
      description,
      qty: optionalText(item.qty, `Line ${index + 1} quantity`, { max: 30 }),
      unit: optionalText(item.unit, `Line ${index + 1} unit`, { max: 40 }),
      rate: dollarsFromCents(rateCents),
      amount: dollarsFromCents(amountCents),
      rateCents,
      amountCents,
    };
  });
}

export function validateDocument(input) {
  const type = oneOf(input?.type, DOCUMENT_TYPES, "Document type");
  const client = input?.client || {};
  const base = {
    type,
    number: documentNumber(input?.number, type === "quote" ? "Quote number" : "Invoice number"),
    jobId: identifier(input?.jobId, "Job ID"),
    client: {
      name: requiredText(client.name, "Client name", { max: 200 }),
      attn: optionalText(client.attn, "Contact", { max: 200 }),
      address: optionalText(client.address, "Client address", { max: 500 }),
      suburb: optionalText(client.suburb, "Suburb, state and postcode", { max: 300 }),
      phone: optionalText(client.phone, "Client phone", { max: 80 }),
    },
    jobSite: optionalText(input?.jobSite, "Job site", { max: 500 }),
    lineItems: validateLineItems(input?.lineItems),
    notes: optionalText(input?.notes, "Notes", { max: 5000 }),
    summary: optionalText(input?.summary, "Summary", { max: 500 }),
  };

  if (type === "quote") {
    const dateIssued = parseLocalDate(input.dateIssued, "Date issued");
    const validUntil = parseLocalDate(input.validUntil, "Valid until");
    if (compareLocalDates(validUntil, dateIssued) < 0) {
      throw new DomainError("Valid until cannot be before the issue date.", "validUntil");
    }
    return {
      ...base,
      dateIssued: localDateISO(dateIssued),
      validUntil: localDateISO(validUntil),
      preparedBy: optionalText(input.preparedBy, "Prepared by", { max: 200 }),
      estStart: optionalText(input.estStart, "Estimated start", { max: 200 }),
      scope: optionalText(input.scope, "Scope", { max: 10000 }),
      includes: optionalText(input.includes, "Includes", { max: 2000 }),
      excludes: optionalText(input.excludes, "Excludes", { max: 2000 }),
      deposit: optionalText(input.deposit, "Deposit", { max: 500 }),
      status: oneOf(input.status || "Pending", QUOTE_STATUSES, "Quote status"),
      convertedTo: optionalText(input.convertedTo, "Converted invoice", { max: 200 }),
    };
  }

  const issueDate = parseLocalDate(input.issueDate, "Issue date");
  const dueDate = parseLocalDate(input.dueDate, "Due date");
  if (compareLocalDates(dueDate, issueDate) < 0) {
    throw new DomainError("Due date cannot be before the issue date.", "dueDate");
  }
  return {
    ...base,
    issueDate: localDateISO(issueDate),
    dueDate: localDateISO(dueDate),
    quoteRef: optionalText(input.quoteRef, "Quote reference", { max: 200 }),
    status: oneOf(input.status || "Unpaid", INVOICE_STATUSES, "Invoice status"),
    datePaid: input.datePaid ? documentDate(input.datePaid, "Date paid") : "",
    received: input.received || "",
  };
}

export function validateStatusTransition(type, current, next) {
  oneOf(type, DOCUMENT_TYPES, "Document type");
  const statuses = type === "quote" ? QUOTE_STATUSES : INVOICE_STATUSES;
  oneOf(current, statuses, "Current status");
  oneOf(next, STATUS_TRANSITIONS[type][current], "Next status");
  return next;
}

export function validateQuoteStatusCommand(number, status) {
  return {
    number: documentNumber(number, "Quote number"),
    status: oneOf(status, QUOTE_STATUSES, "Quote status"),
  };
}

export function validateInvoiceStatusCommand(number, status, { datePaid = "", received = "" } = {}) {
  const command = {
    number: documentNumber(number, "Invoice number"),
    status: oneOf(status, INVOICE_STATUSES, "Invoice status"),
    datePaid: datePaid ? documentDate(datePaid, "Date paid") : "",
    receivedCents: received === "" || received == null
      ? 0
      : parseCents(String(received).replace(/[$,\s]/g, ""), "Received"),
  };
  if (status === "Paid" && !command.datePaid) {
    throw new DomainError("Date paid is required when an invoice is paid.", "datePaid");
  }
  if (status !== "Paid" && (command.datePaid || command.receivedCents)) {
    throw new DomainError("Payment details are only allowed for paid invoices.", "status");
  }
  return command;
}

export function validateConversionCommand(quoteNumber, invoiceNumber) {
  return {
    quoteNumber: documentNumber(quoteNumber, "Quote number"),
    invoiceNumber: documentNumber(invoiceNumber, "Invoice number"),
  };
}

export function validateDocumentStateCommand(type, number) {
  return {
    type: oneOf(type, DOCUMENT_TYPES, "Document type"),
    number: documentNumber(number, type === "invoice" ? "Invoice number" : "Quote number"),
  };
}
