import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextRequest } from "next/server";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { buildTenantStatement } from "@/lib/billing-statement";
import { BillingV2Pdf } from "@/lib/billing-v2-pdf";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { tenantId } = await requireTenantAuth(); const { id } = await params;
    const statement = await buildTenantStatement(id, tenantId);
    const buffer = await renderToBuffer(<BillingV2Pdf statements={[statement]}/>);
    return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="Betriebskostenabrechnung-${statement.startDate.slice(0, 4)}.pdf"` } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "PDF-Erzeugung fehlgeschlagen" }, { status: 500 }); }
}
