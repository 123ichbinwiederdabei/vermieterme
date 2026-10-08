import { NextResponse } from "next/server";
import { registerClient } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await registerClient(body), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: "invalid_client_metadata", error_description: error instanceof Error ? error.message : "Invalid registration" }, { status: 400 });
  }
}
