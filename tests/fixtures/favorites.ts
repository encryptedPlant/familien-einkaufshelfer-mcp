// Fixed, fictional sample favourites for unit tests. Article numbers and
// URLs are made up; they do not refer to real dm products.

import type { Favorite } from "../../src/core/types";

const createdAt = "2026-01-05T08:00:00.000Z";

export const wetWipes: Favorite = {
  id: "0b1f6a52-3c4d-4e8f-9a01-111111111111",
  name: "Feuchttücher sensitiv",
  category: "Feuchttücher",
  aliases: ["Die üblichen Feuchttücher"],
  dmArticleNumber: "100001",
  dmUrl: "https://www.dm.de/beispiel-feuchttuecher-sensitiv-p100001.html",
  createdAt,
};

export const toothpasteMint: Favorite = {
  id: "0b1f6a52-3c4d-4e8f-9a01-222222222222",
  name: "Zahnpasta",
  category: "Zahnpflege",
  aliases: ["Die übliche Zahnpasta"],
  dmArticleNumber: "100002",
  createdAt,
};

export const toothpasteHerbal: Favorite = {
  id: "0b1f6a52-3c4d-4e8f-9a01-333333333333",
  name: "Zahnpasta",
  category: "Zahnpflege",
  aliases: [],
  dmArticleNumber: "100003",
  createdAt,
};

export const showerGelSea: Favorite = {
  id: "0b1f6a52-3c4d-4e8f-9a01-444444444444",
  name: "Duschgel Meeresbrise",
  category: "Körperpflege",
  aliases: ["Duschgel"],
  dmUrl: "https://www.dm.de/beispiel-duschgel-meeresbrise-p100004.html",
  createdAt,
};

export const showerGelPlain: Favorite = {
  id: "0b1f6a52-3c4d-4e8f-9a01-555555555555",
  name: "Duschgel",
  category: "Körperpflege",
  aliases: [],
  dmArticleNumber: "100005",
  createdAt,
};

export const dishSoap: Favorite = {
  id: "0b1f6a52-3c4d-4e8f-9a01-666666666666",
  name: "Spülmittel Zitrone",
  category: "Haushalt",
  aliases: ["Spüli"],
  dmUrl: "https://www.dm.de/beispiel-spuelmittel-zitrone-p100006.html",
  createdAt,
};

export const favorites: readonly Favorite[] = [
  wetWipes,
  toothpasteMint,
  toothpasteHerbal,
  showerGelSea,
  showerGelPlain,
  dishSoap,
];
