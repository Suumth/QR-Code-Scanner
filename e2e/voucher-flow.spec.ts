import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { strFromU8, unzipSync } from "fflate";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4173";
const E2E_ADMIN_PASSWORD = "rt22-e2e-only-password";
const EVENT = {
  name: "RT22 E2E Sommerfest",
  date: "2099-09-12",
  pin: "246810",
};
const SPONSOR_NAME = "Heidelberger Eventpartner";
const EVIDENCE_DIRECTORY =
  process.env.RT22_CAPTURE_EVIDENCE === "1"
    ? resolve("docs/evidence/v2")
    : null;

test("completes the V2 voucher lifecycle across isolated devices and fails closed on a lost redeem response", async ({
  browser,
}) => {
  const contexts: BrowserContext[] = [];
  const consoleFailures: string[] = [];
  let exportedFirstCode = "";
  let exportedFirstPublicId = "";

  try {
    const adminContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(adminContext);
    await adminContext.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: BASE_URL,
    });
    const admin = await adminContext.newPage();
    recordRuntimeFailures(admin, "admin", consoleFailures);

    await test.step("admin creates the event, sponsor and vouchers and recovers the private link", async () => {
      await admin.goto("/admin");
      await expect(admin).toHaveTitle("Event Voucher QR");
      await expect(
        admin.getByRole("heading", { name: "Administration" }),
      ).toBeVisible();

      await admin.getByLabel("Admin-Passwort").fill(E2E_ADMIN_PASSWORD);
      await admin.getByRole("button", { name: "Anmelden" }).click();
      await expect(
        admin.getByRole("heading", { name: "Noch kein Event" }),
      ).toBeVisible();

      await admin.getByLabel("Eventname").fill(EVENT.name);
      await admin.getByLabel("Eventdatum").fill(EVENT.date);
      await admin.getByLabel("Sechsstellige Team-PIN").fill(EVENT.pin);
      await admin.getByRole("button", { name: "Event erstellen" }).click();
      await expect(admin.getByText("Event wurde erstellt.")).toBeVisible();
      await expect(
        admin.getByRole("heading", { name: EVENT.name }),
      ).toBeVisible();

      await admin.getByLabel("Sponsorname").fill(SPONSOR_NAME);
      await admin.getByRole("button", { name: "Sponsor hinzufügen" }).click();
      await expect(admin.getByText("Sponsor wurde angelegt.")).toBeVisible();

      await admin.getByRole("button", { name: "Gutscheinart hinzufügen" }).click();
      await admin
        .getByLabel(`Neue Gutscheinart für ${SPONSOR_NAME}`)
        .fill("1 Bier");
      await admin.getByRole("button", { name: "Gutscheinart anlegen" }).click();
      await expect(admin.getByText("Gutscheinart wurde angelegt.")).toBeVisible();

      await admin.getByRole("button", { name: "Gutscheinart hinzufügen" }).click();
      await admin
        .getByLabel(`Neue Gutscheinart für ${SPONSOR_NAME}`)
        .fill("1 Essen");
      await admin.getByRole("button", { name: "Gutscheinart anlegen" }).click();
      await expect(admin.getByText("Gutscheinart wurde angelegt.")).toBeVisible();

      await admin
        .getByRole("button", { name: `Gutscheine für ${SPONSOR_NAME} – 1 Bier erstellen` })
        .click();
      await admin
        .getByLabel(`Anzahl Gutscheine für ${SPONSOR_NAME} – 1 Bier`)
        .fill("3");
      await admin
        .getByRole("button", { name: "3 Gutscheine für 1 Bier erstellen" })
        .click();
      await expect(admin.getByText("3 Gutscheine wurden erstellt.")).toBeVisible();

      await admin
        .getByRole("button", { name: `Gutscheine für ${SPONSOR_NAME} – 1 Essen erstellen` })
        .click();
      await admin
        .getByLabel(`Anzahl Gutscheine für ${SPONSOR_NAME} – 1 Essen`)
        .fill("2");
      await admin
        .getByRole("button", { name: "2 Gutscheine für 1 Essen erstellen" })
        .click();
      await expect(admin.getByText("2 Gutscheine wurden erstellt.")).toBeVisible();

      const summary = admin.getByLabel("Gutschein-Übersicht");
      await expect(summary).toContainText("5Ausgegeben");
      await expect(summary).toContainText("5Verfügbar");
      await expect(summary).toContainText("0Eingelöst");
      await expect(admin.getByText("3 ausgegeben · 3 verfügbar · 0 eingelöst")).toBeVisible();
      await expect(admin.getByText("2 ausgegeben · 2 verfügbar · 0 eingelöst")).toBeVisible();
      await expectMinimumTarget(
        admin.getByRole("button", { name: "CSV exportieren" }),
        44,
      );
      await assertNoHorizontalOverflow(admin);
      await assertKeyboardFocusVisible(admin);
      await captureEvidence(admin, "01-admin-populated.png", true);

      // A sponsor URL must remain recoverable from persisted state, not only
      // from the create response held by the current React render.
      await admin.reload();
      await expect(
        admin.getByRole("heading", { name: EVENT.name }),
      ).toBeVisible();
      await expect(admin.getByText(SPONSOR_NAME, { exact: true })).toBeVisible();
      await expect(admin.getByLabel("Gutschein-Übersicht")).toContainText(
        "5Ausgegeben",
      );

      const [download] = await Promise.all([
        admin.waitForEvent("download"),
        admin
          .getByRole("button", { name: "QR-Paket herunterladen (1 Bier, 3)" })
          .click(),
      ]);
      expect(download.suggestedFilename()).toBe(
        "Vouchers-Heidelberger-Eventpartner-1-Bier-Gutscheine.zip",
      );
      const downloadPath = await download.path();
      expect(downloadPath).toBeTruthy();
      const entries = unzipSync(new Uint8Array(readFileSync(downloadPath ?? "")));
      const svgEntries = Object.keys(entries).filter((entry) => entry.startsWith("qr/"));
      expect(svgEntries).toHaveLength(3);
      expect(new Set(svgEntries).size).toBe(3);
      expect(Object.keys(entries).sort()).toEqual([
        "manifest.csv",
        ...svgEntries.sort(),
      ]);
      const manifest = strFromU8(entries["manifest.csv"]);
      expect(manifest.split("\r\n")).toHaveLength(5);
      expect(manifest).toContain("file_name,sponsor,voucher_type,manual_code,status");
      expect(manifest).toContain('"1 Bier"');
      const exportedVouchers = svgEntries.map((entry) => {
        const svg = strFromU8(entries[entry]);
        const payload = svg.match(/data-qr-payload="([^"]+)"/)?.[1];
        expect(payload).toMatch(/^http:\/\/127\.0\.0\.1:4173\/v\/[A-Za-z0-9_-]+$/);
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
        return { fileName: entry.replace("qr/", ""), payload: payload ?? "" };
      });
      expect(new Set(exportedVouchers.map((voucher) => voucher.payload)).size).toBe(3);
      expect(exportedVouchers.every((voucher) => manifest.includes(voucher.fileName))).toBe(true);
      exportedFirstCode = exportedVouchers[0]?.fileName.replace(/\.svg$/, "") ?? "";
      exportedFirstPublicId = new URL(exportedVouchers[0]?.payload ?? "invalid").pathname
        .split("/")
        .at(-1) ?? "";
    });

    const sponsorLinkField = admin.getByLabel(
      `Sponsor-Link für ${SPONSOR_NAME}`,
    );
    const sponsorUrl = await sponsorLinkField.inputValue();
    expect(sponsorUrl).toMatch(/^http:\/\/127\.0\.0\.1:4173\/s\/[A-Za-z0-9_-]{32}$/);

    await admin
      .getByRole("button", { name: `Link für ${SPONSOR_NAME} kopieren` })
      .click();
    await expect(admin.getByText("Sponsor-Link wurde kopiert.")).toBeVisible();
    await expect
      .poll(() => admin.evaluate(() => navigator.clipboard.readText()))
      .toBe(sponsorUrl);

    const teamUrl = await admin
      .getByRole("link", { name: "Team-Anmeldung öffnen" })
      .getAttribute("href");
    expect(teamUrl).toMatch(/^\/team\/[A-Za-z0-9_-]+$/);

    const sponsorContext = await browser.newContext({
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
    });
    contexts.push(sponsorContext);
    const sponsor = await sponsorContext.newPage();
    recordRuntimeFailures(sponsor, "sponsor", consoleFailures);

    let firstCode = "";
    let firstPublicId = "";
    await test.step("the one sponsor link shows one read-only voucher at a time", async () => {
      await sponsor.goto(sponsorUrl);
      await expect(
        sponsor.getByRole("heading", { name: EVENT.name }),
      ).toBeVisible();
      await expect(
        sponsor.getByRole("heading", { name: SPONSOR_NAME }),
      ).toBeVisible();
      await expect(sponsor.getByLabel("5 Gutscheine insgesamt")).toBeVisible();
      await expect(sponsor.getByLabel("5 Gutscheine verfügbar")).toBeVisible();
      await expect(sponsor.getByLabel("0 Gutscheine eingelöst")).toBeVisible();
      await expect(sponsor.getByRole("heading", { name: "1 Bier" })).toBeVisible();
      await expect(sponsor.getByRole("heading", { name: "1 Essen" })).toBeVisible();
      await expectNoRedeemControl(sponsor);
      await expectMinimumTarget(
        sponsor.getByRole("button", {
          name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)",
        }),
        52,
      );
      await expectMinimumTarget(
        sponsor.getByRole("button", {
          name: "Nächsten verfügbaren Gutschein anzeigen (1 Essen)",
        }),
        52,
      );
      await assertNoHorizontalOverflow(sponsor);
      await assertKeyboardFocusVisible(sponsor);
      await captureEvidence(sponsor, "02-sponsor-overview-mobile.png", true);

      await sponsor
        .getByRole("button", {
          name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)",
        })
        .click();
      const qr = sponsor.locator('[role="img"][data-qr-payload]');
      await expect(qr).toBeVisible();
      const qrPayload = await qr.getAttribute("data-qr-payload");
      expect(qrPayload).toMatch(/^http:\/\/127\.0\.0\.1:4173\/v\/[A-Za-z0-9_-]{22}$/);
      firstPublicId = new URL(qrPayload ?? "invalid").pathname.split("/").at(-1) ?? "";
      firstCode = (await sponsor.locator(".voucher-code").innerText()).trim();
      expect(firstCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
      await expect(sponsor.getByText("Verfügbar", { exact: true })).toBeVisible();
      await expect(sponsor.getByText("1 Bier", { exact: true })).toBeVisible();
      await expect(sponsor.getByRole("heading", { name: "1 Bier" })).toBeVisible();
      await expect(sponsor.getByText("1 Getränk", { exact: true })).toHaveCount(0);
      await expectNoRedeemControl(sponsor);
      await assertVisibleControlsNotClipped(sponsor);
      await captureEvidence(sponsor, "03-sponsor-voucher-mobile.png", true);

      firstCode = exportedFirstCode;
      firstPublicId = exportedFirstPublicId;

      const publicVoucher = await sponsorContext.newPage();
      recordRuntimeFailures(publicVoucher, "public-voucher", consoleFailures);
      await publicVoucher.goto(`/v/${firstPublicId}`);
      await expect(
        publicVoucher.getByText("Nur das Event-Team kann Gutscheine einlösen."),
      ).toBeVisible();
      await expect(publicVoucher.getByText(firstCode, { exact: true })).toBeVisible();
      await expect(
        publicVoucher.getByRole("img", { name: "Gutschein QR-Code" }),
      ).toHaveCount(0);
      await expectNoRedeemControl(publicVoucher);
      await publicVoucher.close();
    });

    const firstTeamContext = await createDeniedCameraContext(browser, {
      width: 390,
      height: 844,
      reducedMotion: "reduce",
    });
    contexts.push(firstTeamContext);
    const firstTeam = await firstTeamContext.newPage();
    recordRuntimeFailures(firstTeam, "team-anna", consoleFailures);

    await test.step("camera denial keeps the scanner usable and both QR/manual inspections stay read-only", async () => {
      await firstTeam.goto("/");
      await expect(
        firstTeam.getByRole("heading", { name: "Team anmelden" }),
      ).toBeVisible();
      await expect(firstTeam.getByText(EVENT.name, { exact: true })).toBeVisible();
      await captureEvidence(firstTeam, "04-team-home-login.png", true);
      await firstTeam.getByLabel("Dein Name").fill("Anna E2E");
      await firstTeam.getByLabel("Event-PIN").fill(EVENT.pin);
      await firstTeam.getByRole("button", { name: "Anmelden" }).click();

      const cameraHeading = firstTeam.getByRole("heading", {
        name: "Kamera nicht verfügbar",
      });
      await expect(cameraHeading).toBeVisible();
      await expect(firstTeam.getByText("Kamerazugriff wurde nicht erlaubt.")).toBeVisible();
      await expect(cameraHeading).toBeFocused();
      await expect(firstTeam.getByLabel("Gutscheincode")).toBeVisible();
      await assertReducedMotion(firstTeam);
      await assertNoHorizontalOverflow(firstTeam);
      await assertKeyboardFocusVisible(firstTeam);
      await captureEvidence(firstTeam, "04-scanner-camera-manual.png", true);

      const qrInspection = await firstTeam.evaluate(async (publicId) => {
        const response = await fetch("/api/team/vouchers/inspect", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicId }),
        });
        return { status: response.status, body: await response.json() };
      }, firstPublicId);
      expect(qrInspection.status).toBe(200);
      expect(qrInspection.body).toMatchObject({
        status: "available",
        voucher: {
          publicId: firstPublicId,
          displayCode: firstCode,
          voucherType: { name: "1 Bier" },
        },
      });

      await firstTeam.getByLabel("Gutscheincode").fill(firstCode);
      await expectMinimumTarget(
        firstTeam.getByRole("button", { name: "Code prüfen" }),
        52,
      );
      await firstTeam.getByRole("button", { name: "Code prüfen" }).click();

      const validHeading = firstTeam.getByRole("heading", {
        name: "Gutschein gültig",
      });
      await expect(validHeading).toBeVisible();
      await expect(validHeading).toBeFocused();
      await expect(firstTeam.getByText(SPONSOR_NAME, { exact: true })).toBeVisible();
      await expect(firstTeam.getByText("1 Bier", { exact: true })).toBeVisible();
      await expect(firstTeam.getByText("1 Getränk", { exact: true })).toHaveCount(0);
      await expectMinimumTarget(
        firstTeam.getByRole("button", { name: "Jetzt einlösen" }),
        52,
      );

      await sponsor.reload();
      await sponsor
        .getByRole("button", {
          name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)",
        })
        .click();
      await expect(sponsor.locator(".voucher-code")).toHaveText(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
      );
      await expect(sponsor.getByText("Verfügbar", { exact: true })).toBeVisible();
      await captureEvidence(firstTeam, "05-scanner-valid-confirm.png", true);
    });

    await test.step("only explicit confirmation redeems and the scanner returns to the next voucher", async () => {
      await firstTeam.getByRole("button", { name: "Jetzt einlösen" }).click();
      await expect(
        firstTeam.getByRole("heading", { name: "Eingelöst" }),
      ).toBeVisible();
      await expect(
        firstTeam.getByText(`1 Bier · ${SPONSOR_NAME}`),
      ).toBeVisible();
      await expect(firstTeam.getByText("1 Getränk", { exact: true })).toHaveCount(0);
      await expect(firstTeam.getByText("Heute eingelöst: 1")).toBeVisible();
      await captureEvidence(firstTeam, "06-scanner-success.png", true);
    });

    const secondTeamContext = await createDeniedCameraContext(browser, {
      width: 390,
      height: 844,
    });
    contexts.push(secondTeamContext);
    const secondTeam = await secondTeamContext.newPage();
    recordRuntimeFailures(secondTeam, "team-ben", consoleFailures);

    await test.step("a concurrent independent team session sees the same voucher as already redeemed", async () => {
      await secondTeam.goto(teamUrl ?? "/team/missing");
      await secondTeam.getByLabel("Dein Name").fill("Ben E2E");
      await secondTeam.getByLabel("Event-PIN").fill(EVENT.pin);
      await secondTeam.getByRole("button", { name: "Anmelden" }).click();
      await expect(
        secondTeam.getByRole("heading", { name: "Kamera nicht verfügbar" }),
      ).toBeVisible();
      await secondTeam.getByLabel("Gutscheincode").fill(firstCode);
      await secondTeam.getByRole("button", { name: "Code prüfen" }).click();
      await expect(
        secondTeam.getByRole("heading", { name: "Bereits eingelöst" }),
      ).toBeVisible();
      await expect(
        secondTeam.getByText(`1 Bier · ${firstCode} · ${SPONSOR_NAME}`),
      ).toBeVisible();
      await expect(secondTeam.getByText("1 Getränk", { exact: true })).toHaveCount(0);
      await expect(secondTeam.getByText(firstCode, { exact: false })).toBeVisible();
      await captureEvidence(secondTeam, "07-scanner-already-redeemed.png", true);

      await secondTeam
        .getByRole("button", { name: "Nächster Gutschein" })
        .click();
      await expect(
        secondTeam.getByRole("heading", { name: "Kamera nicht verfügbar" }),
      ).toBeVisible();
      await secondTeam.getByLabel("Gutscheincode").fill("ZZZZ-ZZZZ");
      await secondTeam.getByRole("button", { name: "Code prüfen" }).click();
      await expect(
        secondTeam.getByRole("heading", { name: "Gutschein ungültig" }),
      ).toBeVisible();
      await expect(
        secondTeam.getByText("gehört nicht zu diesem Event"),
      ).toBeVisible();
    });

    await sponsor.reload();
    await sponsor
      .getByRole("button", {
        name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)",
      })
      .click();
    const secondCode = (await sponsor.locator(".voucher-code").innerText()).trim();
    expect(secondCode).not.toBe(firstCode);

    await test.step("a server-committed redeem whose response is lost never renders success and recovery only re-inspects", async () => {
      await firstTeam.getByRole("button", { name: "Nächster Gutschein" }).click();
      await expect(
        firstTeam.getByRole("heading", { name: "Kamera nicht verfügbar" }),
      ).toBeVisible();
      await firstTeam.getByLabel("Gutscheincode").fill(secondCode);
      await firstTeam.getByRole("button", { name: "Code prüfen" }).click();
      await expect(
        firstTeam.getByRole("heading", { name: "Gutschein gültig" }),
      ).toBeVisible();

      let redeemRequests = 0;
      let inspectRequests = 0;
      firstTeam.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/team/vouchers/redeem") {
          redeemRequests += 1;
        }
        if (pathname === "/api/team/vouchers/inspect") {
          inspectRequests += 1;
        }
      });
      await firstTeam.route("**/api/team/vouchers/redeem", async (route) => {
        const committedResponse = await route.fetch();
        expect(committedResponse.status()).toBe(200);
        await expect(committedResponse.json()).resolves.toMatchObject({
          status: "redeemed",
          voucher: { displayCode: secondCode },
        });
        await route.abort("failed");
      });

      await firstTeam.getByRole("button", { name: "Jetzt einlösen" }).click();
      await expect(
        firstTeam.getByRole("heading", { name: "Verbindung unterbrochen" }),
      ).toBeVisible();
      await expect(firstTeam.getByText(`1 Bier · ${SPONSOR_NAME}`)).toBeVisible();
      await expect(firstTeam.getByText(secondCode, { exact: true })).toBeVisible();
      await expect(firstTeam.getByText("1 Getränk", { exact: true })).toHaveCount(0);
      await expect(
        firstTeam.getByText("Es wird kein Erfolg angezeigt."),
      ).toBeVisible();
      await expect(
        firstTeam.getByRole("heading", { name: "Eingelöst" }),
      ).toHaveCount(0);
      expect(redeemRequests).toBe(1);
      await captureEvidence(firstTeam, "08-scanner-network-fail-closed.png", true);

      await firstTeam.unroute("**/api/team/vouchers/redeem");
      const inspectionsBeforeRecovery = inspectRequests;
      await firstTeam
        .getByRole("button", { name: "Status erneut prüfen" })
        .click();
      await expect(
        firstTeam.getByRole("heading", { name: "Bereits eingelöst" }),
      ).toBeVisible();
      expect(redeemRequests).toBe(1);
      expect(inspectRequests).toBe(inspectionsBeforeRecovery + 1);
    });

    await test.step("desktop, iPhone and 768px layouts remain unclipped with semantic status and focus", async () => {
      await firstTeam.setViewportSize({ width: 768, height: 1024 });
      await assertNoHorizontalOverflow(firstTeam);
      await assertVisibleControlsNotClipped(firstTeam);

      await admin.setViewportSize({ width: 768, height: 1024 });
      await assertNoHorizontalOverflow(admin);
      await admin.getByRole("heading", { name: "Sponsoren" }).scrollIntoViewIfNeeded();
      await assertVisibleControlsNotClipped(admin);

      await sponsor.setViewportSize({ width: 390, height: 844 });
      await assertNoHorizontalOverflow(sponsor);
      await assertVisibleControlsNotClipped(sponsor);
      await expect(sponsor.getByText(/Verfügbar|Bereits eingelöst/)).toBeVisible();
    });

    expect(consoleFailures).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function createDeniedCameraContext(
  browser: Browser,
  options: {
    width: number;
    height: number;
    reducedMotion?: "reduce";
  },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: options.width, height: options.height },
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await context.addInitScript(() => {
    const rejectedCamera = () =>
      Promise.reject(new DOMException("Camera permission denied for E2E", "NotAllowedError"));
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: rejectedCamera,
      });
    } else {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: rejectedCamera },
      });
    }
  });
  return context;
}

