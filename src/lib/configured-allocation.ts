import { prisma } from "@/lib/prisma";
import { allocateConfiguredCost, allocateKnownUnitAmounts, resolveRuleSegments, type AllocationUnit, type AllocationMethod, type ConfiguredAllocationResult } from "@/lib/allocation-engine";
import { allocateCents, toScaledInteger } from "@/lib/billing-v2";
import { isoDay } from "@/lib/energy-billing";
import { allocateServiceLineToPeriod } from "@/lib/cost-invoice";

export type AllocationCharge = { amountCents: bigint; start: Date; end: Date };
type RawUnit = { id: string; name: string; areaM2: { toString(): string } | null; shares?: number; ownerOccupied: boolean; tenants: AllocationUnit["tenants"] };
const day = 86_400_000;

export async function configuredAllocation(input: { propertyId: string; categoryId: string; units: RawUnit[]; start: Date; end: Date; amountCents: bigint; purpose?: string; sourceType: string; charges?: AllocationCharge[]; legacyMethod?: "AREA" | "FIXED_SHARES"; consumptionWeights?: Record<string, bigint> }) {
  const rules = await prisma.propertyCostAllocationRule.findMany({ where: { propertyId: input.propertyId, costCategoryId: input.categoryId, purpose: input.purpose || "TOTAL", supersededAt: null }, include: { units: true }, orderBy: [{ validFrom: "asc" }, { id: "asc" }] });
  const states = await prisma.unitStatePeriod.findMany({ where: { unitId: { in: input.units.map((u) => u.id) } } });
  const result: ConfiguredAllocationResult = { allocations: [], unitDetails: [], tenantAmountCents: 0n, landlordOwnerAmountCents: 0n, vacancyAmountCents: 0n };
  const warnings: string[] = [];
  const consumptionEvidence: unknown[] = [];
  const selected = rules.length ? resolveRuleSegments(rules, input.start, input.end) : [];
  if (!selected.length) {
    if (!input.legacyMethod || input.end >= new Date("2026-10-01T00:00:00Z")) throw new Error(`Gültiger Verteilerschlüssel ${input.purpose || "TOTAL"} fehlt.`);
    warnings.push("Historischer Bestandsschlüssel: fachliche Grundlage vor Freigabe bestätigen.");
    selected.push({ start: input.start, end: input.end, rule: { id: "LEGACY", allocationMethod: input.legacyMethod, consumptionSharePercent: null, validFrom: input.start, validTo: input.end, units: [] } as unknown as typeof rules[number] });
  }
  const collect = (allocation: ConfiguredAllocationResult) => {
    result.allocations.push(...allocation.allocations); result.unitDetails.push(...allocation.unitDetails);
    result.tenantAmountCents += allocation.tenantAmountCents; result.landlordOwnerAmountCents += allocation.landlordOwnerAmountCents; result.vacancyAmountCents += allocation.vacancyAmountCents;
  };
  const sources = input.charges?.length ? input.charges : [{ amountCents: input.amountCents, start: input.start, end: input.end }];
  for (const segment of selected) {
    const cuts = new Set([segment.start.getTime(), segment.end.getTime() + day]);
    if (["HEIZKOSTENV", "DIRECT_CONSUMPTION", "MIXED"].includes(segment.rule.allocationMethod)) {
      for (const unit of input.units) for (const tenant of unit.tenants) {
        if (tenant.moveInDate > segment.start && tenant.moveInDate <= segment.end) cuts.add(tenant.moveInDate.getTime());
        if (tenant.moveOutDate && tenant.moveOutDate >= segment.start && tenant.moveOutDate < segment.end) cuts.add(tenant.moveOutDate.getTime() + day);
      }
    }
    for (const state of states) {
      if (state.validFrom > segment.start && state.validFrom <= segment.end) cuts.add(state.validFrom.getTime());
      if (state.validTo && state.validTo >= segment.start && state.validTo < segment.end) cuts.add(state.validTo.getTime() + day);
    }
    const boundaries = [...cuts].sort((a, b) => a - b);
    const prepared: Array<{ start: Date; end: Date; amount: bigint; units: AllocationUnit[]; weights: bigint[] }> = [];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = new Date(boundaries[index]);
      const end = new Date(boundaries[index + 1] - day);
      const amount = sources.reduce((sum, charge) => sum + allocateServiceLineToPeriod(charge.amountCents, charge.start, charge.end, start, end), 0n);
      const units: AllocationUnit[] = input.units.map((unit) => {
        const applicable = states.filter((state) => state.unitId === unit.id && state.validFrom <= start && (!state.validTo || state.validTo >= end));
        if (applicable.length > 1) throw new Error(`Wohnungszustände für ${unit.name} überlappen.`);
        if (states.some((state) => state.unitId === unit.id) && !applicable.length) throw new Error(`Historischer Wohnungszustand für ${unit.name} fehlt.`);
        const state = applicable[0];
        const configured = segment.rule.units.find((row) => row.unitId === unit.id);
        return { unitId: unit.id, unitName: unit.name, tenants: unit.tenants, ownerOccupied: state?.ownerOccupied ?? unit.ownerOccupied, included: segment.rule.id === "LEGACY" || !!configured?.included, areaM2: configured?.areaM2?.toString() ?? state?.areaM2.toString() ?? unit.areaM2?.toString(), weight: configured?.weight?.toString() ?? "1" };
      });
      const method = segment.rule.allocationMethod as AllocationMethod;
      const source = { distributionKey: method, sourceType: input.sourceType, allocationRuleId: segment.rule.id === "LEGACY" ? undefined : segment.rule.id };
      let allocation: ConfiguredAllocationResult;
      if (method === "AREA" || method === "FIXED_SHARES") allocation = allocateConfiguredCost(amount, method, units, start, end, source);
      else {
        const weights: bigint[] = [];
        for (const unit of units) {
          if (!unit.included) { weights.push(0n); continue; }
          if (input.consumptionWeights) { weights.push(input.consumptionWeights[unit.unitId] ?? 0n); continue; }
          if (method === "HEIZKOSTENV") {
            const meters = await prisma.heatMeter.findMany({ where: { unitId: unit.unitId, heatingSystem: { propertyId: input.propertyId }, validFrom: { lte: start }, OR: [{ validTo: null }, { validTo: { gte: end } }] }, include: { readings: { where: { confirmed: true, readingDate: { in: [start, new Date(end.getTime() + day)] } }, orderBy: { readingDate: "asc" } } } });
            if (!meters.length || meters.some((meter) => meter.readings.length !== 2)) throw new Error(`Wärme-Grenzablesungen für ${unit.unitName} fehlen.`);
            const quantity = meters.reduce((sum, meter) => sum + toScaledInteger(meter.readings[1].readingValue.toString()) - toScaledInteger(meter.readings[0].readingValue.toString()), 0n);
            if (quantity < 0n) throw new Error("Negativer Wärmeverbrauch");
            consumptionEvidence.push(...meters);
            weights.push(quantity); continue;
          }
          const readings = await prisma.allocationConsumptionReading.findMany({ where: { costCategoryId: input.categoryId, unitId: unit.unitId, readingDate: { in: [start, new Date(end.getTime() + day)] }, confirmed: true }, orderBy: { readingDate: "asc" } });
          if (readings.length !== 2) throw new Error(`Verbrauchs-Grenzablesungen für ${unit.unitName} fehlen (${isoDay(start)}–${isoDay(end)}).`);
          const consumption = toScaledInteger(readings[1].quantity.toString()) - toScaledInteger(readings[0].quantity.toString());
          if (consumption < 0n) throw new Error("Negativer Zählerverbrauch");
          consumptionEvidence.push(...readings);
          weights.push(consumption);
        }
        prepared.push({ start, end, amount, units, weights });
        continue;
      }
      collect(allocation);
    }
    if (prepared.length) {
      const method = segment.rule.allocationMethod as AllocationMethod;
      const total = prepared.reduce((sum, row) => sum + row.amount, 0n);
      const weights = prepared.flatMap((row) => row.weights);
      const mixed = method === "HEIZKOSTENV" || method === "MIXED";
      const percent = mixed ? segment.rule.consumptionSharePercent : 100;
      if (percent == null || !Number.isInteger(percent) || percent < (method === "HEIZKOSTENV" ? 50 : 0) || percent > (method === "HEIZKOSTENV" ? 70 : 100)) throw new Error("Gultiger Verbrauchskostenanteil fehlt.");
      if (!mixed && method !== "DIRECT_CONSUMPTION") throw new Error(`Nicht unterstutzter Schlussel ${method}`);
      const [variableTotal, baseTotal] = allocateCents(total, [BigInt(percent), BigInt(100 - percent)]);
      if (variableTotal && weights.every((weight) => weight === 0n)) throw new Error("Verbrauchsverteilung ohne gemessenen Verbrauch gesperrt.");
      // Consumption shares span all tenancy/state sections of the rule. A tenant
      // change therefore uses measured consumption, never a daily split of heat.
      const variable = allocateCents(variableTotal, weights);
      // Weight base costs before cent rounding. Otherwise the invoice's daily
      // remainder would skew equal tenancy sections (e.g. 2,006 / 1,994 cents).
      const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
      const denominators = sources.map((charge) => BigInt(Math.round((charge.end.getTime() - charge.start.getTime()) / day) + 1));
      const denominator = denominators.reduce((a, b) => a / gcd(a, b) * b, 1n);
      const baseWeights = prepared.map((row) => {
        const weight = sources.reduce((sum, charge, index) => {
          const start = Math.max(row.start.getTime(), charge.start.getTime());
          const end = Math.min(row.end.getTime(), charge.end.getTime());
          const days = end < start ? 0n : BigInt(Math.round((end - start) / day) + 1);
          return sum + charge.amountCents * days * (denominator / denominators[index]);
        }, 0n);
        return weight < 0n ? -weight : weight;
      });
      const baseSections = allocateCents(baseTotal, baseWeights);
      let offset = 0;
      for (const [index, row] of prepared.entries()) {
        const areaWeights = row.units.map((unit) => unit.included ? toScaledInteger(unit.areaM2 || "0") : 0n);
        if (baseSections[index] && areaWeights.every((weight) => weight === 0n)) throw new Error("Grundkostenflachen fehlen.");
        const base = allocateCents(baseSections[index], areaWeights);
        const amounts = row.weights.map((_, unitIndex) => variable[offset + unitIndex] + base[unitIndex]);
        offset += row.units.length;
        const allocation = allocateKnownUnitAmounts(amounts, row.weights, method, row.units, row.start, row.end, { distributionKey: mixed ? `${method}: ${percent}% Verbrauch / ${100 - percent}% Flache` : method, sourceType: input.sourceType, allocationRuleId: segment.rule.id });
        collect(allocation);
      }
    }
  }
  return { ...result, rules, states, warnings, consumptionEvidence };
}
