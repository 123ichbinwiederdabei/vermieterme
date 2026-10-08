import { NextResponse } from "next/server";
import { oauthMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export function GET() { return NextResponse.json(oauthMetadata(), { headers: { "Cache-Control": "public, max-age=300" } }); }
