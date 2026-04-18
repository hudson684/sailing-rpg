import { createRegistry } from "../data/createRegistry";
import shopData from "../data/shops.json";
import type { ShopDef } from "./types";

const RAW = (shopData as unknown as { shops: ShopDef[] }).shops;

export const shops = createRegistry<ShopDef>(RAW, { label: "shop" });

export const ALL_SHOP_IDS: string[] = RAW.map((s) => s.id);
