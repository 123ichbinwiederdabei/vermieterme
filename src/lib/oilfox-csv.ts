export interface OilFoxCsvRow {
  measuredAt: Date;
  fillLevelLiters: string;
  distanceCm?: string;
  fillLevelPercent?: number;
  meteringStatus?: string;
  manuallyInvalidated?: boolean;
  meteringType?: string;
  signalStrength?: string;
}

export interface OilFoxCsvParseResult { rows: OilFoxCsvRow[]; invalidRows: number; unitErrors: number; warnings: string[]; detectedColumns: string[]; }

function parseLine(line: string, delimiter: string): string[] {
  const cells: string[] = []; let current = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') { if (quoted && line[index + 1] === '"') { current += '"'; index += 1; } else quoted = !quoted; }
    else if (char === delimiter && !quoted) { cells.push(current.trim()); current = ""; }
    else current += char;
  }
  cells.push(current.trim()); return cells;
}
function normalize(value: string) { return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""); }
function decimal(value: string): string | null { const normalized = value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."); return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : null; }
function date(value: string): Date | null {
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}))(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const parsed = new Date(Number(match[1] || match[6]), Number(match[2] || match[5]) - 1, Number(match[3] || match[4]), Number(match[7] || 0), Number(match[8] || 0), Number(match[9] || 0));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function asBoolean(value: string): boolean | undefined { if (/^(true|1|yes|ja)$/i.test(value.trim())) return true; if (/^(false|0|no|nein)$/i.test(value.trim())) return false; return undefined; }
function divideByTen(value: string): string { const digits = value.replace(".", ""); const decimals = (value.split(".")[1] || "").length; const padded = digits.padStart(decimals + 2, "0"); const splitAt = padded.length - decimals - 1; return `${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1"); }

export function parseOilFoxCsv(content: string): OilFoxCsvParseResult {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], invalidRows: 0, unitErrors: 0, warnings: ["Die CSV-Datei enthält keine Messdaten."], detectedColumns: [] };
  const delimiter = (lines[0].match(/;/g)?.length || 0) >= (lines[0].match(/,/g)?.length || 0) ? ";" : ",";
  const detectedColumns = parseLine(lines[0], delimiter); const headers = detectedColumns.map(normalize);
  const find = (...names: string[]) => headers.findIndex((header) => names.some((name) => header === name || header.includes(name)));
  const dateIndex = find("measurementtime", "datum", "date", "zeit"); const litersIndex = find("filllevel", "fullstandliter", "fuellstandliter", "filllevelliter", "liter"); const unitIndex = find("filllevelunit", "einheit", "unit");
  const distanceMmIndex = find("distancemm", "abstandmm"); const distanceCmIndex = find("distancecm", "abstandcm", "messwertcm"); const percentIndex = detectedColumns.findIndex((header) => /%/.test(header) && /fill level|füllstand/i.test(header));
  const statusIndex = find("meteringstatus", "messstatus"); const invalidatedIndex = find("manuallyinvalidated", "manuellinvalidiert"); const meteringTypeIndex = find("meteringtype", "messtyp"); const signalIndex = find("signalstrength", "signalstarke");
  if (dateIndex < 0 || litersIndex < 0) return { rows: [], invalidRows: lines.length - 1, unitErrors: 0, warnings: ["Spalten für Measurement Time und Fill Level wurden nicht gefunden."], detectedColumns };
  const rows: OilFoxCsvRow[] = []; let invalidRows = 0; let unitErrors = 0;
  for (const line of lines.slice(1)) {
    const cells = parseLine(line, delimiter); const measuredAt = date(cells[dateIndex] || ""); const fillLevelLiters = decimal(cells[litersIndex] || ""); const unit = unitIndex >= 0 ? (cells[unitIndex] || "").trim().toUpperCase() : "L";
    const distanceMm = distanceMmIndex >= 0 ? decimal(cells[distanceMmIndex] || "") : null; const distanceCm = distanceCmIndex >= 0 ? decimal(cells[distanceCmIndex] || "") : distanceMm ? divideByTen(distanceMm) : null;
    if (!measuredAt || !fillLevelLiters) { invalidRows += 1; continue; } if (unit !== "L") { unitErrors += 1; continue; }
    const percent = percentIndex >= 0 ? decimal(cells[percentIndex] || "") : null; const manuallyInvalidated = invalidatedIndex >= 0 ? asBoolean(cells[invalidatedIndex] || "") : undefined;
    rows.push({ measuredAt, fillLevelLiters, ...(distanceCm ? { distanceCm } : {}), ...(percent && /^\d+$/.test(percent) ? { fillLevelPercent: Number(percent) } : {}), ...(statusIndex >= 0 && cells[statusIndex] ? { meteringStatus: cells[statusIndex] } : {}), ...(manuallyInvalidated !== undefined ? { manuallyInvalidated } : {}), ...(meteringTypeIndex >= 0 && cells[meteringTypeIndex] ? { meteringType: cells[meteringTypeIndex] } : {}), ...(signalIndex >= 0 && cells[signalIndex] ? { signalStrength: cells[signalIndex] } : {}) });
  }
  const warnings: string[] = []; if (unitErrors) warnings.push(`${unitErrors} Zeile(n) wurden verworfen, weil die Füllstandseinheit nicht Liter ist.`); if (invalidRows) warnings.push(`${invalidRows} Zeile(n) enthalten keinen gültigen Zeitpunkt oder Füllstand.`);
  return { rows, invalidRows, unitErrors, warnings, detectedColumns };
}
