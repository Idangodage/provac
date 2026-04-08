import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Routes that require authentication.
 * If a user is not logged in and accesses these, they are redirected to /login.
 */
const protectedPatterns = [
  "/dashboard",
  "/onboarding",
  "/settings",
  "/projects",
];

/**
 * Routes that are only for unauthenticated users.
 * If a logged-in user accesses these, they are redirected to /dashboard.
 */
const authOnlyPatterns = ["/login", "/register", "/forgot-password"];

function matchesPatterns(pathname: string, patterns: string[]): boolean {
  return patterns.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

function isLoggedIn(request: NextRequest): boolean {
  // NextAuth v5 sets session-token cookie (secure prefix on HTTPS)
  return !!(
    request.cookies.get("__Secure-next-auth.session-token") ||
    request.cookies.get("next-auth.session-token") ||
    request.cookies.get("authjs.session-token") ||
    request.cookies.get("__Secure-authjs.session-token")
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const loggedIn = isLoggedIn(request);

  // Redirect unauthenticated users away from protected pages
  if (!loggedIn && matchesPatterns(pathname, protectedPatterns)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect authenticated users away from auth pages
  if (loggedIn && matchesPatterns(pathname, authOnlyPatterns)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, public assets
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
