/**
 * tRPC Context
 * Creates the context used by all tRPC procedures
 */

import type { PrismaClient, User, OrganizationRole, PlatformAdmin } from "@provacx/database";
import { prisma } from "@provacx/database";

/**
 * Session type (from NextAuth)
 */
export interface Session {
  user: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  };
  expires: string;
}

/**
 * Context options passed from the API handler
 */
export interface CreateContextOptions {
  session: Session | null;
  organizationId?: string;
  platformAdmin?: PlatformAdmin | null;
  headers?: Headers;
}

/**
 * Context type - shared between all procedures
 */
export interface Context {
  prisma: PrismaClient;
  session: Session | null;
  user: User | null;
  organizationId: string | null;
  organizationRole: OrganizationRole | null;
  platformAdmin: PlatformAdmin | null;
}

/**
 * Create context for API handlers
 */
export async function createContext(opts: CreateContextOptions): Promise<Context> {
  let user: User | null = null;
  const requestedOrganizationId = opts.organizationId?.trim() || null;
  let organizationId: string | null = null;

  if (opts.session?.user?.id) {
    user = await prisma.user.findUnique({
      where: { id: opts.session.user.id },
    });
  }

  if (user) {
    // Respect explicit organization selection only when the user is actually a member.
    if (requestedOrganizationId) {
      const selectedMembership = await prisma.organizationUser.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: requestedOrganizationId,
          },
        },
        select: { organizationId: true },
      });

      if (selectedMembership) {
        organizationId = selectedMembership.organizationId;
      }
    }

    // Fallback to the first org membership when no valid org header is present.
    if (!organizationId) {
      const firstMembership = await prisma.organizationUser.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { organizationId: true },
      });

      organizationId = firstMembership?.organizationId ?? null;
    }
  }

  return {
    prisma,
    session: opts.session,
    user,
    organizationId,
    organizationRole: null, // Will be set by organizationProcedure
    platformAdmin: opts.platformAdmin ?? null,
  };
}
