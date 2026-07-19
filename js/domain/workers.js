import {
  identifier, oneOf, optionalInstant, optionalText, requiredText,
} from "./validation.js";

export const WORKER_STATUSES = Object.freeze(["Active", "Archived"]);

export function validateWorker(input) {
  return {
    id: identifier(input?.id, "Worker ID", { required: false }),
    firstName: requiredText(input?.firstName, "First name", { max: 100 }),
    lastName: requiredText(input?.lastName, "Last name", { max: 100 }),
    mobile: optionalText(input?.mobile, "Mobile number", { max: 80 }),
    status: oneOf(input?.status || "Active", WORKER_STATUSES, "Worker status"),
    createdAt: optionalInstant(input?.createdAt, "Created timestamp"),
    updatedAt: optionalInstant(input?.updatedAt, "Updated timestamp"),
  };
}

export function validateWorkerId(id) {
  return identifier(id, "Worker ID");
}
