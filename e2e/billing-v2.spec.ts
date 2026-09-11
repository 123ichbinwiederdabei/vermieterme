import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel(/E-Mail/i).fill("e2e@example.test");
  await page.getByLabel(/Passwort/i).fill("e2e-password");
  await page.getByRole("button", { name: /Anmelden/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("admin completes heating-oil billing and opens the shared PDF", async ({ page, request }) => {
  await login(page);
  await page.getByRole("link", { name: "Heizöl" }).click();
  await expect(page.getByRole("heading", { name: "Heizöl", exact: true })).toBeVisible();
  await expect(page.getByText("OilFox-Status")).toBeVisible();

  await page.getByLabel("Tank").nth(0).selectOption("tank-1");
  await page.getByLabel("Datum", { exact: true }).fill("2024-01-01");
  await page.getByLabel("Menge (L)").nth(0).fill("1000");
  await page.getByLabel("Bestandswert (€)").fill("1000.00");
  await page.getByRole("button", { name: "Speichern", exact: true }).nth(1).click();

  await page.getByLabel("Tank").nth(1).selectOption("tank-1");
  await page.getByLabel("Lieferdatum").fill("2024-06-01");
  await page.getByLabel("Menge (L)").nth(1).fill("1000");
  await page.getByLabel("Gesamtbetrag (€)").fill("1200.00");
  await page.getByLabel("Lieferant").fill("E2E Energie");
  await page.getByLabel("Rechnungsnummer").fill("E2E-2024");
  await page.getByRole("button", { name: "Speichern", exact: true }).nth(2).click();

  for (const [date, liters] of [["2024-01-01", "1000"], ["2024-12-31", "500"]]) {
    await page.getByLabel("Tank").nth(2).selectOption("tank-1");
    await page.getByLabel("Ablesedatum").fill(date);
    await page.getByLabel("Tankstand (l)").fill(liters);
    await page.getByRole("button", { name: "Speichern", exact: true }).nth(3).click();
  }

  await page.getByRole("link", { name: "Abrechnungen" }).click();
  await page.getByRole("link", { name: "Bearbeiten" }).first().click();
  await expect(page).toHaveURL(/\/billing\/bp-2024$/);
  await page.getByRole("button", { name: "Vorschau berechnen" }).first().click();
  await expect(page.getByText("1.600,00 €").first()).toBeVisible();
  await page.getByRole("button", { name: "Unveränderlich übernehmen" }).first().click();
  await expect(page.getByText("Gespeichert").first()).toBeVisible();

  const cookies = (await page.context().cookies()).map((row) => `${row.name}=${row.value}`).join("; ");
  const pdf = await request.get("/api/billing-periods/bp-2024/pdf", { headers: { cookie: cookies } });
  expect(pdf.ok()).toBeTruthy();
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
});

test("electricity and finance dashboards are available", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Strom" }).click();
  await expect(page.getByRole("heading", { name: "Strom", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stromvertrag", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Miet- und NK-Historie" }).click();
  await expect(page.getByRole("heading", { name: "Miet- und NK-Historie" })).toBeVisible();
  await expect(page.getByText("Kaltmiete").first()).toBeVisible();
});

test("tenant card opens and updates the complete finance history", async ({ page, request }) => {
  await login(page);
  await page.getByRole("navigation").getByRole("link", { name: "Mieter", exact: true }).click();

  const annaCard = page.getByText("Frau Anna Schmidt").locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
  await expect(annaCard.getByText("Kaltmiete: 850,00 €")).toBeVisible();
  await expect(annaCard.getByText("NK-Vorauszahlung: 200,00 €")).toBeVisible();
  await annaCard.getByRole("link", { name: "Anpassen" }).click();

  await expect(page).toHaveURL(/\/rent-changes\?tenantId=tenant-1&new=1/);
  await expect(page.getByRole("heading", { name: "Vollständigen Stand speichern" })).toBeVisible();
  await expect(page.getByLabel("Mietverhältnis")).toHaveValue("tenant-1");
  await expect(page.getByLabel("Mietverhältnis")).toBeDisabled();
  await expect(page.getByLabel("Kaltmiete (€)")).toHaveValue("850.00");
  await expect(page.getByLabel("NK Heizöl (€)")).toHaveValue("100.00");
  await expect(page.getByLabel("NK Strom (€)")).toHaveValue("100.00");

  const validFrom = await page.getByLabel("Gültig ab").inputValue();
  await page.getByLabel("Kaltmiete (€)").fill("900.00");
  await page.getByLabel("Änderungsgrund").fill("Mietanpassung E2E");
  await page.getByRole("button", { name: "Periode speichern" }).click();
  await expect(page.getByText("Finanzperiode gespeichert")).toBeVisible();
  await expect(page.getByText("Kaltmiete 900,00 €").first()).toBeVisible();

  const cookies = (await page.context().cookies()).map((row) => `${row.name}=${row.value}`).join("; ");
  const periodsResponse = await request.get("/api/tenants/tenant-1/financial-periods", { headers: { cookie: cookies } });
  expect(periodsResponse.ok()).toBeTruthy();
  const periods = await periodsResponse.json();
  const previous = periods.find((period: { monthlyColdRentCents: string }) => period.monthlyColdRentCents === "85000");
  const previousEnd = new Date(`${validFrom}T00:00:00.000Z`);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  expect(previous?.validTo.slice(0, 10)).toBe(previousEnd.toISOString().slice(0, 10));

  await page.getByRole("link", { name: "Zum Mieter" }).click();
  await expect(annaCard.getByText("Kaltmiete: 900,00 €")).toBeVisible();
  await expect(annaCard.getByText("NK-Vorauszahlung: 200,00 €")).toBeVisible();
});
