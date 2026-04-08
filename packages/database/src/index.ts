// Re-export Prisma client
export { prisma } from "./client";
export type { PrismaClient } from "./client";

// Re-export the Prisma types used inside this workspace.
export type {
  BOQCategory,
  ComponentType,
  ConnectionType,
  OrganizationRole,
  PlatformAdmin,
  Prisma,
  User,
} from "@prisma/client";
