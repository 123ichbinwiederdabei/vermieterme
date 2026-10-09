import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordHash, recordLifecycleAudit, sanitizeRecord } from "@/lib/mcp/entities";
import { dateValue, decimalString, integerCents, requiredString } from "@/lib/billing-v2-input";
import { ALLOCATION_METHODS } from "@/lib/allocation-engine";
import { serializeExact, prorateMonthlyCents } from "@/lib/billing-v2";
import { archiveName } from "@/lib/document-paths";

export const DOMAIN_ACTIONS = ["create_property", "update_property", "create_unit", "change_unit_state", "create_tenancy", "update_tenant_contacts", "end_tenancy", "move_tenant", "add_lease_party", "end_lease_party", "set_financial_period", "set_allocation_rule", "create_cost_category", "set_period_category", "create_billing_period", "split_billing_period", "set_electricity_tariff", "create_electricity_contract", "create_electricity_meter", "record_electricity_reading", "record_heat_reading", "record_consumption_reading", "configure_heating_system", "select_active_tank", "configure_document_storage", "configure_microsoft_source", "update_landlord", "confirm_invoice_sample", "set_cost_agreement", "record_billing_evidence", "create_heat_meter", "end_meter_assignment", "create_heating_system", "create_oil_tank", "record_oil_stock", "set_oil_opening_balance", "revise_allocation_rule", "revise_financial_period", "correct_electricity_reading", "revise_billing_period", "set_property_tax_basis", "prepare_krandorf_transition"] as const;
export type DomainAction = typeof DOMAIN_ACTIONS[number];
export type AuditContext = { userId: string; requestId: string; reason: string };
type Input = Record<string, unknown>;
type Db = Prisma.TransactionClient;
const day = 86_400_000;

export async function domainFingerprint(db: Db = prisma): Promise<string> {
  const rows = await Promise.all([
    db.property.findMany({ orderBy: { id: "asc" } }), db.unit.findMany({ orderBy: { id: "asc" } }), db.tenant.findMany({ orderBy: { id: "asc" } }),
    db.unitStatePeriod.findMany({ orderBy: { id: "asc" } }), db.leaseParty.findMany({ orderBy: { id: "asc" } }), db.leaseFinancialPeriod.findMany({ orderBy: { id: "asc" } }),
    db.prepaymentComponent.findMany({ orderBy: { id: "asc" } }), db.propertyCostAllocationRule.findMany({ orderBy: { id: "asc" }, include: { units: { orderBy: { unitId: "asc" } } } }),
    db.billingPeriod.findMany({ orderBy: { id: "asc" } }), db.cost.findMany({ orderBy: { id: "asc" } }), db.costCategory.findMany({ orderBy: { id: "asc" } }),
    db.categoryCalculationHead.findMany({ orderBy: [{ billingPeriodId: "asc" }, { costCategoryId: "asc" }] }), db.costInvoice.findMany({ orderBy: { id: "asc" }, include: { lines: { orderBy: { id: "asc" } } } }),
    db.electricityContract.findMany({ orderBy: { id: "asc" } }), db.electricityTariff.findMany({ orderBy: { id: "asc" } }), db.electricityReading.findMany({ orderBy: { id: "asc" } }),
    db.electricityMeter.findMany({ orderBy: { id: "asc" } }), db.heatingSystem.findMany({ orderBy: { id: "asc" }, include: { units: true } }), db.heatMeterReading.findMany({ orderBy: { id: "asc" } }),
    db.documentStorage.findMany({ orderBy: { id: "asc" } }), db.microsoftImportSource.findMany({ orderBy: { id: "asc" } }), db.leaseCostCategoryAgreement.findMany({ orderBy: { id: "asc" } }), db.propertyTaxSetting.findMany({ orderBy: { id: "asc" } }), db.oilInventoryLot.findMany({ orderBy: { id: "asc" } }), db.oilStockReading.findMany({ orderBy: { id: "asc" } }), db.heatMeter.findMany({ orderBy: { id: "asc" } }), db.document.findMany({ orderBy: { id: "asc" } }),
    db.landlordInfo.findMany({ orderBy: { id: "asc" } }), db.statementRevision.findMany({ orderBy: { id: "asc" } }), db.allocationConsumptionReading.findMany({ orderBy: { id: "asc" } }),
  ]);
  return recordHash(rows);
}

function text(input: Input, key: string) { return requiredString(input[key], key); }
function from(input: Input) { return dateValue(input.validFrom, "validFrom"); }
function until(input: Input) { const end = input.validTo ? dateValue(input.validTo, "validTo") : null; if (end && input.validFrom && end < from(input)) throw new Error("Ende liegt vor Beginn"); return end; }
async function evidence(db: Db, input: Input) {
  const id = text(input, "sourceDocumentId");
  if (!await db.document.findUnique({ where: { id } })) throw new Error("Nachweis fehlt");
  return id;
}
async function closeEarlier(db: Db, model: "leaseFinancialPeriod" | "propertyCostAllocationRule" | "electricityTariff" | "unitStatePeriod", where: Input, start: Date) {
  // The existing row is only closed prospectively; amounts/basis are never overwritten.
  const delegate = db[model] as unknown as { findMany(args: unknown): Promise<Array<{ id: string; validFrom: Date; validTo: Date | null }>>; update(args: unknown): Promise<unknown> };
  const rows = await delegate.findMany({ where: { ...where, OR: [{ validTo: null }, { validTo: { gte: start } }] } });
  for (const row of rows) {
    if (row.validFrom >= start) throw new Error("Gültigkeitsperioden überlappen; bestehende Regel zuerst als Revision korrigieren.");
    await delegate.update({ where: { id: row.id }, data: { validTo: new Date(start.getTime() - day) } });
  }
}

