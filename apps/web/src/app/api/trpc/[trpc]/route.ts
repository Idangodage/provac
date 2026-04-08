import { appRouter, createContext } from "@provacx/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";


import { auth } from "@/lib/auth";

/**
 * tRPC API handler
 */
const handler = async (req: Request) => {
  const session = await auth();

  // Get organization ID from header
  const organizationId = req.headers.get("x-organization-id") ?? undefined;

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createContext({
        session: session
          ? {
              user: {
                id: session.user?.id ?? "",
                email: session.user?.email ?? "",
                name: session.user?.name,
                image: session.user?.image,
              },
              expires: session.expires,
            }
          : null,
        organizationId,
        headers: new Headers(req.headers),
      }),
    onError:
      process.env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(
              `tRPC error on ${path ?? "<no-path>"}: ${error.message}`
            );
          }
        : undefined,
  });
};

export { handler as GET, handler as POST };
