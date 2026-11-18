// A valid, fictional store document for storage tests.

import type { StoreFile } from "../../src/core/types";
import { dishSoap, toothpasteMint, wetWipes } from "./favorites";

export const ENTRY_OPEN = "e0000000-0000-4000-8000-000000000001";
export const ENTRY_BOUGHT = "e0000000-0000-4000-8000-000000000002";

export function validStore(): StoreFile {
  return {
    version: 1,
    favorites: structuredClone([wetWipes, toothpasteMint, dishSoap]),
    list: [
      {
        id: ENTRY_OPEN,
        product: {
          name: wetWipes.name,
          category: wetWipes.category,
          dmArticleNumber: "100001",
          dmUrl:
            "https://www.dm.de/beispiel-feuchttuecher-sensitiv-p100001.html",
        },
        favoriteId: wetWipes.id,
        quantity: 2,
        status: "open",
        addedAt: "2026-02-01T10:00:00.000Z",
      },
      {
        id: ENTRY_BOUGHT,
        product: { name: "Zahnseide mint", dmArticleNumber: "100007" },
        quantity: 1,
        status: "bought",
        addedAt: "2026-02-01T10:00:00.000Z",
        boughtAt: "2026-02-03T17:45:00.000Z",
      },
    ],
    processedRequests: [
      {
        requestId: "req-1",
        payloadHash: "a".repeat(64),
        result: {
          requestId: "req-1",
          replayed: false,
          entries: [
            {
              entryId: ENTRY_OPEN,
              name: wetWipes.name,
              quantity: 2,
              action: "created",
            },
          ],
        },
        processedAt: "2026-02-01T10:00:00.000Z",
      },
    ],
  };
}
