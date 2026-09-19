import { randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}
