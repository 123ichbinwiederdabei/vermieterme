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

  const openingForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Anfangsbestand" }) });
  const deliveryForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Heizöllieferung" }) });
  const readingForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Tankstand erfassen" }) });

  await openingForm.getByLabel("Tank").selectOption("tank-1");
  await openingForm.getByLabel("Datum", { exact: true }).fill("2024-01-01");
  await openingForm.getByLabel("Menge (L)").fill("1000");
  await openingForm.getByLabel("Bestandswert (€)").fill("1000.00");
  await openingForm.getByRole("button", { name: "Speichern", exact: true }).click();

  await deliveryForm.getByLabel("Tank").selectOption("tank-1");
  await deliveryForm.getByLabel("Lieferdatum").fill("2024-06-01");
  await deliveryForm.getByLabel("Menge (L)").fill("1000");
  await deliveryForm.getByLabel("Gesamtbetrag (€)").fill("1200.00");
  await deliveryForm.getByLabel("Lieferant").fill("E2E Energie");
  await deliveryForm.getByLabel("Rechnungsnummer").fill("E2E-2024");
  await deliveryForm.getByRole("button", { name: "Speichern", exact: true }).click();

  for (const [date, liters] of [["2024-01-01", "1000"], ["2024-12-31", "500"]]) {
    await readingForm.getByLabel("Tank", { exact: true }).selectOption("tank-1");
    await readingForm.getByLabel("Ablesedatum").fill(date);
    await readingForm.getByLabel("Tankstand (l)").fill(liters);
    await readingForm.getByRole("button", { name: "Speichern", exact: true }).click();
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

test("small wastewater management and plant-meter role are available", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Strom", exact: true }).click();
  const meterForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Stromzähler", exact: true }) });
  await expect(meterForm.getByRole("option", { name: "Kleinkläranlage – Anlagenstrom" })).toBeAttached();
  await page.getByRole("link", { name: "Kleinkläranlage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Kleinkläranlage", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rechnung erfassen", exact: true })).toBeVisible();
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
