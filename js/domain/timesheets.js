import {
  addLocalDays, localDateISO, localDayOfWeek, parseLocalDate,
} from "./local-date.js";
import { hoursFromHundredths, parseHourHundredths } from "./hours.js";
import {
  DomainError, identifier, optionalInstant, optionalText, requiredText,
} from "./validation.js";

const cloneSnapshot = (value) => JSON.parse(JSON.stringify(value));

export function validateTimesheet(input) {
  const weekStartDate = parseLocalDate(input?.weekStart, "Week start");
  if (localDayOfWeek(weekStartDate) !== 1) {
    throw new DomainError("The timesheet must start on a Monday.", "weekStart");
  }
  if (!Array.isArray(input?.days) || input.days.length !== 7) {
    throw new DomainError("The timesheet must contain Monday through Sunday.", "days");
  }

  let totalHoursHundredths = 0;
  const days = input.days.map((day, index) => {
    const expected = localDateISO(addLocalDays(weekStartDate, index));
    if (day?.date !== expected) {
      throw new DomainError(`${expected} is required for this timesheet day.`, `days.${index}.date`);
    }
    const hoursHundredths = Number.isInteger(day.hoursHundredths)
      ? day.hoursHundredths
      : parseHourHundredths(day.hours, `${expected} hours`);
    if (hoursHundredths < 0 || hoursHundredths > 2400) {
      throw new DomainError("Daily hours must be between 0 and 24.", `days.${index}.hours`);
    }
    totalHoursHundredths += hoursHundredths;
    return {
      date: expected,
      hoursHundredths,
      hours: hoursFromHundredths(hoursHundredths),
    };
  });
  if (!totalHoursHundredths) {
    throw new DomainError("Enter hours for at least one day.", "days");
  }

  return {
    id: identifier(input?.id, "Timesheet ID", { required: false }),
    jobId: identifier(input?.jobId, "Job ID"),
    jobName: requiredText(input?.jobName, "Job name", { max: 200 }),
    ...(Object.prototype.hasOwnProperty.call(input || {}, "jobSnapshot")
      ? {
          jobSnapshot: input.jobSnapshot && typeof input.jobSnapshot === "object"
            ? cloneSnapshot(input.jobSnapshot)
            : null,
        }
      : {}),
    workerId: identifier(input?.workerId, "Worker ID"),
    workerName: requiredText(input?.workerName, "Worker name", { max: 200 }),
    ...(Object.prototype.hasOwnProperty.call(input || {}, "workerSnapshot")
      ? {
          workerSnapshot: input.workerSnapshot && typeof input.workerSnapshot === "object"
            ? cloneSnapshot(input.workerSnapshot)
            : null,
        }
      : {}),
    weekStart: localDateISO(weekStartDate),
    weekEnd: localDateISO(addLocalDays(weekStartDate, 6)),
    days,
    totalHoursHundredths,
    totalHours: hoursFromHundredths(totalHoursHundredths),
    weeklyNote: optionalText(input?.weeklyNote, "Weekly note", { max: 5000 }),
    ...(Object.prototype.hasOwnProperty.call(input || {}, "docLink")
      ? { docLink: optionalText(input.docLink, "Document link", { max: 2000 }) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input || {}, "pdfLink")
      ? { pdfLink: optionalText(input.pdfLink, "PDF link", { max: 2000 }) }
      : {}),
    createdAt: optionalInstant(input?.createdAt, "Created timestamp"),
    updatedAt: optionalInstant(input?.updatedAt, "Updated timestamp"),
  };
}

export function validateTimesheetDeleteCommand(id) {
  return { id: identifier(id, "Timesheet ID") };
}
