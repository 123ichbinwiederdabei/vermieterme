import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ExternalBillingClosingPdf } from "@/lib/billing-v2-pdf";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
  const { id } = await params;
  const closing = await prisma.externalBillingClosing.findUnique({ where: { id }, include: { property: true, tenants: { include: { tenant: { include: { unit: true } } } } } });
  if (!closing) return Response.json({ error: "Abschlussmarker nicht gefunden" }, { status: 404 });
  const buffer = await renderToBuffer(<ExternalBillingClosingPdf closing={closing} />);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="Abrechnungsabschluss-${closing.closingDate.toISOString().slice(0, 10)}.pdf"` } });
}