function recordRuntimeFailures(
  page: Page,
  label: string,
  failures: string[],
): void {
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      if (message.text().startsWith("Failed to load resource:")) {
        return;
      }
      failures.push(`${label} console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    failures.push(`${label} pageerror: ${error.message}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(
        `${label} response ${response.status()}: ${new URL(response.url()).pathname}`,
      );
    }
  });
}

async function expectNoRedeemControl(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: /Jetzt einlösen|Einlösen|Redeem/i }),
  ).toHaveCount(0);
}

async function expectMinimumTarget(locator: Locator, minimum: number): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "critical action must have a measurable box").not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.bodyScroll).toBeLessThanOrEqual(widths.bodyClient);
}

async function assertVisibleControlsNotClipped(page: Page): Promise<void> {
  const clipped = await page
    .locator("button:visible, a:visible, input:visible")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const rectangle = element.getBoundingClientRect();
        const intersectsVertically = rectangle.bottom > 0 && rectangle.top < window.innerHeight;
        if (!intersectsVertically) {
          return [];
        }
        return rectangle.left < -0.5 || rectangle.right > window.innerWidth + 0.5
          ? [
              `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""}] ${rectangle.left}..${rectangle.right}`,
            ]
          : [];
      }),
    );
  expect(clipped).toEqual([]);
}

async function assertKeyboardFocusVisible(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) {
      return null;
    }
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focus?.tag).toMatch(/A|BUTTON|INPUT/);
  expect(focus?.outlineStyle).not.toBe("none");
  expect(focus?.outlineWidth ?? 0).toBeGreaterThanOrEqual(3);
}

async function assertReducedMotion(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const element = document.querySelector(".scanner-camera-off-icon");
    const style = element ? getComputedStyle(element) : null;
    return {
      preference: matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationDuration: style?.animationDuration ?? "",
      animationIterationCount: style?.animationIterationCount ?? "",
    };
  });
  expect(result.preference).toBe(true);
  expect(result.animationDuration).toMatch(/^(0\.01ms|0\.00001s|1e-05s)$/);
  expect(result.animationIterationCount).toBe("1");
}

async function captureEvidence(
  page: Page,
  filename: string,
  fullPage: boolean,
): Promise<void> {
  if (!EVIDENCE_DIRECTORY) {
    return;
  }
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  await page.screenshot({
    path: resolve(EVIDENCE_DIRECTORY, filename),
    fullPage,
    animations: "disabled",
  });
}
