import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { auth } from "@/lib/auth";
import { buildAllTenantStatements, buildTenantStatement } from "@/lib/billing-statement";
import { BillingV2Pdf } from "@/lib/billing-v2-pdf";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
  try {
    const { id } = await params;
    const tenantId = new URL(request.url).searchParams.get("tenantId");
    const statements = tenantId ? [await buildTenantStatement(id, tenantId)] : await buildAllTenantStatements(id);
    if (statements.length === 0) return Response.json({ error: "Keine Mietverhältnisse im Zeitraum" }, { status: 400 });
    const buffer = await renderToBuffer(<BillingV2Pdf statements={statements}/>);
    return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="Betriebskostenabrechnung-${statements[0].startDate.slice(0, 4)}${tenantId ? `-${statements[0].unit.name}` : "-Sammeldatei"}.pdf"` } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "PDF-Erzeugung fehlgeschlagen" }, { status: 500 });
  }
}
