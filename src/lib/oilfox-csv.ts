export interface OilFoxCsvRow {
  measuredAt: Date;
  fillLevelLiters: string;
  distanceCm?: string;
}

function parseLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { cells.push(current.trim()); current = ""; }
    else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

function decimal(value: string): string | null {
  const normalized = value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : null;
}

function date(value: string): Date | null {
  const trimmed = value.trim();
  const iso = new Date(trimmed);
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) && !Number.isNaN(iso.getTime())) return iso;
  const match = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!match) return null;
  const parsed = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseOilFoxCsv(content: string) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [] as OilFoxCsvRow[], invalidRows: 0, warnings: ["Die CSV-Datei enthält keine Messdaten."] };
  const delimiter = (lines[0].match(/;/g)?.length || 0) >= (lines[0].match(/,/g)?.length || 0) ? ";" : ",";
  const headers = parseLine(lines[0], delimiter).map(normalize);
  const dateIndex = headers.findIndex((header) => header.includes("datum") || header.includes("date") || header.includes("zeit"));
  const litersIndex = headers.findIndex((header) => header.includes("fullstandliter") || header.includes("fuellstandliter") || header.includes("filllevelliter") || header === "liter");
  const distanceIndex = headers.findIndex((header) => header.includes("messwertcm") || header.includes("distancecm") || header.includes("abstandcm"));
  if (dateIndex < 0 || litersIndex < 0) return { rows: [] as OilFoxCsvRow[], invalidRows: lines.length - 1, warnings: ["Spalten für Datum und Füllstand (Liter) wurden nicht gefunden."] };
  const rows: OilFoxCsvRow[] = [];
  let invalidRows = 0;
  for (const line of lines.slice(1)) {
    const cells = parseLine(line, delimiter);
    const measuredAt = date(cells[dateIndex] || "");
    const fillLevelLiters = decimal(cells[litersIndex] || "");
    const distanceCm = distanceIndex >= 0 ? decimal(cells[distanceIndex] || "") : null;
    if (!measuredAt || !fillLevelLiters) { invalidRows += 1; continue; }
    rows.push({ measuredAt, fillLevelLiters, ...(distanceCm ? { distanceCm } : {}) });
  }
  return { rows, invalidRows, warnings: [] as string[] };
}
