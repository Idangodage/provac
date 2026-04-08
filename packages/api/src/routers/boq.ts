/**
 * BOQ Router
 * Handles Bill of Quantities operations
 */

import type { BOQCategory } from "@provacx/database";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  organizationProcedure,
} from "../trpc";

export const boqRouter = createTRPCRouter({
  /**
   * List BOQ items for a project
   */
  listByProject: organizationProcedure
    .input(
      z.object({
        projectId: z.string(),
        category: z.string().optional(),
      })
    )
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

      const items = await ctx.prisma.bOQItem.findMany({
        where: {
          projectId: input.projectId,
          ...(input.category && { category: input.category as BOQCategory }),
        },
        orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
      });

      // Group by category
      const grouped = items.reduce((acc: Record<string, typeof items>, item: (typeof items)[number]) => {
        const categoryKey = item.category;
        const bucket = acc[categoryKey] ?? [];
        bucket.push(item);
        acc[categoryKey] = bucket;
        return acc;
      }, {} as Record<string, typeof items>);

      // Calculate totals
      const totals = {
        materialCost: items.reduce((sum: number, i: (typeof items)[number]) => sum + i.materialCost, 0),
        labourCost: items.reduce((sum: number, i: (typeof items)[number]) => sum + i.labourCost, 0),
        totalCost: items.reduce((sum: number, i: (typeof items)[number]) => sum + i.totalCost, 0),
        itemCount: items.length,
      };

      return { items, grouped, totals };
    }),

  /**
   * Add BOQ item
   */
  create: organizationProcedure
    .input(
      z.object({
        projectId: z.string(),
        componentId: z.string().optional(),
        category: z.enum([
          "DUCTWORK", "FITTINGS", "TERMINALS", "EQUIPMENT", "VRF_PIPING",
          "INSULATION", "SUPPORTS", "ACCESSORIES", "ELECTRICAL", "CONTROLS",
          "TESTING", "MISCELLANEOUS",
        ]),
        itemNumber: z.string().optional(),
        description: z.string().min(1).max(500),
        specification: z.string().max(2000).optional(),
        unit: z.string().min(1).max(20),
        quantity: z.number().min(0),
        unitRate: z.number().min(0).default(0),
        materialCost: z.number().min(0).default(0),
        labourCost: z.number().min(0).default(0),
        notes: z.string().max(1000).optional(),
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

      // Calculate total cost
      const totalCost = input.materialCost + input.labourCost;

      // Get next sort order
      const lastItem = await ctx.prisma.bOQItem.findFirst({
        where: { projectId: input.projectId, category: input.category },
        orderBy: { sortOrder: "desc" },
      });
      const sortOrder = (lastItem?.sortOrder ?? 0) + 1;

      return ctx.prisma.bOQItem.create({
        data: {
          ...input,
          totalCost,
          sortOrder,
        },
      });
    }),

  /**
   * Update BOQ item
   */
  update: organizationProcedure
    .input(
      z.object({
        id: z.string(),
        category: z.enum([
          "DUCTWORK", "FITTINGS", "TERMINALS", "EQUIPMENT", "VRF_PIPING",
          "INSULATION", "SUPPORTS", "ACCESSORIES", "ELECTRICAL", "CONTROLS",
          "TESTING", "MISCELLANEOUS",
        ]).optional(),
        itemNumber: z.string().optional().nullable(),
        description: z.string().min(1).max(500).optional(),
        specification: z.string().max(2000).optional().nullable(),
        unit: z.string().min(1).max(20).optional(),
        quantity: z.number().min(0).optional(),
        unitRate: z.number().min(0).optional(),
        materialCost: z.number().min(0).optional(),
        labourCost: z.number().min(0).optional(),
        notes: z.string().max(1000).optional().nullable(),
        sortOrder: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      // Verify item belongs to organization
      const item = await ctx.prisma.bOQItem.findUnique({
        where: { id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!item || item.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "BOQ item not found",
        });
      }

      // Recalculate total if costs changed
      const materialCost = data.materialCost ?? item.materialCost;
      const labourCost = data.labourCost ?? item.labourCost;
      const totalCost = materialCost + labourCost;

      return ctx.prisma.bOQItem.update({
        where: { id },
        data: {
          ...data,
          totalCost,
        },
      });
    }),

  /**
   * Delete BOQ item
   */
  delete: organizationProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify item belongs to organization
      const item = await ctx.prisma.bOQItem.findUnique({
        where: { id: input.id },
        include: { project: { select: { organizationId: true } } },
      });

      if (!item || item.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "BOQ item not found",
        });
      }

      await ctx.prisma.bOQItem.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Extract BOQ from drawing
   */
  extractFromDrawing: organizationProcedure
    .input(z.object({ drawingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Get drawing with components
      const drawing = await ctx.prisma.drawing.findUnique({
        where: { id: input.drawingId },
        include: {
          project: { select: { id: true, organizationId: true } },
          components: true,
        },
      });

      if (!drawing || drawing.project.organizationId !== ctx.organizationId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Drawing not found",
        });
      }

      // Group components by type and properties
      const groupedComponents = new Map<string, {
        type: string;
        properties: Record<string, unknown>;
        components: typeof drawing.components;
      }>();

      for (const component of drawing.components) {
        const props = component.properties as Record<string, unknown>;
        const key = `${component.type}-${JSON.stringify({
          width: props.width,
          height: props.height,
          diameter: props.diameter,
          material: props.material,
        })}`;

        if (!groupedComponents.has(key)) {
          groupedComponents.set(key, {
            type: component.type,
            properties: props,
            components: [],
          });
        }
        groupedComponents.get(key)!.components.push(component);
      }

      // Create BOQ items from grouped components
      const boqItems = [];
      let sortOrder = 1;

      for (const [, group] of groupedComponents) {
        const props = group.properties;
        const category = mapTypeToCategory(group.type);
        const description = generateDescription(group.type, props);
        const { quantity, unit } = calculateQuantity(group.type, props, group.components.length);
        const firstComponent = group.components[0];
        if (!firstComponent) {
          continue;
        }

        const item = await ctx.prisma.bOQItem.create({
          data: {
            projectId: drawing.project.id,
            componentId: firstComponent.id,
            category,
            description,
            unit,
            quantity,
            sortOrder: sortOrder++,
          },
        });

        boqItems.push(item);
      }

      return { items: boqItems, count: boqItems.length };
    }),

  /**
   * Bulk update items (for reordering)
   */
  bulkUpdateOrder: organizationProcedure
    .input(
      z.object({
        projectId: z.string(),
        items: z.array(
          z.object({
            id: z.string(),
            sortOrder: z.number(),
          })
        ),
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

      // Update all items
      await Promise.all(
        input.items.map((item) =>
          ctx.prisma.bOQItem.update({
            where: { id: item.id },
            data: { sortOrder: item.sortOrder },
          })
        )
      );

      return { success: true };
    }),
});

