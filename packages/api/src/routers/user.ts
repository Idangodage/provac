/**
 * User Router
 * Handles user profile and settings
 */

import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
} from "../trpc";

export const userRouter = createTRPCRouter({
  /**
   * Get current user
   */
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.user;
  }),

  /**
   * Update user profile
   */
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .transform((v) => v.trim().replace(/<[^>]*>/g, ""))
          .optional(),
        image: z.string().url().max(2048).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.user.update({
        where: { id: ctx.user!.id },
        data: input,
      });
    }),

  /**
   * Get user's organizations
   */
  getOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.prisma.organizationUser.findMany({
      where: { userId: ctx.user!.id },
      include: {
        organization: true,
      },
      orderBy: {
        organization: { name: "asc" },
      },
    });

    return memberships.map((m: (typeof memberships)[number]) => ({
      ...m.organization,
      role: m.role,
    }));
  }),

  /**
   * Get onboarding status
   */
  getOnboardingStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = ctx.user!;

    // Check if user has completed profile
    const profileComplete = !!user.name;

    // Check if user has an organization
    const orgCount = await ctx.prisma.organizationUser.count({
      where: { userId: user.id },
    });
    const orgComplete = orgCount > 0;

    // Check if user has created a project
    const projectCount = await ctx.prisma.project.count({
      where: { createdById: user.id },
    });
    const firstProjectComplete = projectCount > 0;

    return {
      profileComplete,
      orgComplete,
      invitesComplete: true, // Optional step
      firstProjectComplete,
      isComplete: profileComplete && orgComplete && firstProjectComplete,
    };
  }),
});
