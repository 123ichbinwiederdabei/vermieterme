import type { Prisma } from "@prisma/client";
import { dateValue, requiredString } from "@/lib/billing-v2-input";
import { serializeExact } from "@/lib/billing-v2";
import type { AuditContext } from "@/lib/domain-changes";

type Db = Prisma.TransactionClient;
type Input = Record<string, unknown>;
const previousDay = (date: Date) => new Date(date.getTime() - 86_400_000);
function ids(input: Input, key: string) {
  const list = input[key];
  if (!Array.isArray(list) || !list.length || list.some(id => typeof id !== "string" || !id) || new Set(list).size !== list.length) throw new Error(`Eindeutige IDs erforderlich: ${key}`);
  return list as string[];
}
async function draft(db: Db, id: string) {
  const period = await db.billingPeriod.findUniqueOrThrow({ where: { id }, include: { statementRevisions: true, billingSnapshots: true } });
  if (period.status === "SUPERSEDED" || period.sentDate || period.paidDate || period.statementRevisions.length || period.billingSnapshots.length) throw new Error("Zeitraum mit ausgestellten oder angewendeten Berechnungen unveränderlich");
  return period;
}

export async function alignBillingBoundary(db: Db, input: Input, context: AuditContext) {
  const previous = await draft(db, requiredString(input.previousPeriodId, "previousPeriodId"));
  const next = await draft(db, requiredString(input.nextPeriodId, "nextPeriodId"));
  const boundary = dateValue(input.boundaryDate, "boundaryDate"), end = previousDay(boundary);
  const replacedIds = ids(input, "replacedPeriodIds"), readingIds = ids(input, "readingIds");
  const replaced = await Promise.all(replacedIds.map(id => draft(db, id)));
  if (previous.propertyId !== input.propertyId || new Set([previous.id, next.id, ...replacedIds]).size !== replaced.length + 2 || next.propertyId !== previous.propertyId || replaced.some(p => p.propertyId !== previous.propertyId || p.startDate < boundary || p.endDate >= next.startDate) || end < previous.startDate || boundary > next.startDate || boundary > next.endDate) throw new Error("Ungültige benachbarte Perioden");
  const outside = await db.billingPeriod.count({ where: { propertyId: previous.propertyId, status: { not: "SUPERSEDED" }, id: { notIn: [previous.id, next.id, ...replacedIds] }, startDate: { lte: next.endDate }, endDate: { gte: previous.startDate } } });
  if (outside) throw new Error("Abrechnungsperioden überlappen");
  const readings = await db.electricityReading.findMany({ where: { id: { in: readingIds } }, include: { meter: true } });
  if (readings.length !== readingIds.length || new Set(readings.map(r => r.meterId)).size !== readings.length || readings.some(r => r.meter.propertyId !== previous.propertyId || !r.confirmed || r.readingDate.getTime() !== boundary.getTime() || (r.billingEffectiveDate && r.billingEffectiveDate.getTime() !== end.getTime()))) throw new Error("Bestätigte Grenzablesungen desselben Objekts fehlen");
  for (const reading of readings) {
    const actual = await db.electricityReading.findUnique({ where: { meterId_readingDate: { meterId: reading.meterId, readingDate: end } } });
    if (actual && actual.readingKwh.toString() !== reading.readingKwh.toString()) throw new Error("Widersprüchliche Grenzablesung");
    await db.electricityReadingAudit.create({ data: { readingId: reading.id, meterId: reading.meterId, action: "CLOSING_BOUNDARY", previousJson: JSON.stringify(serializeExact(reading)), reason: context.reason } });
    await db.electricityReading.update({ where: { id: reading.id }, data: { billingEffectiveDate: end, note: [reading.note, `Schlussgrenze ${end.toISOString().slice(0,10)}: tatsächliche Grenzablesung ${boundary.toISOString().slice(0,10)}; ${context.reason}`].filter(Boolean).join("; ") } });
  }
  await db.billingPeriod.updateMany({ where: { id: { in: replacedIds } }, data: { status: "SUPERSEDED" } });
  await db.billingPeriod.update({ where: { id: previous.id }, data: { endDate: end } });
  await db.billingPeriod.update({ where: { id: next.id }, data: { startDate: boundary } });
  return { propertyId: previous.propertyId, previousPeriodId: previous.id, previousEnd: end, nextPeriodId: next.id, nextStart: boundary, replacedPeriodIds: replacedIds, unchangedMeasuredReadingDate: boundary, readingIds };
}

