import { useGameStore } from "../store/gameStore";
import {
  ALL_ITEM_IDS,
  CURRENCY_ITEM_ID,
  ITEMS,
  type ItemId,
} from "../inventory/items";

/**
 * Dev-only console commands. Wired up from main.tsx behind
 * `import.meta.env.DEV`, so prod bundles never include this module.
 *
 * Exposes a `dev` global (and shorthands `give` / `gold` / `help`) for use
 * from the browser devtools console.
 */

function logHelp(): void {
  const lines = [
    "Sailing RPG dev console — available commands:",
    "",
    "  dev.help()                 Show this help.",
    "  dev.gold(amount)           Add `amount` coins to inventory (negative removes).",
    "  dev.give(itemId, qty?)     Add `qty` (default 1) of `itemId` to inventory.",
    "  dev.listItems(filter?)     List item ids; optional substring filter.",
    "",
    "Shorthands: give(...), gold(...), help() — same as the dev.* versions.",
    "",
    "Examples:",
    "  gold(1000)",
    "  give('cutlass')",
    "  give('crab_cake', 10)",
    "  listItems('ring')",
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function giveGold(amount: number): number {
  if (!Number.isFinite(amount) || amount === 0) {
    // eslint-disable-next-line no-console
    console.warn("gold(amount): amount must be a non-zero finite number");
    return 0;
  }
  const store = useGameStore.getState();
  if (amount > 0) {
    const leftover = store.inventoryAdd(CURRENCY_ITEM_ID, Math.floor(amount));
    const added = Math.floor(amount) - leftover;
    // eslint-disable-next-line no-console
    console.log(`+${added} coin${leftover > 0 ? ` (${leftover} dropped — inventory full)` : ""}`);
    return added;
  }
  // Negative: remove coins from any slots holding currency.
  let toRemove = Math.floor(-amount);
  let removed = 0;
  const slots = store.inventory.slots;
  for (let i = 0; i < slots.length && toRemove > 0; i++) {
    const s = slots[i];
    if (!s || s.itemId !== CURRENCY_ITEM_ID) continue;
    const r = store.inventoryRemoveAt(i, Math.min(s.quantity, toRemove));
    removed += r;
    toRemove -= r;
  }
  // eslint-disable-next-line no-console
  console.log(`-${removed} coin`);
  return -removed;
}

function giveItem(itemId: ItemId, qty: number = 1): number {
  if (!ITEMS[itemId]) {
    // eslint-disable-next-line no-console
    console.warn(`give: unknown item '${itemId}'. Try listItems().`);
    return 0;
  }
  const n = Math.floor(qty);
  if (!Number.isFinite(n) || n <= 0) {
    // eslint-disable-next-line no-console
    console.warn("give(itemId, qty): qty must be a positive integer");
    return 0;
  }
  const leftover = useGameStore.getState().inventoryAdd(itemId, n);
  const added = n - leftover;
  // eslint-disable-next-line no-console
  console.log(
    `+${added} ${itemId}${leftover > 0 ? ` (${leftover} dropped — inventory full)` : ""}`,
  );
  return added;
}

function listItems(filter?: string): ItemId[] {
  const f = filter?.toLowerCase();
  const ids = f ? ALL_ITEM_IDS.filter((id) => id.toLowerCase().includes(f)) : ALL_ITEM_IDS;
  // eslint-disable-next-line no-console
  console.log(ids.join("\n"));
  return ids;
}

export function installDevConsole(): void {
  const w = window as unknown as Record<string, unknown>;
  const api = {
    help: logHelp,
    gold: giveGold,
    give: giveItem,
    listItems,
  };
  w.dev = api;
  w.help = logHelp;
  w.gold = giveGold;
  w.give = giveItem;
  w.listItems = listItems;
  // eslint-disable-next-line no-console
  console.log("[dev] console commands ready — type help() for a list.");
}