async function tenantAvailable(db: Db, unitId: string, start: Date, end: Date | null, exclude?: string) {
  const rows = await db.tenant.count({ where: { unitId, id: exclude ? { not: exclude } : undefined, moveInDate: { lte: end || new Date("9999-12-31") }, OR: [{ moveOutDate: null }, { moveOutDate: { gte: start } }] } });
  if (rows) throw new Error("Überlappendes Mietverhältnis; weitere Vertragsparteien über add_lease_party hinzufügen.");
}

export async function executeDomainChange(db: Db, action: DomainAction, input: Input, context: AuditContext) {
  if (input.sourceDocumentId) {
    const doc = await db.document.findUniqueOrThrow({ where: { id: String(input.sourceDocumentId) } });
    const propertyId = await propertyForAction(db, action, input);
    if (doc.propertyId && propertyId && doc.propertyId !== propertyId) throw new Error("Nachweis gehört zu anderem Objekt");
  }
  const before = await domainState(db);
  let result: unknown;
  if (action === "prepare_krandorf_transition") {
    const propertyId = text(input, "propertyId"); const sourceDocumentId = await evidence(db, input);
    const units = await db.unit.findMany({ where: { propertyId }, orderBy: { id: "asc" } });
    if (units.length !== 3 || units.filter((u) => u.ownerOccupied).length !== 1 || units.map((u) => u.areaM2?.toString()).sort().join(",") !== ["110", "200", "80"].sort().join(",")) throw new Error("Krandorf-Profil benotigt eindeutig bestatigte 80/200/110-m2-Einheiten");
    const categories = await db.costCategory.findMany();
    const changes = [];
    const start = "2026-10-01";
    for (const code of ["WATER", "WASTE", "WASTEWATER", "ELECTRICITY"]) {
      const category = categories.find((c) => c.code === code); if (!category) throw new Error(`Kostenart ${code} fehlt`);
      changes.push(await executeDomainChange(db, "set_allocation_rule", { propertyId, costCategoryId: category.id, validFrom: start, purpose: code === "ELECTRICITY" ? "BASE" : "TOTAL", allocationMethod: code === "WATER" ? "AREA" : "FIXED_SHARES", sourceDocumentId, units: units.map((u) => ({ unitId: u.id, included: true, weight: "1" })) }, context));
    }
    const tenantEvidence = input.tenantDocuments as Record<string, string> | undefined;
    for (const [name, cold, general, electricity] of [["Isabella", "28800", "18700", "4100"], ["Vladimir", "36000", "41000", "9000"]]) {
      const matches = await db.tenant.findMany({ where: { firstName: name, unit: { propertyId }, moveInDate: { lte: new Date(start) }, OR: [{ moveOutDate: null }, { moveOutDate: { gte: new Date(start) } }] } });
      if (matches.length !== 1 || !tenantEvidence?.[matches[0].id]) throw new Error(`Eindeutiges Mietverhaltnis und Vertragsnachweis fur ${name} erforderlich`);
      changes.push(await executeDomainChange(db, "set_financial_period", { tenantId: matches[0].id, validFrom: start, sourceDocumentId: tenantEvidence[matches[0].id], monthlyColdRentCents: cold, monthlyGeneralOperatingAndHeatingPrepaymentCents: general, monthlyElectricityPrepaymentCents: electricity, monthlyFlatRateCents: "0" }, context));
    }
    if (input.billingPeriodId) changes.push(await executeDomainChange(db, "split_billing_period", { billingPeriodId: input.billingPeriodId, splitDate: start }, context));
    result = changes;
  } else if (action === "revise_allocation_rule") {
    const old = await db.propertyCostAllocationRule.findUniqueOrThrow({ where: { id: text(input, "id") }, include: { units: true } });
    if (old.supersededAt) throw new Error("Regel bereits revidiert");
    await db.propertyCostAllocationRule.update({ where: { id: old.id }, data: { supersededAt: new Date() } });
    result = await executeDomainChange(db, "set_allocation_rule", { ...input, propertyId: old.propertyId, costCategoryId: old.costCategoryId, purpose: old.purpose, validFrom: input.validFrom || old.validFrom.toISOString().slice(0, 10), validTo: input.validTo === undefined ? old.validTo?.toISOString().slice(0, 10) : input.validTo, units: input.units || old.units.map((u) => ({ ...u, weight: u.weight?.toString(), areaM2: u.areaM2?.toString() })) }, context);
    await db.propertyCostAllocationRule.update({ where: { id: (result as { id: string }).id }, data: { revisionOfId: old.id } });
  } else if (action === "revise_financial_period") {
    const old = await db.leaseFinancialPeriod.findUniqueOrThrow({ where: { id: text(input, "id") } });
    if (old.supersededAt) throw new Error("Finanzvereinbarung bereits revidiert");
    await db.leaseFinancialPeriod.update({ where: { id: old.id }, data: { supersededAt: new Date() } });
    result = await executeDomainChange(db, "set_financial_period", { ...input, tenantId: old.tenantId, validFrom: input.validFrom || old.validFrom.toISOString().slice(0, 10), validTo: input.validTo === undefined ? old.validTo?.toISOString().slice(0, 10) : input.validTo }, context);
    await db.leaseFinancialPeriod.update({ where: { id: (result as { id: string }).id }, data: { revisionOfId: old.id, revisionReason: context.reason } });
  } else if (action === "correct_electricity_reading") {
    const old = await db.electricityReading.findUniqueOrThrow({ where: { id: text(input, "id") } });
    await evidence(db, input);
    await db.electricityReadingAudit.create({ data: { readingId: old.id, meterId: old.meterId, action: "UPDATE", previousJson: JSON.stringify(serializeExact(old)), reason: context.reason } });
    result = await db.electricityReading.update({ where: { id: old.id }, data: { readingKwh: decimalString(input.readingKwh, "readingKwh"), note: context.reason, confirmed: true } });
  } else if (action === "revise_billing_period") {
    const old = await db.billingPeriod.findUniqueOrThrow({ where: { id: text(input, "billingPeriodId") }, include: { statementRevisions: true, costs: true } });
    if (!old.statementRevisions.length || old.status === "SUPERSEDED") throw new Error("Nur aktuelle ausgestellte Periode revidierbar");
    result = await db.billingPeriod.create({ data: { propertyId: old.propertyId, startDate: old.startDate, endDate: old.endDate, copiedFromId: old.id, revisionOfPeriodId: old.id, revisionReason: context.reason, costs: { create: old.costs.map((c) => ({ costCategoryId: c.costCategoryId, totalAmount: 0, totalAmountCents: 0n, enabled: c.enabled })) } } });
    await db.billingPeriod.update({ where: { id: old.id }, data: { status: "SUPERSEDED" } });
  } else if (action === "create_heating_system") {
    await evidence(db, input); const propertyId = text(input, "propertyId");
    const ids = input.unitIds as string[]; if (!Array.isArray(ids) || !ids.length || await db.unit.count({ where: { id: { in: ids }, propertyId } }) !== ids.length) throw new Error("Gultige versorgte Einheiten erforderlich");
    result = await db.heatingSystem.create({ data: { propertyId, name: text(input, "name"), billingRegime: "STANDARD_HEIZKOSTENV", consumptionSource: "HEAT_METERS", units: { create: ids.map((unitId) => ({ unitId })) } } });
  } else if (action === "create_oil_tank") {
    await evidence(db, input);
    result = await db.heatingOilTank.create({ data: { heatingSystemId: text(input, "heatingSystemId"), name: text(input, "name"), capacityLiters: decimalString(input.capacityLiters, "Tankkapazitat", false), activeFrom: from(input) } });
  } else if (action === "record_oil_stock") {
    const tank = await db.heatingOilTank.findUniqueOrThrow({ where: { id: text(input, "tankId") } });
    const quantityLiters = decimalString(input.quantityLiters, "Tankstand");
    if (Number(quantityLiters) > Number(tank.capacityLiters)) throw new Error("Tankstand uber Kapazitat");
    result = await db.oilStockReading.create({ data: { tankId: tank.id, readingDate: dateValue(input.readingDate, "readingDate"), quantityLiters, documentId: await evidence(db, input), source: "MANUAL", method: "MANUAL", confirmed: true, note: context.reason } });
  } else if (action === "set_oil_opening_balance") {
    const sourceDocumentId = await evidence(db, input); const tankId = text(input, "tankId"); const effectiveDate = from(input);
    if (await db.oilInventoryLot.count({ where: { tankId, sourceType: "OPENING" } })) throw new Error("Bestand bereits vorhanden; Korrektur als Revision erforderlich");
    const lot = await db.oilInventoryLot.create({ data: { tankId, sourceType: "OPENING", sourceDate: effectiveDate, quantityLiters: decimalString(input.quantityLiters, "Bestand", false), totalAmountCents: integerCents(input.totalAmountCents, "Bestandswert"), co2CostCents: integerCents(input.co2CostCents, "CO2-Kosten"), co2Grams: integerCents(input.co2Grams, "CO2-Menge"), co2EvidenceReference: sourceDocumentId, note: context.reason } });
    result = await db.oilInventoryBaseline.create({ data: { tankId, effectiveDate, inventoryLotId: lot.id, confirmedBy: context.userId, confirmedAt: new Date(), sourceDocumentId, note: context.reason } });
  } else if (action === "set_property_tax_basis") {
    const sourceDocumentId = await evidence(db, input); const propertyId = text(input, "propertyId");
    result = await db.propertyTaxSetting.upsert({ where: { propertyId }, create: { propertyId, allocationMethod: "ALLOCATABLE_AMOUNT", annualAssessmentCents: integerCents(input.annualAssessmentCents, "Bescheidbetrag"), annualAllocatableAmountCents: integerCents(input.annualAllocatableAmountCents, "Wohnanteil"), allocationNote: `${context.reason}; Beleg ${sourceDocumentId}` }, update: { annualAssessmentCents: integerCents(input.annualAssessmentCents, "Bescheidbetrag"), annualAllocatableAmountCents: integerCents(input.annualAllocatableAmountCents, "Wohnanteil"), allocationNote: `${context.reason}; Beleg ${sourceDocumentId}` } });
  } else if (action === "create_property") result = await db.property.create({ data: { street: text(input, "street"), zip: text(input, "zip"), city: text(input, "city") } });
  else if (action === "update_property") result = await db.property.update({ where: { id: text(input, "id") }, data: { street: text(input, "street"), zip: text(input, "zip"), city: text(input, "city") } });
  else if (action === "create_unit") {
    const sourceDocumentId = await evidence(db, input);
    const start = from(input); const areaM2 = decimalString(input.areaM2, "areaM2", false);
    result = await db.unit.create({ data: { propertyId: text(input, "propertyId"), name: text(input, "name"), floor: text(input, "floor"), shares: 0, areaM2, ownerOccupied: input.ownerOccupied === true, statePeriods: { create: { validFrom: start, validTo: until(input), areaM2, ownerOccupied: input.ownerOccupied === true, sourceDocumentId } } } });
  } else if (action === "change_unit_state") {
    const unitId = text(input, "unitId"); const start = from(input); const sourceDocumentId = await evidence(db, input);
    await closeEarlier(db, "unitStatePeriod", { unitId }, start);
    result = await db.unitStatePeriod.create({ data: { unitId, validFrom: start, validTo: until(input), areaM2: decimalString(input.areaM2, "areaM2", false), ownerOccupied: input.ownerOccupied === true, sourceDocumentId } });
  } else if (action === "create_tenancy") {
    await evidence(db, input); const unitId = text(input, "unitId"); const start = dateValue(input.moveInDate, "moveInDate"); const end = input.moveOutDate ? dateValue(input.moveOutDate, "moveOutDate") : null;
    await tenantAvailable(db, unitId, start, end);
    result = await db.tenant.create({ data: { unitId, salutation: text(input, "salutation"), firstName: text(input, "firstName"), lastName: text(input, "lastName"), email: typeof input.email === "string" ? input.email : null, phone: typeof input.phone === "string" ? input.phone : null, moveInDate: start, moveOutDate: end } });
  } else if (action === "update_tenant_contacts") {
    const data: Record<string, string | null> = {};
    for (const key of ["salutation", "firstName", "lastName", "phone", "email", "bankName", "iban", "accountHolder"]) if (input[key] !== undefined) { if (input[key] !== null && typeof input[key] !== "string") throw new Error(`Invalid ${key}`); data[key] = input[key] as string | null; }
    result = await db.tenant.update({ where: { id: text(input, "tenantId") }, data });
  } else if (action === "end_tenancy" || action === "move_tenant") {
    await evidence(db, input); const old = await db.tenant.findUniqueOrThrow({ where: { id: text(input, "tenantId") }, include: { financialPeriods: { where: { supersededAt: null }, include: { components: true, flatRateCoverages: true } } } });
    const end = dateValue(input.moveOutDate, "moveOutDate");
    if (end < old.moveInDate || (old.moveOutDate && old.moveOutDate.getTime() !== end.getTime())) throw new Error("Ungültiges Auszugsdatum");
    await db.tenant.update({ where: { id: old.id }, data: { moveOutDate: end } });
    if (action === "move_tenant") {
      const start = dateValue(input.moveInDate, "moveInDate"); const unitId = text(input, "unitId");
      if (start <= end) throw new Error("Neue Wohnung muss nach dem Ende des alten Mietverhältnisses beginnen");
      await tenantAvailable(db, unitId, start, null);
      result = await db.tenant.create({ data: { unitId, salutation: old.salutation, firstName: old.firstName, lastName: old.lastName, email: old.email, phone: old.phone, moveInDate: start } });
    } else result = await db.tenant.findUnique({ where: { id: old.id } });
  } else if (action === "add_lease_party") result = await db.leaseParty.create({ data: { tenantId: text(input, "tenantId"), firstName: text(input, "firstName"), lastName: text(input, "lastName"), email: typeof input.email === "string" ? input.email : null, validFrom: from(input), validTo: until(input), sourceDocumentId: await evidence(db, input) } });
  else if (action === "end_lease_party") result = await db.leaseParty.update({ where: { id: text(input, "id") }, data: { validTo: dateValue(input.validTo, "validTo") } });
  else if (action === "set_financial_period") {
    const tenantId = text(input, "tenantId"); const start = from(input); const sourceDocumentId = await evidence(db, input);
    await closeEarlier(db, "leaseFinancialPeriod", { tenantId, supersededAt: null }, start);
    const general = integerCents(input.monthlyGeneralOperatingAndHeatingPrepaymentCents, "Betriebs-/Heizkosten"); const electricity = integerCents(input.monthlyElectricityPrepaymentCents, "Stromvorauszahlung");
    result = await db.leaseFinancialPeriod.create({ data: { tenantId, validFrom: start, validTo: until(input), monthlyColdRentCents: integerCents(input.monthlyColdRentCents, "Kaltmiete"), monthlyPrepaymentCents: general + electricity, monthlyGeneralOperatingAndHeatingPrepaymentCents: general, monthlyElectricityPrepaymentCents: electricity, monthlyFlatRateCents: integerCents(input.monthlyFlatRateCents || "0", "Pauschale"), sourceDocumentId, reason: context.reason, createdBy: context.userId } });
  } else if (action === "set_allocation_rule") {
    const propertyId = text(input, "propertyId"); const costCategoryId = text(input, "costCategoryId"); const start = from(input); const purpose = String(input.purpose || "TOTAL");
    if (!["TOTAL", "BASE", "COMMON"].includes(purpose)) throw new Error("Ungültiger Regelzweck");
    const allocationMethod = text(input, "allocationMethod");
    if (!ALLOCATION_METHODS.includes(allocationMethod as typeof ALLOCATION_METHODS[number])) throw new Error("Ungültiger Verteilerschlüssel");
    const percent = input.consumptionSharePercent == null ? null : Number(input.consumptionSharePercent);
    if (["HEIZKOSTENV", "MIXED"].includes(allocationMethod) && (percent == null || !Number.isInteger(percent) || percent < (allocationMethod === "HEIZKOSTENV" ? 50 : 0) || percent > (allocationMethod === "HEIZKOSTENV" ? 70 : 100))) throw new Error("Gültiger Verbrauchskostenanteil erforderlich");
    const sourceDocumentId = await evidence(db, input);
    const rawUnits = input.units;
    if (!Array.isArray(rawUnits) || !rawUnits.length) throw new Error("Beteiligte Einheiten fehlen");
    const ids = await db.unit.findMany({ where: { propertyId }, select: { id: true } });
    const unitInputs = rawUnits as Input[];
    if (new Set(unitInputs.map((unit) => text(unit, "unitId"))).size !== unitInputs.length || unitInputs.some((unit) => !ids.some((id) => id.id === unit.unitId))) throw new Error("Doppelte oder objektfremde Einheit");
    await closeEarlier(db, "propertyCostAllocationRule", { propertyId, costCategoryId, purpose, supersededAt: null }, start);
    result = await db.propertyCostAllocationRule.create({ data: { propertyId, costCategoryId, purpose, allocationMethod, validFrom: start, validTo: until(input), sourceDocumentId, explanation: context.reason, createdBy: context.userId, consumptionSharePercent: input.consumptionSharePercent == null ? null : Number(input.consumptionSharePercent), units: { create: unitInputs.map((unit) => ({ unitId: text(unit, "unitId"), included: unit.included !== false, areaM2: unit.areaM2 == null ? null : decimalString(unit.areaM2, "areaM2", false), weight: unit.weight == null ? null : decimalString(unit.weight, "weight", false) })) } }, include: { units: true } });
  } else if (action === "create_cost_category") result = await db.costCategory.create({ data: { name: text(input, "name"), code: text(input, "code"), calculationType: "MANUAL", distributionKey: "Konfiguriert" } });
  else if (action === "set_period_category") {
    const billingPeriodId = text(input, "billingPeriodId"); await mutablePeriod(db, billingPeriodId);
    const costCategoryId = text(input, "costCategoryId");
    result = await db.cost.upsert({ where: { billingPeriodId_costCategoryId: { billingPeriodId, costCategoryId } }, create: { billingPeriodId, costCategoryId, totalAmount: 0, totalAmountCents: 0n, enabled: input.enabled === true }, update: { enabled: input.enabled === true } });
  } else if (action === "create_billing_period") {
    const propertyId = text(input, "propertyId"); const start = dateValue(input.startDate, "startDate"); const end = dateValue(input.endDate, "endDate");
    if (await db.billingPeriod.count({ where: { propertyId, status: { not: "SUPERSEDED" }, startDate: { lte: end }, endDate: { gte: start } } })) throw new Error("Abrechnungsperioden überlappen");
    result = await db.billingPeriod.create({ data: { propertyId, startDate: start, endDate: end, costs: { create: (await db.costCategory.findMany()).map((category) => ({ costCategoryId: category.id, totalAmount: 0, totalAmountCents: 0n, enabled: true })) } } });
  } else if (action === "split_billing_period") {
    const old = await mutablePeriod(db, text(input, "billingPeriodId")); const start = dateValue(input.splitDate, "splitDate");
    if (start <= old.startDate || start > old.endDate) throw new Error("Trennstichtag liegt außerhalb des Zeitraums");
    const costs = await db.cost.findMany({ where: { billingPeriodId: old.id } });
    await db.billingPeriod.update({ where: { id: old.id }, data: { status: "SUPERSEDED" } });
    result = await Promise.all([{ start: old.startDate, end: new Date(start.getTime() - day) }, { start, end: old.endDate }].map((range) => db.billingPeriod.create({ data: { propertyId: old.propertyId, startDate: range.start, endDate: range.end, copiedFromId: old.id, costs: { create: costs.map((cost) => ({ costCategoryId: cost.costCategoryId, totalAmount: 0, totalAmountCents: 0n, enabled: cost.enabled })) } } })));
  } else if (action === "create_electricity_contract") result = await db.electricityContract.create({ data: { propertyId: text(input, "propertyId"), provider: text(input, "provider"), validFrom: from(input), validTo: until(input), basePriceAllocation: "CONFIGURED", basePriceAgreementNote: text(input, "basePriceAgreementNote") } });
  else if (action === "set_electricity_tariff") {
    const contractId = text(input, "contractId"); const start = from(input); const sourceDocumentId = await evidence(db, input);
    await closeEarlier(db, "electricityTariff", { contractId }, start);
    result = await db.electricityTariff.create({ data: { contractId, validFrom: start, validTo: until(input), priceMicroEuroPerKwh: integerCents(input.priceMicroEuroPerKwh, "Arbeitspreis"), monthlyBasePriceCents: integerCents(input.monthlyBasePriceCents, "Grundpreis"), vatRate: decimalString(input.vatRate, "vatRate"), sourceDocumentId } });
  } else if (action === "create_electricity_meter") {
    const contract = await db.electricityContract.findUniqueOrThrow({ where: { id: text(input, "contractId") } });
    if (input.unitId && !await db.unit.findFirst({ where: { id: String(input.unitId), propertyId: contract.propertyId } })) throw new Error("Objektfremde Zählerzuordnung");
    const role = text(input, "role"); if (!["UNIT_CONSUMPTION", "OWNER_CONSUMPTION", "COMMON_ELECTRICITY", "HEATING_ELECTRICITY", "SMALL_WASTEWATER_ELECTRICITY"].includes(role)) throw new Error("Ungültige Zählerrolle");
    result = await db.electricityMeter.create({ data: { contractId: contract.id, propertyId: contract.propertyId, unitId: input.unitId ? String(input.unitId) : null, meterNumber: text(input, "meterNumber"), role, validFrom: from(input), validTo: until(input) } });
  } else if (action === "record_electricity_reading") result = await db.electricityReading.create({ data: { meterId: text(input, "meterId"), readingDate: dateValue(input.readingDate, "readingDate"), readingKwh: decimalString(input.readingKwh, "readingKwh"), reason: String(input.reason || "REGULAR"), note: input.note ? String(input.note) : null, estimationMethod: input.estimationMethod ? String(input.estimationMethod) : null, uncertaintyNote: input.uncertaintyNote ? String(input.uncertaintyNote) : null, confirmed: true } });
  else if (action === "record_consumption_reading") result = await db.allocationConsumptionReading.create({ data: { unitId: text(input, "unitId"), costCategoryId: text(input, "costCategoryId"), readingDate: dateValue(input.readingDate, "readingDate"), quantity: decimalString(input.quantity, "quantity"), sourceDocumentId: await evidence(db, input), confirmed: true } });
  else if (action === "record_heat_reading") result = await db.heatMeterReading.create({ data: { meterId: text(input, "heatMeterId"), readingDate: dateValue(input.readingDate, "readingDate"), readingValue: decimalString(input.value, "value"), source: "MANUAL", sourceDocumentId: await evidence(db, input), confirmed: true, notes: context.reason } });
  else if (action === "configure_heating_system") {
    const id = text(input, "id"); const regime = text(input, "billingRegime");
    if (!["STANDARD_HEIZKOSTENV", "SECTION_11_EXCEPTION", "SECTION_2_CONTRACTUAL_DEVIATION"].includes(regime)) throw new Error("Ungültiger Heizkostenmodus");
    const percent = Number(input.consumptionSharePercent); if (!Number.isInteger(percent) || percent < 50 || percent > 70) throw new Error("Verbrauchsanteil muss zwischen 50 und 70 Prozent liegen");
    const sourceDocumentId = await evidence(db, input);
    result = await db.heatingSystem.update({ where: { id }, data: { billingRegime: regime, consumptionSource: regime === "STANDARD_HEIZKOSTENV" ? "HEAT_METERS" : "NONE", consumptionSharePercent: percent, baseSharePercent: 100 - percent, evidenceValidatedAt: new Date(), evidenceValidatedBy: context.userId, contractualDocumentId: sourceDocumentId, contractualValidFrom: from(input), contractualReason: context.reason, exceptionDocumentId: sourceDocumentId, exceptionValidFrom: from(input), exceptionValidTo: until(input), exceptionReason: context.reason, exceptionReasonCode: input.exceptionReasonCode ? String(input.exceptionReasonCode) : null, ownerOccupiedUnitId: input.ownerOccupiedUnitId ? String(input.ownerOccupiedUnitId) : null } });
  } else if (action === "select_active_tank") {
    const system = await db.heatingSystem.findUniqueOrThrow({ where: { id: text(input, "heatingSystemId") } }); const tank = await db.heatingOilTank.findUniqueOrThrow({ where: { id: text(input, "tankId") } });
    if (tank.heatingSystemId !== system.id) throw new Error("Tank gehört nicht zum Heizsystem");
    result = await db.heatingSystem.update({ where: { id: system.id }, data: { activeTankId: tank.id } });
  } else if (action === "configure_document_storage") {
    const propertyId = text(input, "propertyId");
    const existing = await db.documentStorage.findUnique({ where: { propertyId } });
    const settings = { propertyId, driveId: text(input, "driveId"), rootItemId: text(input, "rootItemId"), objectFolder: archiveName(text(input, "objectFolder")) };
    if (input.enabled === true && (!existing?.testedAt || existing.testedAt < new Date(Date.now() - 30 * 60_000) || existing.testedFingerprint !== recordHash(settings))) throw new Error("Ausgewahlte OneDrive-Ablage erst speichern und mit test_document_storage prufen");
    if (existing && existing.enabled && await db.documentArchive.count({ where: { storageId: existing.id } }) && (existing.driveId !== settings.driveId || existing.rootItemId !== settings.rootItemId || existing.objectFolder !== settings.objectFolder)) throw new Error("Archivziel nach erster Ablage unveranderlich; kontrollierte Archivmigration erforderlich");
    result = await db.documentStorage.upsert({ where: { propertyId }, create: { propertyId, driveId: text(input, "driveId"), rootItemId: text(input, "rootItemId"), objectFolder: archiveName(text(input, "objectFolder")), enabled: input.enabled === true }, update: { driveId: text(input, "driveId"), rootItemId: text(input, "rootItemId"), objectFolder: archiveName(text(input, "objectFolder")), enabled: input.enabled === true } });
  } else if (action === "configure_microsoft_source") {
    const kind = text(input, "kind"); if (!["MAIL", "ONEDRIVE"].includes(kind)) throw new Error("Ungültige Quelle");
    const values = { propertyId: text(input, "propertyId"), kind, folderId: text(input, "folderId"), mailbox: kind === "MAIL" ? text(input, "mailbox") : null, driveId: kind === "ONEDRIVE" ? text(input, "driveId") : null, costCategoryId: text(input, "costCategoryId"), section: text(input, "section"), enabled: input.enabled === true, autoBook: input.autoBook === true, intervalMinutes: 15, createdBy: context.userId };
    const existing = input.id ? await db.microsoftImportSource.findUnique({ where: { id: String(input.id) } }) : null;
    const selected = { propertyId: values.propertyId, kind: values.kind, mailbox: values.mailbox, driveId: values.driveId, folderId: values.folderId, costCategoryId: values.costCategoryId, section: values.section };
    if (values.enabled && (!existing?.testedAt || existing.testedAt < new Date(Date.now() - 30 * 60_000) || existing.testedFingerprint !== recordHash(selected))) throw new Error("Quelle zunachst deaktiviert speichern und Berechtigungen mit test_microsoft_source prufen");
    result = input.id ? await db.microsoftImportSource.update({ where: { id: String(input.id) }, data: values }) : await db.microsoftImportSource.create({ data: values });
  } else if (action === "confirm_invoice_sample") {
    const doc = await db.document.findUniqueOrThrow({ where: { id: text(input, "documentId") } });
    if (!doc.fileHash || doc.category.startsWith("billing")) throw new Error("Original mit SHA-256 erforderlich");
    const role = text(input, "role"); if (!["TRAINING", "HOLDOUT"].includes(role)) throw new Error("TRAINING oder HOLDOUT erforderlich");
    if (!input.expected || typeof input.expected !== "object" || Array.isArray(input.expected)) throw new Error("Unabhangig am Original geprufte Sollwerte erforderlich");
    result = await db.invoiceVerifiedSample.create({ data: { documentId: doc.id, fileHash: doc.fileHash, expectedJson: JSON.stringify(input.expected), expectedLinesJson: JSON.stringify(input.expectedLines || []), role, confirmedBy: context.userId } });
  } else if (action === "set_cost_agreement") {
    result = await db.leaseCostCategoryAgreement.create({ data: { tenantId: text(input, "tenantId"), costCategoryId: text(input, "costCategoryId"), validFrom: from(input), validTo: until(input), contractDocumentId: await evidence(db, input), note: context.reason, confirmedBy: context.userId } });
  } else if (action === "record_billing_evidence") {
    const period = await mutablePeriod(db, text(input, "billingPeriodId"));
    result = await db.billingPeriodEvidence.create({ data: { billingPeriodId: period.id, kind: text(input, "kind"), documentId: await evidence(db, input), note: context.reason, confirmedBy: context.userId } });
  } else if (action === "create_heat_meter") {
    const system = await db.heatingSystem.findUniqueOrThrow({ where: { id: text(input, "heatingSystemId") } });
    const unit = await db.unit.findUniqueOrThrow({ where: { id: text(input, "unitId") } });
    if (unit.propertyId !== system.propertyId) throw new Error("Objektfremder Warmezahler");
    await evidence(db, input);
    result = await db.heatMeter.create({ data: { heatingSystemId: system.id, unitId: unit.id, meterNumber: text(input, "meterNumber"), validFrom: from(input), validTo: until(input) } });
  } else if (action === "end_meter_assignment") {
    const kind = text(input, "kind"); const end = dateValue(input.validTo, "validTo"); await evidence(db, input);
    if (kind === "HEAT") { const meter = await db.heatMeter.findUniqueOrThrow({ where: { id: text(input, "meterId") } }); if (end < meter.validFrom) throw new Error("Ende vor Beginn"); result = await db.heatMeter.update({ where: { id: meter.id }, data: { validTo: end } }); }
    else if (kind === "ELECTRICITY") { const meter = await db.electricityMeter.findUniqueOrThrow({ where: { id: text(input, "meterId") } }); if (end < meter.validFrom) throw new Error("Ende vor Beginn"); result = await db.electricityMeter.update({ where: { id: meter.id }, data: { validTo: end } }); }
    else throw new Error("Ungultiger Zahlertyp");
  } else if (action === "update_landlord") {
    const data: Record<string, string> = {};
    for (const key of ["name", "street", "zip", "city", "phone", "email", "bankName", "iban", "accountHolder"]) if (typeof input[key] === "string") data[key] = String(input[key]);
    result = await db.landlordInfo.update({ where: { id: text(input, "id") }, data });
  } else throw new Error("Nicht unterstützte Fachaktion");
  // Invalidate draft calculations only. Issued statements and their metadata are immutable.
  const affectedProperty = await propertyForAction(db, action, input);
  const drafts = { ...(affectedProperty ? { propertyId: affectedProperty } : {}), status: { not: "SUPERSEDED" }, statementRevisions: { none: {} }, sentDate: null, paidDate: null };
  if (!["configure_document_storage", "configure_microsoft_source", "update_tenant_contacts", "add_lease_party", "end_lease_party", "confirm_invoice_sample"].includes(action)) {
  await db.categoryCalculationHead.updateMany({ where: { billingPeriod: drafts }, data: { stale: true } });
  await db.billingPeriod.updateMany({ where: drafts, data: { sourceRevision: { increment: 1 } } });
  }
  await recordLifecycleAudit({ ...context, action, entityType: "DomainChange", itemRef: String((result as { id?: string })?.id || action), before, after: result }, db);
  return serializeExact(result);
}