export async function deferContractTransition(db: Db, input: Input, context: AuditContext) {
  const propertyId = requiredString(input.propertyId, "propertyId"), from = dateValue(input.previousValidFrom, "previousValidFrom"), to = dateValue(input.validFrom, "validFrom");
  if (to <= from) throw new Error("Neuer Vertragsbeginn muss später liegen");
  if (await db.billingPeriod.count({ where: { propertyId, startDate: { lt: to }, endDate: { gte: from }, OR: [{ statementRevisions: { some: {} } }, { sentDate: { not: null } }, { paidDate: { not: null } }] } })) throw new Error("Ausgestellte Abrechnungen verhindern rückwirkende Vertragsänderung");
  const finances = await db.leaseFinancialPeriod.findMany({ where: { id: { in: ids(input,"financialPeriodIds") }, supersededAt: null }, include: { tenant: { include: { unit: true } }, components: true } });
  const rules = await db.propertyCostAllocationRule.findMany({ where: { id: { in: ids(input,"ruleIds") }, supersededAt: null }, include: { units: true } });
  const agreements = await db.leaseCostCategoryAgreement.findMany({ where: { id: { in: ids(input,"agreementIds") } }, include: { tenant: { include: { unit: true } } } });
  if (finances.length !== ids(input,"financialPeriodIds").length || rules.length !== ids(input,"ruleIds").length || agreements.length !== ids(input,"agreementIds").length || finances.some(f => f.tenant.unit.propertyId !== propertyId || f.validFrom.getTime() !== from.getTime() || !f.sourceDocumentId || f.validTo) || rules.some(r => r.propertyId !== propertyId || r.validFrom.getTime() !== from.getTime() || !r.sourceDocumentId || r.validTo) || agreements.some(a => a.tenant.unit.propertyId !== propertyId || a.validFrom.getTime() !== from.getTime() || a.validTo)) throw new Error("Quellengestützte Vertragsumstellung stimmt nicht mit Vorschau überein");
  const financialRevisions = [];
  for (const f of finances) {
    const earlier = await db.leaseFinancialPeriod.findMany({ where: { tenantId: f.tenantId, supersededAt: null, validTo: previousDay(from), validFrom: { lt: from } } });
    if (earlier.length !== 1) throw new Error("Eindeutige vorherige Finanzvereinbarung fehlt");
    if (await db.leaseFinancialPeriod.count({ where: { tenantId: f.tenantId, supersededAt: null, id: { notIn: [f.id,earlier[0].id] }, validFrom: { lt: to }, OR: [{ validTo: null }, { validTo: { gte: from } }] } })) throw new Error("Finanzvereinbarungen überlappen");
    await db.leaseFinancialPeriod.update({ where: { id: f.id }, data: { supersededAt: new Date() } });
    await db.leaseFinancialPeriod.update({ where: { id: earlier[0].id }, data: { validTo: previousDay(to) } });
    financialRevisions.push(await db.leaseFinancialPeriod.create({ data: { tenantId: f.tenantId, validFrom: to, validTo: f.validTo, monthlyColdRentCents: f.monthlyColdRentCents, monthlyPrepaymentCents: f.monthlyPrepaymentCents, monthlyGeneralOperatingAndHeatingPrepaymentCents: f.monthlyGeneralOperatingAndHeatingPrepaymentCents, monthlyElectricityPrepaymentCents: f.monthlyElectricityPrepaymentCents, monthlyFlatRateCents: f.monthlyFlatRateCents, sourceDocumentId: f.sourceDocumentId, revisionOfId: f.id, revisionReason: context.reason, reason: context.reason, createdBy: context.userId, components: { create: f.components.map(c => ({ costCategoryId: c.costCategoryId, monthlyAmountCents: c.monthlyAmountCents })) } } }));
  }
  const ruleRevisions = [];
  for (const r of rules) {
    if (await db.propertyCostAllocationRule.count({ where: { propertyId, costCategoryId: r.costCategoryId, purpose: r.purpose, supersededAt: null, id: { not: r.id }, OR: [{ validTo: null }, { validTo: { gte: to } }] } })) throw new Error("Verteilungsregeln überlappen");
    await db.propertyCostAllocationRule.update({ where: { id: r.id }, data: { supersededAt: new Date() } });
    const { id, units, ...data } = r;
    delete (data as Partial<typeof data>).createdAt; delete (data as Partial<typeof data>).updatedAt;
    ruleRevisions.push(await db.propertyCostAllocationRule.create({ data: { ...data, validFrom: to, supersededAt: null, revisionOfId: id, explanation: context.reason, createdBy: context.userId, units: { create: units.map(({ unitId, included, weight, areaM2 }) => ({ unitId, included, weight, areaM2 })) } } }));
  }
  for (const a of agreements) await db.leaseCostCategoryAgreement.update({ where: { id: a.id }, data: { validFrom: to, note: context.reason } });
  const system = await db.heatingSystem.findUniqueOrThrow({ where: { id: requiredString(input.heatingSystemId,"heatingSystemId") } });
  if (system.propertyId !== propertyId || system.contractualValidFrom?.getTime() !== from.getTime() || system.exceptionValidFrom?.getTime() !== from.getTime()) throw new Error("Heizkosten-Quellengültigkeit stimmt nicht überein");
  await db.heatingSystem.update({ where: { id: system.id }, data: { contractualValidFrom: to, exceptionValidFrom: to, contractualReason: context.reason, exceptionReason: context.reason } });
  return { propertyId, previousValidFrom: from, validFrom: to, financialRevisions, ruleRevisions, agreementIds: agreements.map(a => a.id), heatingSystemId: system.id, originalContractBytesUnchanged: true };
}
