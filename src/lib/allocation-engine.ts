import { allocateCents, fromScaledInteger, toScaledInteger } from "@/lib/billing-v2";
import { isoDay, splitUnitAmountAcrossTenants, type AllocationResult } from "@/lib/energy-billing";

export const ALLOCATION_METHODS = [
  "AREA",
  "FIXED_SHARES",
  "DIRECT_CONSUMPTION",
  "HEIZKOSTENV",
  "BAVARIA_PROPERTY_TAX_RESIDENTIAL_COMPONENT",
] as const;

export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export type AllocationTenant = {
  id: string;
  moveInDate: Date;
  moveOutDate: Date | null;
};

export type AllocationUnit = {
  unitId: string;
  unitName: string;
  ownerOccupied: boolean;
  included: boolean;
  weight?: string | null;
  areaM2?: string | null;
  tenants: AllocationTenant[];
};

export type AllocationSource = {
  distributionKey: string;
  sourceType: string;
  sourceReferenceId?: string;
  allocationRuleId?: string;
};

export type UnitAllocationDetail = {
  unitId: string;
  unitName: string;
  ownerOccupied: boolean;
  basis: string;
  weight: string;
  totalWeight: string;
  amountCents: string;
};

export type ConfiguredAllocationResult = {
  allocations: Array<AllocationResult & { allocationRuleId?: string }>;
  unitDetails: UnitAllocationDetail[];
  tenantAmountCents: bigint;
  landlordOwnerAmountCents: bigint;
  vacancyAmountCents: bigint;
};

function positiveWeight(value: string | null | undefined, label: string): bigint {
  const weight = toScaledInteger(value ?? "0");
  if (weight <= 0n) throw new Error(`${label} muss größer als 0 sein.`);
  return weight;
}

export function allocationWeights(method: AllocationMethod, units: AllocationUnit[]): bigint[] {
  return units.map((unit) => {
    if (!unit.included) return 0n;
    if (method === "FIXED_SHARES") return positiveWeight(unit.weight, `Anteil für ${unit.unitName}`);
    if (method === "AREA") return positiveWeight(unit.areaM2, `Fläche für ${unit.unitName}`);
    throw new Error(`Die Methode ${method} benötigt eine spezialisierte Berechnung.`);
  });
}

function allocationBasis(method: AllocationMethod, weight: bigint, totalWeight: bigint): string {
  const own = fromScaledInteger(weight);
  const total = fromScaledInteger(totalWeight);
  return method === "AREA" ? `${own} m² von ${total} m²` : `${own} von ${total} Anteilen`;
}

export function allocateConfiguredCost(
  totalCents: bigint,
  method: Extract<AllocationMethod, "AREA" | "FIXED_SHARES">,
  units: AllocationUnit[],
  periodStart: Date,
  periodEnd: Date,
  source: AllocationSource
): ConfiguredAllocationResult {
  if (totalCents < 0n) throw new Error("Der zu verteilende Betrag darf nicht negativ sein.");
  const weights = allocationWeights(method, units);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0n);
  if (totalWeight <= 0n) throw new Error("Mindestens eine teilnehmende Einheit mit positiver Basis ist erforderlich.");
  const unitAmounts = allocateCents(totalCents, weights);
  return allocateKnownUnitAmounts(unitAmounts, weights, method, units, periodStart, periodEnd, source);
}

