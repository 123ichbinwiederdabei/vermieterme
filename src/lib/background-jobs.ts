import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { processArchive, enqueueJob } from "@/lib/document-archive";
import { runMicrosoftImport } from "@/lib/microsoft-import";
import { MicrosoftGraph, MicrosoftGraphError } from "@/lib/microsoft-graph";
import { RcloneArchiveError } from "@/lib/archive-transport";
import { statementDocument, validateBillingPeriod } from "@/lib/billing-workflow";

async function dispatchStatement(id: string, graph = new MicrosoftGraph()) {
  const dispatch = await prisma.statementDispatch.findUniqueOrThrow({ where: { id } });
  if (dispatch.status === "ACCEPTED") return;
  const { document, bytes, artifact } = await statementDocument(dispatch.artifactId);
  if (document.archive?.status !== "VERIFIED") throw new Error("Final statement archive not verified");
  if (dispatch.status === "UNCERTAIN") {
    if (!dispatch.graphMessageId) throw new Error("Uncertain send requires operator investigation");
    const message = await graph.request(`users/${encodeURIComponent(dispatch.mailbox)}/messages/${encodeURIComponent(dispatch.graphMessageId)}?$select=id,isDraft`);
    if (message.isDraft === false) {
      await prisma.statementDispatch.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date(), error: null } });
      await updateSentDate(artifact.billingPeriodId);
      return;
    }
    // Never resend an uncertain draft automatically; eventual consistency can
    // show isDraft before the accepted send has completed.
    throw new Error("Uncertain Microsoft send: verify Sent Items before retrying");
  }
  let messageId = dispatch.graphMessageId;
  if (!messageId) {
    messageId = await graph.createMailDraft(dispatch.mailbox, dispatch.recipient, dispatch.subject, dispatch.bodyText, path.basename(document.archive.relativePath), bytes);
    await prisma.statementDispatch.update({ where: { id }, data: { graphMessageId: messageId, status: "DRAFT_READY" } });
  }
  await prisma.statementDispatch.update({ where: { id }, data: { status: "UNCERTAIN" } });
  await graph.request(`users/${encodeURIComponent(dispatch.mailbox)}/messages/${encodeURIComponent(messageId)}/send`, "POST");
  await prisma.statementDispatch.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date(), error: null } });
  await updateSentDate(artifact.billingPeriodId);
}
async function updateSentDate(billingPeriodId: string) {
  const artifacts = await prisma.statementArtifact.findMany({ where: { billingPeriodId: billingPeriodId, status: "ISSUED" } });
  const dispatches = await prisma.statementDispatch.findMany({ where: { artifactId: { in: artifacts.map((a) => a.id) } } });
  if (artifacts.every((a) => dispatches.some((d) => d.artifactId === a.id && d.status === "ACCEPTED"))) await prisma.billingPeriod.update({ where: { id: billingPeriodId }, data: { sentDate: new Date() } });
}

export async function scheduleBackgroundJobs() {
  const sources = await prisma.microsoftImportSource.findMany({ where: { enabled: true, nextRunAt: { lte: new Date() } } });
  for (const source of sources) await enqueueJob("MICROSOFT_IMPORT", `import:${source.id}:${source.nextRunAt.toISOString()}`, { sourceId: source.id });
  const uncertain = await prisma.statementDispatch.findMany({ where: { status: "UNCERTAIN" } });
  const reconcileSlot = Math.floor(Date.now() / (15 * 60_000));
  for (const dispatch of uncertain) await enqueueJob("SEND_STATEMENT", `send-reconcile:${dispatch.id}:${reconcileSlot}`, { dispatchId: dispatch.id });
  const slot = Math.floor(Date.now() / (15 * 60_000));
  await enqueueJob("BILLING_NOTICES", `notices:${slot}`, {});
}

