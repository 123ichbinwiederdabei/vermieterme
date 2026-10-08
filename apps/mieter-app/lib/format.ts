export function formatCurrency(value: number): string {
  return value
    .toFixed(2)
    .replace(".", ",")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

export function formatDateRange(start: string, end: string): string {
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Display final server-calculated cents without converting through floats.
export function formatCents(value: string, absolute = false): string {
  const cents = BigInt(value);
  const amount = cents < 0n ? -cents : cents;
  return `${cents < 0n && !absolute ? "−" : ""}${(amount / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${(amount % 100n).toString().padStart(2, "0")}`;
}
