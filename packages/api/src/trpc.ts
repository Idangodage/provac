/**
 * tRPC Server Configuration
 * This is the main setup file for the tRPC server
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import type { Context } from "./context";

/**
 * Initialize tRPC with context and transformer
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

/**
 * Create a tRPC router
 */
export const createTRPCRouter = t.router;

/**
 * Create a caller factory for server-side calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * Merge multiple routers
 */
export const mergeRouters = t.mergeRouters;

/**
 * Public procedure - no authentication required
 */
export const publicProcedure = t.procedure;

/**
 * Authenticated procedure - requires logged-in user
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      user: ctx.user,
    },
  });
});

/**
 * Organization procedure - requires user to be part of an organization
 */
export const organizationProcedure = protectedProcedure.use(
  async ({ ctx, next }) => {
    if (!ctx.organizationId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You must select an organization to access this resource",
      });
    }

    // Verify user is member of organization
    const membership = await ctx.prisma.organizationUser.findUnique({
      where: {
        userId_organizationId: {
          userId: ctx.user.id,
          organizationId: ctx.organizationId,
        },
      },
    });

    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not a member of this organization",
      });
    }

    return next({
      ctx: {
        ...ctx,
        organizationId: ctx.organizationId,
        organizationRole: membership.role,
      },
    });
  }
);

/**
 * Admin procedure - requires ADMIN or OWNER role in organization
 */
export const adminProcedure = organizationProcedure.use(
  async ({ ctx, next }) => {
    if (ctx.organizationRole !== "ADMIN" && ctx.organizationRole !== "OWNER") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You must be an admin to perform this action",
      });
    }

    return next({ ctx });
  }
);

/**
 * Owner procedure - requires OWNER role in organization
 */
export const ownerProcedure = organizationProcedure.use(
  async ({ ctx, next }) => {
    if (ctx.organizationRole !== "OWNER") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only the organization owner can perform this action",
      });
    }

    return next({ ctx });
  }
);

/**
 * Platform admin procedure - requires SUPER_ADMIN role
 */
export const platformAdminProcedure = t.procedure.use(
  async ({ ctx, next }) => {
    if (!ctx.platformAdmin) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Platform admin access required",
      });
    }

    return next({
      ctx: {
        ...ctx,
        platformAdmin: ctx.platformAdmin,
      },
    });
  }
);
