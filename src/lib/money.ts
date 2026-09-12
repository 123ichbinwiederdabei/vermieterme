export function euroToCents(value: string): string {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error("Bitte einen Eurobetrag mit höchstens zwei Nachkommastellen eingeben.");
  return (BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0")).toString();
}

export function centsToEuro(value: string | bigint): string {
  const cents = BigInt(value);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole},${fraction} €`;
}

export function euroToMicroEuros(value: string): string {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) throw new Error("Bitte einen Arbeitspreis mit höchstens sechs Nachkommastellen eingeben.");
  return (BigInt(match[1]) * 1_000_000n + BigInt((match[2] || "").padEnd(6, "0") || "0")).toString();
}

export function microEurosPerKwhToEuro(value: string | bigint): string {
  const microEuros = BigInt(value);
  const negative = microEuros < 0n;
  const absolute = negative ? -microEuros : microEuros;
  const whole = (absolute / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimal = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole}${decimal ? `,${decimal}` : ""} €`;
}

export function microEurosPerKwhToInput(value: string | bigint): string {
  const microEuros = BigInt(value);
  const whole = microEuros / 1_000_000n;
  const decimal = (microEuros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${decimal ? `.${decimal}` : ""}`;
}
