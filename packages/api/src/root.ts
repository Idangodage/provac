/**
 * Root Router
 * Combines all routers into a single app router
 */

import {
  userRouter,
  organizationRouter,
  projectRouter,
  drawingRouter,
  boqRouter,
  pricingRouter,
  proposalRouter,
} from "./routers";
import { createTRPCRouter } from "./trpc";

/**
 * Main app router with all sub-routers
 */
export const appRouter = createTRPCRouter({
  user: userRouter,
  organization: organizationRouter,
  project: projectRouter,
  drawing: drawingRouter,
  boq: boqRouter,
  pricing: pricingRouter,
  proposal: proposalRouter,
});

/**
 * Type definition for the app router
 * Used for type inference in clients
 */
export type AppRouter = typeof appRouter;
