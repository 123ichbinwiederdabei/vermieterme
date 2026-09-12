export const QUANTITY_SCALE = 3;

export function toScaledInteger(value: string | number, scale = QUANTITY_SCALE): bigint {
  const raw = String(value).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Ungültige Dezimalzahl: ${value}`);
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = `${fraction}${"0".repeat(scale)}`.slice(0, scale);
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || "0");
  return negative ? -result : result;
}

export function fromScaledInteger(value: bigint, scale = QUANTITY_SCALE): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function roundFraction(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Der Nenner muss positiv sein.");
  if (numerator < 0n) return -roundFraction(-numerator, denominator);
  return (numerator + denominator / 2n) / denominator;
}

export function allocateCents(totalCents: bigint, rawWeights: bigint[]): bigint[] {
  if (rawWeights.some((weight) => weight < 0n)) {
    throw new Error("Verteilgewichte dürfen nicht negativ sein.");
  }
  const weightTotal = rawWeights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal === 0n) return rawWeights.map(() => 0n);

  const base = rawWeights.map((weight) => (totalCents * weight) / weightTotal);
  let remainder = totalCents - base.reduce((sum, amount) => sum + amount, 0n);
  const order = rawWeights
    .map((weight, index) => ({
      index,
      fraction: (totalCents * weight) % weightTotal,
    }))
    .sort((a, b) =>
      a.fraction === b.fraction
        ? a.index - b.index
        : a.fraction > b.fraction
          ? -1
          : 1
    );

  for (let i = 0; remainder > 0n; i += 1) {
    base[order[i % order.length].index] += 1n;
    remainder -= 1n;
  }
  return base;
}

export interface FifoLotInput {
  id: string;
  sourceDate: string | Date;
  quantityLiters: string | number;
  totalAmountCents: bigint | string | number;
  co2CostCents?: bigint | string | number;
  co2Grams?: bigint | string | number;
}

export interface FifoConsumption {
  lotId: string;
  consumedLiters: string;
  amountCents: bigint;
  co2CostCents: bigint;
  co2Grams: bigint;
  remainingLiters: string;
  remainingAmountCents: bigint;
}

export function calculateFifoConsumption(
  lots: FifoLotInput[],
  requestedLiters: string | number
): { consumptions: FifoConsumption[]; totalAmountCents: bigint; totalCo2CostCents: bigint; totalCo2Grams: bigint } {
  let remainingToConsume = toScaledInteger(requestedLiters);
  if (remainingToConsume < 0n) throw new Error("Der Heizölverbrauch darf nicht negativ sein.");

  const sorted = [...lots].sort((a, b) => {
    const dateDifference = new Date(a.sourceDate).getTime() - new Date(b.sourceDate).getTime();
    return dateDifference || a.id.localeCompare(b.id);
  });
  const consumptions: FifoConsumption[] = [];

  for (const lot of sorted) {
    const quantity = toScaledInteger(lot.quantityLiters);
    if (quantity <= 0n) continue;
    const consumed = remainingToConsume < quantity ? remainingToConsume : quantity;
    const amount = BigInt(lot.totalAmountCents);
    const co2Cost = BigInt(lot.co2CostCents ?? 0);
    const co2Grams = BigInt(lot.co2Grams ?? 0);
    const allocatedAmount = roundFraction(amount * consumed, quantity);
    const allocatedCo2Cost = roundFraction(co2Cost * consumed, quantity);
    const allocatedCo2Grams = roundFraction(co2Grams * consumed, quantity);

    consumptions.push({
      lotId: lot.id,
      consumedLiters: fromScaledInteger(consumed),
      amountCents: allocatedAmount,
      co2CostCents: allocatedCo2Cost,
      co2Grams: allocatedCo2Grams,
      remainingLiters: fromScaledInteger(quantity - consumed),
      remainingAmountCents: amount - allocatedAmount,
    });
    remainingToConsume -= consumed;
    if (remainingToConsume === 0n) break;
  }

  if (remainingToConsume > 0n) {
    throw new Error(`FIFO-Bestand reicht nicht aus; ${fromScaledInteger(remainingToConsume)} l fehlen.`);
  }

  return {
    consumptions,
    totalAmountCents: consumptions.reduce((sum, row) => sum + row.amountCents, 0n),
    totalCo2CostCents: consumptions.reduce((sum, row) => sum + row.co2CostCents, 0n),
    totalCo2Grams: consumptions.reduce((sum, row) => sum + row.co2Grams, 0n),
  };
}

export function calculateElectricityCostCents(
  startKwh: string | number,
  endKwh: string | number,
  priceMicroEuroPerKwh: bigint
): { consumptionKwh: string; amountCents: bigint } {
  const start = toScaledInteger(startKwh);
  const end = toScaledInteger(endKwh);
  if (end < start) throw new Error("Der Stromzählerstand darf nicht rückwärts laufen.");
  const consumption = end - start;
  return {
    consumptionKwh: fromScaledInteger(consumption),
    // meter values use QUANTITY_SCALE decimals; one cent equals 10,000 µ€.
    amountCents: roundFraction(consumption * priceMicroEuroPerKwh, 10n ** BigInt(QUANTITY_SCALE + 4)),
  };
}

export function prorateMonthlyCents(
  monthlyCents: bigint,
  validFrom: string | Date,
  validTo: string | Date
): bigint {
  const start = new Date(validFrom);
  const end = new Date(validTo);
  if (end < start) return 0n;
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  let total = 0n;
  while (cursor <= endMonth) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const segmentStart = new Date(Math.max(start.getTime(), Date.UTC(year, month, 1)));
    const segmentEnd = new Date(Math.min(end.getTime(), Date.UTC(year, month, daysInMonth)));
    const coveredDays = Math.floor((segmentEnd.getTime() - segmentStart.getTime()) / 86_400_000) + 1;
    total += roundFraction(monthlyCents * BigInt(coveredDays), BigInt(daysInMonth));
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return total;
}

export function serializeExact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object" && item.constructor?.name === "Decimal") {
        return item.toString();
      }
      return item;
    })
  ) as T;
}
