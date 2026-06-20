// src/middleware.ts
// Next.js middleware — redirects unauthenticated users to /login.
// Checks for the gitwire-session cookie on all page routes.
// Allows /login, /_next/*, and static assets without auth.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes that don't require authentication.
// With basePath: '/dashboard', the incoming pathname is already stripped
// of the prefix by Next.js, so these are relative to the basePath root.
const PUBLIC_PATHS = new Set([
  "/login",
]);

function isPublicAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".") // static files have extensions
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths and static assets
  if (PUBLIC_PATHS.has(pathname) || isPublicAsset(pathname)) {
    return NextResponse.next();
  }

  // Check for session cookie
  const session = request.cookies.get("gitwire-session");

  if (!session?.value) {
    // Redirect to login — use nextUrl so the basePath ('/dashboard') is preserved.
    // Building a raw `new URL("/login", request.url)` would drop the basePath
    // and send users to /login (which nginx 404s) instead of /dashboard/login.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Match all paths except Next.js internals and API routes
  // API routes (/api/*) go through the Express backend, not this middleware
  matcher: [
    /*
     * Match all request paths except:
     * - api (API routes handled by Express backend via tunnel routing)
     * - _next/static (static files)
     * - _next/image (image optimization)
     */
    "/((?!api|_next/static|_next/image).*)",
  ],
};
