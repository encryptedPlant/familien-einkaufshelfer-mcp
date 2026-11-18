import { describe, expect, test } from "vitest";
import { normalize, normalizeDmUrl } from "../../src/core/normalize";

describe("normalize (SPEC §4.1)", () => {
  test("ignores case and surrounding / repeated whitespace", () => {
    expect(normalize("  Die üblichen  FEUCHTTÜCHER ")).toBe(
      "die üblichen feuchttücher",
    );
  });

  test("collapses tabs, line breaks and non-breaking spaces to one space", () => {
    expect(normalize("Spül\t\tmittel\n Zitrone\u00a0 extra")).toBe(
      "spül mittel zitrone extra",
    );
  });

  test("applies Unicode NFC so decomposed umlauts equal composed ones", () => {
    const decomposed = "Zahnpflege fu\u0308r Kinder";
    const composed = "Zahnpflege f\u00fcr Kinder";
    expect(normalize(decomposed)).toBe(normalize(composed));
  });

  test("does no other folding: no ä/ae, ß/ss or plural handling", () => {
    expect(normalize("Äpfel")).not.toBe(normalize("Aepfel"));
    expect(normalize("Straße")).not.toBe(normalize("Strasse"));
    expect(normalize("Feuchttuch")).not.toBe(normalize("Feuchttücher"));
  });
});

describe("normalizeDmUrl (SPEC §4.2)", () => {
  const canonical = "https://www.dm.de/beispiel-zahnpasta-p100002.html";

  test.each([
    ["already normalised", canonical],
    [
      "query string",
      "https://www.dm.de/beispiel-zahnpasta-p100002.html?utm_source=x&ref=y",
    ],
    [
      "fragment",
      "https://www.dm.de/beispiel-zahnpasta-p100002.html#bewertungen",
    ],
    ["trailing slash", "https://www.dm.de/beispiel-zahnpasta-p100002.html/"],
    ["host case", "https://WWW.DM.DE/beispiel-zahnpasta-p100002.html"],
    ["bare dm.de host", "https://dm.de/beispiel-zahnpasta-p100002.html"],
    [
      "surrounding whitespace",
      "  https://www.dm.de/beispiel-zahnpasta-p100002.html  ",
    ],
    ["http scheme", "http://www.dm.de/beispiel-zahnpasta-p100002.html"],
  ])(
    "AC-A5 (normalisation part): %s yields the canonical URL",
    (_label, raw) => {
      expect(normalizeDmUrl(raw)).toBe(canonical);
    },
  );

  test("keeps the path as is, including its case", () => {
    expect(
      normalizeDmUrl("https://www.dm.de/Beispiel-Zahnpasta-P100002.html"),
    ).toBe("https://www.dm.de/Beispiel-Zahnpasta-P100002.html");
  });

  test.each([
    ["other host", "https://www.example.com/beispiel-zahnpasta-p100002.html"],
    ["dm subdomain", "https://shop.dm.de/beispiel-zahnpasta-p100002.html"],
    [
      "look-alike host",
      "https://dm.de.example.com/beispiel-zahnpasta-p100002.html",
    ],
    ["other dm country", "https://www.dm.at/beispiel-zahnpasta-p100002.html"],
    ["non-http scheme", "ftp://www.dm.de/beispiel-zahnpasta-p100002.html"],
    ["explicit port", "https://www.dm.de:8443/beispiel-zahnpasta-p100002.html"],
    [
      "credentials",
      "https://user:secret@www.dm.de/beispiel-zahnpasta-p100002.html",
    ],
    ["no scheme", "www.dm.de/beispiel-zahnpasta-p100002.html"],
    ["not a URL", "Zahnpasta"],
    ["empty", "   "],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeDmUrl(raw)).toBeUndefined();
  });

  test.each([
    "https://www.dm.de",
    "https://www.dm.de/",
    "https://www.dm.de/?utm_source=x",
    "https://www.dm.de/#angebote",
    "https://www.dm.de?utm_source=x#angebote",
    "https://dm.de",
    "https://WWW.DM.DE//",
    "http://dm.de/?ref=y",
  ])("rejects the dm start page as product URL: %s", (raw) => {
    expect(normalizeDmUrl(raw)).toBeUndefined();
  });

  test("still accepts a product URL whose query or fragment is removed", () => {
    expect(
      normalizeDmUrl("https://dm.de/beispiel-zahnpasta-p100002.html/?x=1#y"),
    ).toBe(canonical);
  });
});
