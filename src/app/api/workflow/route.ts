import { randomUUID } from "node:crypto";
import { apiHandler, requireAdmin, jsonOk, ApiError } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { DOMAIN_ACTIONS, previewDomainChange, commitDomainChange, type DomainAction } from "@/lib/domain-changes";
import { billingWorkspace, renewBillingApproval, validateBillingPeriod, previewBillingPeriod, issueBillingPreview, previewStatementSend, sendStatementPreview } from "@/lib/billing-workflow";
import { queuePropertyOriginals, retryDocumentArchive } from "@/lib/document-archive";
import { testMicrosoftSource } from "@/lib/microsoft-import";
import { documentDownload } from "@/lib/document-download";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAdmin();
    const propertyId = new URL(request.url).searchParams.get("propertyId");
    if (!propertyId) return jsonOk({ properties: await prisma.property.findMany({ select: { id: true, street: true, city: true } }) });
    const periods = await prisma.billingPeriod.findMany({ where: { propertyId }, select: { id: true } });
    return jsonOk({ workspace: await billingWorkspace(propertyId), archives: await prisma.documentArchive.findMany({ where: { document: { propertyId } }, include: { document: true } }), artifacts: await prisma.statementArtifact.findMany({ where: { billingPeriodId: { in: periods.map((p) => p.id) } } }), sources: await prisma.microsoftImportSource.findMany({ where: { propertyId } }), notices: await prisma.billingNotice.findMany({ where: { propertyId, resolvedAt: null } }) });
  });
}
export function POST(request: Request) {
  return apiHandler(async () => {
    const session = await requireAdmin();
    const body = await request.json();
    const context = { userId: session.user.id, requestId: randomUUID(), reason: String(body.reason || "Bestatigte Web-Verwaltung") };
    try {
      if (body.operation === "preview_change" && DOMAIN_ACTIONS.includes(body.action)) return jsonOk(await previewDomainChange(body.action as DomainAction, body.values, context));
      if (body.operation === "commit_change") return jsonOk(await commitDomainChange(String(body.previewId), body.confirmed === true, context));
      if (body.operation === "validate") return jsonOk(await validateBillingPeriod(String(body.billingPeriodId)));
      if (body.operation === "preview_billing") return jsonOk(await previewBillingPeriod(String(body.billingPeriodId), context));
      if (body.operation === "renew_approval") return jsonOk(await renewBillingApproval(String(body.previewId), context));
      if (body.operation === "issue") return jsonOk(await issueBillingPreview(String(body.previewId), body.confirmed === true, context));
      if (body.operation === "preview_send") return jsonOk(await previewStatementSend(body.values, context));
      if (body.operation === "send") return jsonOk(await sendStatementPreview(String(body.previewId), body.confirmed === true, context));
      if (body.operation === "queue_originals") return jsonOk(await queuePropertyOriginals(String(body.propertyId)));
      if (body.operation === "retry_archive") return jsonOk(await retryDocumentArchive(String(body.documentId)));
      if (body.operation === "test_source") return jsonOk(await testMicrosoftSource(String(body.sourceId)));
      if (body.operation === "download") return jsonOk(await documentDownload(String(body.documentId)));
      throw new Error("Unbekannte Fachaktion");
    } catch (error) { throw new ApiError(error instanceof Error ? error.message : "Fachprufung fehlgeschlagen", 409); }
  });
}