async function mutablePeriod(db: Db, id: string) {
  const period = await db.billingPeriod.findUniqueOrThrow({ where: { id }, include: { statementRevisions: true } });
  if (period.status === "SUPERSEDED" || period.statementRevisions.length || period.sentDate || period.paidDate) throw new Error("Ausgestellte Abrechnung ist unveränderlich");
  return period;
}

async function domainState(db: Db) {
  return serializeExact({ properties: await db.property.findMany(), units: await db.unit.findMany({ include: { statePeriods: true } }), tenants: await db.tenant.findMany({ include: { financialPeriods: { where: { supersededAt: null } }, parties: true } }), rules: await db.propertyCostAllocationRule.findMany({ where: { supersededAt: null }, include: { units: true } }), tariffs: await db.electricityTariff.findMany(), heatingSystems: await db.heatingSystem.findMany(), storage: await db.documentStorage.findMany(), sources: await db.microsoftImportSource.findMany(), taxBasis: await db.propertyTaxSetting.findMany(), costAgreements: await db.leaseCostCategoryAgreement.findMany(), heatReadings: await db.heatMeterReading.findMany(), electricityReadings: await db.electricityReading.findMany(), oilStocks: await db.oilStockReading.findMany(), landlord: await db.landlordInfo.findMany() });
}
async function propertyForAction(db: Db, action: DomainAction, input: Input): Promise<string | undefined> {
  if (input.propertyId) return String(input.propertyId);
  if (input.tenantId) return (await db.tenant.findUniqueOrThrow({ where: { id: String(input.tenantId) }, include: { unit: true } })).unit.propertyId;
  if (input.unitId) return (await db.unit.findUniqueOrThrow({ where: { id: String(input.unitId) } })).propertyId;
  if (input.billingPeriodId) return (await db.billingPeriod.findUniqueOrThrow({ where: { id: String(input.billingPeriodId) } })).propertyId;
  if (input.contractId) return (await db.electricityContract.findUniqueOrThrow({ where: { id: String(input.contractId) } })).propertyId;
  if (action === "update_property") return String(input.id);
  if (input.heatingSystemId || action === "configure_heating_system") return (await db.heatingSystem.findUniqueOrThrow({ where: { id: String(input.heatingSystemId || input.id) } })).propertyId;
  if (input.tankId) return (await db.heatingOilTank.findUniqueOrThrow({ where: { id: String(input.tankId) }, include: { heatingSystem: true } })).heatingSystem.propertyId;
  if (input.heatMeterId || (action === "end_meter_assignment" && input.kind === "HEAT")) return (await db.heatMeter.findUniqueOrThrow({ where: { id: String(input.heatMeterId || input.meterId) }, include: { heatingSystem: true } })).heatingSystem.propertyId;
  if (input.meterId) return (await db.electricityMeter.findUniqueOrThrow({ where: { id: String(input.meterId) } })).propertyId;
  if (action === "correct_electricity_reading") return (await db.electricityReading.findUniqueOrThrow({ where: { id: String(input.id) }, include: { meter: true } })).meter.propertyId;
  if (action === "revise_financial_period") return (await db.leaseFinancialPeriod.findUniqueOrThrow({ where: { id: String(input.id) }, include: { tenant: { include: { unit: true } } } })).tenant.unit.propertyId;
  if (action === "revise_allocation_rule") return (await db.propertyCostAllocationRule.findUniqueOrThrow({ where: { id: String(input.id) } })).propertyId;
  if (action === "end_lease_party") return (await db.leaseParty.findUniqueOrThrow({ where: { id: String(input.id) }, include: { tenant: { include: { unit: true } } } })).tenant.unit.propertyId;
  return undefined;
}

