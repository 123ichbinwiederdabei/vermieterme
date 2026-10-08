import { NextResponse } from "next/server";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export function GET() { return NextResponse.json(protectedResourceMetadata(), { headers: { "Cache-Control": "public, max-age=300" } }); }
