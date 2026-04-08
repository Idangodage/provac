/**
 * Pricing Router
 * Handles unit rates and pricing rules
 */

import type { BOQCategory } from "@provacx/database";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  organizationProcedure,
  adminProcedure,
} from "../trpc";

export const pricingRouter = createTRPCRouter({
  /**
   * Get organization unit rates
   */
  getUnitRates: organizationProcedure
    .input(
      z.object({
        category: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const rates = await ctx.prisma.unitRate.findMany({
        where: {
          organizationId: ctx.organizationId,
          isActive: true,
          ...(input.category && {
            category: input.category as BOQCategory,
          }),
          ...(input.search && {
            OR: [
              { description: { contains: input.search, mode: "insensitive" } },
              { itemCode: { contains: input.search, mode: "insensitive" } },
            ],
          }),
        },
        orderBy: [{ category: "asc" }, { description: "asc" }],
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined = undefined;
      if (rates.length > input.limit) {
        const nextItem = rates.pop();
        nextCursor = nextItem?.id;
      }

      return { rates, nextCursor };
    }),

  /**
   * Create unit rate
   */
  createUnitRate: adminProcedure
    .input(
      z.object({
        category: z.enum([
          "DUCTWORK", "FITTINGS", "TERMINALS", "EQUIPMENT", "VRF_PIPING",
          "INSULATION", "SUPPORTS", "ACCESSORIES", "ELECTRICAL", "CONTROLS",
          "TESTING", "MISCELLANEOUS",
        ]),
        itemCode: z.string().max(50).optional(),
        description: z.string().min(1).max(500),
        unit: z.string().min(1).max(20),
        materialRate: z.number().min(0),
        labourRate: z.number().min(0),
        currency: z.string().default("USD"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const totalRate = input.materialRate + input.labourRate;

      return ctx.prisma.unitRate.create({
        data: {
          ...input,
          totalRate,
          organizationId: ctx.organizationId,
        },
      });
    }),

  /**
   * Update unit rate
   */
  updateUnitRate: adminProcedure
    .input(
      z.object({
        id: z.string(),
        category: z.enum([
          "DUCTWORK", "FITTINGS", "TERMINALS", "EQUIPMENT", "VRF_PIPING",
          "INSULATION", "SUPPORTS", "ACCESSORIES", "ELECTRICAL", "CONTROLS",
          "TESTING", "MISCELLANEOUS",
        ]).optional(),
        itemCode: z.string().max(50).optional().nullable(),
        description: z.string().min(1).max(500).optional(),
        unit: z.string().min(1).max(20).optional(),
        materialRate: z.number().min(0).optional(),
        labourRate: z.number().min(0).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      // Verify rate belongs to organization
      const rate = await ctx.prisma.unitRate.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });

      if (!rate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Unit rate not found",
        });
      }

      // Recalculate total if rates changed
      const materialRate = data.materialRate ?? rate.materialRate;
      const labourRate = data.labourRate ?? rate.labourRate;
      const totalRate = materialRate + labourRate;

      return ctx.prisma.unitRate.update({
        where: { id },
        data: {
          ...data,
          totalRate,
        },
      });
    }),

  /**
   * Delete unit rate
   */
  deleteUnitRate: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify rate belongs to organization
      const rate = await ctx.prisma.unitRate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });

      if (!rate) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Unit rate not found",
        });
      }

      await ctx.prisma.unitRate.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Get project pricing rules
   */
  getProjectRules: organizationProcedure
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

      return ctx.prisma.pricingRule.findMany({
        where: { projectId: input.projectId },
        orderBy: { priority: "asc" },
      });
    }),

  /**
   * Create pricing rule
   */
  createRule: organizationProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1).max(100),
        type: z.enum([
          "MARKUP_PERCENTAGE", "MARKUP_FIXED", "DISCOUNT_PERCENTAGE",
          "DISCOUNT_FIXED", "OVERHEAD", "PROFIT", "CONTINGENCY",
        ]),
        scope: z.enum(["PROJECT", "CATEGORY", "ITEM"]),
        category: z.enum([
          "DUCTWORK", "FITTINGS", "TERMINALS", "EQUIPMENT", "VRF_PIPING",
          "INSULATION", "SUPPORTS", "ACCESSORIES", "ELECTRICAL", "CONTROLS",
          "TESTING", "MISCELLANEOUS",
        ]).optional(),
        value: z.number(),
        priority: z.number().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
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

      return ctx.prisma.pricingRule.create({
        data: input,
      });
    }),

  /**
   * Update pricing rule
   */
  updateRule: organizationProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        type: z.enum([
          "MARKUP_PERCENTAGE", "MARKUP_FIXED", "DISCOUNT_PERCENTAGE",
          "DISCOUNT_FIXED", "OVERHEAD", "PROFIT", "CONTINGENCY",
        ]).optional(),
        scope: z.enum(["PROJECT", "CATEGORY", "ITEM"]).optional(),
        category: z.enum([
          "DUCTWORK", "FITTINGS", "TERMINALS", "EQUIPMENT", "VRF_PIPING",
          "INSULATION", "SUPPORTS", "ACCESSORIES", "ELECTRICAL", "CONTROLS",
          "TESTING", "MISCELLANEOUS",
        ]).optional().nullable(),
        value: z.number().optional(),
        priority: z.number().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      // Verify rule belongs to organization
      const rule = await ctx.prisma.pricingRule.findUnique({
        where: { id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!rule || rule.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pricing rule not found",
        });
      }

      return ctx.prisma.pricingRule.update({
        where: { id },
        data,
      });
    }),

  /**
   * Delete pricing rule
   */
  deleteRule: organizationProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify rule belongs to organization
      const rule = await ctx.prisma.pricingRule.findUnique({
        where: { id: input.id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!rule || rule.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pricing rule not found",
        });
      }

      await ctx.prisma.pricingRule.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Apply unit rates to BOQ items
   */
  applyRatesToBoq: organizationProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Get project with BOQ items
      const project = await ctx.prisma.project.findFirst({
        where: {
          id: input.projectId,
          organizationId: ctx.organizationId,
        },
        include: {
          boqItems: true,
          pricingRules: { where: { isActive: true }, orderBy: { priority: "asc" } },
        },
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Get organization unit rates
      const unitRates = await ctx.prisma.unitRate.findMany({
        where: { organizationId: ctx.organizationId, isActive: true },
      });

      // Create rate lookup map
      const rateMap = new Map(
        unitRates.map((r: (typeof unitRates)[number]) => [`${r.category}-${r.description}`, r])
      );

      // Update each BOQ item
      const updatedItems = await Promise.all(
        project.boqItems.map(async (item: (typeof project.boqItems)[number]) => {
          // Find matching rate
          const rate = rateMap.get(`${item.category}-${item.description}`) ||
            unitRates.find((r: (typeof unitRates)[number]) => r.category === item.category);

          if (!rate) return item;

          const materialCost = item.quantity * rate.materialRate;
          const labourCost = item.quantity * rate.labourRate;
          let totalCost = materialCost + labourCost;

          // Apply pricing rules
          for (const rule of project.pricingRules) {
            if (rule.scope === "CATEGORY" && rule.category !== item.category) {
              continue;
            }

            switch (rule.type) {
              case "MARKUP_PERCENTAGE":
              case "OVERHEAD":
              case "PROFIT":
              case "CONTINGENCY":
                totalCost *= 1 + rule.value / 100;
                break;
              case "MARKUP_FIXED":
                totalCost += rule.value;
                break;
              case "DISCOUNT_PERCENTAGE":
                totalCost *= 1 - rule.value / 100;
                break;
              case "DISCOUNT_FIXED":
                totalCost -= rule.value;
                break;
            }
          }

          return ctx.prisma.bOQItem.update({
            where: { id: item.id },
            data: {
              unitRate: rate.totalRate,
              materialCost,
              labourCost,
              totalCost: Math.max(0, totalCost),
            },
          });
        })
      );

      return { updatedCount: updatedItems.length };
    }),

  /**
   * Calculate project totals
   */
  calculateTotals: organizationProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      // Get project with BOQ items and rules
      const project = await ctx.prisma.project.findFirst({
        where: {
          id: input.projectId,
          organizationId: ctx.organizationId,
        },
        include: {
          boqItems: true,
          pricingRules: { where: { isActive: true } },
        },
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const materialCost = project.boqItems.reduce((sum: number, i: (typeof project.boqItems)[number]) => sum + i.materialCost, 0);
      const labourCost = project.boqItems.reduce((sum: number, i: (typeof project.boqItems)[number]) => sum + i.labourCost, 0);
      const subtotal = materialCost + labourCost;

      // Get overhead, profit, contingency from rules
      const overheadRule = project.pricingRules.find((r: (typeof project.pricingRules)[number]) => r.type === "OVERHEAD");
      const profitRule = project.pricingRules.find((r: (typeof project.pricingRules)[number]) => r.type === "PROFIT");
      const contingencyRule = project.pricingRules.find((r: (typeof project.pricingRules)[number]) => r.type === "CONTINGENCY");

      const overhead = subtotal * ((overheadRule?.value ?? 0) / 100);
      const profit = (subtotal + overhead) * ((profitRule?.value ?? 0) / 100);
      const contingency = (subtotal + overhead + profit) * ((contingencyRule?.value ?? 0) / 100);

      const beforeTax = subtotal + overhead + profit + contingency;
      const taxAmount = beforeTax * (project.taxRate / 100);
      const total = beforeTax + taxAmount;

      return {
        materialCost,
        labourCost,
        subtotal,
        overhead,
        profit,
        contingency,
        taxRate: project.taxRate,
        taxAmount,
        total,
      };
    }),
});
