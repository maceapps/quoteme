export class DomainError extends Error {
  constructor(message, field = "") {
    super(message);
    this.name = "DomainError";
    this.field = field;
  }
}

export function requiredText(value, field, { max = 500 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw new DomainError(`${field} is required.`, field);
  if (text.length > max) throw new DomainError(`${field} must be ${max} characters or fewer.`, field);
  return text;
}

export function optionalText(value, field, { max = 2000 } = {}) {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new DomainError(`${field} must be ${max} characters or fewer.`, field);
  return text;
}

export function identifier(value, field, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text && !required) return "";
  if (!text) throw new DomainError(`${field} is required.`, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text)) {
    throw new DomainError(`${field} is invalid.`, field);
  }
  return text;
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new DomainError(`${field} must be one of: ${allowed.join(", ")}.`, field);
  }
  return value;
}

export function optionalInstant(value, field) {
  if (!value) return "";
  const text = String(value);
  if (!Number.isFinite(Date.parse(text))) throw new DomainError(`${field} is invalid.`, field);
  return text;
}
