import { expect, test, type Page, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createKrandorfFixture,
  fixturePng,
} from "../test-support/krandorf-fixture";
import type { OcrDocument } from "../src/lib/invoice-extraction";

const databaseUrl = `file:${path.join(process.cwd(), "prisma/e2e.db")}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/E-Mail/i).fill("e2e@example.test");
  await page.getByLabel(/Passwort/i).fill("e2e-password");
  await page.getByRole("button", { name: /Anmelden/i }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function createAndConfirm(
  page: Page,
  card: Locator,
  amount: string,
  extras: Record<string, string> = {},
) {
  await card
    .getByRole("button", { name: "Rechnung erfassen", exact: true })
    .click();
  const review = card
    .locator("details")
    .filter({ hasText: "Neue Rechnung" })
    .last();
  await review.locator("input[type=file]").setInputFiles({
    name: "synthetic-invoice.png",
    mimeType: "image/png",
    buffer: fixturePng,
  });
  await expect(
    review.getByRole("link", { name: "synthetic-invoice.png", exact: true }),
  ).toBeVisible();
  for (const [label, value] of Object.entries({
    Lieferant: "Testlieferant",
    Rechnungsnummer: `${amount}-${Date.now()}`,
    Rechnungsdatum: "2026-12-31",
    Leistungsbeginn: "2026-10-01",
    Leistungsende: "2026-12-31",
    "Bruttobetrag (€)": amount,
    ...extras,
  }))
    await review.getByLabel(label, { exact: true }).fill(value);
  await review
    .getByRole("button", { name: "Geprüfte Rechnung bestätigen" })
    .click();
  await expect(
    card.locator("summary").filter({ hasText: "CONFIRMED" }).last(),
  ).toBeVisible();
  return review;
}

test("uploads invoices in all categories, publishes a visual template and freezes a complete bill", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const fixture = await createKrandorfFixture(db, "browser-workflow");
  await mkdir("data/uploads", { recursive: true });
  await writeFile(
    path.join("data/uploads", fixture.document.fileName),
    fixturePng,
  );
  await page.setViewportSize({ width: 1600, height: 2200 });
  await login(page);
  await page.goto(`/billing/${fixture.period.id}`);
  for (const name of [
    "Heizkosten",
    "Haushaltsstrom",
    "Wasserversorgung",
    "Müllentsorgung",
    "Kleinkläranlage",
    "Grundsteuer",
  ])
    await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
  const water = page.getByRole("region", {
    name: "Wasserversorgung",
    exact: true,
  });
  await water
    .getByRole("button", { name: "Rechnung erfassen", exact: true })
    .click();
  const review = water
    .locator("details")
    .filter({ hasText: "Neue Rechnung" })
    .last();
  const invoicePage = await context.newPage();
  const items = [
    ["supplier", "Wasserwerk Muster", 80, 80],
    ["invoiceDate", "31.12.2026", 400, 200],
    ["servicePeriodStart", "01.10.2026", 400, 260],
    ["servicePeriodEnd", "31.12.2026", 400, 320],
    ["totalAmountCents", "390,00 €", 400, 400],
    ["netAmountCents", "327,73 €", 400, 460],
    ["vatAmountCents", "62,27 €", 400, 520],
    ["vatRate", "19 %", 400, 580],
  ];
  await invoicePage.setViewportSize({ width: 800, height: 1000 });
  await invoicePage.setContent(
    `<body style="margin:0;width:800px;height:1000px;background:white;font:20px Arial">${items.map(([key, text, x, y]) => `<span data-field="${key}" style="position:absolute;left:${x}px;top:${y}px">${text}</span>`).join("")}</body>`,
  );
  const words = await invoicePage
    .locator("[data-field]")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          field: element.getAttribute("data-field")!,
          text: element.textContent!,
          confidence: 0.99,
          region: {
            x: box.x / 800,
            y: box.y / 1000,
            width: box.width / 800,
            height: box.height / 1000,
          },
        };
      }),
    );
  const png = await invoicePage.screenshot();
  await invoicePage.close();
  await review.locator("input[type=file]").setInputFiles({
    name: "water-invoice.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    review.getByRole("link", { name: "water-invoice.png", exact: true }),
  ).toBeVisible();
  await review.getByRole("button", { name: "Google OCR starten" }).click();
  const invoice = await db.costInvoice.findFirstOrThrow({
    where: {
      billingPeriodId: fixture.period.id,
      costCategoryId: fixture.categories.WATER,
    },
  });
  await expect
    .poll(() =>
      db.invoiceExtractionJob.count({ where: { invoiceId: invoice.id } }),
    )
    .toBe(1);
  const ocr: OcrDocument = {
    text: words.map((word) => word.text).join("\n"),
    pages: [
      {
        page: 1,
        words: words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          region: word.region,
        })),
      },
    ],
  };
  // A captured OCR response keeps this browser test deterministic. The actual
  // durable worker processes the subsequent template job using this stored OCR.
  await db.invoiceExtractionJob.updateMany({
    where: { invoiceId: invoice.id },
    data: {
      status: "REVIEW_REQUIRED",
      ocrJson: JSON.stringify(ocr),
      resultJson: JSON.stringify({
        fields: {},
        lines: [],
        errors: ["Vorlage erforderlich"],
      }),
    },
  });
  await water.getByText("Rechnungsvorlagen", { exact: true }).click();
  await expect(
    water.getByRole("button", { name: "Vorlage aus Musterbeleg erstellen" }),
  ).toBeEnabled();
  await water
    .getByRole("button", { name: "Vorlage aus Musterbeleg erstellen" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Rechnungsvorlage bearbeiten",
  });
  await dialog
    .getByLabel("Vorlagenname", { exact: true })
    .fill("Wasserwerk Layout A");
  await dialog
    .getByLabel("Lieferant", { exact: true })
    .fill("Wasserwerk Muster");
  await dialog.getByLabel(/Erkennungsmerkmale/).fill("Wasserwerk Muster");
  const expected: Record<string, string> = {
    invoiceDate: "2026-12-31",
    servicePeriodStart: "2026-10-01",
    servicePeriodEnd: "2026-12-31",
    totalAmountCents: "39000",
    netAmountCents: "32773",
    vatAmountCents: "6227",
    vatRate: "19",
  };
  for (const [field, value] of Object.entries(expected)) {
    await dialog
      .getByRole("combobox", { name: "Feld", exact: true })
      .selectOption(field);
    await dialog
      .getByRole("combobox", { name: "Format", exact: true })
      .selectOption(
        field.endsWith("Cents")
          ? "CENTS"
          : field === "vatRate"
            ? "PERCENT"
            : "DATE",
      );
    const image = dialog.getByRole("img", { name: "Rechnungsbeleg" });
    await expect(image).toBeVisible();
    const box = (await image.boundingBox())!;
    const region = words.find((word) => word.field === field)!.region;
    await page.mouse.move(
      box.x + (region.x - 0.008) * box.width,
      box.y + (region.y - 0.008) * box.height,
    );
    await page.mouse.down();
    await page.mouse.move(
      box.x + (region.x + region.width + 0.008) * box.width,
      box.y + (region.y + region.height + 0.008) * box.height,
    );
    await page.mouse.up();
    await dialog
      .getByRole("button", { name: "Auswahl als Regel übernehmen" })
      .click();
    await dialog
      .getByLabel(/Erwarteter Testwert/)
      .last()
      .fill(value);
  }
  await dialog
    .getByRole("button", { name: "Entwurf speichern", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Vorlage testen" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Vorlage testen" }).click();
  await expect(
    dialog.getByRole("button", { name: "Veröffentlichen", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Veröffentlichen", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const template = await db.invoiceTemplate.findFirstOrThrow({
    where: { name: "Wasserwerk Layout A", status: "PUBLISHED" },
  });
  await water
    .getByLabel("Vorlage auswählen", { exact: true })
    .selectOption(template.id);
  await water
    .getByRole("button", { name: "Entwürfe mit Vorlage neu extrahieren" })
    .click();
  const worker = spawn(process.execPath, ["dist/invoice-worker.cjs"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
  });
  try {
    await expect
      .poll(
        async () =>
          (
            await db.invoiceExtractionJob.findFirst({
              where: { invoiceId: invoice.id },
              orderBy: { createdAt: "desc" },
            })
          )?.status,
      )
      .toBe("REVIEW_REQUIRED");
    await expect(
      review.getByRole("button", { name: "Vorschläge in Formular übernehmen" }),
    ).toBeEnabled();
    await expect(
      review.getByText("Bruttobetrag (€): 390", { exact: true }),
    ).toBeVisible();
    await review
      .getByRole("button", { name: "Vorschläge in Formular übernehmen" })
      .click();
    await expect(
      review.getByLabel("Bruttobetrag (€)", { exact: true }),
    ).toHaveValue("390");
    await review
      .getByLabel("Lieferant", { exact: true })
      .fill("Wasserwerk Muster");
    await review
      .getByLabel("Rechnungsnummer", { exact: true })
      .fill("WATER-E2E-1");
    await review
      .getByRole("button", { name: "Geprüfte Rechnung bestätigen" })
      .click();
    await expect(
      water.locator("summary").filter({ hasText: "CONFIRMED" }),
    ).toBeVisible();
  } finally {
    worker.kill("SIGTERM");
  }
  const heating = page.getByRole("region", { name: "Heizkosten", exact: true });
  await heating.getByLabel("Rechnungsabschnitt").selectOption("WARTUNG");
  await createAndConfirm(page, heating, "119.00", {
    "Nettobetrag (€)": "100.00",
    "Umsatzsteuer (€)": "19.00",
    "Umsatzsteuer (%)": "19",
  });
  await createAndConfirm(
    page,
    page.getByRole("region", { name: "Müllentsorgung", exact: true }),
    "300.00",
  );
  await createAndConfirm(
    page,
    page.getByRole("region", { name: "Kleinkläranlage", exact: true }),
    "300.00",
  );
  await createAndConfirm(
    page,
    page.getByRole("region", { name: "Grundsteuer", exact: true }),
    "1200.00",
    {
      "Wohnanteil der beiden Mietwohnungen (€)": "280.00",
      "Belegte Berechnung des Wohnanteils":
        "Nur 80+200 m², Grundstück/Garten/Garage/Vermieterflächen abgezogen",
    },
  );
  const electricity = page.getByRole("region", {
    name: "Haushaltsstrom",
    exact: true,
  });
  await electricity
    .getByLabel("Rechnungsabschnitt")
    .selectOption("JAHRESRECHNUNG");
  await createAndConfirm(page, electricity, "859.20", {
    Zählernummer: "35863079/32983031",
    "Verbrauch laut Rechnung (kWh)": "3000",
    "Arbeitspreis (€/kWh)": "0.2764",
  });
  for (const name of [
    "Heizkosten",
    "Haushaltsstrom",
    "Wasserversorgung",
    "Müllentsorgung",
    "Kleinkläranlage",
    "Grundsteuer",
  ]) {
    const card = page.getByRole("region", { name, exact: true });
    await card.getByRole("button", { name: "Vorschau berechnen" }).click();
    await expect(
      card.getByRole("button", { name: "Unveränderlich übernehmen" }),
    ).toBeEnabled();
    await card
      .getByRole("button", { name: "Unveränderlich übernehmen" })
      .click();
    await expect(
      page.getByRole("status").filter({
        hasText: "Berechnung als unveränderliche Revision übernommen",
      }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Abrechnung ausstellen", exact: true })
    .click();
  await expect(page.getByText(/Abrechnung ausgestellt/)).toBeVisible();
  const before = await page.request.get(
    `/api/billing-periods/${fixture.period.id}/pdf?tenantId=${fixture.tenants[0].id}`,
  );
  expect(before.ok()).toBe(true);
  expect(before.headers()["content-type"]).toContain("application/pdf");
  const bytes = await before.body();
  await db.tenant.update({
    where: { id: fixture.tenants[0].id },
    data: { firstName: "Später geändert" },
  });
  const after = await page.request.get(
    `/api/billing-periods/${fixture.period.id}/pdf?tenantId=${fixture.tenants[0].id}`,
  );
  expect(await after.body()).toEqual(bytes);
  await expect(
    water.getByRole("button", { name: "Rechnung erfassen", exact: true }),
  ).not.toBeVisible();
});

test.afterAll(async () => {
  await db.$disconnect();
});
