/**
 * Project Router
 * Handles project CRUD operations
 */

import type { Prisma } from "@provacx/database";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  organizationProcedure,
} from "../trpc";

export const projectRouter = createTRPCRouter({
  /**
   * List projects for organization
   */
  list: organizationProcedure
    .input(
      z.object({
        status: z.enum(["DRAFT", "IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED", "COMPLETED", "ARCHIVED"]).optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const projects = await ctx.prisma.project.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.status && { status: input.status }),
          ...(input.search && {
            OR: [
              { name: { contains: input.search, mode: "insensitive" } },
              { clientName: { contains: input.search, mode: "insensitive" } },
            ],
          }),
        },
        include: {
          createdBy: {
            select: { id: true, name: true, image: true },
          },
          _count: {
            select: {
              drawings: true,
              boqItems: true,
              proposals: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined = undefined;
      if (projects.length > input.limit) {
        const nextItem = projects.pop();
        nextCursor = nextItem?.id;
      }

      return { projects, nextCursor };
    }),

  /**
   * Get project by ID
   */
  getById: organizationProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.prisma.project.findFirst({
        where: {
          id: input.id,
          organizationId: ctx.organizationId,
        },
        include: {
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
          drawings: {
            orderBy: { updatedAt: "desc" },
          },
          boqItems: {
            orderBy: { sortOrder: "asc" },
          },
          pricingRules: {
            orderBy: { priority: "asc" },
          },
          proposals: {
            orderBy: { version: "desc" },
          },
          complianceSheet: true,
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

      return {
        ...project,
        totals: {
          subtotal,
          taxRate: project.taxRate,
          taxAmount,
          total,
        },
      };
    }),

  /**
   * Create project
   */
  create: organizationProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        clientName: z.string().max(200).optional(),
        clientEmail: z.string().email().optional(),
        clientPhone: z.string().max(50).optional(),
        location: z.string().max(500).optional(),
        workflow: z.enum(["FULL", "BOQ", "QUICK", "IMPORT"]).default("FULL"),
        layoutTemplate: z.string().optional(),
        layoutSettings: z.record(z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { layoutSettings, ...restInput } = input;

      const project = await ctx.prisma.project.create({
        data: {
          ...restInput,
          ...(layoutSettings !== undefined && {
            layoutSettings: layoutSettings as Prisma.InputJsonValue,
          }),
          organizationId: ctx.organizationId,
          createdById: ctx.user!.id,
        },
      });

      return project;
    }),

  /**
   * Update project
   */
  update: organizationProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(1000).optional().nullable(),
        clientName: z.string().max(200).optional().nullable(),
        clientEmail: z.string().email().optional().nullable(),
        clientPhone: z.string().max(50).optional().nullable(),
        location: z.string().max(500).optional().nullable(),
        status: z.enum(["DRAFT", "IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED", "COMPLETED", "ARCHIVED"]).optional(),
        taxRate: z.number().min(0).max(100).optional(),
        validityDays: z.number().min(1).max(365).optional(),
        warrantyMonths: z.number().min(1).max(120).optional(),
        defaultTerms: z.string().optional().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      // Verify project belongs to organization
      const existing = await ctx.prisma.project.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      return ctx.prisma.project.update({
        where: { id },
        data,
      });
    }),

  /**
   * Delete project
   */
  delete: organizationProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify project belongs to organization
      const existing = await ctx.prisma.project.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      await ctx.prisma.project.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Duplicate project
   */
  duplicate: organizationProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const original = await ctx.prisma.project.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          drawings: {
            include: { components: true },
          },
          boqItems: true,
          pricingRules: true,
        },
      });

      if (!original) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Create new project with copied data
      const newProject = await ctx.prisma.project.create({
        data: {
          name: input.name,
          description: original.description,
          clientName: original.clientName,
          clientEmail: original.clientEmail,
          clientPhone: original.clientPhone,
          location: original.location,
          workflow: original.workflow,
          layoutTemplate: original.layoutTemplate,
          layoutSettings: original.layoutSettings ?? undefined,
          taxRate: original.taxRate,
          validityDays: original.validityDays,
          warrantyMonths: original.warrantyMonths,
          defaultTerms: original.defaultTerms,
          organizationId: ctx.organizationId,
          createdById: ctx.user!.id,
          status: "DRAFT",
        },
      });

      // Copy BOQ items
      if (original.boqItems.length > 0) {
        await ctx.prisma.bOQItem.createMany({
          data: original.boqItems.map((item: (typeof original.boqItems)[number]) => ({
            projectId: newProject.id,
            category: item.category,
            itemNumber: item.itemNumber,
            description: item.description,
            specification: item.specification,
            unit: item.unit,
            quantity: item.quantity,
            unitRate: item.unitRate,
            materialCost: item.materialCost,
            labourCost: item.labourCost,
            totalCost: item.totalCost,
            notes: item.notes,
            sortOrder: item.sortOrder,
          })),
        });
      }

      // Copy pricing rules
      if (original.pricingRules.length > 0) {
        await ctx.prisma.pricingRule.createMany({
          data: original.pricingRules.map((rule: (typeof original.pricingRules)[number]) => ({
            projectId: newProject.id,
            name: rule.name,
            type: rule.type,
            scope: rule.scope,
            category: rule.category,
            value: rule.value,
            priority: rule.priority,
            isActive: rule.isActive,
          })),
        });
      }

      return newProject;
    }),

  /**
   * Get project progress/step
   */
  getProgress: organizationProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.prisma.project.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          _count: {
            select: {
              drawings: true,
              boqItems: true,
              proposals: true,
            },
          },
          pricingRules: { where: { isActive: true } },
        },
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Determine progress based on workflow
      const hasDrawings = project._count.drawings > 0;
      const hasBoq = project._count.boqItems > 0;
      const hasPricing = project.pricingRules.length > 0;
      const hasProposal = project._count.proposals > 0;

      let currentStep = 0;
      const completedSteps: string[] = [];

      if (project.workflow === "FULL") {
        if (hasDrawings) {
          completedSteps.push("drawing");
          currentStep = 1;
        }
        if (hasBoq) {
          completedSteps.push("boq");
          currentStep = 2;
        }
        if (hasPricing) {
          completedSteps.push("pricing");
          currentStep = 3;
        }
        if (hasProposal) {
          completedSteps.push("proposal");
          currentStep = 4;
        }
      }

      return {
        workflow: project.workflow,
        currentStep,
        completedSteps,
        hasDrawings,
        hasBoq,
        hasPricing,
        hasProposal,
      };
    }),
});