export async function processNextBackgroundJob(graph?: MicrosoftGraph): Promise<boolean> {
  const job = await prisma.backgroundJob.findFirst({ where: { OR: [{ status: "QUEUED", availableAt: { lte: new Date() } }, { status: "PROCESSING", leaseUntil: { lt: new Date() } }] }, orderBy: [{ availableAt: "asc" }, { id: "asc" }] });
  if (!job) return false;
  const leaseToken = randomUUID();
  const claimed = await prisma.backgroundJob.updateMany({ where: { id: job.id, status: job.status, attempts: job.attempts, leaseToken: job.leaseToken }, data: { status: "PROCESSING", attempts: { increment: 1 }, leaseToken, leaseUntil: new Date(Date.now() + 15 * 60_000) } });
  if (!claimed.count) return true;
  const payload = JSON.parse(job.payloadJson);
  const heartbeat = setInterval(() => { void prisma.backgroundJob.updateMany({ where: { id: job.id, leaseToken, status: "PROCESSING" }, data: { leaseUntil: new Date(Date.now() + 15 * 60_000) } }).catch(() => undefined); }, 60_000);
  try {
    if (job.kind === "ARCHIVE") await processArchive(payload.archiveId, graph);
    else if (job.kind === "MICROSOFT_IMPORT") await runMicrosoftImport(payload.sourceId, graph);
    else if (job.kind === "SEND_STATEMENT") await dispatchStatement(payload.dispatchId, graph);
    else if (job.kind === "BILLING_NOTICES") {
      const periods = await prisma.billingPeriod.findMany({ where: { status: { not: "SUPERSEDED" }, statementRevisions: { none: {} } } });
      for (const period of periods) {
        const validation = await validateBillingPeriod(period.id);
        const keys = validation.blockers.map((message) => `${period.id}:${message}`);
        await prisma.billingNotice.updateMany({ where: { propertyId: period.propertyId, key: { startsWith: `${period.id}:`, notIn: keys }, resolvedAt: null }, data: { resolvedAt: new Date() } });
        for (let i = 0; i < keys.length; i++) {
          const existing = await prisma.billingNotice.findUnique({ where: { propertyId_key: { propertyId: period.propertyId, key: keys[i] } } });
          if (!existing || existing.resolvedAt) await prisma.billingNotice.upsert({ where: { propertyId_key: { propertyId: period.propertyId, key: keys[i] } }, create: { propertyId: period.propertyId, key: keys[i], message: validation.blockers[i] }, update: { resolvedAt: null } });
        }
      }
    } else throw new Error("Unknown background job");
    const pendingArchive = job.kind === "ARCHIVE" && (await prisma.documentArchive.findUnique({ where: { id: payload.archiveId } }))?.status !== "VERIFIED";
    await prisma.backgroundJob.updateMany({ where: { id: job.id, leaseToken }, data: { status: pendingArchive ? "QUEUED" : "DONE", leaseUntil: null, error: null } });
  } catch (error) {
    const safe = error instanceof MicrosoftGraphError || error instanceof RcloneArchiveError ? error.message : "Job requires review; inspect source, evidence or configuration";
    const transient = error instanceof RcloneArchiveError ? error.retryable : error instanceof MicrosoftGraphError && (error.status === 429 || error.status >= 500);
    const retry = transient && job.attempts < 5 && job.kind !== "SEND_STATEMENT";
    if (job.kind === "SEND_STATEMENT") await prisma.statementDispatch.updateMany({ where: { id: payload.dispatchId }, data: { error: safe } });
    if (job.kind === "ARCHIVE") await prisma.documentArchive.updateMany({ where: { id: payload.archiveId }, data: { status: "FAILED", error: safe } });
    if (job.kind === "MICROSOFT_IMPORT") {
      if (error instanceof MicrosoftGraphError && error.status === 410) {
        await prisma.microsoftImportSource.update({ where: { id: payload.sourceId }, data: { cursor: null, nextRunAt: new Date(Date.now() + 60_000), lastError: "Delta cursor reset; safe full rescan scheduled" } });
      } else await prisma.microsoftImportSource.update({ where: { id: payload.sourceId }, data: { lastError: safe, nextRunAt: new Date(Date.now() + 15 * 60_000) } });
    }
    await prisma.backgroundJob.updateMany({ where: { id: job.id, leaseToken }, data: { status: retry ? "QUEUED" : "FAILED", availableAt: new Date(Date.now() + Math.max(error instanceof MicrosoftGraphError ? error.retryAfterSeconds * 1000 : 0, 30_000 * 2 ** job.attempts)), leaseUntil: null, error: safe } });
  } finally { clearInterval(heartbeat); }

  return true;
}
