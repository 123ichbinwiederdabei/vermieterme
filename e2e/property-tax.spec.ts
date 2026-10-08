import { expect, test } from "@playwright/test";

test("property-tax settings persist and feed the shared billing preview", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/E-Mail/i).fill("e2e@example.test");
  await page.getByLabel(/Passwort/i).fill("e2e-password");
  await page.getByRole("button", { name: /Anmelden/i }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/settings");
  await page.getByRole("link", { name: "Grundsteuerumlage verwalten" }).click();
  await expect(page.getByRole("heading", { name: "Grundsteuerumlage", exact: true })).toBeVisible();
  const form = page.locator("form");
  await expect(form.locator("select").first()).toHaveValue("property-1");
  await form.locator("input").nth(0).fill("1200.00");
  await form.locator("input").nth(1).fill("800.00");
  await form.locator("textarea").fill("Wohnanteil laut Bescheid; übrige Fläche beim Vermieter");
  await form.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible();
  await page.reload();
  await expect(form.locator("input").nth(0)).toHaveValue("1200.00");
  await expect(form.locator("input").nth(1)).toHaveValue("800.00");

  const saved = await page.request.get("/api/properties/property-1/property-tax-setting");
  expect(saved.ok()).toBeTruthy();
  expect(await saved.json()).toMatchObject({ annualAssessmentCents: "120000", annualAllocatableAmountCents: "80000" });

  await page.goto("/billing/bp-2024");
  const taxCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Grundsteuer", exact: true }) });
  await taxCard.getByRole("button", { name: "Vorschau berechnen" }).click();
  await expect(taxCard.getByText("1.200,00 €", { exact: true })).toBeVisible();
  await expect(taxCard.getByRole("button", { name: "Unveränderlich übernehmen" })).toBeEnabled();
  const preview = await page.request.get("/api/billing-periods/bp-2024/energy-preview?kind=MANUAL&costCategoryId=cat-8");
  expect(preview.ok()).toBeTruthy();
  expect(await preview.json()).toMatchObject({
    kind: "MANUAL", totalAmountCents: "120000", blockers: [],
    details: { allocatableAmountCents: "80000", nonAllocatableLandlordCents: "40000" },
  });
});
