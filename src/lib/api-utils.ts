import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { serializeExact } from "@/lib/billing-v2";

import { ApiError } from "@/lib/api-error";
export { ApiError } from "@/lib/api-error";

export async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new ApiError("Nicht angemeldet", 401);
  }
  return session as { user: { id: string; email?: string | null } };
}

export async function requireAdmin() {
  const session = await requireAuth();
  if (!process.env.ADMIN_EMAIL || session.user.email?.toLowerCase() !== process.env.ADMIN_EMAIL.toLowerCase()) throw new ApiError("Administrator-Zugang erforderlich", 403);
  return session;
}

export function apiHandler(
  fn: () => Promise<NextResponse | Response>,
): Promise<NextResponse | Response> {
  return fn().catch((error) => {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  });
}

export function jsonOk(data: unknown, status = 200) {
  return NextResponse.json(serializeExact(data), { status });
}

export function jsonCreated(data: unknown) {
  return NextResponse.json(serializeExact(data), { status: 201 });
}