export async function previewDomainChange(action: DomainAction, input: Input, context: AuditContext) {
  if (input.startDate && input.endDate && dateValue(input.endDate, "endDate") < dateValue(input.startDate, "startDate")) throw new Error("Ende vor Beginn");
  if (!DOMAIN_ACTIONS.includes(action)) throw new Error("Unbekannte Fachaktion");
  // Validate the complete transaction on SQLite and roll it back deliberately;
  // the same service performs the confirmed write, so preview cannot drift.
  let after: unknown;
  let oldValues: unknown;
  let fingerprint = "";
  class PreviewRollback extends Error {}
  try {
    await prisma.$transaction(async (tx) => { fingerprint = await domainFingerprint(tx); oldValues = await domainState(tx); after = await executeDomainChange(tx, action, input, context); throw new PreviewRollback(); }, { timeout: 30_000 });
  } catch (error) { if (!(error instanceof PreviewRollback)) throw error; }
  const affectedProperty = await propertyForAction(prisma, action, input);
  const periods = await prisma.billingPeriod.findMany({ where: { ...(affectedProperty ? { propertyId: affectedProperty } : {}), status: { not: "SUPERSEDED" }, statementRevisions: { none: {} } }, select: { id: true, startDate: true, endDate: true } });
  let financialImpact: unknown = { affectedPeriods: periods.map((period) => period.id), requiresRecalculation: true };
  if (["set_financial_period", "revise_financial_period"].includes(action)) {
    const proposed = after as { tenantId: string; validFrom: string; validTo: string | null; monthlyColdRentCents: string; monthlyPrepaymentCents: string; monthlyFlatRateCents: string };
    const oldRows = (oldValues as { tenants: Array<{ id: string; financialPeriods: Array<{ validFrom: string; validTo: string | null; monthlyColdRentCents: string; monthlyPrepaymentCents: string; monthlyFlatRateCents: string }> }> }).tenants.find((tenant) => tenant.id === proposed.tenantId)?.financialPeriods || [];
    const current = oldRows.find((row) => row.validFrom <= proposed.validFrom && (!row.validTo || row.validTo >= proposed.validFrom));
    const oldMonthly = current ? BigInt(current.monthlyColdRentCents) + BigInt(current.monthlyPrepaymentCents) + BigInt(current.monthlyFlatRateCents) : null;
    const newMonthly = BigInt(proposed.monthlyColdRentCents) + BigInt(proposed.monthlyPrepaymentCents) + BigInt(proposed.monthlyFlatRateCents);
    financialImpact = { previousMonthlyTotalCents: oldMonthly?.toString() ?? null, newMonthlyTotalCents: newMonthly.toString(), monthlyDeltaCents: oldMonthly == null ? null : (newMonthly - oldMonthly).toString(), advanceEffect: periods.map((period) => {
      const start = period.startDate > new Date(proposed.validFrom) ? period.startDate : new Date(proposed.validFrom);
      const end = proposed.validTo && new Date(proposed.validTo) < period.endDate ? new Date(proposed.validTo) : period.endDate;
      return { billingPeriodId: period.id, newAgreedAdvanceCents: end < start ? "0" : prorateMonthlyCents(BigInt(proposed.monthlyPrepaymentCents), start, end).toString() };
    }), note: "Sollvereinbarung; Zahlungseingänge und Rückstände werden nicht verändert." };
  }
  const impact = { oldValues, financialImpact, validFrom: input.validFrom ?? input.moveInDate ?? input.splitDate ?? null, proposed: sanitizeRecord(after), affectedDraftPeriods: periods, note: "Entwürfe werden neu berechnet; ausgegebene Fassungen bleiben unverändert.", oldStateFingerprint: fingerprint };
  const preview = await prisma.domainChangePreview.create({ data: { userId: context.userId, action, payloadJson: JSON.stringify(input), fingerprint, impactJson: JSON.stringify(serializeExact(impact)), expiresAt: new Date(Date.now() + 5 * 60_000) } });
  return { previewId: preview.id, expiresAt: preview.expiresAt, ...impact };
}

export async function commitDomainChange(previewId: string, confirmed: boolean, context: AuditContext) {
  if (!confirmed) throw new Error("Ausdrückliche Bestätigung der Vorschau erforderlich");
  return prisma.$transaction(async (tx) => {
    const preview = await tx.domainChangePreview.findUniqueOrThrow({ where: { id: previewId } });
    if (!DOMAIN_ACTIONS.includes(preview.action as DomainAction)) throw new Error("Vorschau ist keine Stammdatenaktion");
    if (preview.userId !== context.userId) throw new Error("Vorschau gehört zu anderem Benutzer");
    if (preview.consumedAt) return JSON.parse(preview.resultJson!);
    if (preview.expiresAt <= new Date()) throw new Error("Vorschau abgelaufen");
    if (await domainFingerprint(tx) !== preview.fingerprint) throw new Error("Daten seit Vorschau verändert; neue Vorschau anfordern");
    const result = await executeDomainChange(tx, preview.action as DomainAction, JSON.parse(preview.payloadJson), context);
    await tx.domainChangePreview.update({ where: { id: preview.id }, data: { consumedAt: new Date(), resultJson: JSON.stringify(result) } });
    return result;
  }, { timeout: 30_000 });
}
