/**
 * Proposal Router
 * Handles proposal generation and management
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  organizationProcedure,
} from "../trpc";

export const proposalRouter = createTRPCRouter({
  /**
   * List proposals for a project
   */
  listByProject: organizationProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      // Verify project belongs to organization
      const project = await ctx.prisma.project.findFirst({
        where: {
          id: input.projectId,
          organizationId: ctx.organizationId,
        },
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      return ctx.prisma.proposal.findMany({
        where: { projectId: input.projectId },
        include: {
          createdBy: {
            select: { id: true, name: true, image: true },
          },
        },
        orderBy: { version: "desc" },
      });
    }),

  /**
   * Get proposal by ID
   */
  getById: organizationProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const proposal = await ctx.prisma.proposal.findUnique({
        where: { id: input.id },
        include: {
          project: {
            select: {
              id: true,
              name: true,
              clientName: true,
              clientEmail: true,
              location: true,
              organizationId: true,
            },
          },
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      });

      if (!proposal || proposal.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      return proposal;
    }),

  /**
   * Create proposal
   */
  create: organizationProcedure
    .input(
      z.object({
        projectId: z.string(),
        coverLetter: z.string().optional(),
        terms: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Get project with BOQ
      const project = await ctx.prisma.project.findFirst({
        where: {
          id: input.projectId,
          organizationId: ctx.organizationId,
        },
        include: {
          boqItems: true,
          drawings: {
            take: 1,
            orderBy: { updatedAt: "desc" },
          },
        },
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Calculate totals
      const subtotal = project.boqItems.reduce((sum: number, item: (typeof project.boqItems)[number]) => sum + item.totalCost, 0);
      const taxAmount = subtotal * (project.taxRate / 100);
      const total = subtotal + taxAmount;

      // Get latest version
      const latestProposal = await ctx.prisma.proposal.findFirst({
        where: { projectId: input.projectId },
        orderBy: { version: "desc" },
      });
      const version = (latestProposal?.version ?? 0) + 1;

      // Calculate validity
      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + project.validityDays);

      return ctx.prisma.proposal.create({
        data: {
          projectId: input.projectId,
          createdById: ctx.user!.id,
          version,
          coverLetter: input.coverLetter,
          terms: input.terms ?? project.defaultTerms,
          notes: input.notes,
          subtotal,
          taxRate: project.taxRate,
          taxAmount,
          total,
          boqSnapshot: project.boqItems,
          drawingSnapshot: project.drawings[0]?.thumbnail,
          validUntil,
        },
      });
    }),

  /**
   * Update proposal
   */
  update: organizationProcedure
    .input(
      z.object({
        id: z.string(),
        coverLetter: z.string().optional(),
        terms: z.string().optional(),
        notes: z.string().optional(),
        status: z.enum([
          "DRAFT", "PENDING_REVIEW", "SENT", "VIEWED",
          "ACCEPTED", "REJECTED", "EXPIRED", "REVISED",
        ]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      // Verify proposal belongs to organization
      const proposal = await ctx.prisma.proposal.findUnique({
        where: { id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!proposal || proposal.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      return ctx.prisma.proposal.update({
        where: { id },
        data,
      });
    }),

  /**
   * Update proposal totals (recalculate from BOQ)
   */
  updateTotals: organizationProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Get project with BOQ
      const project = await ctx.prisma.project.findFirst({
        where: {
          id: input.projectId,
          organizationId: ctx.organizationId,
        },
        include: {
          boqItems: true,
          proposals: {
            where: { status: "DRAFT" },
            orderBy: { version: "desc" },
            take: 1,
          },
        },
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      if (!project.proposals[0]) {
        return null;
      }

      // Calculate totals
      const subtotal = project.boqItems.reduce((sum: number, item: (typeof project.boqItems)[number]) => sum + item.totalCost, 0);
      const taxAmount = subtotal * (project.taxRate / 100);
      const total = subtotal + taxAmount;

      return ctx.prisma.proposal.update({
        where: { id: project.proposals[0].id },
        data: {
          subtotal,
          taxAmount,
          total,
          boqSnapshot: project.boqItems,
        },
      });
    }),

  /**
   * Mark proposal as sent
   */
  markAsSent: organizationProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify proposal belongs to organization
      const proposal = await ctx.prisma.proposal.findUnique({
        where: { id: input.id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!proposal || proposal.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      return ctx.prisma.proposal.update({
        where: { id: input.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
        },
      });
    }),

  /**
   * Delete proposal
   */
  delete: organizationProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify proposal belongs to organization
      const proposal = await ctx.prisma.proposal.findUnique({
        where: { id: input.id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!proposal || proposal.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      await ctx.prisma.proposal.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Generate PDF (stub - actual implementation in PDF generator package)
   */
  generatePdf: organizationProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify proposal belongs to organization
      const proposal = await ctx.prisma.proposal.findUnique({
        where: { id: input.id },
        include: {
          project: {
            include: {
              organization: true,
            },
          },
        },
      });

      if (!proposal || proposal.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      // TODO: Call PDF generator service
      // For now, return a placeholder
      const pdfUrl = `/api/proposals/${input.id}/pdf`;

      await ctx.prisma.proposal.update({
        where: { id: input.id },
        data: { pdfUrl },
      });

      return { pdfUrl };
    }),
});
