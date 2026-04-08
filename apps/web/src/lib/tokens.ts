import crypto from "crypto";

export function generateRandomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

