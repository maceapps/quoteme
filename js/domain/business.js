import { DomainError, optionalText, requiredText } from "./validation.js";

export function validateBusinessDetails(input) {
  const bank = input?.bank || {};
  const email = optionalText(input?.email, "Business email", { max: 254 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new DomainError("Business email is invalid.", "email");
  }
  const abn = optionalText(input?.abn, "ABN", { max: 30 });
  if (abn && !/^\d{2}\s?\d{3}\s?\d{3}\s?\d{3}$/.test(abn)) {
    throw new DomainError("ABN must contain 11 digits.", "abn");
  }
  return {
    name: requiredText(input?.name, "Business name", { max: 200 }),
    addressLine1: optionalText(input?.addressLine1, "Address line 1", { max: 300 }),
    addressLine2: optionalText(input?.addressLine2, "Address line 2", { max: 300 }),
    phone: optionalText(input?.phone, "Business phone", { max: 80 }),
    email,
    licence: optionalText(input?.licence, "Licence", { max: 100 }),
    abn,
    bank: {
      bankName: optionalText(bank.bankName, "Bank name", { max: 100 }),
      accountName: optionalText(bank.accountName, "Account name", { max: 200 }),
      bsb: optionalText(bank.bsb, "BSB", { max: 20 }),
      account: optionalText(bank.account, "Account number", { max: 40 }),
    },
  };
}
