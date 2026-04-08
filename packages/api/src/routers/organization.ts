/**
 * Organization Router
 * Handles organization management
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
  organizationProcedure,
  adminProcedure,
  ownerProcedure,
} from "../trpc";

export const organizationRouter = createTRPCRouter({
  /**
   * Create a new organization
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/),
        logo: z.string().url().optional(),
        address: z.string().max(500).optional(),
        phone: z.string().max(50).optional(),
        website: z.string().url().optional(),
        timezone: z.string().default("UTC"),
        currency: z.string().default("USD"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Check if slug is unique
      const existing = await ctx.prisma.organization.findUnique({
        where: { slug: input.slug },
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An organization with this slug already exists",
        });
      }

      // Create organization and add user as owner
      const organization = await ctx.prisma.organization.create({
        data: {
          ...input,
          users: {
            create: {
              userId: ctx.user!.id,
              role: "OWNER",
            },
          },
          subscription: {
            create: {
              plan: "FREE",
              status: "ACTIVE",
            },
          },
        },
      });

      return organization;
    }),

  /**
   * Get current organization
   */
  getCurrent: organizationProcedure.query(async ({ ctx }) => {
    return ctx.prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      include: {
        subscription: true,
        _count: {
          select: {
            users: true,
            projects: true,
          },
        },
      },
    });
  }),

  /**
   * Update organization
   */
  update: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
        logo: z.string().url().optional().nullable(),
        address: z.string().max(500).optional().nullable(),
        phone: z.string().max(50).optional().nullable(),
        website: z.string().url().optional().nullable(),
        timezone: z.string().optional(),
        currency: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.organization.update({
        where: { id: ctx.organizationId },
        data: input,
      });
    }),

  /**
   * Delete organization (owner only)
   */
  delete: ownerProcedure.mutation(async ({ ctx }) => {
    // Soft delete or hard delete based on requirements
    await ctx.prisma.organization.delete({
      where: { id: ctx.organizationId },
    });

    return { success: true };
  }),

  /**
   * Get organization members
   */
  getMembers: organizationProcedure.query(async ({ ctx }) => {
    const members = await ctx.prisma.organizationUser.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return members;
  }),

  /**
   * Invite member
   */
  inviteMember: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Check if user already exists and is member
      const existingUser = await ctx.prisma.user.findUnique({
        where: { email: input.email },
        include: {
          organizationUsers: {
            where: { organizationId: ctx.organizationId },
          },
        },
      });

      if (existingUser?.organizationUsers.length) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "User is already a member of this organization",
        });
      }

      // Create invitation
      const token = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

      const invitation = await ctx.prisma.organizationInvitation.create({
        data: {
          email: input.email,
          organizationId: ctx.organizationId,
          role: input.role,
          token,
          expiresAt,
        },
      });

      // TODO: Send invitation email

      return invitation;
    }),

  /**
   * Remove member
   */
  removeMember: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Can't remove yourself
      if (input.userId === ctx.user!.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot remove yourself from the organization",
        });
      }

      // Can't remove owner
      const member = await ctx.prisma.organizationUser.findUnique({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: ctx.organizationId,
          },
        },
      });

      if (member?.role === "OWNER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot remove the organization owner",
        });
      }

      await ctx.prisma.organizationUser.delete({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: ctx.organizationId,
          },
        },
      });

      return { success: true };
    }),

  /**
   * Update member role
   */
  updateMemberRole: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Can't change own role
      if (input.userId === ctx.user!.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot change your own role",
        });
      }

      // Can't change owner role (must transfer ownership)
      const member = await ctx.prisma.organizationUser.findUnique({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: ctx.organizationId,
          },
        },
      });

      if (member?.role === "OWNER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot change owner role. Transfer ownership instead.",
        });
      }

      return ctx.prisma.organizationUser.update({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: ctx.organizationId,
          },
        },
        data: { role: input.role },
      });
    }),

  /**
   * Transfer ownership
   */
  transferOwnership: ownerProcedure
    .input(z.object({ newOwnerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify new owner is a member
      const newOwnerMembership = await ctx.prisma.organizationUser.findUnique({
        where: {
          userId_organizationId: {
            userId: input.newOwnerId,
            organizationId: ctx.organizationId,
          },
        },
      });

      if (!newOwnerMembership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User is not a member of this organization",
        });
      }

      // Transfer ownership
      await ctx.prisma.$transaction([
        // Demote current owner to admin
        ctx.prisma.organizationUser.update({
          where: {
            userId_organizationId: {
              userId: ctx.user!.id,
              organizationId: ctx.organizationId,
            },
          },
          data: { role: "ADMIN" },
        }),
        // Promote new owner
        ctx.prisma.organizationUser.update({
          where: {
            userId_organizationId: {
              userId: input.newOwnerId,
              organizationId: ctx.organizationId,
            },
          },
          data: { role: "OWNER" },
        }),
      ]);

      return { success: true };
    }),
});
