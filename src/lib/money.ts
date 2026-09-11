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
