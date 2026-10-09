import React from "react";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextRequest } from "next/server";
import { requireTenantAuth } from "@/lib/tenant-auth";
import { buildTenantStatement } from "@/lib/billing-statement";
import { prisma } from "@/lib/prisma";
import { statementDocument } from "@/lib/billing-workflow";
import { BillingV2Pdf } from "@/lib/billing-v2-pdf";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { tenantId } = await requireTenantAuth();
    const { id } = await params;
    const artifact = await prisma.statementArtifact.findFirst({ where: { billingPeriodId: id, tenantId, status: "ISSUED" }, orderBy: { revision: "desc" } });
    if (artifact) {
      const { document, bytes } = await statementDocument(artifact.id);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${path.posix.basename(document.archive!.relativePath).replace(/["\r\n]/g, "_")}"` } });
    }
    const statement = await buildTenantStatement(id, tenantId, {
      issuedOnly: true,
    });
    const buffer = await renderToBuffer(
      <BillingV2Pdf statements={[statement]} />,
    );
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Betriebskostenabrechnung-${statement.startDate.slice(0, 4)}.pdf"`,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "PDF-Erzeugung fehlgeschlagen",
      },
      { status: 500 },
    );
  }
}
