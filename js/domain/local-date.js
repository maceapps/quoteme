import { DomainError } from "./validation.js";

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseLocalDate(value, field = "Date") {
  const match = ISO_PATTERN.exec(String(value || ""));
  if (!match) throw new DomainError(`${field} must use YYYY-MM-DD format.`, field);
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12
    || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    throw new DomainError(`${field} is not a valid date.`, field);
  }
  return Object.freeze(date);
}

export function localDateISO(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;
}

export function todayLocalDate(now = new Date()) {
  return Object.freeze({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  });
}

export function todayISO(now = new Date()) {
  return localDateISO(todayLocalDate(now));
}

export function addLocalDays(value, amount) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  if (!Number.isInteger(amount)) throw new DomainError("Day offset must be an integer.", "amount");
  const instant = new Date(Date.UTC(date.year, date.month - 1, date.day + amount, 12));
  return Object.freeze({
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  });
}

export function compareLocalDates(left, right) {
  return localDateISO(left).localeCompare(localDateISO(right));
}

export function localDayOfWeek(value) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 12)).getUTCDay();
}

export function mondayFor(value) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  const day = localDayOfWeek(date);
  return addLocalDays(date, day === 0 ? -6 : 1 - day);
}

export function formatLocalDate(value) {
  if (!value) return "—";
  try {
    const date = typeof value === "string" ? parseLocalDate(value) : value;
    const pad = (part) => String(part).padStart(2, "0");
    return `${pad(date.day)} / ${pad(date.month)} / ${date.year}`;
  } catch {
    return String(value);
  }
}

export function displayLocalDate(value, includeYear = false) {
  const date = typeof value === "string" ? parseLocalDate(value) : value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const base = `${String(date.day).padStart(2, "0")} ${months[date.month - 1]}`;
  return includeYear ? `${base} ${date.year}` : base;
}