// Helper functions
function mapTypeToCategory(type: string): "DUCTWORK" | "FITTINGS" | "TERMINALS" | "EQUIPMENT" | "VRF_PIPING" | "INSULATION" | "SUPPORTS" | "ACCESSORIES" | "MISCELLANEOUS" {
  const typePrefix = type.split("_")[0];
  switch (typePrefix) {
    case "RECT":
    case "ROUND":
    case "FLAT":
    case "FLEX":
      return "DUCTWORK";
    case "ELBOW":
    case "REDUCER":
    case "TRANSITION":
    case "OFFSET":
    case "TEE":
    case "WYE":
    case "END":
      return "FITTINGS";
    case "DIFFUSER":
    case "GRILLE":
    case "REGISTER":
      return "TERMINALS";
    case "VRF":
    case "AHU":
    case "FCU":
    case "ERV":
    case "EXHAUST":
      return "EQUIPMENT";
    case "BRANCH":
    case "REF":
      return "VRF_PIPING";
    case "INSULATION":
      return "INSULATION";
    case "THREADED":
    case "TRAPEZE":
    case "HANGER":
    case "PIPE":
    case "ANCHOR":
    case "VIBRATION":
      return "SUPPORTS";
    case "DAMPER":
    case "ACCESS":
    case "TEST":
      return "ACCESSORIES";
    default:
      return "MISCELLANEOUS";
  }
}

function generateDescription(type: string, props: Record<string, unknown>): string {
  const width = props.width as number | undefined;
  const height = props.height as number | undefined;
  const diameter = props.diameter as number | undefined;
  const material = props.material as string | undefined;

  const size = diameter ? `Ø${diameter}mm` : width && height ? `${width}x${height}mm` : "";
  const mat = material ? ` ${material.replace(/_/g, " ")}` : "";

  return `${type.replace(/_/g, " ")} ${size}${mat}`.trim();
}

function calculateQuantity(
  type: string,
  props: Record<string, unknown>,
  count: number
): { quantity: number; unit: string } {
  const length = (props.length as number) || 0;

  if (type.includes("DUCT") && !type.includes("FLEX")) {
    return { quantity: (length / 1000) * count, unit: "LM" };
  }

  if (type.includes("INSULATION")) {
    const width = (props.width as number) || 0;
    const height = (props.height as number) || 0;
    const perimeter = 2 * (width + height);
    const surfaceArea = (perimeter / 1000) * (length / 1000);
    return { quantity: surfaceArea * count, unit: "SQM" };
  }

  return { quantity: count, unit: "NOS" };
}
