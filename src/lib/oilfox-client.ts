const API_BASE = "https://api.oilfox.io/customer-api/v1";

export interface OilFoxDeviceStatus {
  hwid: string;
  currentMeteringAt: string;
  nextMeteringAt?: string;
  daysReach?: number;
  validationError?: string;
  batteryLevel?: "FULL" | "GOOD" | "MEDIUM" | "WARNING" | "CRITICAL";
  fillLevelPercent?: number;
  fillLevelQuantity?: number;
  quantityUnit: "L" | "kg";
}

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

let tokenState: TokenState | null = null;

export class OilFoxError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryAfterSeconds?: number) {
    super(message);
  }
}

function credentials() {
  const email = process.env.OILFOX_USER?.trim();
  const password = process.env.OILFOX_PW;
  if (!email || !password) throw new OilFoxError("OilFox-Zugangsdaten sind nicht konfiguriert.");
  return { email, password };
}

async function checkedFetch(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (response.status === 429) {
      throw new OilFoxError("OilFox-Anfragelimit erreicht.", 429, Number(response.headers.get("retry-after") || 0));
    }
    return response;
  } catch (error) {
    if (error instanceof OilFoxError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new OilFoxError("OilFox-Zeitüberschreitung.");
    throw new OilFoxError("OilFox ist derzeit nicht erreichbar.");
  } finally {
    clearTimeout(timer);
  }
}

async function login(): Promise<TokenState> {
  const response = await checkedFetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials()),
  });
  if (!response.ok) throw new OilFoxError("OilFox-Anmeldung fehlgeschlagen.", response.status);
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new OilFoxError("OilFox lieferte keine gültigen Zugangstoken.");
  }
  tokenState = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + 14 * 60_000 };
  return tokenState;
}

async function refresh(): Promise<TokenState> {
  if (!tokenState?.refreshToken) return login();
  const response = await checkedFetch(`${API_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: tokenState.refreshToken }),
  });
  if (!response.ok) return login();
  const body = await response.json() as Record<string, unknown>;
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") return login();
  tokenState = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + 14 * 60_000 };
  return tokenState;
}

async function authorized(path: string, retry = true): Promise<Response> {
  const token = !tokenState ? await login() : tokenState.expiresAt <= Date.now() ? await refresh() : tokenState;
  const response = await checkedFetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (response.status === 401 && retry) {
    tokenState = null;
    await login();
    return authorized(path, false);
  }
  if (!response.ok) throw new OilFoxError("OilFox-Gerätedaten konnten nicht geladen werden.", response.status);
  return response;
}

function validateDevice(value: unknown): OilFoxDeviceStatus {
  const row = value as Record<string, unknown>;
  if (!row || typeof row.hwid !== "string" || typeof row.currentMeteringAt !== "string" || (row.quantityUnit !== "L" && row.quantityUnit !== "kg")) {
    throw new OilFoxError("OilFox lieferte einen ungültigen Gerätestatus.");
  }
  return row as unknown as OilFoxDeviceStatus;
}

export async function getOilFoxDevices() {
  const response = await authorized("/device");
  const body = await response.json() as { items?: unknown[] };
  if (!Array.isArray(body.items)) throw new OilFoxError("OilFox lieferte keine Geräteliste.");
  return {
    devices: body.items.map(validateDevice),
    apiVersion: response.headers.get("customer-api-version"),
    apiWarning: response.headers.get("x-api-warn"),
  };
}

export async function getOilFoxDevice(hwid: string) {
  const response = await authorized(`/device/${encodeURIComponent(hwid)}`);
  return {
    device: validateDevice(await response.json()),
    apiVersion: response.headers.get("customer-api-version"),
    apiWarning: response.headers.get("x-api-warn"),
  };
}

export function clearOilFoxTokenCache() {
  tokenState = null;
}
