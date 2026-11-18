import { expect, test } from "@playwright/test";

test("start page renders the app title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Familien-Einkaufshelfer");
  await expect(
    page.getByRole("heading", { level: 1, name: "Familien-Einkaufshelfer" }),
  ).toBeVisible();
});
