import { ulid as _ulid } from "ulid";

/** Generate a new ULID (time-sortable unique id). */
export function generateUlid(): string {
  return _ulid();
}
