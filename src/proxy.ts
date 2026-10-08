export { auth as proxy } from "@/lib/auth.proxy";

export const config = {
  matcher: ["/((?!api/auth|login|impressum|mcp|oauth|\\.well-known|_next/static|_next/image|favicon\\.ico|favicon\\.svg|vermieterme-icon\\.svg).*)"],
};
