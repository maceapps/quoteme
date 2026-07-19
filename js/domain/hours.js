import { DomainError } from "./validation.js";

export function parseHourHundredths(value, field = "Hours") {
  const text = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new DomainError(`${field} must be a number with no more than two decimal places.`, field);
  }
  const hundredths = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (hundredths < 0 || hundredths > 2400) {
    throw new DomainError(`${field} must be between 0 and 24.`, field);
  }
  return hundredths;
}

export function hoursFromHundredths(hundredths) {
  if (!Number.isInteger(hundredths) || hundredths < 0) {
    throw new DomainError("Hours must be stored as non-negative integer hundredths.", "hoursHundredths");
  }
  return hundredths / 100;
}

export function formatHourHundredths(hundredths) {
  return hoursFromHundredths(hundredths).toFixed(2);
}