export function allocateKnownUnitAmounts(
  unitAmounts: bigint[],
  weights: bigint[],
  method: AllocationMethod,
  units: AllocationUnit[],
  periodStart: Date,
  periodEnd: Date,
  source: AllocationSource
): ConfiguredAllocationResult {
  const totalWeight = weights.reduce((sum, value) => sum + value, 0n);
  const allocations: ConfiguredAllocationResult["allocations"] = [];
  const unitDetails: UnitAllocationDetail[] = [];
  let tenantAmountCents = 0n;
  let landlordOwnerAmountCents = 0n;
  let vacancyAmountCents = 0n;

  units.forEach((unit, index) => {
    const amount = unitAmounts[index] ?? 0n;
    const weight = weights[index] ?? 0n;
    if (!unit.included || weight <= 0n) return;
    const basis = allocationBasis(method, weight, totalWeight);
    unitDetails.push({
      unitId: unit.unitId,
      unitName: unit.unitName,
      ownerOccupied: unit.ownerOccupied,
      basis,
      weight: fromScaledInteger(weight),
      totalWeight: fromScaledInteger(totalWeight),
      amountCents: amount.toString(),
    });
    if (unit.ownerOccupied) {
      landlordOwnerAmountCents += amount;
      allocations.push({
        unitId: unit.unitId,
        tenantId: null,
        periodStart: isoDay(periodStart),
        periodEnd: isoDay(periodEnd),
        amountCents: amount.toString(),
        distributionKey: source.distributionKey,
        calculationBasis: basis,
        sourceType: source.sourceType,
        sourceReferenceId: source.sourceReferenceId,
        allocationRuleId: source.allocationRuleId,
      });
      return;
    }
    const split = splitUnitAmountAcrossTenants(amount, unit.unitId, unit.tenants, periodStart, periodEnd, {
      distributionKey: source.distributionKey,
      calculationBasis: basis,
      sourceType: source.sourceType,
      sourceReferenceId: source.sourceReferenceId,
    });
    allocations.push(...split.allocations.map((row) => ({ ...row, allocationRuleId: source.allocationRuleId })));
    tenantAmountCents += split.allocations.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
    vacancyAmountCents += split.vacancyCents;
  });

  return { allocations, unitDetails, tenantAmountCents, landlordOwnerAmountCents, vacancyAmountCents };
}

export type EffectiveRule = { id: string; validFrom: Date; validTo: Date | null };

export function resolveRuleSegments<T extends EffectiveRule>(rules: T[], start: Date, end: Date): Array<{ start: Date; end: Date; rule: T }> {
  const sorted = rules
    .filter((rule) => rule.validFrom <= end && (!rule.validTo || rule.validTo >= start))
    .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  const segments: Array<{ start: Date; end: Date; rule: T }> = [];
  let expected = start;
  for (const rule of sorted) {
    const segmentStart = rule.validFrom > start ? rule.validFrom : start;
    const segmentEnd = rule.validTo && rule.validTo < end ? rule.validTo : end;
    if (segmentStart > expected) throw new Error(`Für den Zeitraum ab ${isoDay(expected)} fehlt eine Verteilungsregel.`);
    if (segmentStart < expected) throw new Error(`Verteilungsregeln überlappen am ${isoDay(expected)}.`);
    segments.push({ start: segmentStart, end: segmentEnd, rule });
    expected = new Date(segmentEnd);
    expected.setUTCDate(expected.getUTCDate() + 1);
  }
  if (expected <= end) throw new Error(`Für den Zeitraum ab ${isoDay(expected)} fehlt eine Verteilungsregel.`);
  return segments;
}

export function calculateBavariaResidentialTaxCents(
  areaM2: string,
  equivalentMicroEuroPerM2: bigint,
  assessmentFactorMillionths: bigint,
  hebesatzBasisPoints: bigint
): bigint {
  const areaMilli = toScaledInteger(areaM2);
  if (areaMilli < 0n || equivalentMicroEuroPerM2 < 0n || assessmentFactorMillionths < 0n || hebesatzBasisPoints < 0n) {
    throw new Error("Grundsteuerparameter dürfen nicht negativ sein.");
  }
  const numerator = areaMilli * equivalentMicroEuroPerM2 * assessmentFactorMillionths * hebesatzBasisPoints;
  const denominator = 1_000n * 1_000_000n * 10_000n * 10_000n;
  return (numerator + denominator / 2n) / denominator;
}
