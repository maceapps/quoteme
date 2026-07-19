import {
  identifier, oneOf, optionalInstant, optionalText, requiredText,
} from "./validation.js";

export const JOB_STATUSES = Object.freeze(["Active", "Complete", "Archived"]);

export function validateJob(input) {
  const client = input?.client || {};
  return {
    id: identifier(input?.id, "Job ID", { required: false }),
    status: oneOf(input?.status || "Active", JOB_STATUSES, "Job status"),
    name: requiredText(input?.name, "Job name", { max: 200 }),
    client: {
      name: optionalText(client.name, "Client name", { max: 200 }),
      attn: optionalText(client.attn, "Contact", { max: 200 }),
      address: optionalText(client.address, "Client address", { max: 500 }),
      suburb: optionalText(client.suburb, "Suburb, state and postcode", { max: 300 }),
      phone: optionalText(client.phone, "Client phone", { max: 80 }),
    },
    jobSite: optionalText(input?.jobSite, "Job site", { max: 500 }),
    createdAt: optionalInstant(input?.createdAt, "Created timestamp"),
    updatedAt: optionalInstant(input?.updatedAt, "Updated timestamp"),
  };
}

export function validateJobDeleteCommand(id) {
  return { id: identifier(id, "Job ID") };
}
