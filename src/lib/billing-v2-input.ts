import { ApiError } from "@/lib/api-utils";

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(`${label} ist erforderlich`, 400);
  }
  return value.trim();
}

export function decimalString(value: unknown, label: string, allowZero = true): string {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) {
    throw new ApiError(`${label} muss eine Zahl mit höchstens drei Nachkommastellen sein`, 400);
  }
  if (!allowZero && Number(normalized) <= 0) {
    throw new ApiError(`${label} muss größer als null sein`, 400);
  }
  return normalized;
}

export function integerCents(value: unknown, label: string): bigint {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ApiError(`${label} muss als Centbetrag angegeben werden`, 400);
  }
  return BigInt(normalized);
}

export function dateValue(value: unknown, label: string): Date {
  const raw = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ApiError(`${label} muss im Format JJJJ-MM-TT angegeben werden`, 400);
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new ApiError(`${label} ist ungültig`, 400);
  return date;
}
